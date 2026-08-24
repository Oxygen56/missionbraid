import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startMissionBraidApp, type AppEngine } from './app.js';
import { DOMAIN_SCHEMA_VERSION, type MissionProjectionV1 } from './domain.js';
import type {
  MissionCreationResult,
  MissionExecutionResult,
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
      expect(runtimeBody.runtimes.map((entry) => entry.id)).toEqual(['codex', 'qoder']);
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

  it('keeps the app bound to loopback hosts', async () => {
    await expect(startMissionBraidApp({ host: '0.0.0.0', port: 0 })).rejects.toThrow('loopback');
  });
});

class FakeEngineState {
  readonly missions = new Map<string, MissionProjectionV1>();
  readonly timelines = new Map<string, MissionTimelineEntry[]>();
  createGate?: Promise<void>;
  onCreateStarted?: () => void;
  resumeCalls = 0;
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
  ];
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
