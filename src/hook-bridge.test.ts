import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { ToolGateway, type PersistedKernelDecisionV1 } from './tool-gateway.js';

const disposableDirectories: string[] = [];
const runningChildren = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of runningChildren) child.kill('SIGKILL');
  runningChildren.clear();
  await Promise.all(
    disposableDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Claude Tool Gateway hook bridge', () => {
  it('blocks a real bridge process until the engine release exists', async () => {
    const root = await disposableDirectory();
    const target = join(root, 'side-effect.txt');
    const toolGateway = gateway(root, 'attempt-block');
    const hookInput = preToolInput('toolu-block', {
      command: `write ${target}`,
      authorization: 'Bearer private.token',
    });
    const bridge = spawnBridge(root, 'attempt-block', hookInput, 2_000);

    const request = await waitForPending(toolGateway);
    await expect(access(target)).rejects.toThrow();
    expect(bridge.child.exitCode).toBeNull();

    const intent = await toolGateway.writeDecisionIntent({
      gateId: request.gateId,
      expectedRequestSha256: request.requestSha256,
      decision: 'approve',
      createdAt: '2026-08-26T00:00:01.000Z',
    });
    await delay(60);
    await expect(access(target)).rejects.toThrow();
    expect(bridge.child.exitCode).toBeNull();

    await toolGateway.writeRelease({
      decisionIntentId: intent.decisionIntentId,
      kernelDecisionEvent: persistedDecision(),
    });
    const completed = await bridge.completed;
    const output = JSON.parse(completed.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(completed).toMatchObject({ code: 0, stderr: '' });
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');

    // This simulates Claude dispatching only after its hook returned allow.
    await writeFile(target, 'executed', 'utf8');
    await expect(access(target)).resolves.toBeUndefined();
    const persistedRequest = JSON.stringify(request);
    expect(persistedRequest).not.toContain('private.token');
  });

  it('returns Claude-native allow plus updatedInput after a persisted modify release', async () => {
    const root = await disposableDirectory();
    const toolGateway = gateway(root, 'attempt-modify');
    const bridge = spawnBridge(
      root,
      'attempt-modify',
      preToolInput('toolu-modify', { command: 'printf original', file_path: 'src/a.ts' }),
      2_000,
    );
    const request = await waitForPending(toolGateway);
    const intent = await toolGateway.writeDecisionIntent({
      gateId: request.gateId,
      expectedRequestSha256: request.requestSha256,
      decision: 'modify',
      updatedInput: { command: 'printf modified', file_path: 'src/b.ts' },
    });
    await toolGateway.writeRelease({
      decisionIntentId: intent.decisionIntentId,
      kernelDecisionEvent: persistedDecision(),
    });

    const completed = await bridge.completed;
    expect(JSON.parse(completed.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'printf modified', file_path: 'src/b.ts' },
      },
    });

    const postBridge = spawnBridge(root, 'attempt-modify', {
      ...preToolInput('toolu-modify', {
        command: 'printf modified',
        file_path: 'src/b.ts',
      }),
      hook_event_name: 'PostToolUse',
      tool_response: { written: 'src/b.ts' },
    });
    await expect(postBridge.completed).resolves.toMatchObject({ code: 0, stdout: '{}\n' });
    await expect(toolGateway.listResults()).resolves.toEqual([
      expect.objectContaining({ gateId: request.gateId, outcome: 'succeeded' }),
    ]);
  });

  it('returns Claude-native deny for a persisted rejection', async () => {
    const root = await disposableDirectory();
    const toolGateway = gateway(root, 'attempt-reject');
    const bridge = spawnBridge(
      root,
      'attempt-reject',
      preToolInput('toolu-reject', { command: 'dangerous action' }),
      2_000,
    );
    const request = await waitForPending(toolGateway);
    const intent = await toolGateway.writeDecisionIntent({
      gateId: request.gateId,
      expectedRequestSha256: request.requestSha256,
      decision: 'reject',
      reason: 'Outside the current Mission authority.',
    });
    await toolGateway.writeRelease({
      decisionIntentId: intent.decisionIntentId,
      kernelDecisionEvent: persistedDecision(),
    });

    const completed = await bridge.completed;
    expect(JSON.parse(completed.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Outside the current Mission authority.',
      },
    });
  });

  it('fails closed on timeout and never emits allow without a release', async () => {
    const root = await disposableDirectory();
    const toolGateway = gateway(root, 'attempt-timeout');
    const bridge = spawnBridge(
      root,
      'attempt-timeout',
      preToolInput('toolu-timeout', { command: 'write forbidden' }),
      80,
    );
    await waitForPending(toolGateway);

    const completed = await bridge.completed;
    expect(completed.code).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(completed.stdout).not.toContain('allow');
  });

  it.each([
    ['PostToolUse', 'succeeded', { tool_response: { stdout: 'private-output' } }],
    ['PostToolUseFailure', 'failed', { error: 'private failure detail' }],
  ] as const)(
    'accepts %s JSON and records only a result digest',
    async (hookEventName, outcome, extra) => {
      const root = await disposableDirectory();
      const attemptId = `attempt-${hookEventName}`;
      const toolGateway = gateway(root, attemptId);
      const hookInput = preToolInput(`toolu-${hookEventName}`, { command: 'npm test' });
      const request = await toolGateway.writePending({
        toolName: hookInput.tool_name,
        toolUseId: hookInput.tool_use_id,
        sessionId: hookInput.session_id,
        toolInput: hookInput.tool_input,
      });
      const bridge = spawnBridge(root, attemptId, {
        ...hookInput,
        hook_event_name: hookEventName,
        ...extra,
      });

      const completed = await bridge.completed;
      expect(completed).toMatchObject({ code: 0, stdout: '{}\n', stderr: '' });
      const resultFiles = await readdir(join(toolGateway.attemptDirectory, 'results'));
      expect(resultFiles).toHaveLength(1);
      const content = await import('node:fs/promises').then(({ readFile }) =>
        readFile(join(toolGateway.attemptDirectory, 'results', resultFiles[0] ?? ''), 'utf8'),
      );
      expect(content).toContain(`"gateId":"${request.gateId}"`);
      expect(content).toContain(`"outcome":"${outcome}"`);
      expect(content).not.toContain('private-output');
      expect(content).not.toContain('private failure detail');
    },
  );
});

interface SpawnedBridge {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completed: Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

function spawnBridge(
  rootDir: string,
  attemptId: string,
  hookInput: unknown,
  timeoutMs = 2_000,
): SpawnedBridge {
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--import', 'tsx', resolve('src/hook-bridge.ts')],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        MISSIONBRAID_TOOL_GATEWAY_ROOT: rootDir,
        MISSIONBRAID_MISSION_ID: 'mission-1',
        MISSIONBRAID_ATTEMPT_ID: attemptId,
        MISSIONBRAID_GATE_TIMEOUT_MS: String(timeoutMs),
        MISSIONBRAID_GATE_POLL_INTERVAL_MS: '5',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  runningChildren.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify(hookInput)}\n`);
  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        runningChildren.delete(child);
        resolvePromise({ code, stdout, stderr });
      });
    },
  );
  return { child, completed };
}

async function waitForPending(toolGateway: ToolGateway) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const pending = await toolGateway.listPending();
    if (pending[0] !== undefined) return pending[0];
    await delay(10);
  }
  throw new Error('Bridge did not write a pending request');
}

function preToolInput(toolUseId: string, toolInput: Record<string, string>) {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: 'session-1',
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: toolInput,
  };
}

function gateway(rootDir: string, attemptId: string): ToolGateway {
  return new ToolGateway({ rootDir, missionId: 'mission-1', attemptId });
}

function persistedDecision(): PersistedKernelDecisionV1 {
  return {
    eventId: 'event-tool-decision-1',
    seq: 23,
    hash: 'c'.repeat(64),
    recordedAt: '2026-08-26T00:00:02.000Z',
  };
}

async function disposableDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'missionbraid-hook-bridge-'));
  disposableDirectories.push(directory);
  return directory;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
