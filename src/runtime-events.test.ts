import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NativeArtifactStore, sanitizeNativeArtifact } from './artifact-store.js';
import {
  nativeToolRequestName,
  nativeEventIdentityIds,
  nativeParentCorrelationIds,
  normalizeRuntimeOutput,
  resolveCooperativeHandoffOrdering,
} from './runtime-events.js';

describe('native runtime evidence', () => {
  it('redacts credential fields and values before content-addressed persistence', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'missionbraid-artifacts-'));
    const store = new NativeArtifactStore(stateDir);
    const artifact = await store.putLine(
      JSON.stringify({ type: 'system', api_key: 'sk-proj-123456789', nested: 'Bearer abc.def' }),
    );
    const content = await readFile(resolve(stateDir, 'artifacts', artifact.relativePath), 'utf8');

    expect(content).not.toContain('sk-proj-123456789');
    expect(content).not.toContain('abc.def');
    expect(artifact.redactionCount).toBe(2);
    expect(artifact.sanitized).toBe(true);
    await expect(store.get(artifact.artifactId)).resolves.toMatchObject({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      mediaType: 'application/json',
      content,
    });
  });

  it('uses stable source identity and explicit causal parents', () => {
    const artifact = {
      artifactId: 'artifact-a',
      sha256: 'a'.repeat(64),
      relativePath: 'sha256/aa/a.json',
      mediaType: 'application/json' as const,
      byteLength: 2,
      sanitized: true as const,
      redactionCount: 0,
    };
    const line = {
      runtime: 'claude' as const,
      sequence: 3,
      streamSequence: 2,
      stream: 'stdout' as const,
      line: '{"type":"assistant"}',
      value: { type: 'assistant', session_id: 'session-1' },
      receivedAt: '2026-08-25T00:00:00.000Z',
    };
    const context = {
      missionId: 'mission-1',
      branchId: 'branch-root-1',
      attemptId: 'attempt-1',
      bindingId: 'binding-1',
      planNodeId: 'stage-1',
      sourceProtocol: 'claude-stream-json',
      causalParentIds: ['runtime-event-parent'],
    };

    const first = normalizeRuntimeOutput(line, context, artifact);
    const replay = normalizeRuntimeOutput(line, context, artifact);
    expect(first.runtimeEventId).toBe(replay.runtimeEventId);
    expect(first.sourceId).toContain(':stdout');
    expect(first.sourceSequence).toBe(2);
    expect(first.semanticKind).toBe('message');
    expect(first.causalParentIds).toEqual(['runtime-event-parent']);
    expect(first.correlationIds).toEqual(['session-1']);
  });

  it('keeps unstructured provider semantics explicit instead of guessing', () => {
    const result = sanitizeNativeArtifact('plain provider output');
    expect(result.mediaType).toBe('text/plain');
    expect(result.content).toBe('plain provider output\n');
  });

  it('derives causality only from explicit native identities', () => {
    expect(nativeEventIdentityIds({ uuid: 'event-1', message: { id: 'message-1' } })).toEqual([
      'event-1',
      'message-1',
    ]);
    expect(
      nativeParentCorrelationIds({ parent_uuid: 'event-1', parent_tool_use_id: 'tool-1' }),
    ).toEqual(['event-1', 'tool-1']);
    expect(nativeParentCorrelationIds({ type: 'assistant' })).toEqual([]);
  });

  it('uses native source order when buffered output arrives after the workspace changed', () => {
    const acknowledgement = {
      sourceId: 'attempt-1:qoder:qoder-stream-json:stdout',
      sourceSequence: 6,
      runtimeEventId: 'runtime-event-ack',
    };
    const firstToolRequest = {
      sourceId: acknowledgement.sourceId,
      sourceSequence: 7,
      runtimeEventId: 'runtime-event-write',
    };

    expect(
      nativeToolRequestName({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write' }] },
      }),
    ).toBe('Write');
    expect(resolveCooperativeHandoffOrdering(acknowledgement, firstToolRequest, false)).toEqual({
      accepted: true,
      evidence: 'native-source-before-tool-request',
    });
  });

  it('rejects an acknowledgement that follows a native mutation-capable request', () => {
    const sourceId = 'attempt-1:claude:claude-stream-json:stdout';
    expect(
      resolveCooperativeHandoffOrdering(
        { sourceId, sourceSequence: 8, runtimeEventId: 'runtime-event-ack' },
        { sourceId, sourceSequence: 7, runtimeEventId: 'runtime-event-write' },
        true,
      ),
    ).toEqual({ accepted: false, evidence: 'native-source-not-before-tool-request' });
  });

  it('treats unknown and cross-source tool requests as ordering barriers', () => {
    expect(nativeToolRequestName({ type: 'tool_call' })).toBe('unknown-tool');
    expect(
      resolveCooperativeHandoffOrdering(
        {
          sourceId: 'attempt-1:claude:claude-stream-json:stdout',
          sourceSequence: 2,
          runtimeEventId: 'runtime-event-ack',
        },
        {
          sourceId: 'attempt-1:claude:claude-stream-json:stderr',
          sourceSequence: 1,
          runtimeEventId: 'runtime-event-tool',
        },
        true,
      ),
    ).toEqual({ accepted: false, evidence: 'unknown' });
  });

  it('falls back to the workspace snapshot when native source ordering is unavailable', () => {
    expect(
      resolveCooperativeHandoffOrdering(
        {
          sourceId: 'attempt-1:claude:claude-stream-json:stdout',
          sourceSequence: 2,
          runtimeEventId: 'runtime-event-ack',
        },
        undefined,
        true,
      ),
    ).toEqual({ accepted: true, evidence: 'workspace-snapshot' });
  });
});
