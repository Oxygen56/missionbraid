import { describe, expect, it } from 'vitest';
import { createCompositeCheckpoint } from './composite-checkpoint.js';
import {
  createMissionOutcomeStudioView,
  type MissionOutcomeStudioInputV1,
} from './mission-outcome-studio.js';
import type {
  AttemptBindingV1,
  AttemptV1,
  BranchV1,
  ContractV1,
  MissionV1,
  ProfileV1,
  ReceiptV1,
  StoredEventV1,
} from './domain.js';

const now = '2026-08-26T00:00:00.000Z';
const contract: ContractV1 = {
  schemaVersion: 1,
  contractId: 'contract-1',
  objective: 'test',
  createdAt: now,
  acceptanceCriteria: [
    {
      criterionId: 'c1',
      description: 'done',
      verifier: { kind: 'deterministic', configuration: {} },
    },
  ],
};
const mission: MissionV1 = {
  schemaVersion: 1,
  missionId: 'mission-1',
  title: 'test',
  workspaceKey: 'workspace-1',
  contractId: contract.contractId,
  initialProfileId: 'profile-1',
  rootBranchId: 'branch-1',
  status: 'running',
  createdAt: now,
};
const profile: ProfileV1 = {
  schemaVersion: 1,
  profileId: 'profile-1',
  harness: 'test',
  model: 'model-1',
  capabilities: [],
  configurationDigest: 'sha256:config',
};
const branch: BranchV1 = {
  schemaVersion: 1,
  branchId: 'branch-1',
  missionId: mission.missionId,
  status: 'active',
  createdAt: now,
};
const attempt: AttemptV1 = {
  schemaVersion: 1,
  attemptId: 'attempt-1',
  missionId: mission.missionId,
  branchId: branch.branchId,
  profileId: profile.profileId,
  status: 'failed',
  startedAt: '2026-08-26T00:00:01.000Z',
  endedAt: '2026-08-26T00:00:02.000Z',
};
const attemptBinding: AttemptBindingV1 = {
  schemaVersion: 1,
  bindingId: 'binding-1',
  missionId: mission.missionId,
  attemptId: attempt.attemptId,
  branchId: branch.branchId,
  contractId: contract.contractId,
  profileId: profile.profileId,
  workspaceKey: mission.workspaceKey,
  planNodeId: 'node-1',
  authority: 'workspace',
  injectionBudgetTokens: 100,
  boundAt: attempt.startedAt,
};
const checkpoint = createCompositeCheckpoint({
  mission,
  branch,
  attempt,
  contract,
  profile,
  eventPrefix: {
    throughSeq: 3,
    headHash: 'sha256:event-head-3',
    evidenceRefs: ['event:3'],
  },
  visibleContext: {
    status: 'captured',
    contextDigest: 'sha256:visible-context',
    artifactRefs: ['artifact:visible-context'],
    evidenceRefs: ['runtime:visible-context'],
  },
  workspace: {
    kind: 'restorable-artifact',
    workspaceKey: mission.workspaceKey,
    workspaceDigest: 'sha256:workspace',
    artifactRef: 'artifact:workspace',
    artifactDigest: 'sha256:workspace-artifact',
    evidenceRefs: ['artifact:workspace'],
  },
  permissions: {
    permissionMode: 'workspace-write',
    authorityRef: 'grant:workspace-1',
    evidenceRefs: [`profile:${profile.profileId}`],
  },
  effects: [],
  process: {
    status: 'stopped',
    stoppedAt: attempt.endedAt!,
    exitCode: 1,
    evidenceRefs: ['runtime:process-stopped'],
  },
  nativeSession: {
    status: 'unavailable',
    harness: profile.harness,
    reason: 'The fixture does not expose a native session.',
    evidenceRefs: ['runtime:session-unavailable'],
  },
  capturedAt: '2026-08-26T00:00:03.000Z',
});
const intervention = {
  interventionId: 'intervention-1',
  kind: 'context' as const,
  targetRef: 'context:fact-1',
  beforeDigest: 'sha256:old-context',
  afterDigest: 'sha256:new-context',
  description: 'Refresh only the stale Context fact.',
  authorityChange: 'unchanged' as const,
};

describe('Mission to Outcome Studio bridge', () => {
  it('keeps absent binding/checkpoint/evaluation explicitly unknown', () => {
    const view = createMissionOutcomeStudioView({ mission, contract, profile, branch });
    expect(view.agentRevision).toBeNull();
    expect(view.branch).toBeNull();
    expect(view.unknown).toEqual(
      expect.arrayContaining([
        'agentRevision.attemptBindingId',
        'branch.checkpoint',
        'branch.evaluation',
      ]),
    );
    expect(view.evaluationSuite?.contractId).toBe(contract.contractId);
  });

  it('does not invent behavior dimensions when a binding is present', () => {
    const view = createMissionOutcomeStudioView({
      mission,
      contract,
      profile,
      branch,
      attemptBinding: {
        schemaVersion: 1,
        bindingId: 'binding-1',
        missionId: mission.missionId,
        attemptId: 'attempt-1',
        branchId: branch.branchId,
        contractId: contract.contractId,
        profileId: profile.profileId,
        workspaceKey: mission.workspaceKey,
        planNodeId: 'node-1',
        authority: 'workspace',
        injectionBudgetTokens: 100,
        boundAt: now,
      },
    });
    expect(
      view.agentRevision?.dimensions.find((d) => d.dimension === 'model-provider')?.fidelity,
    ).toBe('known');
    expect(
      view.agentRevision?.dimensions.find((d) => d.dimension === 'context-memory')?.fidelity,
    ).toBe('unknown');
  });

  it('changes Agent Revision for a Context Intervention but not merely for a retry binding', () => {
    const base = createMissionOutcomeStudioView({
      mission,
      contract,
      profile,
      branch,
      attemptBinding,
      checkpoint,
      intervention,
    });
    const retried = createMissionOutcomeStudioView({
      mission,
      contract,
      profile,
      branch,
      attemptBinding: { ...attemptBinding, bindingId: 'binding-retry', attemptId: 'attempt-retry' },
      checkpoint,
      intervention,
    });
    const changedContext = createMissionOutcomeStudioView({
      mission,
      contract,
      profile,
      branch,
      attemptBinding,
      checkpoint,
      intervention: { ...intervention, afterDigest: 'sha256:newer-context' },
    });

    expect(retried.agentRevision?.revisionId).toBe(base.agentRevision?.revisionId);
    expect(changedContext.agentRevision?.revisionId).not.toBe(base.agentRevision?.revisionId);
  });

  it('does not create an incident scenario without actual criterion evidence', () => {
    const view = createMissionOutcomeStudioView(completeInput([]));

    expect(view.branch).not.toBeNull();
    expect(view.incidentScenario).toBeNull();
    expect(view.ciResult).toBeNull();
    expect(view.unknown).toContain('incidentScenario.expectedEvidence');
  });

  it('keeps the predeclared regression scenario stable after an unrelated Kernel event', () => {
    const baseline = createMissionOutcomeStudioView(completeInput(['verifier:c1']));
    const withLaterEvent = createMissionOutcomeStudioView(
      completeInput(['verifier:c1'], [laterUnrelatedEvent]),
    );

    expect(baseline.incidentScenario).not.toBeNull();
    expect(baseline.ciResult).toBeNull();
    expect(withLaterEvent.incidentScenario).toMatchObject({
      scenarioId: baseline.incidentScenario!.scenarioId,
      scenarioHash: baseline.incidentScenario!.scenarioHash,
    });
    expect(withLaterEvent.ciResult).toBeNull();
    expect(baseline.branch).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      eventHeadHash: 'sha256:terminal-head',
      eventThroughSeq: 8,
    });
    expect(
      baseline.branch?.dimensions.filter((entry) => entry.fidelity === 'known').length,
    ).toBeGreaterThan(0);
    expect(baseline.incidentScenario?.executionPlan).toMatchObject({
      evaluationSuite: {
        criteria: [
          {
            mode: 'stochastic-model',
            trialCount: 3,
            threshold: { metric: 'pass-rate', value: 1, minimumKnownTrials: 3 },
          },
        ],
      },
      sourceProfileId: profile.profileId,
      requiresDistinctAgentRevision: true,
    });
    expect(baseline.incidentScenario?.evaluationSuiteId).not.toBe(
      baseline.evaluationSuite?.suiteId,
    );
  });
});

const laterUnrelatedEvent: StoredEventV1 = {
  schemaVersion: 1,
  eventId: 'event-99',
  missionId: mission.missionId,
  occurredAt: '2026-08-26T00:01:00.000Z',
  type: 'mission.status_changed',
  payload: { status: 'waiting', reason: 'Awaiting an unrelated user decision.' },
  seq: 99,
  recordedAt: '2026-08-26T00:01:00.001Z',
  payloadHash: 'sha256:payload-99',
  prevHash: checkpoint.eventPrefix.headHash,
  hash: 'sha256:event-99',
};

function completeInput(
  evidenceRefs: readonly string[],
  events: readonly StoredEventV1[] = [],
): MissionOutcomeStudioInputV1 {
  const receipt: ReceiptV1 = {
    schemaVersion: 1,
    receiptId: 'receipt-1',
    missionId: mission.missionId,
    contractId: contract.contractId,
    branchId: branch.branchId,
    outcome: 'verified',
    verifications: [{ criterionId: 'c1', status: 'passed', evidenceRefs }],
    verifiedHeadHash: 'sha256:terminal-head',
    verifiedThroughSeq: 8,
    attemptIds: [attempt.attemptId],
    issuedAt: '2026-08-26T00:00:04.000Z',
  };
  return {
    mission,
    contract,
    profile,
    branch,
    attemptBinding,
    checkpoint,
    intervention,
    events,
    receipt,
    createdAt: '2026-08-26T00:00:05.000Z',
  };
}
