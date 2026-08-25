import { describe, expect, it } from 'vitest';

import {
  cachedContextFromMission,
  cachedReplaySourceFromMission,
  confirmedEffectNoRepeatDecisions,
  replayKernelEvents,
} from './mission-checkpoint-replay.js';
import type { CompositeCheckpointManifestV1 } from './composite-checkpoint.js';
import type { StoredEventV1 } from './domain.js';
import type { CheckpointReplayRecordV1 } from './checkpoint-replay.js';

describe('Mission checkpoint replay bridge', () => {
  it('uses exact persisted source Artifacts and preserves Kernel order', () => {
    const checkpoint = fixtureCheckpoint();
    const history = [runtimeEvent(1, 'branch-a'), runtimeEvent(3, 'branch-a')];
    const source = cachedReplaySourceFromMission(checkpoint, history);
    const context = cachedContextFromMission(checkpoint, history);
    expect(source.evidence).toHaveLength(1);
    expect(source.evidence[0]).toMatchObject({ sourceSequence: 3, status: 'observed' });
    expect(context.artifactRefs).toHaveLength(1);
    expect(context.targetDigests[0]?.targetRef).toContain('runtime-event:');
  });

  it('creates one child Branch only for Branch-producing replay and records the replay phase', () => {
    const record = replayRecord();
    const first = replayKernelEvents(record, '2026-08-26T00:00:05.000Z', true);
    const repeated = replayKernelEvents(record, '2026-08-26T00:00:05.000Z', false);
    expect(first.map((event) => event.type)).toEqual(['branch.created', 'runtime.observation']);
    expect(repeated.map((event) => event.type)).toEqual(['runtime.observation']);
    expect(first[1]?.eventId).toBe(repeated[0]?.eventId);
  });

  it('requires explicit no-repeat decisions only for confirmed Effects', () => {
    const decisions = confirmedEffectNoRepeatDecisions(fixtureCheckpoint());
    expect(decisions).toEqual([{ effectId: 'effect-confirmed', action: 'inherit-no-repeat' }]);
  });
});

function runtimeEvent(seq: number, branchId: string): StoredEventV1 {
  const hex = String(seq).padStart(64, '0');
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    missionId: 'mission-a',
    attemptId: 'attempt-a',
    occurredAt: `2026-08-26T00:00:0${seq}.000Z`,
    type: 'runtime.event',
    payload: {
      event: {
        runtimeEventId: `runtime-${seq}`,
        missionId: 'mission-a',
        branchId,
        attemptId: 'attempt-a',
        bindingId: 'binding-a',
        planNodeId: 'stage-a',
        sourceHarness: 'codex',
        sourceProtocol: 'codex-jsonl',
        sourceId: 'source-a',
        sourceSequence: seq,
        nativeEventType: 'message',
        semanticKind: 'message',
        causalParentIds: [],
        correlationIds: [],
        observedAt: `2026-08-26T00:00:0${seq}.000Z`,
        fidelity: 'native',
        normalized: {},
        nativeArtifact: {
          artifactId: `artifact-${hex}`,
          sha256: hex,
          relativePath: `${hex}.json`,
          mediaType: 'application/json',
          byteLength: 2,
          sanitized: true,
          redactionCount: 0,
        },
      },
    },
    seq,
    recordedAt: `2026-08-26T00:00:0${seq}.000Z`,
    payloadHash: hex,
    prevHash: seq === 1 ? null : '1'.repeat(64),
    hash: hex,
  };
}

function fixtureCheckpoint(): CompositeCheckpointManifestV1 {
  return {
    schemaVersion: 'missionbraid.dev/composite-checkpoint/v1',
    checkpointId: 'checkpoint-a',
    manifestHash: 'sha256:' + 'a'.repeat(64),
    source: {
      missionId: 'mission-a',
      branchId: 'branch-a',
      attemptId: 'attempt-a',
      contractId: 'contract-a',
      profileId: 'profile-a',
      workspaceKey: 'workspace-a',
    },
    eventPrefix: { throughSeq: 1, headHash: '0'.repeat(64) },
    workspace: {
      state: 'restorable-artifact',
      workspaceKey: 'workspace-a',
      workspaceDigest: 'workspace-digest',
      artifactRef: 'git-commit:a',
      artifactDigest: 'git-tree:a',
    },
    externalEffectFrontier: [
      {
        effectId: 'effect-confirmed',
        attemptId: 'attempt-a',
        scope: 'mission_global_external',
        controlLevel: 'guarded',
        status: 'confirmed',
        kind: 'http',
        resourceKey: 'target:a',
        authorityRef: 'authority:a',
        idempotencyKey: 'idempotency:a',
        evidenceRefs: ['effect:a'],
      },
      {
        effectId: 'effect-failed',
        attemptId: 'attempt-a',
        scope: 'shared_resource',
        controlLevel: 'enforced',
        status: 'failed',
        kind: 'write',
        resourceKey: 'file:a',
        evidenceRefs: ['effect:b'],
      },
    ],
    process: { status: 'stopped', stoppedAt: '2026-08-26T00:00:02.000Z' },
    nativeSession: {
      status: 'unavailable',
      harness: 'codex',
      reason: 'not exposed',
    },
    components: [
      {
        component: 'visible-context',
        disposition: 'portable',
        contentDigest: 'sha256:' + 'b'.repeat(64),
        evidenceRefs: ['context'],
      },
    ],
    capturedAt: '2026-08-26T00:00:02.000Z',
  };
}

function replayRecord(): CheckpointReplayRecordV1 {
  return {
    replayId: 'checkpoint-cached-replay-a',
    mode: 'cached-replay',
    phase: 'completed',
    lineage: {
      schemaVersion: 'missionbraid.dev/checkpoint-replay/v1',
      replayId: 'checkpoint-cached-replay-a',
      lineageId: 'lineage-a',
      mode: 'cached-replay',
      missionId: 'mission-a',
      contractId: 'contract-a',
      profileId: 'profile-a',
      parentAttemptId: 'attempt-a',
      parentBranchId: 'branch-a',
      childBranchId: 'branch-child',
      childWorkspaceKey: 'workspace-child',
      parentCheckpointId: 'checkpoint-a',
      intervention: {
        interventionId: 'intervention-a',
        kind: 'guidance',
        targetRef: 'guidance:a',
        afterDigest: 'sha256:' + 'c'.repeat(64),
        description: 'change one guidance item',
        authorityChange: 'unchanged',
      },
      interventionArtifact: {
        artifactId: 'artifact-' + 'c'.repeat(64),
        contentDigest: 'sha256:' + 'c'.repeat(64),
        fidelity: 'exact-replay-safe',
        evidenceRefs: ['fixture'],
        targetRef: 'guidance:a',
      },
      inheritedExternalEffectFrontier: [],
      externalEffectDecisions: [],
      sourceFuture: {
        schemaVersion: 'missionbraid.dev/checkpoint-replay-source/v1',
        checkpointId: 'checkpoint-a',
        sourceBranchId: 'branch-a',
        sourceEventPrefix: { throughSeq: 1, headHash: '0'.repeat(64) },
        evidence: [],
        bundleId: 'bundle-a',
        manifestDigest: 'sha256:' + 'd'.repeat(64),
      },
      createdAt: '2026-08-26T00:00:04.000Z',
    },
    plan: {
      schemaVersion: 'missionbraid.dev/checkpoint-operation/v1',
      mode: 'cached-replay',
      planId: 'plan-a',
      parentCheckpointId: 'checkpoint-a',
      parentBranchId: 'branch-a',
      inheritedExternalEffectFrontier: [],
      semantics: {
        createsBranch: true,
        producesNewEvidence: true,
        modelExecution: 'cached',
        toolExecution: 'cached',
        workspaceUse: 'isolated-read-only',
        sourceHistory: 'immutable',
      },
      childBranchId: 'branch-child',
      intervention: {
        interventionId: 'intervention-a',
        kind: 'guidance',
        targetRef: 'guidance:a',
        afterDigest: 'sha256:' + 'c'.repeat(64),
        description: 'change one guidance item',
        authorityChange: 'unchanged',
      },
      isolatedWorktree: {
        worktreeId: 'worktree-a',
        workspaceKey: 'workspace-child',
        absolutePath: '/tmp/worktree-a',
        isolationMechanism: 'copy-on-write',
        baselineWorkspaceDigest: 'workspace-digest',
        evidenceRefs: ['fixture'],
      },
      externalEffectDecisions: [],
    },
    events: [],
    modelEvidence: [],
  };
}
