import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMissionBraidApp, type AppEngine } from './app.js';
import type { CompositeCheckpointManifestV1 } from './composite-checkpoint.js';
import { deriveContextGraph } from './context-graph.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type BranchV1,
  type JsonValue,
  type MissionCommandActionV1,
  type MissionCommandV1,
  type MissionProjectionV1,
  type ReceiptV1,
} from './domain.js';
import type { ExternalEffectOutcome } from './external-effect.js';
import type { ExecutionForkRecordV1 } from './execution-fork.js';
import type { CheckpointReplayRecordV1 } from './checkpoint-replay.js';
import type { MissionCheckpointReplayRequestV1 } from './mission-checkpoint-replay.js';
import type {
  MissionCreationResult,
  MissionExecutionResult,
  MissionExecutionForkRequestV1,
  MissionExecutionForkResultV1,
  MissionCheckpointReplayResultV1,
  MissionExecutionPlannerCandidateV1,
  MissionExecutionPlannerOverrideRequestV1,
  MissionExecutionPlannerOverrideV1,
  MissionExternalEffectRequestV1,
  MissionStatusView,
  MissionTimelineEntry,
} from './engine.js';
import type { RuntimeCatalogEntry } from './runtime-catalog.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MissionBraid local app', () => {
  it('serves the workbench and creates a real persisted Mission entry before background run', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
      now: incrementingClock(),
      id: () => 'draft-fixture',
    });
    try {
      const page = await fetch(app.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('MissionBraid');

      const runtimeResponse = await fetch(`${app.url}/api/v1/runtimes`);
      const runtimeBody = (await runtimeResponse.json()) as {
        runtimes: RuntimeCatalogEntry[];
        providers: Array<{ id: string; status: string }>;
      };
      expect(runtimeBody.runtimes.map((entry) => entry.id)).toEqual(['codex', 'qoder', 'claude']);
      expect(runtimeBody.providers).toContainEqual(
        expect.objectContaining({ id: 'kandev', status: 'compatibility-only' }),
      );

      const createResponse = await fetch(`${app.url}/api/v1/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(missionInput(fixture.workspace)),
      });
      expect(createResponse.status).toBe(202);
      const created = (await createResponse.json()) as {
        missionId: string;
        status: string;
      };
      expect(created).toMatchObject({ missionId: 'mission-app-1', status: 'pending' });

      const detail = await waitFor(async () => {
        const response = await fetch(`${app.url}/api/v1/missions/${created.missionId}`);
        const body = (await response.json()) as {
          operation: { phase: string } | null;
          mission: { status: string };
          timeline: MissionTimelineEntry[];
        };
        return body.operation?.phase === 'completed' ? body : undefined;
      });
      expect(detail.mission.status).toBe('succeeded');
      expect(detail.timeline.map((entry) => entry.kind)).toContain('receipt.issued');
      expect(await readdir(join(fixture.stateDir, 'drafts'))).toEqual([
        '2026-08-24T03-00-00-000Z-draft-fixture.yaml',
      ]);
    } finally {
      await app.close();
    }
  });

  it('refuses a route whose selected runtime is not execution-ready', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const catalog = readyCatalog().map((entry) =>
      entry.id === 'qoder'
        ? {
            ...entry,
            status: 'installed-unavailable' as const,
            reason: 'Qoder version probe did not respond.',
          }
        : entry,
    );
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => catalog,
    });
    try {
      const response = await fetch(`${app.url}/api/v1/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(missionInput(fixture.workspace)),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        message: expect.stringContaining('qoder is not ready'),
      });
      expect(state.missions.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('accepts one ordered Codex-to-Qoder-to-Claude Workbench route', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const response = await fetch(`${app.url}/api/v1/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(threeRuntimeMissionInput(fixture.workspace)),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        missionId: 'mission-app-1',
        commandId: 'command-app-1',
      });
    } finally {
      await app.close();
    }
  });

  it('serves a hash-verified sanitized native artifact through the Workbench API', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const sha256 = 'a'.repeat(64);
    state.artifacts.set(`artifact-${sha256}`, {
      artifactId: `artifact-${sha256}`,
      sha256,
      mediaType: 'application/json',
      content: '{"type":"assistant"}\n',
    });
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const response = await fetch(`${app.url}/api/v1/artifacts/artifact-${sha256}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(state.artifacts.get(`artifact-${sha256}`));
    } finally {
      await app.close();
    }
  });

  it('projects persisted running work as interrupted and lets the same Mission resume', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-interrupted';
    state.missions.set(missionId, projection(missionId, 'running'));
    state.timelines.set(missionId, [timeline(missionId, 'attempt.started', 'Attempt started')]);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const detailResponse = await fetch(`${app.url}/api/v1/missions/${missionId}`);
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        mission: { missionId, status: 'running' },
        operation: { action: 'resume', phase: 'interrupted' },
      });

      const resumeResponse = await fetch(`${app.url}/api/v1/missions/${missionId}/resume`, {
        method: 'POST',
      });
      expect(resumeResponse.status).toBe(202);
      const recovered = await waitFor(async () => {
        const response = await fetch(`${app.url}/api/v1/missions/${missionId}`);
        const body = (await response.json()) as {
          operation: { phase: string } | null;
          mission: { status: string };
        };
        return body.operation?.phase === 'completed' ? body : undefined;
      });
      expect(recovered.mission.status).toBe('succeeded');
      expect(state.resumeCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('automatically resumes an accepted command after the Workbench restarts', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    let releaseExecution: (() => void) | undefined;
    let markExecutionStarted: (() => void) | undefined;
    state.executionGate = new Promise<void>((resolveGate) => {
      releaseExecution = resolveGate;
    });
    const executionStarted = new Promise<void>((resolveStarted) => {
      markExecutionStarted = resolveStarted;
    });
    state.onExecuteStarted = () => markExecutionStarted?.();

    const first = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    const createResponse = await fetch(`${first.url}/api/v1/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(missionInput(fixture.workspace)),
    });
    expect(createResponse.status).toBe(202);
    const created = (await createResponse.json()) as { missionId: string; commandId: string };
    await executionStarted;
    const close = first.close();
    releaseExecution?.();
    await close;
    expect(state.commands.get(created.commandId)?.status).toBe('pending');
    expect(state.resumeCalls).toBe(0);

    delete state.executionGate;
    delete state.onExecuteStarted;
    const restarted = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const detail = await waitFor(async () => {
        const response = await fetch(`${restarted.url}/api/v1/missions/${created.missionId}`);
        const body = (await response.json()) as {
          operation: { phase: string } | null;
          mission: { status: string };
        };
        return body.operation?.phase === 'completed' ? body : undefined;
      });
      expect(detail.mission.status).toBe('succeeded');
      expect(state.resumeCalls).toBe(1);
    } finally {
      await restarted.close();
    }
  });

  it('does not launch a Runtime when shutdown begins during Mission creation', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    let releaseCreate: (() => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    state.createGate = new Promise<void>((resolveGate) => {
      releaseCreate = resolveGate;
    });
    const createStarted = new Promise<void>((resolveStarted) => {
      markCreateStarted = resolveStarted;
    });
    state.onCreateStarted = () => markCreateStarted?.();
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });

    const createResponse = fetch(`${app.url}/api/v1/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(missionInput(fixture.workspace)),
    });
    await createStarted;
    const close = app.close();
    releaseCreate?.();
    const response = await createResponse;
    expect(response.status).toBe(503);
    await close;
    expect(state.resumeCalls).toBe(0);
    expect(state.missions.size).toBe(1);
  });

  it('streams newly persisted timeline entries and resumes from a Mission sequence cursor', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-live';
    state.missions.set(missionId, projection(missionId, 'running'));
    state.timelines.set(missionId, [timeline(missionId, 'mission.created', 'Mission created')]);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
      now: () => new Date('2026-08-24T03:00:01.000Z'),
    });
    const controller = new AbortController();
    try {
      const response = await fetch(`${app.url}/api/v1/missions/${missionId}/events?after=1`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      state.timelines.get(missionId)?.push({
        seq: 2,
        occurredAt: '2026-08-24T03:00:00.900Z',
        recordedAt: '2026-08-24T03:00:00.900Z',
        category: 'runtime',
        kind: 'runtime.event',
        label: 'codex · tool · source #1',
        data: { runtimeEventId: 'runtime-live-1', semanticKind: 'tool' },
      });
      const event = await readSseEvent(response);
      expect(event).toContain('id: 2');
      expect(event).toContain('event: timeline');
      expect(event).toContain('"runtimeEventId":"runtime-live-1"');
      expect(event).toContain('"journalToWireLatencyMs":100');
      expect(event).not.toContain('id: 1');
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it('coordinates a versioned external Effect through the local API', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-external-effect';
    state.missions.set(missionId, projection(missionId, 'running'));
    state.timelines.set(missionId, [timeline(missionId, 'mission.created', 'Mission created')]);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const response = await fetch(
        `${app.url}/api/v1/missions/${missionId}/external-effects/effect-create-record/coordinate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            attemptId: 'attempt-external-effect',
            targetId: 'target-fixture',
            kind: 'record.create',
            resourceKey: 'record:fixture',
            authorityRef: 'grant:fixture',
            idempotencyKey: 'create-record-once',
            payloadDigest: 'payload-digest',
            payload: { token: 'not-persisted-by-the-route', value: 1 },
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        outcome: {
          status: 'confirmed',
          source: 'dispatch',
          receipt: { recordId: 'record-fixture' },
          evidenceRefs: ['target:record-fixture'],
        },
      });
      expect(state.externalEffects).toEqual([
        expect.objectContaining({
          missionId,
          input: expect.objectContaining({
            effectId: 'effect-create-record',
            idempotencyKey: 'create-record-once',
          }),
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('creates a Composite Checkpoint through the normal Mission API', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-checkpoint';
    state.missions.set(missionId, projection(missionId, 'succeeded'));
    state.timelines.set(missionId, [timeline(missionId, 'mission.created', 'Mission created')]);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const response = await fetch(`${app.url}/api/v1/missions/${missionId}/checkpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: 'attempt-checkpoint' }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        checkpoint: {
          checkpointId: 'checkpoint-app-fixture',
          source: { missionId, attemptId: 'attempt-checkpoint' },
        },
      });
      expect(state.checkpointRequests).toEqual([{ missionId, attemptId: 'attempt-checkpoint' }]);
    } finally {
      await app.close();
    }
  });

  it('creates a real execution Fork and exposes Branch, Checkpoint, Fork, and Receipt evidence', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-execution-fork';
    const rootBranchId = `branch-root-${missionId}`;
    const checkpoint = checkpointFixture(missionId, 'attempt-source');
    state.missions.set(missionId, projection(missionId, 'succeeded'));
    state.timelines.set(missionId, [timeline(missionId, 'mission.created', 'Mission created')]);
    state.branches.set(missionId, [
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        branchId: rootBranchId,
        missionId,
        status: 'active',
        createdAt: '2026-08-24T03:00:00.000Z',
      },
    ]);
    state.checkpoints.set(missionId, [checkpoint]);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const response = await fetch(
        `${app.url}/api/v1/missions/${missionId}/checkpoints/${checkpoint.checkpointId}/forks`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            childBranchId: 'branch-b',
            intervention: {
              interventionId: 'intervention-app-fixture',
              kind: 'guidance',
              targetRef: 'mission-guidance',
              afterDigest: 'sha256:new-guidance',
              description: 'Try the evidence-backed alternative.',
              authorityChange: 'unchanged',
            },
          }),
        },
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        executionFork: {
          phase: 'finished',
          lineage: { parentBranchId: rootBranchId, childBranchId: 'branch-b' },
        },
        receipt: { branchId: 'branch-b', outcome: 'verified' },
      });
      expect(state.forkRequests).toEqual([
        {
          missionId,
          input: expect.objectContaining({
            checkpointId: checkpoint.checkpointId,
            childBranchId: 'branch-b',
            intervention: expect.objectContaining({ interventionId: 'intervention-app-fixture' }),
          }),
        },
      ]);

      const detailResponse = await fetch(`${app.url}/api/v1/missions/${missionId}`);
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        branches: [
          { branchId: rootBranchId },
          { branchId: 'branch-b', parentBranchId: rootBranchId },
        ],
        compositeCheckpoints: [{ checkpointId: checkpoint.checkpointId }],
        executionForks: [{ lineage: { childBranchId: 'branch-b' } }],
        capabilities: { createCompositeCheckpoint: true, executeFork: true },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects malformed execution Fork requests before reaching the Engine', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-invalid-fork';
    state.missions.set(missionId, projection(missionId, 'succeeded'));
    state.timelines.set(missionId, []);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const response = await fetch(
        `${app.url}/api/v1/missions/${missionId}/checkpoints/checkpoint-invalid/forks`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ intervention: { kind: 'not-a-mode' } }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INVALID_EXECUTION_FORK' });
      expect(state.forkRequests).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('runs each honest Checkpoint Replay mode through the versioned Workbench API', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-checkpoint-replay';
    const checkpoint = checkpointFixture(missionId, 'attempt-source');
    state.missions.set(missionId, projection(missionId, 'succeeded'));
    state.timelines.set(missionId, []);
    state.checkpoints.set(missionId, [checkpoint]);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const playback = await fetch(
        `${app.url}/api/v1/missions/${missionId}/checkpoints/${checkpoint.checkpointId}/replays`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'playback' }),
        },
      );
      expect(playback.status).toBe(200);
      expect(await playback.json()).toMatchObject({
        checkpointReplay: { mode: 'playback', createsBranch: false },
      });

      const cached = await fetch(
        `${app.url}/api/v1/missions/${missionId}/checkpoints/${checkpoint.checkpointId}/replays`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'cached-replay',
            childBranchId: 'branch-cached',
            intervention: {
              kind: 'guidance',
              targetRef: 'guidance:next-turn',
              replacement: 'Use the retained alternative.',
              description: 'Change one visible guidance item.',
            },
          }),
        },
      );
      expect(cached.status).toBe(201);
      expect(await cached.json()).toMatchObject({
        checkpointReplay: {
          mode: 'cached-replay',
          lineage: { childBranchId: 'branch-cached' },
        },
      });
      expect(state.replayRequests.map((item) => item.input.mode)).toEqual([
        'playback',
        'cached-replay',
      ]);

      const detail = await fetch(`${app.url}/api/v1/missions/${missionId}`);
      expect(await detail.json()).toMatchObject({
        checkpointReplays: [{ mode: 'cached-replay' }],
        capabilities: { replayCheckpoint: true },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects malformed Checkpoint Replay requests before reaching the Engine', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-invalid-replay';
    state.missions.set(missionId, projection(missionId, 'succeeded'));
    state.timelines.set(missionId, []);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const response = await fetch(
        `${app.url}/api/v1/missions/${missionId}/checkpoints/checkpoint-invalid/replays`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'cached-replay', intervention: { kind: 'guidance' } }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INVALID_CHECKPOINT_REPLAY' });
      expect(state.replayRequests).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('keeps the app bound to loopback hosts', async () => {
    await expect(startMissionBraidApp({ host: '0.0.0.0', port: 0 })).rejects.toThrow('loopback');
  });

  it('records, exposes, and clears a fallback Profile override through the Workbench API', async () => {
    const fixture = await createWorkspace();
    const state = new FakeEngineState();
    const missionId = 'mission-planner-override';
    state.missions.set(missionId, projection(missionId, 'waiting'));
    state.timelines.set(missionId, []);
    state.plannerCandidates.set(missionId, [
      plannerCandidate('primary', 'codex', 'gpt-5.6-sol'),
      plannerCandidate('fallback', 'qoder', 'qwen3.8-max'),
    ]);
    const app = await startMissionBraidApp({
      stateDir: fixture.stateDir,
      port: 0,
      engineFactory: () => new FakeEngine(state),
      discoverRuntimes: async () => readyCatalog(),
    });
    try {
      const set = await fetch(
        `${app.url}/api/v1/missions/${missionId}/execution-planner/override`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stageId: 'fallback', reason: 'Prefer the available quota' }),
        },
      );
      expect(set.status).toBe(201);
      expect(await set.json()).toMatchObject({
        override: { missionId, stageId: 'fallback', reason: 'Prefer the available quota' },
      });

      const detail = await fetch(`${app.url}/api/v1/missions/${missionId}`);
      expect(await detail.json()).toMatchObject({
        executionPlanner: {
          candidates: [
            { stageId: 'primary', profileDefinition: { harness: 'codex' } },
            { stageId: 'fallback', profileDefinition: { harness: 'qoder' } },
          ],
          override: { stageId: 'fallback' },
        },
        capabilities: {
          setExecutionPlannerOverride: true,
          clearExecutionPlannerOverride: true,
        },
      });

      const clear = await fetch(
        `${app.url}/api/v1/missions/${missionId}/execution-planner/override`,
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'Use automatic routing again' }),
        },
      );
      expect(clear.status).toBe(200);
      expect(state.plannerOverrides.has(missionId)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

class FakeEngineState {
  readonly missions = new Map<string, MissionProjectionV1>();
  readonly timelines = new Map<string, MissionTimelineEntry[]>();
  readonly commands = new Map<string, MissionCommandV1>();
  readonly artifacts = new Map<
    string,
    { artifactId: string; sha256: string; mediaType: 'application/json'; content: string }
  >();
  createGate?: Promise<void>;
  onCreateStarted?: () => void;
  executionGate?: Promise<void>;
  onExecuteStarted?: () => void;
  resumeCalls = 0;
  readonly externalEffects: Array<{
    readonly missionId: string;
    readonly input: MissionExternalEffectRequestV1;
  }> = [];
  readonly checkpointRequests: Array<{
    readonly missionId: string;
    readonly attemptId?: string;
  }> = [];
  readonly branches = new Map<string, BranchV1[]>();
  readonly checkpoints = new Map<string, CompositeCheckpointManifestV1[]>();
  readonly executionForkRecords = new Map<string, ExecutionForkRecordV1[]>();
  readonly checkpointReplayRecords = new Map<string, CheckpointReplayRecordV1[]>();
  readonly forkRequests: Array<{
    readonly missionId: string;
    readonly input: MissionExecutionForkRequestV1;
  }> = [];
  readonly replayRequests: Array<{
    readonly missionId: string;
    readonly checkpointId: string;
    readonly input: MissionCheckpointReplayRequestV1;
  }> = [];
  readonly plannerCandidates = new Map<string, MissionExecutionPlannerCandidateV1[]>();
  readonly plannerOverrides = new Map<string, MissionExecutionPlannerOverrideV1>();
}

class FakeEngine implements AppEngine {
  readonly #state: FakeEngineState;

  constructor(state: FakeEngineState) {
    this.#state = state;
  }

  async create(): Promise<MissionCreationResult> {
    this.#state.onCreateStarted?.();
    await this.#state.createGate;
    const missionId = `mission-app-${String(this.#state.missions.size + 1)}`;
    this.#state.missions.set(missionId, projection(missionId, 'pending'));
    this.#state.timelines.set(missionId, [
      timeline(missionId, 'mission.created', 'Mission created'),
    ]);
    return { missionId, status: 'pending' };
  }

  async resume(missionId: string): Promise<MissionExecutionResult> {
    this.#state.resumeCalls += 1;
    this.#require(missionId);
    this.#state.missions.set(missionId, projection(missionId, 'succeeded'));
    this.#state.timelines
      .get(missionId)
      ?.push(timeline(missionId, 'receipt.issued', 'Outcome verified'));
    return { missionId, status: 'succeeded' };
  }

  async verify(missionId: string): Promise<MissionExecutionResult> {
    this.#require(missionId);
    return { missionId, status: 'succeeded' };
  }

  async acceptCommand(
    missionId: string,
    action: MissionCommandActionV1,
    idempotencyKey = `fake-${String(this.#state.commands.size + 1)}`,
  ): Promise<MissionCommandV1> {
    const mission = this.#require(missionId);
    const commandId = `command-app-${String(this.#state.commands.size + 1)}`;
    const command: MissionCommandV1 = {
      commandId,
      missionId,
      branchId: mission.rootBranchId ?? `branch-root-${missionId}`,
      action,
      idempotencyKey,
      expectedHeadHash: mission.headHash,
      status: 'pending',
      acceptedAt: mission.updatedAt,
      updatedAt: mission.updatedAt,
      dispatchCount: 0,
    };
    this.#state.commands.set(commandId, command);
    return command;
  }

  claimNextCommand(): MissionCommandV1 | undefined {
    const command = [...this.#state.commands.values()].find(
      (candidate) => candidate.status === 'pending',
    );
    if (command === undefined) return undefined;
    const claimed = {
      ...command,
      status: 'dispatching' as const,
      dispatchCount: command.dispatchCount + 1,
    };
    this.#state.commands.set(command.commandId, claimed);
    return claimed;
  }

  renewCommandClaim(commandId: string): MissionCommandV1 {
    const command = this.command(commandId);
    if (command === undefined) throw new Error(`Unknown command ${commandId}`);
    return command;
  }

  async executeCommand(commandId: string, signal?: AbortSignal): Promise<MissionExecutionResult> {
    const command = this.command(commandId);
    if (command === undefined) throw new Error(`Unknown command ${commandId}`);
    this.#state.onExecuteStarted?.();
    await this.#state.executionGate;
    if (signal?.aborted === true) {
      this.#state.commands.set(commandId, {
        ...command,
        status: 'pending',
        updatedAt: '2026-08-24T03:00:01.000Z',
      });
      return { missionId: command.missionId, status: this.#require(command.missionId).status };
    }
    const result =
      command.action === 'verify'
        ? await this.verify(command.missionId)
        : await this.resume(command.missionId);
    const completed = {
      ...command,
      status: 'completed' as const,
      updatedAt: '2026-08-24T03:00:01.000Z',
    };
    this.#state.commands.set(commandId, completed);
    return result;
  }

  command(commandId: string): MissionCommandV1 | undefined {
    return this.#state.commands.get(commandId);
  }

  commands(missionId?: string): MissionCommandV1[] {
    return [...this.#state.commands.values()].filter(
      (command) => missionId === undefined || command.missionId === missionId,
    );
  }

  async artifact(artifactId: string) {
    return this.#state.artifacts.get(artifactId);
  }

  async contextGraph(missionId: string) {
    return deriveContextGraph({ timeline: this.timeline(missionId) });
  }

  branches(missionId: string): readonly BranchV1[] {
    this.#require(missionId);
    return this.#state.branches.get(missionId) ?? [];
  }

  compositeCheckpoints(missionId: string): readonly CompositeCheckpointManifestV1[] {
    this.#require(missionId);
    return this.#state.checkpoints.get(missionId) ?? [];
  }

  async executionForks(missionId: string): Promise<readonly ExecutionForkRecordV1[]> {
    this.#require(missionId);
    return this.#state.executionForkRecords.get(missionId) ?? [];
  }

  async checkpointReplays(missionId: string): Promise<readonly CheckpointReplayRecordV1[]> {
    this.#require(missionId);
    return this.#state.checkpointReplayRecords.get(missionId) ?? [];
  }

  async coordinateExternalEffect(
    missionId: string,
    input: MissionExternalEffectRequestV1,
  ): Promise<ExternalEffectOutcome<JsonValue>> {
    this.#require(missionId);
    this.#state.externalEffects.push({ missionId, input });
    return {
      status: 'confirmed',
      source: 'dispatch',
      receipt: { recordId: 'record-fixture' },
      evidenceRefs: ['target:record-fixture'],
    };
  }

  async createCompositeCheckpoint(
    missionId: string,
    requestedAttemptId?: string,
  ): Promise<CompositeCheckpointManifestV1> {
    this.#require(missionId);
    this.#state.checkpointRequests.push({
      missionId,
      ...(requestedAttemptId === undefined ? {} : { attemptId: requestedAttemptId }),
    });
    const checkpoint = checkpointFixture(missionId, requestedAttemptId ?? 'attempt-latest');
    this.#state.checkpoints.set(missionId, [
      ...(this.#state.checkpoints.get(missionId) ?? []),
      checkpoint,
    ]);
    return checkpoint;
  }

  async executeFork(
    missionId: string,
    input: MissionExecutionForkRequestV1,
  ): Promise<MissionExecutionForkResultV1> {
    const mission = this.#require(missionId);
    this.#state.forkRequests.push({ missionId, input });
    const checkpoint = this.#state.checkpoints
      .get(missionId)
      ?.find((candidate) => candidate.checkpointId === input.checkpointId);
    if (checkpoint === undefined) throw new Error(`Unknown Checkpoint ${input.checkpointId}`);
    const childBranchId = input.childBranchId ?? 'branch-b';
    const child: BranchV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      branchId: childBranchId,
      missionId,
      parentBranchId: checkpoint.source.branchId,
      baseCheckpointId: checkpoint.checkpointId,
      status: 'active',
      createdAt: '2026-08-24T03:01:00.000Z',
    };
    this.#state.branches.set(missionId, [...(this.#state.branches.get(missionId) ?? []), child]);
    const record = executionForkFixture(checkpoint, input, childBranchId);
    this.#state.executionForkRecords.set(missionId, [
      ...(this.#state.executionForkRecords.get(missionId) ?? []),
      record,
    ]);
    const receipt: ReceiptV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      receiptId: 'receipt-execution-fork-fixture',
      missionId,
      contractId: mission.contract.contractId,
      branchId: childBranchId,
      outcome: 'verified',
      verifications: [],
      verifiedHeadHash: mission.headHash,
      verifiedThroughSeq: mission.lastSeq,
      effects: [],
      unresolvedItems: [],
      issuedAt: '2026-08-24T03:02:00.000Z',
    };
    return { record, receipt };
  }

  async replayCheckpoint(
    missionId: string,
    checkpointId: string,
    input: MissionCheckpointReplayRequestV1,
  ): Promise<MissionCheckpointReplayResultV1> {
    this.#require(missionId);
    this.#state.replayRequests.push({ missionId, checkpointId, input });
    if (input.mode === 'playback') {
      return {
        schemaVersion: 'missionbraid.dev/checkpoint-replay/v1',
        mode: 'playback',
        replayId: 'checkpoint-playback-fixture',
        checkpointId,
        parentBranchId: `branch-root-${missionId}`,
        eventPrefix: { throughSeq: 1, headHash: '0'.repeat(64) },
        history: [],
        createsBranch: false,
        futureEvidenceRefs: [],
        modelExecution: 'none',
        toolExecution: 'none',
        kernelWrite: 'none',
        audit: replayRecordFixture(missionId, checkpointId, 'playback', undefined),
      };
    }
    const childBranchId = input.childBranchId ?? `branch-${input.mode}`;
    const record = replayRecordFixture(missionId, checkpointId, input.mode, childBranchId);
    this.#state.checkpointReplayRecords.set(missionId, [
      ...(this.#state.checkpointReplayRecords.get(missionId) ?? []),
      record,
    ]);
    return record;
  }

  executionPlannerCandidates(missionId: string): readonly MissionExecutionPlannerCandidateV1[] {
    this.#require(missionId);
    return this.#state.plannerCandidates.get(missionId) ?? [];
  }

  executionPlannerOverride(missionId: string): MissionExecutionPlannerOverrideV1 | undefined {
    this.#require(missionId);
    return this.#state.plannerOverrides.get(missionId);
  }

  async setExecutionPlannerOverride(
    missionId: string,
    request: MissionExecutionPlannerOverrideRequestV1,
  ): Promise<MissionExecutionPlannerOverrideV1> {
    this.#require(missionId);
    const candidate = (this.#state.plannerCandidates.get(missionId) ?? []).find(
      (item) => item.stageId === request.stageId,
    );
    if (candidate === undefined) throw new Error(`Unknown planner stage ${request.stageId}`);
    const override: MissionExecutionPlannerOverrideV1 = {
      overrideId: `planner-override-${missionId}`,
      missionId,
      stageId: request.stageId,
      profileDefinitionId: candidate.profileDefinition.definitionId,
      reason: request.reason,
      recordedAt: '2026-08-24T03:00:00.000Z',
    };
    this.#state.plannerOverrides.set(missionId, override);
    return override;
  }

  async clearExecutionPlannerOverride(missionId: string): Promise<void> {
    this.#require(missionId);
    this.#state.plannerOverrides.delete(missionId);
  }

  status(missionId: string): MissionStatusView {
    return {
      mission: this.#require(missionId),
      chainValid: true,
      eventCount: this.#state.timelines.get(missionId)?.length ?? 0,
      attempts: [],
    };
  }

  timeline(missionId: string): MissionTimelineEntry[] {
    this.#require(missionId);
    return [...(this.#state.timelines.get(missionId) ?? [])];
  }

  list(): MissionProjectionV1[] {
    return [...this.#state.missions.values()];
  }

  close(): void {}

  #require(missionId: string): MissionProjectionV1 {
    const mission = this.#state.missions.get(missionId);
    if (mission === undefined) throw new Error(`Unknown Mission ${missionId}`);
    return mission;
  }
}

function plannerCandidate(
  stageId: string,
  harness: string,
  requestedModel: string,
): MissionExecutionPlannerCandidateV1 {
  return {
    stageId,
    profileDefinition: {
      definitionId: `profile-definition-${stageId}`,
      harness,
      requestedModel,
      injectionBudgetTokens: 2_000,
    },
  };
}

function checkpointFixture(missionId: string, attemptId: string): CompositeCheckpointManifestV1 {
  const componentNames = [
    'mission',
    'branch',
    'attempt',
    'contract',
    'profile',
    'event-prefix',
    'visible-context',
    'workspace',
    'permissions',
    'effect-frontier',
    'process',
    'native-session',
  ] as const;
  return {
    schemaVersion: 'missionbraid.dev/composite-checkpoint/v1',
    checkpointId: 'checkpoint-app-fixture',
    manifestHash: 'sha256:checkpoint-app-fixture',
    source: {
      missionId,
      branchId: `branch-root-${missionId}`,
      attemptId,
      contractId: 'contract-app-fixture',
      profileId: 'profile-app-fixture',
      workspaceKey: 'workspace-app-fixture',
    },
    eventPrefix: { throughSeq: 1, headHash: 'head-hash' },
    workspace: {
      workspaceKey: 'workspace-app-fixture',
      state: 'restorable-artifact',
      workspaceDigest: 'workspace-digest',
      artifactRef: `git-commit:${'a'.repeat(40)}`,
      artifactDigest: `git-tree:${'b'.repeat(40)}`,
    },
    process: { status: 'stopped', stoppedAt: '2026-08-24T03:00:00.000Z' },
    nativeSession: { status: 'unavailable', harness: 'codex', reason: 'not exposed' },
    externalEffectFrontier: [],
    components: componentNames.map((component) => ({
      component,
      disposition:
        component === 'workspace'
          ? ('recoverable' as const)
          : component === 'native-session'
            ? ('unavailable' as const)
            : component === 'effect-frontier' || component === 'process'
              ? ('inspect-only' as const)
              : ('portable' as const),
      contentDigest: `sha256:${component}`,
      evidenceRefs: [`fixture:${component}`],
    })),
    capturedAt: '2026-08-24T03:00:00.000Z',
  };
}

function executionForkFixture(
  checkpoint: CompositeCheckpointManifestV1,
  input: MissionExecutionForkRequestV1,
  childBranchId: string,
): ExecutionForkRecordV1 {
  const forkId = 'execution-fork-app-fixture';
  const isolatedWorktreePath = '/tmp/missionbraid-app-fork';
  const childWorkspaceKey = 'workspace-app-fork';
  const lineage = {
    schemaVersion: 'missionbraid.dev/execution-fork/v1' as const,
    lineageId: 'execution-fork-lineage-app-fixture',
    forkId,
    mode: 'execution-fork' as const,
    missionId: checkpoint.source.missionId,
    contractId: checkpoint.source.contractId,
    profileId: checkpoint.source.profileId,
    parentAttemptId: checkpoint.source.attemptId,
    parentBranchId: checkpoint.source.branchId,
    childBranchId,
    parentCheckpointId: checkpoint.checkpointId,
    parentEventPrefix: { ...checkpoint.eventPrefix },
    intervention: input.intervention,
    repositoryRoot: '/tmp/missionbraid-app-source',
    isolatedWorktreePath,
    gitBranchName: 'missionbraid/fork-app-fixture',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    childWorkspaceKey,
    inheritedExternalEffectFrontier: checkpoint.externalEffectFrontier,
    externalEffectDecisions: [],
    createdAt: '2026-08-24T03:01:00.000Z',
  };
  return {
    forkId,
    phase: 'finished',
    lineage,
    plan: {
      schemaVersion: 'missionbraid.dev/checkpoint-operation/v1',
      mode: 'execution-fork',
      planId: 'checkpoint-plan-app-fixture',
      parentCheckpointId: checkpoint.checkpointId,
      parentBranchId: checkpoint.source.branchId,
      inheritedExternalEffectFrontier: checkpoint.externalEffectFrontier,
      semantics: {
        createsBranch: true,
        producesNewEvidence: true,
        modelExecution: 'live',
        toolExecution: 'live',
        workspaceUse: 'isolated-writable',
        sourceHistory: 'immutable',
      },
      childBranchId,
      intervention: input.intervention,
      isolatedWorktree: {
        worktreeId: 'worktree-app-fixture',
        workspaceKey: childWorkspaceKey,
        absolutePath: isolatedWorktreePath,
        isolationMechanism: 'git-worktree',
        baselineWorkspaceDigest: checkpoint.workspace.workspaceDigest ?? 'workspace-digest',
        evidenceRefs: ['worktree-plan:worktree-app-fixture'],
      },
      externalEffectDecisions: [],
    },
    events: [],
    runtimeEvidence: [],
    cleaned: false,
  };
}

function replayRecordFixture(
  missionId: string,
  checkpointId: string,
  mode: 'playback' | 'cached-replay' | 'counterfactual-resample',
  childBranchId: string | undefined,
): CheckpointReplayRecordV1 {
  const parentBranchId = `branch-root-${missionId}`;
  if (mode === 'playback') {
    return {
      replayId: 'checkpoint-playback-fixture',
      mode,
      phase: 'completed',
      lineage: {
        schemaVersion: 'missionbraid.dev/checkpoint-replay/v1',
        replayId: 'checkpoint-playback-fixture',
        lineageId: 'checkpoint-replay-lineage-playback-fixture',
        mode,
        missionId,
        parentBranchId,
        parentCheckpointId: checkpointId,
        sourceEventPrefix: { throughSeq: 1, headHash: 'head-hash', eventRefs: [] },
        createdAt: '2026-08-24T03:00:00.000Z',
      },
      plan: {
        schemaVersion: 'missionbraid.dev/checkpoint-operation/v1',
        mode,
        planId: 'checkpoint-playback-plan-fixture',
        parentCheckpointId: checkpointId,
        parentBranchId,
        inheritedExternalEffectFrontier: [],
        semantics: {
          createsBranch: false,
          producesNewEvidence: false,
          modelExecution: 'none',
          toolExecution: 'none',
          workspaceUse: 'read-only',
          sourceHistory: 'immutable',
        },
      },
      events: [],
      modelEvidence: [],
    };
  }
  const replayId = `checkpoint-${mode}-fixture`;
  const branchId = childBranchId ?? `branch-${mode}`;
  const intervention = {
    interventionId: 'intervention-replay-fixture',
    kind: 'guidance' as const,
    targetRef: 'guidance:next-turn',
    afterDigest: 'sha256:' + 'a'.repeat(64),
    description: 'Change one visible guidance item.',
    authorityChange: 'unchanged' as const,
  };
  const commonLineage = {
    schemaVersion: 'missionbraid.dev/checkpoint-replay/v1' as const,
    replayId,
    lineageId: `checkpoint-replay-lineage-${mode}-fixture`,
    missionId,
    contractId: 'contract-app-fixture',
    profileId: 'profile-app-fixture',
    parentAttemptId: 'attempt-source',
    parentBranchId,
    childBranchId: branchId,
    childWorkspaceKey: `workspace-${mode}-fixture`,
    parentCheckpointId: checkpointId,
    intervention,
    interventionArtifact: {
      artifactId: 'artifact-' + 'a'.repeat(64),
      contentDigest: 'sha256:' + 'a'.repeat(64),
      fidelity: 'exact-replay-safe' as const,
      evidenceRefs: ['fixture'],
      targetRef: intervention.targetRef,
    },
    inheritedExternalEffectFrontier: [],
    externalEffectDecisions: [],
    createdAt: '2026-08-24T03:00:00.000Z',
  };
  const plan = {
    schemaVersion: 'missionbraid.dev/checkpoint-operation/v1' as const,
    mode,
    planId: `checkpoint-${mode}-plan-fixture`,
    parentCheckpointId: checkpointId,
    parentBranchId,
    inheritedExternalEffectFrontier: [],
    semantics: {
      createsBranch: true,
      producesNewEvidence: true,
      modelExecution: mode === 'cached-replay' ? ('cached' as const) : ('resampled' as const),
      toolExecution: mode === 'cached-replay' ? ('cached' as const) : ('none' as const),
      workspaceUse: 'isolated-read-only' as const,
      sourceHistory: 'immutable' as const,
    },
    childBranchId: branchId,
    intervention,
    isolatedWorktree: {
      worktreeId: `worktree-${mode}-fixture`,
      workspaceKey: `workspace-${mode}-fixture`,
      absolutePath: `/tmp/${mode}-fixture`,
      isolationMechanism: 'copy-on-write' as const,
      baselineWorkspaceDigest: 'workspace-digest',
      evidenceRefs: ['fixture'],
    },
    externalEffectDecisions: [],
  };
  return {
    replayId,
    mode,
    phase: 'completed',
    lineage:
      mode === 'cached-replay'
        ? {
            ...commonLineage,
            mode,
            sourceFuture: {
              schemaVersion: 'missionbraid.dev/checkpoint-replay-source/v1',
              checkpointId,
              sourceBranchId: parentBranchId,
              sourceEventPrefix: { throughSeq: 1, headHash: 'head-hash' },
              evidence: [],
              bundleId: 'cached-source-fixture',
              manifestDigest: 'sha256:' + 'b'.repeat(64),
            },
          }
        : {
            ...commonLineage,
            mode,
            cachedContext: {
              schemaVersion: 'missionbraid.dev/checkpoint-replay-source/v1',
              checkpointId,
              contextDigest: 'sha256:' + 'c'.repeat(64),
              artifactRefs: [],
              targetDigests: [],
              evidenceRefs: ['fixture'],
              bundleId: 'cached-context-fixture',
              manifestDigest: 'sha256:' + 'd'.repeat(64),
            },
          },
    plan,
    events: [],
    modelEvidence: [],
  };
}

function projection(missionId: string, status: MissionProjectionV1['status']): MissionProjectionV1 {
  const timestamp = '2026-08-24T03:00:00.000Z';
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    missionId,
    workspaceKey: 'workspace-app-fixture',
    rootBranchId: `branch-root-${missionId}`,
    title: 'App fixture Mission',
    status,
    contract: {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      contractId: 'contract-app-fixture',
      objective: 'Complete the app fixture.',
      acceptanceCriteria: [],
      createdAt: timestamp,
    },
    activeProfile: {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      profileId: 'profile-app-fixture',
      harness: 'codex',
      model: 'gpt-5.6-sol',
      capabilities: ['workspace-write'],
      configurationDigest: 'profile-digest',
    },
    lastSeq: 1,
    headHash: 'head-hash',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function timeline(missionId: string, kind: string, label: string): MissionTimelineEntry {
  return {
    seq: kind === 'mission.created' ? 1 : 2,
    occurredAt: '2026-08-24T03:00:00.000Z',
    recordedAt: '2026-08-24T03:00:00.000Z',
    category: kind === 'receipt.issued' ? 'receipt' : 'mission',
    kind,
    label,
    data: { missionId },
  };
}

function readyCatalog(): RuntimeCatalogEntry[] {
  return [
    {
      id: 'codex',
      displayName: 'Codex',
      status: 'ready-supported',
      support: 'supported',
      path: '/opt/bin/codex',
      version: '0.149.0',
      reason: 'Ready.',
      capabilities: ['workspace'],
      checkedAt: '2026-08-24T03:00:00.000Z',
    },
    {
      id: 'qoder',
      displayName: 'Qoder',
      status: 'ready-supported',
      support: 'supported',
      path: '/opt/bin/qodercli',
      version: '1.1.6',
      reason: 'Ready.',
      capabilities: ['workspace'],
      checkedAt: '2026-08-24T03:00:00.000Z',
    },
    {
      id: 'claude',
      displayName: 'Claude Code',
      status: 'ready-supported',
      support: 'supported',
      path: '/opt/bin/claude',
      version: '2.1.245',
      reason: 'Ready.',
      capabilities: ['workspace'],
      checkedAt: '2026-08-24T03:00:00.000Z',
    },
  ];
}

function threeRuntimeMissionInput(workspace: string): Record<string, unknown> {
  const input = missionInput(workspace);
  return {
    ...input,
    stages: [
      ...(input.stages as unknown[]),
      {
        stageId: 'claude-continuation',
        harness: 'claude',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'medium',
        permissionMode: 'bypassPermissions',
        injectionBudgetTokens: 1_600,
      },
    ],
  };
}

function missionInput(workspace: string): Record<string, unknown> {
  return {
    title: 'App fixture Mission',
    objective: 'Complete the app fixture.',
    workspace,
    constraints: ['Stay inside the disposable workspace.'],
    verifier: { executable: 'node', args: ['--test'], timeoutMs: 30_000 },
    stages: [
      {
        stageId: 'codex-primary',
        harness: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        permissionMode: 'workspace-write',
        injectionBudgetTokens: 1_600,
      },
      {
        stageId: 'qoder-continuation',
        harness: 'qoder',
        model: 'Qwen3.8-Max',
        reasoningEffort: 'medium',
        permissionMode: 'bypass_permissions',
        injectionBudgetTokens: 1_600,
      },
    ],
  };
}

async function createWorkspace(): Promise<{
  readonly root: string;
  readonly stateDir: string;
  readonly workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'missionbraid-app-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace);
  await mkdir(stateDir);
  await writeFile(join(workspace, 'README.md'), 'fixture\n');
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['add', 'README.md'], { cwd: workspace });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=MissionBraid',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: workspace },
  );
  return { root, stateDir, workspace };
}

function incrementingClock(): () => Date {
  let offset = 0;
  return () => new Date(Date.parse('2026-08-24T03:00:00.000Z') + offset++);
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms`);
}

async function readSseEvent(response: Response, timeoutMs = 2_000): Promise<string> {
  if (response.body === null) throw new Error('SSE response did not expose a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Timed out reading SSE event')), remaining),
        ),
      ]);
      if (result.done) break;
      content += decoder.decode(result.value, { stream: true });
      const boundary = content.indexOf('\n\n');
      if (boundary >= 0) return content.slice(0, boundary);
    }
    throw new Error('SSE stream ended before an event was received');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
