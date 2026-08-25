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
  type JsonValue,
  type MissionCommandActionV1,
  type MissionCommandV1,
  type MissionProjectionV1,
} from './domain.js';
import type { ExternalEffectOutcome } from './external-effect.js';
import type {
  MissionCreationResult,
  MissionExecutionResult,
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

  it('keeps the app bound to loopback hosts', async () => {
    await expect(startMissionBraidApp({ host: '0.0.0.0', port: 0 })).rejects.toThrow('loopback');
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
    return {
      schemaVersion: 'missionbraid.dev/composite-checkpoint/v1',
      checkpointId: 'checkpoint-app-fixture',
      manifestHash: 'sha256:checkpoint-app-fixture',
      source: {
        missionId,
        branchId: `branch-root-${missionId}`,
        attemptId: requestedAttemptId ?? 'attempt-latest',
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
      components: [],
      capturedAt: '2026-08-24T03:00:00.000Z',
    };
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
