import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMissionBraidApp, type AppEngine } from './app.js';
import type { MissionPlanRuntimeProjectionV1 } from './mission-plan-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Mission Plan runtime route', () => {
  it('serves a rebuildable node execution projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-plan-runtime-app-'));
    roots.push(root);
    const projection: MissionPlanRuntimeProjectionV1 = {
      schemaVersion: 'missionbraid.dev/mission-plan-runtime/v1',
      missionId: 'mission-plan-runtime-route',
      planId: 'plan-route',
      planRevisionId: 'plan-revision-route',
      contractRevisionId: 'contract-revision-route',
      nodes: [],
      readyNodeIds: [],
      runningNodeIds: [],
      staleNodeIds: [],
      blockedNodeIds: [],
      completedNodeIds: [],
      joinNodeIds: [],
      unknownNodeIds: [],
      invalidationIds: [],
      authority: 'derived-plan-evidence-only',
    };
    const engine = {
      missionPlanRuntime: () => projection,
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
        `${app.url}/api/v1/missions/${projection.missionId}/plan/runtime`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(projection);
    } finally {
      await app.close();
    }
  });
});
