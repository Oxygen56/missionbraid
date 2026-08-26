import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMissionBraidApp, type AppEngine } from './app.js';
import { createMissionOutcomeStudioView } from './mission-outcome-studio.js';
import type { BranchV1, ContractV1, MissionV1, ProfileV1 } from './domain.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Outcome Studio Workbench route', () => {
  it('serves the read-only projection without requiring Kernel command methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-outcome-studio-app-'));
    roots.push(root);
    const now = '2026-08-26T00:00:00.000Z';
    const contract: ContractV1 = {
      schemaVersion: 1,
      contractId: 'contract-outcome-route',
      objective: 'Expose evidence.',
      createdAt: now,
      acceptanceCriteria: [
        {
          criterionId: 'criterion-route',
          description: 'The route responds.',
          verifier: { kind: 'deterministic', configuration: {} },
        },
      ],
    };
    const mission: MissionV1 = {
      schemaVersion: 1,
      missionId: 'mission-outcome-route',
      title: 'Outcome route',
      workspaceKey: 'workspace-outcome-route',
      contractId: contract.contractId,
      initialProfileId: 'profile-outcome-route',
      rootBranchId: 'branch-outcome-route',
      status: 'succeeded',
      createdAt: now,
    };
    const profile: ProfileV1 = {
      schemaVersion: 1,
      profileId: mission.initialProfileId,
      harness: 'codex',
      model: 'gpt-5.6-sol',
      capabilities: [],
      configurationDigest: 'profile-digest',
    };
    const branch: BranchV1 = {
      schemaVersion: 1,
      branchId: mission.rootBranchId,
      missionId: mission.missionId,
      status: 'active',
      createdAt: now,
    };
    const outcomeStudio = createMissionOutcomeStudioView({ mission, contract, profile, branch });
    const engine = {
      outcomeStudio: async () => outcomeStudio,
      claimNextCommand: () => undefined,
      close: () => undefined,
    } as unknown as AppEngine;
    const app = await startMissionBraidApp({
      stateDir: root,
      port: 0,
      engineFactory: () => engine,
      discoverRuntimes: async () => [],
    });
    try {
      const response = await fetch(
        `${app.url}/api/v1/missions/${mission.missionId}/outcome-studio`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        evaluationSuite: { contractId: contract.contractId },
        branch: null,
        unknown: expect.arrayContaining(['agentRevision.attemptBindingId']),
      });
    } finally {
      await app.close();
    }
  });

  it('exposes scenario save, read, and export entry points', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-outcome-scenarios-app-'));
    roots.push(root);
    const collection = { missionId: 'mission-scenarios', scenarios: [], ciResults: [] };
    const engine = {
      outcomeStudioScenarios: () => collection,
      saveOutcomeStudioScenario: async () => collection,
      exportOutcomeStudioScenarios: async () => JSON.stringify(collection),
      claimNextCommand: () => undefined,
      close: () => undefined,
    } as unknown as AppEngine;
    const app = await startMissionBraidApp({
      stateDir: root,
      port: 0,
      engineFactory: () => engine,
      discoverRuntimes: async () => [],
    });
    try {
      const base = `${app.url}/api/v1/missions/mission-scenarios/outcome-studio/scenarios`;
      expect((await fetch(base)).status).toBe(200);
      expect(
        (
          await fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(201);
      const exported = await fetch(`${base}/export`);
      expect(exported.status).toBe(200);
      expect(await exported.json()).toEqual(collection);
    } finally {
      await app.close();
    }
  });

  it('persists and reads a human Outcome Branch selection separately from verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-outcome-selection-app-'));
    roots.push(root);
    const selection = {
      schemaVersion: 'missionbraid.dev/outcome-branch-selection/v1',
      selectionId: 'outcome-selection-test',
      comparisonId: 'comparison-test',
      contractId: 'contract-test',
      branchId: 'branch-verified',
      receiptId: 'receipt-verified',
      authorityKind: 'human',
      authorityRef: 'developer:test',
      decidedAt: '2026-08-26T00:00:00.000Z',
      selectionHash: 'selection-hash-test',
    } as const;
    const selectOutcomeStudioBranch = vi.fn(async () => selection);
    const engine = {
      selectOutcomeStudioBranch,
      outcomeStudioSelections: () => [selection],
      claimNextCommand: () => undefined,
      close: () => undefined,
    } as unknown as AppEngine;
    const app = await startMissionBraidApp({
      stateDir: root,
      port: 0,
      engineFactory: () => engine,
      discoverRuntimes: async () => [],
    });
    try {
      const endpoint = `${app.url}/api/v1/missions/mission-selection/outcome-studio/selections`;
      const created = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          branchId: selection.branchId,
          authorityKind: selection.authorityKind,
          authorityRef: selection.authorityRef,
        }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual(selection);
      expect(selectOutcomeStudioBranch).toHaveBeenCalledWith(
        'mission-selection',
        selection.branchId,
        selection.authorityRef,
        selection.authorityKind,
      );

      const persisted = await fetch(endpoint);
      expect(persisted.status).toBe(200);
      expect(await persisted.json()).toEqual({
        missionId: 'mission-selection',
        selections: [selection],
      });
    } finally {
      await app.close();
    }
  });

  it('starts and reopens a persisted Kernel scenario rerun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-outcome-rerun-app-'));
    roots.push(root);
    const rerun = {
      runId: 'outcome-kernel-rerun-test',
      scenarioId: 'scenario-test',
      trials: [{ branchId: 'branch-trial-1', attemptId: 'attempt-trial-1' }],
    };
    const rerunOutcomeStudioScenario = vi.fn(async () => rerun);
    const engine = {
      rerunOutcomeStudioScenario,
      outcomeStudioReruns: () => [rerun],
      claimNextCommand: () => undefined,
      close: () => undefined,
    } as unknown as AppEngine;
    const app = await startMissionBraidApp({
      stateDir: root,
      port: 0,
      engineFactory: () => engine,
      discoverRuntimes: async () => [],
    });
    try {
      const endpoint = `${app.url}/api/v1/missions/mission-rerun/outcome-studio/scenarios/scenario-test/runs`;
      const created = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targetStageId: 'stage-qoder-upgraded',
          targetProfileDefinitionId: 'profile-definition-qoder-upgraded',
        }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual(rerun);
      expect(rerunOutcomeStudioScenario).toHaveBeenCalledWith('mission-rerun', 'scenario-test', {
        targetStageId: 'stage-qoder-upgraded',
        targetProfileDefinitionId: 'profile-definition-qoder-upgraded',
      });

      const reopened = await fetch(endpoint);
      expect(reopened.status).toBe(200);
      expect(await reopened.json()).toEqual({
        missionId: 'mission-rerun',
        scenarioId: 'scenario-test',
        runs: [rerun],
      });
    } finally {
      await app.close();
    }
  });
});
