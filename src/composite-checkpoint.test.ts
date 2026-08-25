import { describe, expect, it } from 'vitest';

import {
  CompositeCheckpointIntegrityError,
  CompositeCheckpointValidationError,
  createCompositeCheckpoint,
  planCheckpointOperation,
  verifyCompositeCheckpoint,
  type BranchingCheckpointRequestV1,
  type CheckpointComponentNameV1,
  type CheckpointOperationModeV1,
  type CompositeCheckpointInputV1,
  type CompositeCheckpointManifestV1,
} from './composite-checkpoint.js';
import type { EffectV1, ProfileV1 } from './domain.js';

describe('composite Checkpoint manifests', () => {
  it('content-addresses exact Mission evidence and labels every component honestly', () => {
    const input = checkpointInput('git-digest');
    const first = createCompositeCheckpoint(input);
    const reordered = createCompositeCheckpoint({
      ...input,
      effects: [...input.effects]
        .reverse()
        .map((effect) => ({ ...effect, evidenceRefs: [...effect.evidenceRefs].reverse() })),
    });

    expect(first.checkpointId).toMatch(/^checkpoint-[a-f0-9]{64}$/);
    expect(first.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reordered.checkpointId).toBe(first.checkpointId);
    expect(reordered.manifestHash).toBe(first.manifestHash);
    expect(first.source).toEqual({
      missionId: 'mission-1',
      branchId: 'branch-root',
      attemptId: 'attempt-1',
      contractId: 'contract-1',
      profileId: 'profile-1',
      workspaceKey: 'workspace-parent',
    });
    expect(first.process).toMatchObject({ status: 'stopped', processRef: 'process:4421' });
    expect(first.nativeSession).toEqual({
      status: 'available',
      harness: 'codex',
      sessionRef: 'session:codex-1',
      resumeSupported: false,
    });
    expect(first.externalEffectFrontier.map((effect) => effect.effectId)).toEqual([
      'effect-publish',
    ]);

    const components = componentMap(first);
    expect(components.size).toBe(12);
    expect(components.get('mission')?.disposition).toBe('portable');
    expect(components.get('contract')?.disposition).toBe('portable');
    expect(components.get('profile')?.disposition).toBe('portable');
    expect(components.get('visible-context')?.disposition).toBe('portable');
    expect(components.get('workspace')).toMatchObject({
      disposition: 'inspect-only',
      reason: 'Git status and content digests do not contain restorable workspace bytes.',
    });
    expect(components.get('effect-frontier')?.disposition).toBe('inspect-only');
    expect(components.get('process')?.disposition).toBe('inspect-only');
    expect(components.get('native-session')).toMatchObject({
      disposition: 'inspect-only',
      reason: 'The Runtime exposes a session reference but not a resumable native session.',
    });
    for (const component of first.components) {
      expect(['portable', 'recoverable', 'inspect-only', 'unavailable']).toContain(
        component.disposition,
      );
      expect(component.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(() => verifyCompositeCheckpoint(first)).not.toThrow();
  });

  it('makes unavailable context/session explicit and rejects a forged manifest', () => {
    const input = checkpointInput('unavailable');
    const manifest = createCompositeCheckpoint({
      ...input,
      visibleContext: {
        status: 'unavailable',
        reason: 'Harness did not expose the effective request.',
        evidenceRefs: ['runtime-capability:context:unsupported'],
      },
      nativeSession: {
        status: 'unavailable',
        harness: 'codex',
        reason: 'Native session reference was not exposed.',
        evidenceRefs: ['runtime-capability:session:unsupported'],
      },
    });

    expect(manifest.workspace).toMatchObject({ state: 'unavailable', workspaceDigest: null });
    expect(manifest.nativeSession).toEqual({
      status: 'unavailable',
      harness: 'codex',
      reason: 'Native session reference was not exposed.',
    });
    expect(componentMap(manifest).get('workspace')?.disposition).toBe('unavailable');
    expect(componentMap(manifest).get('visible-context')?.disposition).toBe('unavailable');
    expect(componentMap(manifest).get('native-session')?.disposition).toBe('unavailable');

    expect(() => verifyCompositeCheckpoint({ ...manifest, manifestHash: 'sha256:forged' })).toThrow(
      CompositeCheckpointIntegrityError,
    );
  });

  it('refuses a boundary unless the owned Runtime process is explicitly stopped', () => {
    const input = checkpointInput('restorable-artifact');
    expect(() =>
      createCompositeCheckpoint({
        ...input,
        process: { ...input.process, status: 'running' },
      } as unknown as CompositeCheckpointInputV1),
    ).toThrowError(
      new CompositeCheckpointValidationError(
        'A Composite Checkpoint requires evidence that the Runtime process stopped',
      ),
    );
  });
});

describe('Checkpoint playback, replay, resample, and execution Fork planning', () => {
  it('assigns four non-overlapping execution semantics', () => {
    const checkpoint = createCompositeCheckpoint(checkpointInput('restorable-artifact'));
    const playback = planCheckpointOperation({ mode: 'playback', checkpoint });
    expect(playback).toMatchObject({
      ok: true,
      plan: {
        mode: 'playback',
        parentBranchId: 'branch-root',
        parentCheckpointId: checkpoint.checkpointId,
        semantics: {
          createsBranch: false,
          producesNewEvidence: false,
          modelExecution: 'none',
          toolExecution: 'none',
          workspaceUse: 'read-only',
          sourceHistory: 'immutable',
        },
      },
    });

    const modes = ['cached-replay', 'counterfactual-resample', 'execution-fork'] as const;
    const expected = {
      'cached-replay': {
        modelExecution: 'cached',
        toolExecution: 'cached',
        workspaceUse: 'isolated-read-only',
      },
      'counterfactual-resample': {
        modelExecution: 'resampled',
        toolExecution: 'cached',
        workspaceUse: 'isolated-read-only',
      },
      'execution-fork': {
        modelExecution: 'live',
        toolExecution: 'live',
        workspaceUse: 'isolated-writable',
      },
    } as const;
    const planIds = new Set<string>();

    for (const mode of modes) {
      const result = planCheckpointOperation(branchRequest(mode, checkpoint));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`Expected ${mode} to produce a plan`);
      planIds.add(result.plan.planId);
      expect(result.plan).toMatchObject({
        mode,
        parentBranchId: 'branch-root',
        parentCheckpointId: checkpoint.checkpointId,
        childBranchId: `branch-${mode}`,
        intervention: {
          interventionId: `intervention-${mode}`,
          kind: 'guidance',
          authorityChange: 'unchanged',
        },
        isolatedWorktree: {
          workspaceKey: `workspace-${mode}`,
          baselineWorkspaceDigest: 'sha256:workspace',
        },
        inheritedExternalEffectFrontier: [
          expect.objectContaining({ effectId: 'effect-publish', status: 'confirmed' }),
        ],
        externalEffectDecisions: [{ effectId: 'effect-publish', action: 'inherit-no-repeat' }],
        semantics: {
          createsBranch: true,
          producesNewEvidence: true,
          sourceHistory: 'immutable',
          ...expected[mode],
        },
      });
    }
    expect(planIds.size).toBe(3);
  });

  it('blocks Branch creation from digest-only workspace evidence', () => {
    const checkpoint = createCompositeCheckpoint(checkpointInput('git-digest'));
    expect(planCheckpointOperation(branchRequest('execution-fork', checkpoint))).toEqual({
      ok: false,
      blocker: {
        code: 'CHECKPOINT_COMPONENT_NOT_RECOVERABLE',
        checkpointId: checkpoint.checkpointId,
        effectIds: [],
        component: 'workspace',
        detail: 'Branch-producing replay requires a recoverable workspace artifact.',
      },
    });
  });

  it('requires confirmed external Effects to be inherited explicitly as no-repeat', () => {
    const checkpoint = createCompositeCheckpoint(checkpointInput('restorable-artifact'));
    const request = branchRequest('execution-fork', checkpoint);
    expect(planCheckpointOperation({ ...request, externalEffectDecisions: [] })).toMatchObject({
      ok: false,
      blocker: {
        code: 'EXTERNAL_EFFECT_DECISION_REQUIRED',
        effectIds: ['effect-publish'],
      },
    });
    expect(() =>
      planCheckpointOperation({
        ...request,
        externalEffectDecisions: [
          { effectId: 'effect-publish', action: 'repeat' },
        ] as unknown as BranchingCheckpointRequestV1['externalEffectDecisions'],
      }),
    ).toThrow('Unsupported external Effect replay action repeat');
  });

  it('blocks replay while any external Effect remains ambiguous', () => {
    const input = checkpointInput('restorable-artifact');
    const checkpoint = createCompositeCheckpoint({
      ...input,
      effects: input.effects.map((effect) =>
        effect.effectId === 'effect-publish' ? { ...effect, status: 'ambiguous' } : effect,
      ),
    });

    expect(planCheckpointOperation(branchRequest('cached-replay', checkpoint))).toMatchObject({
      ok: false,
      blocker: {
        code: 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED',
        effectIds: ['effect-publish'],
      },
    });
    expect(planCheckpointOperation({ mode: 'playback', checkpoint })).toMatchObject({
      ok: true,
      plan: { mode: 'playback', semantics: { producesNewEvidence: false } },
    });
  });
});

function checkpointInput(
  workspaceKind: 'git-digest' | 'restorable-artifact' | 'unavailable',
): CompositeCheckpointInputV1 {
  const profile: ProfileV1 = {
    schemaVersion: 1,
    profileId: 'profile-1',
    harness: 'codex',
    model: 'gpt-fixture',
    reasoningEffort: 'medium',
    permissionMode: 'workspace-write',
    capabilities: ['workspace-write', 'native-events'],
    configurationDigest: 'sha256:profile',
  };
  const effects: EffectV1[] = [
    {
      schemaVersion: 1,
      effectId: 'effect-publish',
      missionId: 'mission-1',
      attemptId: 'attempt-1',
      kind: 'external.publish',
      resourceKey: 'release:fixture',
      controlLevel: 'guarded',
      scope: 'mission_global_external',
      status: 'confirmed',
      authorityRef: 'grant:fixture',
      idempotencyKey: 'publish:fixture:1',
      evidenceRefs: ['target:receipt-1', 'event:effect-confirmed'],
      createdAt: '2026-08-26T00:00:03.000Z',
    },
    {
      schemaVersion: 1,
      effectId: 'effect-workspace',
      missionId: 'mission-1',
      attemptId: 'attempt-1',
      kind: 'workspace.write',
      resourceKey: 'src/file.ts',
      controlLevel: 'enforced',
      scope: 'branch_local_workspace',
      status: 'confirmed',
      evidenceRefs: ['workspace:sha256:workspace'],
      createdAt: '2026-08-26T00:00:02.000Z',
    },
  ];
  return {
    mission: {
      schemaVersion: 1,
      missionId: 'mission-1',
      title: 'Fixture Mission',
      workspaceKey: 'workspace-parent',
      contractId: 'contract-1',
      initialProfileId: 'profile-1',
      rootBranchId: 'branch-root',
      status: 'waiting',
      createdAt: '2026-08-26T00:00:00.000Z',
    },
    branch: {
      schemaVersion: 1,
      branchId: 'branch-root',
      missionId: 'mission-1',
      status: 'active',
      createdAt: '2026-08-26T00:00:00.000Z',
    },
    attempt: {
      schemaVersion: 1,
      attemptId: 'attempt-1',
      missionId: 'mission-1',
      branchId: 'branch-root',
      profileId: 'profile-1',
      status: 'failed',
      startedAt: '2026-08-26T00:00:01.000Z',
      endedAt: '2026-08-26T00:00:05.000Z',
    },
    contract: {
      schemaVersion: 1,
      contractId: 'contract-1',
      objective: 'Produce the declared fixture outcome.',
      constraints: ['Remain inside the disposable fixture.'],
      acceptanceCriteria: [
        {
          criterionId: 'criterion-1',
          description: 'The fixture output is independently verified.',
          verifier: { kind: 'fixture', configuration: { expected: true } },
        },
      ],
      createdAt: '2026-08-26T00:00:00.000Z',
    },
    profile,
    eventPrefix: {
      throughSeq: 18,
      headHash: 'sha256:event-head',
      evidenceRefs: ['event:18', 'event-chain:verified'],
    },
    visibleContext: {
      status: 'captured',
      contextDigest: 'sha256:visible-context',
      artifactRefs: ['artifact:context-18'],
      evidenceRefs: ['runtime-event:18'],
    },
    workspace:
      workspaceKind === 'git-digest'
        ? {
            kind: 'git-digest',
            workspaceKey: 'workspace-parent',
            snapshot: {
              schemaVersion: 1,
              workspaceRoot: '/tmp/missionbraid-parent',
              head: '0123456789abcdef',
              status: [{ code: ' M', path: 'src/file.ts' }],
              paths: [{ path: 'src/file.ts', kind: 'file', sha256: 'sha256:file-content' }],
              statusDigest: 'sha256:status',
              workspaceDigest: 'sha256:workspace',
              capturedAt: '2026-08-26T00:00:04.000Z',
            },
            evidenceRefs: ['workspace-snapshot:18'],
          }
        : workspaceKind === 'restorable-artifact'
          ? {
              kind: 'restorable-artifact',
              workspaceKey: 'workspace-parent',
              workspaceDigest: 'sha256:workspace',
              artifactRef: 'artifact:workspace-tar-18',
              artifactDigest: 'sha256:workspace-tar',
              evidenceRefs: ['artifact-store:workspace-tar-18'],
            }
          : {
              kind: 'unavailable',
              workspaceKey: 'workspace-parent',
              reason: 'Workspace bytes were not retained.',
              evidenceRefs: ['workspace-capability:unavailable'],
            },
    permissions: {
      permissionMode: 'workspace-write',
      authorityRef: 'grant:workspace-fixture',
      evidenceRefs: ['profile:profile-1'],
    },
    effects,
    process: {
      status: 'stopped',
      stoppedAt: '2026-08-26T00:00:05.000Z',
      processRef: 'process:4421',
      exitCode: 1,
      evidenceRefs: ['runtime-process:stopped-4421'],
    },
    nativeSession: {
      status: 'available',
      harness: 'codex',
      sessionRef: 'session:codex-1',
      resumeSupported: false,
      evidenceRefs: ['runtime-session:codex-1'],
    },
    capturedAt: '2026-08-26T00:00:06.000Z',
  };
}

function branchRequest(
  mode: Exclude<CheckpointOperationModeV1, 'playback'>,
  checkpoint: CompositeCheckpointManifestV1,
): BranchingCheckpointRequestV1 {
  return {
    mode,
    checkpoint,
    childBranchId: `branch-${mode}`,
    intervention: {
      interventionId: `intervention-${mode}`,
      kind: 'guidance',
      targetRef: 'context:new-guidance',
      beforeDigest: 'sha256:old-guidance',
      afterDigest: `sha256:new-guidance-${mode}`,
      description: 'Try one declared guidance change.',
      authorityChange: 'unchanged',
    },
    isolatedWorktree: {
      worktreeId: `worktree-${mode}`,
      workspaceKey: `workspace-${mode}`,
      absolutePath: `/tmp/missionbraid-${mode}`,
      isolationMechanism: 'git-worktree',
      baselineWorkspaceDigest: 'sha256:workspace',
      evidenceRefs: [`worktree:${mode}:isolated`],
    },
    externalEffectDecisions: [{ effectId: 'effect-publish', action: 'inherit-no-repeat' }],
  };
}

function componentMap(
  checkpoint: CompositeCheckpointManifestV1,
): Map<CheckpointComponentNameV1, CompositeCheckpointManifestV1['components'][number]> {
  return new Map(checkpoint.components.map((component) => [component.component, component]));
}
