import { describe, expect, it } from 'vitest';
import { createMissionOutcomeStudioView } from './mission-outcome-studio.js';
import type { ContractV1, MissionV1, ProfileV1, BranchV1 } from './domain.js';

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
});
