import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NativeArtifactStore, sanitizeNativeArtifact } from './artifact-store.js';
import {
  nativeEventIdentityIds,
  nativeParentCorrelationIds,
  normalizeRuntimeOutput,
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
});
