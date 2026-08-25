import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ToolGateway,
  ToolGatewayTimeoutError,
  type PersistedKernelDecisionV1,
  type ToolDecision,
} from './tool-gateway.js';

const disposableDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    disposableDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('filesystem Tool Gateway', () => {
  it('uses Attempt-specific directories, stable ids, 0600 records, and sanitized inputs', async () => {
    const root = await disposableDirectory();
    const first = gateway(root, 'attempt-1');
    const secondAttempt = gateway(root, 'attempt-2');
    const draft = {
      toolName: 'Bash',
      toolUseId: 'toolu-private-123',
      sessionId: 'session-private-456',
      toolInput: {
        command: 'curl -H "Authorization: Bearer abc.def" https://example.invalid',
        api_key: 'sk-proj-123456789',
        file_path: 'src/widget.ts',
      },
      requestedAt: '2026-08-26T00:00:00.000Z',
    } as const;

    const request = await first.writePending(draft);
    const duplicate = await first.writePending({
      ...draft,
      requestedAt: '2026-08-26T00:00:01.000Z',
    });
    const replayGateway = gateway(root, 'attempt-1');
    const identity = replayGateway.identifyRequest(draft);
    const requestFile = join(first.attemptDirectory, 'requests', `${request.gateId}.json`);
    const content = await readFile(requestFile, 'utf8');
    const mode = (await stat(requestFile)).mode & 0o777;

    expect(duplicate).toEqual(request);
    expect(identity.gateId).toBe(request.gateId);
    expect(identity.effectId).toBe(request.effectId);
    expect(first.attemptDirectory).not.toBe(secondAttempt.attemptDirectory);
    expect(await first.listPending()).toEqual([request]);
    expect(await secondAttempt.listPending()).toEqual([]);
    expect(content).not.toContain('toolu-private-123');
    expect(content).not.toContain('session-private-456');
    expect(content).not.toContain('sk-proj-123456789');
    expect(content).not.toContain('abc.def');
    expect(content).toContain('[REDACTED]');
    expect(mode).toBe(0o600);
  });

  it('keeps App intent non-executable until an engine release cites a persisted event', async () => {
    const root = await disposableDirectory();
    const toolGateway = gateway(root, 'attempt-release');
    const request = await toolGateway.writePending(toolDraft('toolu-release'));

    await expect(
      toolGateway.waitForRelease(request.gateId, { timeoutMs: 20, pollIntervalMs: 2 }),
    ).rejects.toBeInstanceOf(ToolGatewayTimeoutError);

    const intent = await toolGateway.writeDecisionIntent({
      gateId: request.gateId,
      expectedRequestSha256: request.requestSha256,
      decision: 'approve',
      reason: 'reviewed',
      createdAt: '2026-08-26T00:00:01.000Z',
    });
    expect(await toolGateway.readDecisionIntents()).toEqual([intent]);
    expect(await toolGateway.readRelease(request.gateId)).toBeUndefined();
    expect(await toolGateway.listPending()).toEqual([request]);

    const release = await toolGateway.writeRelease({
      decisionIntentId: intent.decisionIntentId,
      kernelDecisionEvent: persistedDecision(),
      releasedAt: '2026-08-26T00:00:02.000Z',
    });
    expect(release).toMatchObject({
      gateId: request.gateId,
      effectId: request.effectId,
      decision: 'approve',
      kernelDecisionEvent: persistedDecision(),
    });
    await expect(toolGateway.waitForRelease(request.gateId, { timeoutMs: 20 })).resolves.toEqual(
      release,
    );
    expect(await toolGateway.listPending()).toEqual([]);
  });

  it.each([
    ['approve', undefined],
    ['reject', undefined],
    ['modify', { command: 'printf modified' }],
  ] as const)(
    'supports %s decisions with stable intent and release records',
    async (decision, updatedInput) => {
      const root = await disposableDirectory();
      const toolGateway = gateway(root, `attempt-${decision}`);
      const request = await toolGateway.writePending(toolDraft(`toolu-${decision}`));
      const intent = await toolGateway.writeDecisionIntent({
        gateId: request.gateId,
        expectedRequestSha256: request.requestSha256,
        decision: decision as ToolDecision,
        ...(updatedInput === undefined ? {} : { updatedInput }),
        createdAt: '2026-08-26T00:00:01.000Z',
      });
      const duplicate = await toolGateway.writeDecisionIntent({
        gateId: request.gateId,
        expectedRequestSha256: request.requestSha256,
        decision: decision as ToolDecision,
        ...(updatedInput === undefined ? {} : { updatedInput }),
        createdAt: '2026-08-26T00:00:03.000Z',
      });
      const release = await toolGateway.writeRelease({
        decisionIntentId: intent.decisionIntentId,
        kernelDecisionEvent: persistedDecision(),
      });

      expect(duplicate).toEqual(intent);
      expect(release.decision).toBe(decision);
      expect(release.updatedInput).toEqual(updatedInput);
    },
  );

  it('rejects stale decisions, oversize inputs, and releases without a persisted intent', async () => {
    const root = await disposableDirectory();
    const toolGateway = gateway(root, 'attempt-invalid', 1_024);
    const request = await toolGateway.writePending(toolDraft('toolu-invalid'));

    await expect(
      toolGateway.writeDecisionIntent({
        gateId: request.gateId,
        expectedRequestSha256: 'f'.repeat(64),
        decision: 'approve',
      }),
    ).rejects.toThrow('stale');
    await expect(
      toolGateway.writeRelease({
        decisionIntentId: `decision-intent-${'a'.repeat(32)}`,
        kernelDecisionEvent: persistedDecision(),
      }),
    ).rejects.toThrow('without a decision intent');
    await expect(
      toolGateway.writePending({
        ...toolDraft('toolu-large'),
        toolInput: { command: 'x'.repeat(2_000) },
      }),
    ).rejects.toThrow('maxFileBytes');
  });

  it('records post-tool status by the explicit gate identity without persisting raw output', async () => {
    const root = await disposableDirectory();
    const toolGateway = gateway(root, 'attempt-result');
    const draft = toolDraft('toolu-result');
    const request = await toolGateway.writePending(draft);
    const result = await toolGateway.markResult({
      gateId: request.gateId,
      originalInputSha256: request.originalInputSha256,
      hookEventName: 'PostToolUse',
      outcome: 'succeeded',
      toolResponse: { stdout: 'private-result-value' },
      observedAt: '2026-08-26T00:00:04.000Z',
    });
    const resultFile = join(toolGateway.attemptDirectory, 'results', `${result.resultId}.json`);
    const content = await readFile(resultFile, 'utf8');

    expect(result).toMatchObject({
      gateId: request.gateId,
      effectId: request.effectId,
      outcome: 'succeeded',
    });
    expect(content).not.toContain('private-result-value');
    expect((await stat(resultFile)).mode & 0o777).toBe(0o600);
    expect(await toolGateway.listResults()).toEqual([result]);
  });

  it('correlates a modified post-tool input to the original invocation identity', async () => {
    const root = await disposableDirectory();
    const toolGateway = gateway(root, 'attempt-modified-result');
    const request = await toolGateway.writePending({
      ...toolDraft('toolu-modified-result'),
      toolInput: { command: 'printf original', file_path: 'src/a.ts' },
    });

    await expect(
      toolGateway.findRequestByInvocation({
        toolName: 'Bash',
        toolUseId: 'toolu-modified-result',
        sessionId: 'session-1',
      }),
    ).resolves.toEqual(request);
    const result = await toolGateway.markResult({
      gateId: request.gateId,
      originalInputSha256: request.originalInputSha256,
      hookEventName: 'PostToolUse',
      outcome: 'succeeded',
      toolResponse: { path: 'src/b.ts' },
    });
    expect(result.gateId).toBe(request.gateId);
  });
});

async function disposableDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'missionbraid-tool-gateway-'));
  disposableDirectories.push(directory);
  return directory;
}

function gateway(rootDir: string, attemptId: string, maxFileBytes?: number): ToolGateway {
  return new ToolGateway({
    rootDir,
    missionId: 'mission-1',
    attemptId,
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  });
}

function toolDraft(toolUseId: string) {
  return {
    toolName: 'Bash',
    toolUseId,
    sessionId: 'session-1',
    toolInput: { command: 'printf original' },
    requestedAt: '2026-08-26T00:00:00.000Z',
  } as const;
}

function persistedDecision(): PersistedKernelDecisionV1 {
  return {
    eventId: 'event-tool-decision-1',
    seq: 17,
    hash: 'b'.repeat(64),
    recordedAt: '2026-08-26T00:00:02.000Z',
  };
}
