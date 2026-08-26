import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCompositeCheckpoint,
  type CheckpointInterventionV1,
  type CompositeCheckpointInputV1,
  type CompositeCheckpointManifestV1,
} from './composite-checkpoint.js';
import {
  CheckpointReplayError,
  CheckpointReplayService,
  FileCheckpointReplayJournal,
  createCachedContextBundle,
  createCachedReplaySourceBundle,
  type CachedReplayRequestV1,
  type CounterfactualResampleRequestV1,
  type ModelOnlyResampleResultV1,
  type ReplayArtifactRefV1,
  type ReplayArtifactResolverV1,
} from './checkpoint-replay.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type AttemptV1,
  type BranchV1,
  type ContractV1,
  type EffectV1,
  type EventV1,
  type MissionV1,
  type ProfileV1,
  type StoredEventV1,
} from './domain.js';
import { computeEventHash, hashPayload } from './store.js';

const disposableRoots: string[] = [];

afterEach(() => {
  for (const root of disposableRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CheckpointReplayService', () => {
  it('playback validates and returns only the immutable historical prefix without Branch, model, tool, or Kernel writes', async () => {
    const fixture = replayFixture();
    const journal = new FileCheckpointReplayJournal(join(fixture.root, 'playback-state'));
    const service = new CheckpointReplayService({ journal, now: fixedClock() });

    const result = await service.playback({
      mode: 'playback',
      checkpoint: fixture.checkpoint,
      history: [fixture.history[1]!, fixture.history[0]!],
    });

    expect(result).toMatchObject({
      mode: 'playback',
      createsBranch: false,
      futureEvidenceRefs: [],
      modelExecution: 'none',
      toolExecution: 'none',
      kernelWrite: 'none',
      audit: { phase: 'completed', mode: 'playback' },
    });
    expect(result.history.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.audit.plan.semantics).toMatchObject({
      createsBranch: false,
      producesNewEvidence: false,
      modelExecution: 'none',
      toolExecution: 'none',
    });
    expect(result.audit.events.map((event) => event.type)).toEqual([
      'replay.planned',
      'source-prefix.validated',
      'replay.completed',
    ]);
    expect('childBranchId' in result.audit.lineage).toBe(false);
    expect('receiptInput' in result.audit).toBe(false);

    const restarted = new CheckpointReplayService({ journal, now: fixedClock() });
    const replayed = await restarted.playback({
      mode: 'playback',
      checkpoint: fixture.checkpoint,
      history: fixture.history,
    });
    expect(replayed.replayId).toBe(result.replayId);
    expect(replayed.audit.events).toEqual(result.audit.events);

    const tampered = fixture.history.map((event) => ({ ...event }));
    tampered[1] = {
      ...tampered[1]!,
      payload: { kind: 'tampered', data: null },
    } as StoredEventV1;
    await expect(
      service.playback({ mode: 'playback', checkpoint: fixture.checkpoint, history: tampered }),
    ).rejects.toMatchObject({
      code: 'HISTORY_PREFIX_INVALID',
    });
  });

  it('cached replay constructs a content-addressed child record from persisted source evidence without Runtime, worktree, or tool execution', async () => {
    const fixture = replayFixture();
    const firstEvidence = fixture.cachedEvidence[0]!;
    const secondEvidence = fixture.cachedEvidence[1]!;
    const reversedBundle = createCachedReplaySourceBundle({
      checkpointId: fixture.checkpoint.checkpointId,
      sourceBranchId: fixture.branch.branchId,
      sourceEventPrefix: fixture.checkpoint.eventPrefix,
      evidence: [secondEvidence, firstEvidence],
    });
    expect(reversedBundle).toEqual(fixture.sourceFuture);

    const state = join(fixture.root, 'cached-state');
    const journal = new FileCheckpointReplayJournal(state);
    const service = new CheckpointReplayService({ journal, now: fixedClock() });
    const record = await service.cachedReplay(fixture.cachedRequest, foundArtifacts());

    expect(record).toMatchObject({
      mode: 'cached-replay',
      phase: 'completed',
      lineage: {
        parentBranchId: fixture.branch.branchId,
        childBranchId: 'branch-child',
        sourceFuture: { bundleId: fixture.sourceFuture.bundleId },
      },
      receiptInput: {
        outcome: 'unknown',
        authority: 'receipt-input-not-kernel-state',
      },
    });
    expect(record.plan.semantics).toMatchObject({
      createsBranch: true,
      modelExecution: 'cached',
      toolExecution: 'cached',
      workspaceUse: 'isolated-read-only',
    });
    expect(record.events.map((event) => event.type)).toEqual([
      'replay.planned',
      'source-future.referenced',
      'receipt-input.ready',
      'replay.completed',
    ]);
    expect(record.modelEvidence).toEqual([]);
    expect(record.receiptInput?.evidenceRefs).toContain(
      `artifact:${firstEvidence.artifactRefs[0]!.artifactId}@${firstEvidence.artifactRefs[0]!.contentDigest}`,
    );
    if (record.plan.mode === 'playback') throw new Error('Expected a branching plan');
    expect(existsSync(record.plan.isolatedWorktree.absolutePath)).toBe(false);

    const restarted = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(state),
      now: fixedClock(),
    });
    const restored = await restarted.cachedReplay(fixture.cachedRequest, foundArtifacts());
    expect(restored).toEqual(record);
  });

  it('blocks unreconciled Effects, incomplete no-repeat decisions, lossy Artifacts, and unverifiable Interventions before creating child evidence', async () => {
    const ambiguous = replayFixture('ambiguous');
    const ambiguousState = join(ambiguous.root, 'ambiguous-state');
    const ambiguousService = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(ambiguousState),
    });
    await expect(
      ambiguousService.cachedReplay(ambiguous.cachedRequest, foundArtifacts()),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED',
    });
    expect(existsSync(ambiguousState)).toBe(false);

    const incomplete = replayFixture('confirmed-without-idempotency');
    await expect(
      new CheckpointReplayService({
        journal: new FileCheckpointReplayJournal(join(incomplete.root, 'incomplete-state')),
      }).cachedReplay(incomplete.cachedRequest, foundArtifacts()),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_EFFECT_FRONTIER_INCOMPLETE',
    });

    const missingDecision = replayFixture();
    await expect(
      new CheckpointReplayService({
        journal: new FileCheckpointReplayJournal(join(missingDecision.root, 'missing-decision')),
      }).cachedReplay(
        { ...missingDecision.cachedRequest, externalEffectDecisions: [] },
        foundArtifacts(),
      ),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_EFFECT_DECISION_REQUIRED',
    });

    const lossy = replayFixture();
    const lossyArtifact: ReplayArtifactRefV1 = {
      ...lossy.cachedRequest.sourceFuture.evidence[0]!.artifactRefs[0]!,
      fidelity: 'sanitized-lossy',
    };
    const lossyBundle = createCachedReplaySourceBundle({
      checkpointId: lossy.checkpoint.checkpointId,
      sourceBranchId: lossy.branch.branchId,
      sourceEventPrefix: lossy.checkpoint.eventPrefix,
      evidence: [
        {
          ...lossy.cachedRequest.sourceFuture.evidence[0]!,
          artifactRefs: [lossyArtifact],
        },
        lossy.cachedRequest.sourceFuture.evidence[1]!,
      ],
    });
    await expect(
      new CheckpointReplayService({
        journal: new FileCheckpointReplayJournal(join(lossy.root, 'lossy-state')),
      }).cachedReplay({ ...lossy.cachedRequest, sourceFuture: lossyBundle }, foundArtifacts()),
    ).rejects.toMatchObject({
      code: 'ARTIFACT_NOT_REPLAY_SAFE',
    });

    const badIntervention = replayFixture();
    await expect(
      new CheckpointReplayService({
        journal: new FileCheckpointReplayJournal(join(badIntervention.root, 'bad-intervention')),
      }).cachedReplay(
        {
          ...badIntervention.cachedRequest,
          intervention: {
            ...badIntervention.cachedRequest.intervention,
            beforeDigest: sha('f'),
          },
        },
        foundArtifacts(),
      ),
    ).rejects.toMatchObject({ code: 'INTERVENTION_INVALID' });
  });

  it('allows a confirmed shared-resource tool Effect without external identity only with an exact no-repeat decision', async () => {
    const fixture = replayFixture('confirmed-with-shared-tool');
    const service = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(join(fixture.root, 'shared-state')),
      now: fixedClock(),
    });
    const record = await service.cachedReplay(fixture.cachedRequest, foundArtifacts());

    expect(record.phase).toBe('completed');
    expect(record.plan.mode).toBe('cached-replay');
    if (record.plan.mode !== 'cached-replay') {
      throw new Error('Expected a cached replay plan');
    }
    expect(record.plan.inheritedExternalEffectFrontier).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          effectId: 'effect-tool-shared',
          scope: 'shared_resource',
          status: 'confirmed',
        }),
      ]),
    );
    expect(record.plan.externalEffectDecisions).toContainEqual({
      effectId: 'effect-tool-shared',
      action: 'inherit-no-repeat',
    });

    const missingDecision = replayFixture('confirmed-with-shared-tool');
    await expect(
      new CheckpointReplayService({
        journal: new FileCheckpointReplayJournal(join(missingDecision.root, 'missing-state')),
      }).cachedReplay(
        {
          ...missingDecision.cachedRequest,
          externalEffectDecisions: [
            { effectId: 'effect-external-confirmed', action: 'inherit-no-repeat' },
          ],
        },
        foundArtifacts(),
      ),
    ).rejects.toMatchObject({ code: 'EXTERNAL_EFFECT_DECISION_REQUIRED' });
  });

  it('counterfactual resampling injects only a model port and produces child evidence plus unknown Receipt input', async () => {
    const fixture = replayFixture();
    const state = join(fixture.root, 'counterfactual-state');
    const service = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(state),
      now: fixedClock(),
    });
    const modelResult = successfulModelResult();
    const model = {
      resample: vi.fn(async (input) => {
        expect(input).toMatchObject({
          liveToolAccess: 'forbidden',
          liveWorkspaceAccess: 'forbidden',
          childBranchId: 'branch-child',
        });
        expect('workspacePath' in input).toBe(false);
        expect('toolPort' in input).toBe(false);
        return modelResult;
      }),
    };

    const record = await service.counterfactualResample(
      fixture.counterfactualRequest,
      foundArtifacts(),
      model,
    );

    expect(model.resample).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({
      mode: 'counterfactual-resample',
      phase: 'completed',
      modelResult: { status: 'completed' },
      receiptInput: {
        outcome: 'unknown',
        authority: 'receipt-input-not-kernel-state',
      },
    });
    expect(record.events.map((event) => event.type)).toEqual([
      'replay.planned',
      'model.started',
      'model.evidence',
      'model.finished',
      'receipt-input.ready',
      'replay.completed',
    ]);
    expect(record.receiptInput).not.toHaveProperty('receiptId');
    if (record.plan.mode === 'playback') throw new Error('Expected a branching plan');
    expect(existsSync(record.plan.isolatedWorktree.absolutePath)).toBe(false);

    const rejectingModel = {
      resample: vi.fn(async () => {
        throw new Error('completed replay must not resample again');
      }),
    };
    const restored = await new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(state),
    }).counterfactualResample(fixture.counterfactualRequest, foundArtifacts(), rejectingModel);
    expect(restored).toEqual(record);
    expect(rejectingModel.resample).not.toHaveBeenCalled();
  });

  it('fails closed when a model-only port returns tool, Effect, or workspace evidence', async () => {
    const fixture = replayFixture();
    const service = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(join(fixture.root, 'prohibited-state')),
      now: fixedClock(),
    });
    await expect(
      service.counterfactualResample(fixture.counterfactualRequest, foundArtifacts(), {
        resample: async () => ({
          ...successfulModelResult(),
          toolRequestEvidenceRefs: ['tool-request:unexpected'],
          effectEvidenceRefs: ['effect:unexpected'],
          workspaceEvidenceRefs: ['workspace:unexpected'],
        }),
      }),
    ).rejects.toMatchObject({
      code: 'PROHIBITED_MODEL_OUTPUT',
    });
    const files = existsSync(join(fixture.root, 'prohibited-state'))
      ? readDirectoryNames(join(fixture.root, 'prohibited-state'))
      : [];
    expect(files).toHaveLength(1);
    const replayId = files[0]!.replace(/\.jsonl$/, '');
    const failed = await service.inspect(replayId);
    expect(failed).toMatchObject({
      phase: 'failed',
      failure: { code: 'PROHIBITED_MODEL_OUTPUT' },
    });
    expect(failed?.receiptInput).toBeUndefined();
  });

  it('records a lost model-only outcome as unknown and never retries it after restart', async () => {
    const fixture = replayFixture();
    const state = join(fixture.root, 'unknown-state');
    const firstModel = {
      resample: vi.fn(async () => {
        throw new Error('connection lost after dispatch');
      }),
    };
    const service = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(state),
      now: fixedClock(),
    });
    const unknown = await service.counterfactualResample(
      fixture.counterfactualRequest,
      foundArtifacts(),
      firstModel,
    );
    expect(unknown).toMatchObject({
      phase: 'unknown',
      unknown: { code: 'MODEL_ONLY_PORT_OUTCOME_UNKNOWN' },
    });
    expect(unknown.receiptInput).toBeUndefined();

    const secondModel = { resample: vi.fn(async () => successfulModelResult()) };
    const restored = await new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(state),
    }).counterfactualResample(fixture.counterfactualRequest, foundArtifacts(), secondModel);
    expect(restored).toEqual(unknown);
    expect(secondModel.resample).not.toHaveBeenCalled();
  });

  it('keeps an explicit model-only unknown as child evidence with only unknown Receipt input', async () => {
    const fixture = replayFixture();
    const record = await new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(join(fixture.root, 'reported-unknown-state')),
      now: fixedClock(),
    }).counterfactualResample(fixture.counterfactualRequest, foundArtifacts(), {
      resample: async () => ({
        ...successfulModelResult(),
        status: 'unknown',
        unresolvedItems: ['provider-terminal-status:unknown'],
      }),
    });

    expect(record).toMatchObject({
      phase: 'unknown',
      modelResult: { status: 'unknown' },
      unknown: { code: 'MODEL_RESULT_UNKNOWN' },
      receiptInput: {
        outcome: 'unknown',
        authority: 'receipt-input-not-kernel-state',
      },
    });
    expect(record.receiptInput).not.toHaveProperty('receiptId');
  });

  it('rebuilds model-running as unknown after restart and never blindly resamples', async () => {
    const fixture = replayFixture();
    const state = join(fixture.root, 'started-only-state');
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const pendingModel = {
      resample: vi.fn(async () => {
        signalEntered();
        return new Promise<ModelOnlyResampleResultV1>(() => undefined);
      }),
    };
    const abandoned = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(state),
      now: fixedClock(),
    }).counterfactualResample(fixture.counterfactualRequest, foundArtifacts(), pendingModel);
    void abandoned;
    await entered;

    const retryModel = { resample: vi.fn(async () => successfulModelResult()) };
    const recovered = await new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(state),
      now: fixedClock(),
    }).counterfactualResample(fixture.counterfactualRequest, foundArtifacts(), retryModel);

    expect(recovered).toMatchObject({
      phase: 'unknown',
      unknown: { code: 'MODEL_RESULT_UNRESOLVED_AFTER_RESTART' },
    });
    expect(pendingModel.resample).toHaveBeenCalledTimes(1);
    expect(retryModel.resample).not.toHaveBeenCalled();
  });

  it('rejects illegal journal order and content tampering instead of projecting them as failure or unknown', async () => {
    const fixture = replayFixture();
    const journal = new FileCheckpointReplayJournal(join(fixture.root, 'integrity-state'));
    await expect(
      journal.append({
        replayId: 'checkpoint-playback-illegal',
        type: 'replay.completed',
        occurredAt: '2026-08-26T08:00:00.000Z',
        payload: { result: 'playback-only' },
      }),
    ).rejects.toMatchObject({
      code: 'REPLAY_EVIDENCE_CORRUPT',
    });

    const service = new CheckpointReplayService({ journal, now: fixedClock() });
    const result = await service.playback({
      mode: 'playback',
      checkpoint: fixture.checkpoint,
      history: fixture.history,
    });
    const path = join(fixture.root, 'integrity-state', `${result.replayId}.jsonl`);
    const tampered = readFileSync(path, 'utf8').replace('playback-only', 'model-only');
    writeFileSync(path, tampered);
    await expect(service.inspect(result.replayId)).rejects.toMatchObject({
      code: 'REPLAY_EVIDENCE_CORRUPT',
    });
  });
});

type FixtureEffectState =
  | 'confirmed'
  | 'ambiguous'
  | 'confirmed-without-idempotency'
  | 'confirmed-with-shared-tool';

interface ReplayFixture {
  readonly root: string;
  readonly mission: MissionV1;
  readonly contract: ContractV1;
  readonly profile: ProfileV1;
  readonly branch: BranchV1;
  readonly attempt: AttemptV1;
  readonly history: readonly StoredEventV1[];
  readonly checkpoint: CompositeCheckpointManifestV1;
  readonly cachedEvidence: CachedReplayRequestV1['sourceFuture']['evidence'];
  readonly sourceFuture: CachedReplayRequestV1['sourceFuture'];
  readonly cachedRequest: CachedReplayRequestV1;
  readonly counterfactualRequest: CounterfactualResampleRequestV1;
}

function replayFixture(effectState: FixtureEffectState = 'confirmed'): ReplayFixture {
  const root = mkdtempSync(join(tmpdir(), 'missionbraid-checkpoint-replay-'));
  disposableRoots.push(root);
  const contract: ContractV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    contractId: 'contract-replay',
    objective: 'Exercise exact Checkpoint replay semantics.',
    acceptanceCriteria: [
      {
        criterionId: 'criterion-replay',
        description: 'Replay remains evidence-only until Kernel verification.',
        verifier: { kind: 'fixture', configuration: {} },
      },
    ],
    createdAt: '2026-08-26T08:00:00.000Z',
  };
  const profile: ProfileV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: 'profile-replay',
    harness: 'codex',
    model: 'gpt-fixture',
    capabilities: ['observe'],
    configurationDigest: sha('1'),
  };
  const mission: MissionV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    missionId: 'mission-replay',
    title: 'Checkpoint replay fixture',
    workspaceKey: 'workspace-parent',
    contractId: contract.contractId,
    initialProfileId: profile.profileId,
    rootBranchId: 'branch-parent',
    status: 'running',
    createdAt: '2026-08-26T08:00:00.000Z',
  };
  const branch: BranchV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    branchId: mission.rootBranchId,
    missionId: mission.missionId,
    status: 'active',
    createdAt: mission.createdAt,
  };
  const attempt: AttemptV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    attemptId: 'attempt-parent',
    missionId: mission.missionId,
    branchId: branch.branchId,
    profileId: profile.profileId,
    status: 'succeeded',
    startedAt: '2026-08-26T08:00:01.000Z',
    endedAt: '2026-08-26T08:00:02.000Z',
  };
  const first: EventV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: 'event-mission-created',
    missionId: mission.missionId,
    occurredAt: mission.createdAt,
    type: 'mission.created',
    payload: { mission, contract, profile },
  };
  const storedFirst = storedEvent(first, 1, null);
  const second: EventV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: 'event-runtime-observation',
    missionId: mission.missionId,
    attemptId: attempt.attemptId,
    occurredAt: '2026-08-26T08:00:02.000Z',
    type: 'runtime.observation',
    payload: { kind: 'fixture.boundary', data: { stopped: true } },
  };
  const storedSecond = storedEvent(second, 2, storedFirst.hash);
  const history = [storedFirst, storedSecond];
  const checkpoint = createCompositeCheckpoint(
    checkpointInput(mission, branch, attempt, contract, profile, storedSecond.hash, effectState),
  );
  const beforeDigest = sha('2');
  const afterDigest = sha('3');
  const firstArtifact = artifact('artifact-source-guidance', beforeDigest);
  const secondArtifact = artifact('artifact-source-tool', sha('4'));
  const cachedEvidence = [
    {
      evidenceId: 'cached-guidance',
      sourceSequence: 3,
      kind: 'model-input' as const,
      status: 'observed' as const,
      targetRef: 'context:guidance',
      contentDigest: beforeDigest,
      artifactRefs: [firstArtifact],
      evidenceRefs: ['native:event-guidance'],
    },
    {
      evidenceId: 'cached-tool-result',
      sourceSequence: 4,
      kind: 'tool-result' as const,
      status: 'observed' as const,
      targetRef: 'tool:read-result',
      contentDigest: sha('4'),
      artifactRefs: [secondArtifact],
      evidenceRefs: ['native:event-tool-result'],
      requestDigest: sha('5'),
    },
  ];
  const sourceFuture = createCachedReplaySourceBundle({
    checkpointId: checkpoint.checkpointId,
    sourceBranchId: branch.branchId,
    sourceEventPrefix: checkpoint.eventPrefix,
    evidence: cachedEvidence,
  });
  const intervention: CheckpointInterventionV1 = {
    interventionId: 'intervention-replay-guidance',
    kind: 'guidance',
    targetRef: 'context:guidance',
    beforeDigest,
    afterDigest,
    description: 'Use the persisted replacement guidance Artifact.',
    authorityChange: 'unchanged',
  };
  const interventionArtifact = {
    ...artifact('artifact-intervention-guidance', afterDigest),
    targetRef: intervention.targetRef,
  };
  const externalEffectDecisions = checkpoint.externalEffectFrontier
    .filter((effect) => effect.status === 'confirmed')
    .map((effect) => ({ effectId: effect.effectId, action: 'inherit-no-repeat' as const }));
  const cachedRequest: CachedReplayRequestV1 = {
    mode: 'cached-replay',
    checkpoint,
    childBranchId: 'branch-child',
    childWorkspaceKey: 'workspace-child',
    intervention,
    interventionArtifact,
    externalEffectDecisions,
    sourceFuture,
  };
  const cachedContext = createCachedContextBundle({
    checkpointId: checkpoint.checkpointId,
    contextDigest: sha('6'),
    artifactRefs: [artifact('artifact-cached-context', sha('6'))],
    targetDigests: [{ targetRef: intervention.targetRef, contentDigest: beforeDigest }],
    evidenceRefs: ['context:event-prefix'],
  });
  const counterfactualRequest: CounterfactualResampleRequestV1 = {
    mode: 'counterfactual-resample',
    checkpoint,
    childBranchId: 'branch-child',
    childWorkspaceKey: 'workspace-child',
    intervention,
    interventionArtifact,
    externalEffectDecisions,
    cachedContext,
  };
  return {
    root,
    mission,
    contract,
    profile,
    branch,
    attempt,
    history,
    checkpoint,
    cachedEvidence,
    sourceFuture,
    cachedRequest,
    counterfactualRequest,
  };
}

function checkpointInput(
  mission: MissionV1,
  branch: BranchV1,
  attempt: AttemptV1,
  contract: ContractV1,
  profile: ProfileV1,
  headHash: string,
  effectState: FixtureEffectState,
): CompositeCheckpointInputV1 {
  const externalEffect: EffectV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    effectId: 'effect-external-confirmed',
    missionId: mission.missionId,
    attemptId: attempt.attemptId,
    kind: 'http.create',
    resourceKey: 'fixture-target',
    controlLevel: 'guarded',
    scope: 'mission_global_external',
    status: effectState === 'ambiguous' ? 'ambiguous' : 'confirmed',
    authorityRef: 'authority:fixture-target',
    ...(effectState === 'confirmed-without-idempotency'
      ? {}
      : { idempotencyKey: 'fixture-create-once' }),
    evidenceRefs: ['effect:target-receipt'],
    createdAt: '2026-08-26T08:00:01.000Z',
  };
  const sharedToolEffect: EffectV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    effectId: 'effect-tool-shared',
    missionId: mission.missionId,
    attemptId: attempt.attemptId,
    kind: 'tool.Bash',
    resourceKey: 'tool-request:fixture-shared',
    controlLevel: 'enforced',
    scope: 'shared_resource',
    status: 'confirmed',
    evidenceRefs: ['tool-gate:fixture-shared', 'tool-result:fixture-shared'],
    createdAt: '2026-08-26T08:00:01.500Z',
  };
  return {
    mission,
    branch,
    attempt,
    contract,
    profile,
    eventPrefix: {
      throughSeq: 2,
      headHash,
      evidenceRefs: ['kernel:event-prefix'],
    },
    visibleContext: {
      status: 'captured',
      contextDigest: sha('6'),
      artifactRefs: ['artifact:checkpoint-context'],
      evidenceRefs: ['runtime:context-captured'],
    },
    workspace: {
      kind: 'restorable-artifact',
      workspaceKey: mission.workspaceKey,
      workspaceDigest: sha('7'),
      artifactRef: 'git-commit:fixture-boundary',
      artifactDigest: sha('8'),
      evidenceRefs: ['git:fixture-boundary'],
    },
    permissions: {
      permissionMode: 'read-only',
      authorityRef: 'authority:workspace-read',
      evidenceRefs: ['policy:workspace-read'],
    },
    effects:
      effectState === 'confirmed-with-shared-tool'
        ? [externalEffect, sharedToolEffect]
        : [externalEffect],
    process: {
      status: 'stopped',
      stoppedAt: '2026-08-26T08:00:02.000Z',
      exitCode: 0,
      evidenceRefs: ['process:stopped'],
    },
    nativeSession: {
      status: 'unavailable',
      harness: 'codex',
      reason: 'Fixture uses a reconstructed replay boundary.',
      evidenceRefs: ['runtime:session-unavailable'],
    },
    capturedAt: '2026-08-26T08:00:03.000Z',
  };
}

function storedEvent(event: EventV1, seq: number, prevHash: string | null): StoredEventV1 {
  const recordedAt = new Date(Date.parse(event.occurredAt) + 100).toISOString();
  const payloadHash = hashPayload(event.payload);
  const hash = computeEventHash({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    missionId: event.missionId,
    attemptId: event.attemptId ?? null,
    seq,
    type: event.type,
    occurredAt: event.occurredAt,
    recordedAt,
    payloadHash,
    prevHash,
  });
  return { ...event, seq, recordedAt, payloadHash, prevHash, hash };
}

function artifact(artifactId: string, contentDigest: string): ReplayArtifactRefV1 {
  return {
    artifactId,
    contentDigest,
    fidelity: 'exact-replay-safe',
    evidenceRefs: [`artifact-store:${artifactId}`],
  };
}

function foundArtifacts(): ReplayArtifactResolverV1 {
  return {
    resolve: async (reference) => ({
      status: 'found',
      contentDigest: reference.contentDigest,
      fidelity: reference.fidelity,
    }),
  };
}

function successfulModelResult(): ModelOnlyResampleResultV1 {
  return {
    responseId: 'model-response-counterfactual',
    status: 'completed',
    modelEvidence: [
      {
        evidenceId: 'model-evidence-output',
        kind: 'model-output',
        observedAt: '2026-08-26T08:00:05.000Z',
        contentDigest: sha('9'),
        artifactRefs: [artifact('artifact-model-output', sha('9'))],
        evidenceRefs: ['model:response-counterfactual'],
      },
    ],
    toolRequestEvidenceRefs: [],
    effectEvidenceRefs: [],
    workspaceEvidenceRefs: [],
    unresolvedItems: [],
  };
}

function fixedClock(): () => Date {
  return () => new Date('2026-08-26T08:00:10.000Z');
}

function sha(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function readDirectoryNames(path: string): string[] {
  return readdirSync(path).sort();
}
