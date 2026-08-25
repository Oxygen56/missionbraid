import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from './adapters/codex.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { QoderAdapter } from './adapters/qoder.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type EventV1,
  type JsonValue,
  type WorkspaceFenceV1,
} from './domain.js';
import { classifyRuntimeOutputFailure, MissionEngine } from './engine.js';
import { createMissionSpecSnapshot, loadMissionSpec } from './spec.js';
import { hashPayload, MissionStore } from './store.js';
import { snapshotGitWorkspace } from './workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MissionEngine', () => {
  it('attributes Qoder provider code 118 to the runtime-account layer without retaining text', () => {
    expect(
      classifyRuntimeOutputFailure({
        runtime: 'qoder',
        sequence: 1,
        streamSequence: 1,
        stream: 'stdout',
        line: '{redacted}',
        receivedAt: '2026-08-24T00:00:00.000Z',
        value: { type: 'result', error_code: 118, errors: ['sensitive provider text'] },
      }),
    ).toEqual({
      classification: 'observed',
      layer: 'runtime-account',
      code: 'CREDIT_LIMIT',
      runtime: 'qoder',
      providerCode: 118,
    });
  });

  it.each(['inside', 'contains'] as const)(
    'refuses a controller state directory that %s the target workspace',
    async (relationship) => {
      const fixture = await createFixture('resume');
      const stateDir =
        relationship === 'inside' ? join(fixture.workspace, '.missionbraid') : fixture.root;
      const engine = new MissionEngine({
        stateDir,
        codexAdapter: new CodexAdapter({ command: fixture.codex }),
        qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      });
      try {
        await expect(
          engine.run(fixture.missionFile, { workspace: fixture.workspace }),
        ).rejects.toThrow('Controller state directory and target workspace must be disjoint');
      } finally {
        engine.close();
      }
    },
  );

  it('resumes the same Mission after a stopped Attempt and closes the original Contract', async () => {
    const fixture = await createFixture('resume');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const first = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
      expect(first.status).toBe('waiting');
      expect(await readFile(join(fixture.workspace, 'codex.txt'), 'utf8')).toBe('checkpoint\n');
      await rm(fixture.missionFile);

      const resumed = await engine.resume(first.missionId);
      expect(resumed.status).toBe('succeeded');
      expect(resumed.receipt).toMatchObject({ outcome: 'verified' });
      expect(resumed.receipt?.attemptIds).toHaveLength(2);
      expect(resumed.receipt?.handoffIds).toHaveLength(1);
      expect(resumed.receipt?.effects).toMatchObject([
        { status: 'confirmed', controlLevel: 'advisory' },
        { status: 'skipped', controlLevel: 'advisory' },
      ]);
      expect(resumed.receipt?.effectIds).toHaveLength(2);
      expect(resumed.receipt?.unresolvedItems).toEqual([]);
      expect(engine.status(first.missionId)).toMatchObject({
        chainValid: true,
        mission: { status: 'succeeded' },
      });
    } finally {
      engine.close();
    }
  });

  it('creates a durable pending Mission before any runtime is started', async () => {
    const fixture = await createFixture('handoff');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });

      expect(created).toMatchObject({ status: 'pending' });
      expect(engine.status(created.missionId)).toMatchObject({
        mission: { status: 'pending' },
        attempts: [],
        chainValid: true,
      });
      await expect(readFile(join(fixture.workspace, 'codex.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const completed = await engine.resume(created.missionId);
      expect(completed.status).toBe('succeeded');
      expect(completed.receipt?.outcome).toBe('verified');
    } finally {
      engine.close();
    }
  });

  it('runs Claude Code through the same Branch, Binding, Event IR, and Receipt path', async () => {
    const fixture = await createFixture('claude');
    const missionSource = await readFile(fixture.missionFile, 'utf8');
    await writeFile(
      fixture.missionFile,
      missionSource.replace('model: deepseek-v4-pro', 'model: claude-requested-model'),
      'utf8',
    );
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const result = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
      expect(result).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      expect(engine.status(result.missionId).attempts).toMatchObject([
        { harness: 'claude', status: 'succeeded' },
      ]);
      const runtimeEntries = engine
        .timeline(result.missionId)
        .filter((entry) => entry.kind === 'runtime.event');
      expect(runtimeEntries).toHaveLength(3);
      const runtimeData = runtimeEntries.map(
        (entry) =>
          entry.data as {
            runtimeEventId: string;
            semanticKind: string;
            sourceSequence: number;
            causalParentIds: string[];
          },
      );
      expect(runtimeData.map((event) => event.semanticKind)).toEqual([
        'session',
        'message',
        'turn',
      ]);
      expect(runtimeData.map((event) => event.sourceSequence)).toEqual([1, 2, 3]);
      expect(runtimeData.map((event) => event.causalParentIds)).toEqual([[], [], []]);
      const effectiveReports = engine
        .timeline(result.missionId)
        .filter((entry) => entry.kind === 'runtime.effective_profile_reported')
        .map((entry) => entry.data);
      expect(effectiveReports[0]).toMatchObject({
        requestedModel: 'claude-requested-model',
        observedModel: 'deepseek-v4-pro',
        modelOverride: true,
        permissionMode: 'dontAsk',
        tools: ['Read', 'Write'],
        skills: ['grill-me'],
        mcpServers: ['filesystem (connected)'],
        runtimeVersion: '2.1.245',
      });
      expect(effectiveReports).toContainEqual(
        expect.objectContaining({ contextWindowTokens: 131_072, costUsd: 0.01 }),
      );
      expect(result.receipt?.rootBranchId).toMatch(/^branch-root-/);

      const stableRuntimeIdentity = runtimeData.map((event) => ({
        runtimeEventId: event.runtimeEventId,
        sourceSequence: event.sourceSequence,
        causalParentIds: event.causalParentIds,
      }));
      engine.close();
      const reopened = new MissionEngine({
        stateDir: fixture.stateDir,
        codexAdapter: new CodexAdapter({ command: fixture.codex }),
        qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
        claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
      });
      try {
        expect(
          reopened
            .timeline(result.missionId)
            .filter((entry) => entry.kind === 'runtime.event')
            .map((entry) => {
              const data = entry.data as {
                runtimeEventId: string;
                sourceSequence: number;
                causalParentIds: string[];
              };
              return {
                runtimeEventId: data.runtimeEventId,
                sourceSequence: data.sourceSequence,
                causalParentIds: data.causalParentIds,
              };
            }),
        ).toEqual(stableRuntimeIdentity);
      } finally {
        reopened.close();
      }
    } finally {
      engine.close();
    }
  });

  it('reopens an accepted command and reaches a Receipt without another user submission', async () => {
    const fixture = await createFixture('claude');
    const adapters = () => ({
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    const creator = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    const created = await creator.create(fixture.missionFile, { workspace: fixture.workspace });
    const accepted = await creator.acceptCommand(created.missionId, 'resume', 'restart-proof');
    creator.close();

    const recovered = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    try {
      const claimed = recovered.claimNextCommand('supervisor-after-restart');
      expect(claimed).toMatchObject({ commandId: accepted.commandId, status: 'dispatching' });
      const result = await recovered.executeCommand(accepted.commandId);
      expect(result).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      expect(recovered.command(accepted.commandId)?.status).toBe('completed');
      expect(recovered.status(created.missionId)).toMatchObject({
        chainValid: true,
        mission: { status: 'succeeded', rootBranchId: result.receipt?.rootBranchId },
      });
    } finally {
      recovered.close();
    }
  });

  it('keeps Profile Definition identity stable while Runtime snapshots change', async () => {
    const fixture = await createFixture('claude');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const first = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      const firstProfile = engine.status(first.missionId).mission.activeProfile;
      const source = await readFile(fixture.claude, 'utf8');
      await writeFile(fixture.claude, source.replace('2.1.245', '2.1.246'), 'utf8');
      const second = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      const secondProfile = engine.status(second.missionId).mission.activeProfile;

      expect(firstProfile.definition?.definitionId).toBe(secondProfile.definition?.definitionId);
      expect(firstProfile.profileId).not.toBe(secondProfile.profileId);
      expect(firstProfile.runtimeVersion).toBe('2.1.245');
      expect(secondProfile.runtimeVersion).toBe('2.1.246');
      expect(firstProfile.catalogObservation?.observationId).not.toBe(
        secondProfile.catalogObservation?.observationId,
      );
    } finally {
      engine.close();
    }
  });

  it('verifies the original Kernel snapshot after the Mission YAML is replaced', async () => {
    const fixture = await createFixture('resume');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const first = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
      expect(first.status).toBe('waiting');
      await writeFile(
        fixture.missionFile,
        'schemaVersion: attacker.example/mission/v99\nobjective: changed\n',
      );

      const verified = await engine.verify(first.missionId);

      expect(verified.status).toBe('succeeded');
      expect(verified.receipt).toMatchObject({ outcome: 'verified' });
      expect(verified.verificationResults).toMatchObject([{ passed: true }]);
    } finally {
      engine.close();
    }
  });

  it('refuses to hand off when the workspace diverges from the latest checkpoint', async () => {
    const fixture = await createFixture('resume');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const first = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
      expect(first.status).toBe('waiting');
      await writeFile(join(fixture.workspace, 'unrecorded.txt'), 'external mutation\n');

      const resumed = await engine.resume(first.missionId);

      expect(resumed).toMatchObject({
        status: 'waiting',
        waitingReason: 'Workspace diverged after the latest checkpoint',
      });
      expect(engine.status(first.missionId).attempts).toHaveLength(1);
    } finally {
      engine.close();
    }
  });

  it('hands an interrupted source Attempt to a second runtime with provenance and a Receipt', async () => {
    const fixture = await createFixture('handoff');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const result = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
      expect(result.status).toBe('succeeded');
      expect(result.receipt).toMatchObject({ outcome: 'verified' });
      expect(result.receipt?.rootBranchId).toMatch(/^branch-root-/);
      expect(result.receipt?.attemptIds).toHaveLength(2);
      expect(result.receipt?.handoffIds).toHaveLength(1);
      const provenance = JSON.parse(
        await readFile(
          join(fixture.stateDir, 'missions', result.missionId, 'provenance.json'),
          'utf8',
        ),
      ) as { stages: Array<{ harness: string; status: string }> };
      expect(provenance.stages).toMatchObject([
        { harness: 'codex', status: 'handed_off' },
        { harness: 'qoder', status: 'succeeded' },
      ]);
      expect(engine.timeline(result.missionId).map((entry) => entry.kind)).toEqual(
        expect.arrayContaining([
          'mission.created',
          'attempt.started',
          'checkpoint.created',
          'handoff.prepared',
          'handoff.acknowledged',
          'verification.completed',
          'receipt.issued',
        ]),
      );
      expect(
        engine.timeline(result.missionId).some((entry) => entry.kind === 'mission.spec_snapshot'),
      ).toBe(false);
      const audit = new MissionStore(join(fixture.stateDir, 'kernel.sqlite'));
      try {
        const events = audit.listEvents(result.missionId);
        const branch = events.find((event) => event.type === 'branch.created');
        expect(branch?.type === 'branch.created' ? branch.payload.branch.branchId : undefined).toBe(
          result.receipt?.rootBranchId,
        );
        const bindings = events.filter((event) => event.type === 'attempt.bound');
        expect(bindings).toHaveLength(2);
        expect(
          bindings.every(
            (event) =>
              event.type === 'attempt.bound' &&
              event.payload.binding.branchId === result.receipt?.rootBranchId,
          ),
        ).toBe(true);
        const runtimeEvents = events.filter((event) => event.type === 'runtime.event');
        expect(runtimeEvents).toHaveLength(2);
        expect(
          runtimeEvents.map((event) =>
            event.type === 'runtime.event'
              ? {
                  harness: event.payload.event.sourceHarness,
                  sourceSequence: event.payload.event.sourceSequence,
                  artifact: event.payload.event.nativeArtifact.relativePath,
                }
              : undefined,
          ),
        ).toMatchObject([
          { harness: 'codex', sourceSequence: 1 },
          { harness: 'qoder', sourceSequence: 1 },
        ]);
        for (const event of runtimeEvents) {
          if (event.type !== 'runtime.event') continue;
          const artifact = await readFile(
            join(fixture.stateDir, 'artifacts', event.payload.event.nativeArtifact.relativePath),
            'utf8',
          );
          expect(hashPayload(JSON.parse(artifact) as unknown)).toBeTruthy();
        }
        expect(audit.verifyEventChain(result.missionId).valid).toBe(true);
      } finally {
        audit.close();
      }
    } finally {
      engine.close();
    }
  });

  it('recovers a stopped runtime after controller loss and continues from its persisted checkpoint Capsule', async () => {
    const fixture = await createFixture('controller-crash');
    const baseline = snapshotGitWorkspace(fixture.workspace);
    const crashedController = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      now: () => new Date('2020-01-01T00:00:00.000Z'),
    });
    const controllerOutcome = crashedController
      .run(fixture.missionFile, { workspace: fixture.workspace })
      .then(
        (result) => result,
        (error: unknown) => error,
      );
    let runtimePid: number | undefined;
    let recovery: MissionEngine | undefined;
    try {
      runtimePid = await waitForValue(async () => {
        try {
          const value = Number.parseInt(await readFile(fixture.runtimePidFile, 'utf8'), 10);
          return Number.isSafeInteger(value) && value > 0 ? value : undefined;
        } catch {
          return undefined;
        }
      });
      const missionId = await waitForValue(async () => crashedController.list()[0]?.missionId);
      expect(crashedController.status(missionId).activeProcess?.pid).toBe(runtimePid);
      expect(await readFile(join(fixture.workspace, 'codex.txt'), 'utf8')).toBe('checkpoint\n');

      crashedController.close();
      process.kill(runtimePid, 'SIGTERM');
      await waitForValue(async () => (processExistsForTest(runtimePid!) ? undefined : true));
      expect(await controllerOutcome).toBeInstanceOf(Error);

      recovery = new MissionEngine({
        stateDir: fixture.stateDir,
        codexAdapter: new CodexAdapter({ command: fixture.codex }),
        qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      });
      const resumed = await recovery.resume(missionId);

      expect(resumed.status).toBe('succeeded');
      expect(resumed.receipt?.handoffIds).toHaveLength(1);
      expect(resumed.receipt?.effects).toMatchObject([
        { status: 'confirmed' },
        { status: 'confirmed' },
      ]);
      const provenance = JSON.parse(
        await readFile(join(fixture.stateDir, 'missions', missionId, 'provenance.json'), 'utf8'),
      ) as {
        stages: Array<{
          checkpointId: string;
          harness: string;
          status: string;
          origin: string;
          beforeWorkspaceDigest: string;
          afterWorkspaceDigest: string;
          changedPaths: Array<{ path: string }>;
        }>;
      };
      expect(provenance.stages).toMatchObject([
        {
          harness: 'codex',
          status: 'handed_off',
          origin: 'controller-recovery',
          beforeWorkspaceDigest: baseline.workspaceDigest,
          changedPaths: [{ path: 'codex.txt' }],
        },
        { harness: 'qoder', status: 'succeeded', origin: 'runtime-completion' },
      ]);
      expect(provenance.stages[1]?.beforeWorkspaceDigest).toBe(
        provenance.stages[0]?.afterWorkspaceDigest,
      );
      expect(provenance.stages.every((stage) => stage.checkpointId.length > 0)).toBe(true);
    } finally {
      if (runtimePid !== undefined && processExistsForTest(runtimePid)) {
        process.kill(runtimePid, 'SIGKILL');
      }
      recovery?.close();
    }
  });

  it('fails closed for a legacy dangling Attempt without a persisted before snapshot', async () => {
    const fixture = await createFixture('controller-crash');
    const missionId = seedLegacyDanglingMission(fixture);
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      await expect(engine.resume(missionId)).rejects.toThrow(
        'persisted before snapshot is missing',
      );
      expect(engine.status(missionId).attempts).toMatchObject([{ status: 'running' }]);
    } finally {
      engine.close();
    }
  });
});

async function createFixture(mode: 'resume' | 'handoff' | 'controller-crash' | 'claude'): Promise<{
  root: string;
  workspace: string;
  stateDir: string;
  missionFile: string;
  codex: string;
  qoder: string;
  claude: string;
  runtimePidFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'missionbraid-engine-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const source = join(root, 'mission-source');
  const bin = join(root, 'bin');
  const stateDir = join(source, '.missionbraid');
  await mkdir(workspace);
  await mkdir(source);
  await mkdir(bin);
  const runtimePidFile = join(root, 'runtime.pid');
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

  const codex = join(bin, 'codex');
  await executable(
    codex,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('codex-cli 1.2.3'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const checkpoint = join(process.cwd(), 'codex.txt');
  if (${JSON.stringify(mode)} === 'controller-crash') {
    if (existsSync(checkpoint)) {
      const ack = prompt.match(/^MISSIONBRAID_ACK (.+)$/m)?.[0];
      if (ack) console.log(JSON.stringify({ type: 'assistant', text: ack }));
      writeFileSync(join(process.cwd(), 'done.txt'), 'checkpoint-complete\\n');
      process.exit(0);
    }
    writeFileSync(checkpoint, 'checkpoint\\n');
    writeFileSync(${JSON.stringify(runtimePidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (${JSON.stringify(mode)} === 'resume' && existsSync(checkpoint)) {
    const ack = prompt.match(/^MISSIONBRAID_ACK (.+)$/m)?.[0];
    if (ack) console.log(JSON.stringify({ type: 'assistant', text: ack }));
	    setTimeout(() => process.exit(0), 120);
    return;
  }
	  writeFileSync(checkpoint, 'checkpoint\\n');
	  if (${JSON.stringify(mode)} === 'resume') writeFileSync(join(process.cwd(), 'done.txt'), 'checkpoint-complete\\n');
  console.log(JSON.stringify({ type: 'assistant', text: 'meaningful checkpoint created' }));
  process.exit(7);
});
`,
  );
  const qoder = join(bin, 'qodercli');
  await executable(
    qoder,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('qodercli 4.5.6'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const ack = prompt.match(/^MISSIONBRAID_ACK (.+)$/m)?.[0];
  if (ack) console.log(JSON.stringify({ type: 'assistant', content: [{ text: ack }] }));
  setTimeout(() => { writeFileSync(join(process.cwd(), 'done.txt'), 'handed-off\\n'); process.exit(0); }, 1000);
});
`,
  );
  const claude = join(bin, 'claude');
  await executable(
    claude,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('2.1.245 (Claude Code)'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-fixture', model: 'deepseek-v4-pro', permissionMode: 'dontAsk', tools: ['Read', 'Write'], skills: ['grill-me'], mcp_servers: [{ name: 'filesystem', status: 'connected' }], claude_code_version: '2.1.245' }));
  writeFileSync(join(process.cwd(), 'claude.txt'), 'claude-complete\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'message-fixture', model: 'deepseek-v4-pro' }, session_id: 'session-fixture' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session-fixture', total_cost_usd: 0.01, modelUsage: { 'deepseek-v4-pro': { contextWindow: 131072 } } }));
});
`,
  );
  const verifier = join(source, 'verify.mjs');
  await writeFile(
    verifier,
    `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const workspace = process.env.MISSIONBRAID_TARGET_WORKSPACE;
const provenanceFile = process.env.PROVENANCE_FILE;
if (!workspace || !provenanceFile) process.exit(2);
if (${JSON.stringify(mode)} === 'claude') {
  if (readFileSync(join(workspace, 'claude.txt'), 'utf8') !== 'claude-complete\\n') process.exit(3);
  process.exit(0);
}
if (readFileSync(join(workspace, 'codex.txt'), 'utf8') !== 'checkpoint\\n') process.exit(3);
if (!existsSync(join(workspace, 'done.txt'))) process.exit(4);
const provenance = JSON.parse(readFileSync(provenanceFile, 'utf8'));
if (${JSON.stringify(mode)} !== 'resume') {
  if (provenance.stages.length !== 2) process.exit(5);
  if (provenance.stages[0].harness !== 'codex' || provenance.stages[0].status !== 'handed_off') process.exit(6);
  if (provenance.stages[1].harness !== 'qoder' || provenance.stages[1].status !== 'succeeded') process.exit(7);
}
`,
  );
  const missionFile = join(source, 'mission.yaml');
  const stages =
    mode === 'claude'
      ? `  - stageId: claude-primary
    profile:
      harness: claude
      model: deepseek-v4-pro
      reasoningEffort: medium
      permissionMode: dontAsk
      injectionBudgetTokens: 4000
    instruction: Complete the Claude fixture.
    onFailure: stop`
      : mode === 'resume'
        ? `  - stageId: codex-only
    profile:
      harness: codex
      model: default
      reasoningEffort: medium
      permissionMode: workspace-write
      injectionBudgetTokens: 4000
    instruction: Continue the fixture.
    onFailure: stop`
        : `  - stageId: codex-source
    profile:
      harness: codex
      model: default
      reasoningEffort: medium
      permissionMode: workspace-write
      injectionBudgetTokens: 4000
    instruction: Create the source checkpoint.
    onFailure: handoff
  - stageId: qoder-target
    profile:
      harness: qoder
      model: default
      reasoningEffort: medium
      permissionMode: bypass_permissions
      injectionBudgetTokens: 4000
    instruction: Acknowledge the capsule and finish the fixture.
    onFailure: stop`;
  await writeFile(
    missionFile,
    `schemaVersion: missionbraid.dev/mission/v1
title: Engine fixture
objective: Preserve a checkpoint and independently verify completion.
workspace: '\${WORKSPACE}'
constraints:
  - Stay inside the disposable workspace.
acceptanceCriteria:
  - id: fixture
    description: The source checkpoint and final result exist.
    verifier:
      kind: command
      executable: node
      args: [verify.mjs]
      cwd: '\${MISSION_FILE_DIR}'
      timeoutMs: 5000
attemptPlan:
${stages}
`,
  );
  return { root, workspace, stateDir, missionFile, codex, qoder, claude, runtimePidFile };
}

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
}

async function waitForValue<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms`);
}

function processExistsForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function seedLegacyDanglingMission(fixture: {
  readonly workspace: string;
  readonly stateDir: string;
  readonly missionFile: string;
}): string {
  const missionId = 'mission-legacy-dangling';
  const attemptId = 'attempt-legacy-dangling';
  const workspaceKey = 'workspace-legacy-dangling';
  const profileId = 'profile-legacy-codex';
  const timestamp = '2026-08-24T00:00:00.000Z';
  const spec = loadMissionSpec(fixture.missionFile, { workspace: fixture.workspace });
  const specSnapshot = createMissionSpecSnapshot(spec);
  const store = new MissionStore(join(fixture.stateDir, 'kernel.sqlite'));
  const lease = store.acquireWorkspaceLease(workspaceKey, 'legacy-seeder');
  const fence: WorkspaceFenceV1 = {
    workspaceKey,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  };
  let event = 0;
  const append = (candidate: Omit<EventV1, 'eventId' | 'occurredAt'>): void => {
    event += 1;
    store.appendEvent(
      { ...candidate, eventId: `event-legacy-${String(event)}`, occurredAt: timestamp } as EventV1,
      fence,
    );
  };
  try {
    store.createMission(
      {
        eventId: 'event-legacy-created',
        occurredAt: timestamp,
        mission: {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          missionId,
          title: 'Legacy dangling fixture',
          workspaceKey,
          contractId: 'contract-legacy-dangling',
          initialProfileId: profileId,
          rootBranchId: 'branch-root-legacy-dangling',
          status: 'pending',
          createdAt: timestamp,
        },
        contract: {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          contractId: 'contract-legacy-dangling',
          objective: spec.objective,
          acceptanceCriteria: [],
          createdAt: timestamp,
        },
        profile: {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          profileId,
          harness: 'codex',
          model: 'default',
          capabilities: ['workspace-write'],
          configurationDigest: 'legacy-profile-configuration',
        },
      },
      fence,
    );
    append({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      missionId,
      type: 'runtime.observation',
      payload: {
        kind: 'mission.spec_snapshot',
        data: {
          snapshot: specSnapshot,
          snapshotHash: hashPayload(specSnapshot),
          provenance: { sourceFile: spec.sourceFile },
        } as unknown as JsonValue,
      },
    });
    append({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      missionId,
      attemptId,
      type: 'runtime.observation',
      payload: {
        kind: 'attempt.plan',
        data: {
          attemptId,
          stageId: spec.attemptPlan[0]!.stageId,
          harness: 'codex',
          profileId,
        },
      },
    });
    append({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      missionId,
      attemptId,
      type: 'effect.recorded',
      payload: {
        effect: {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          effectId: `effect-${attemptId}`,
          missionId,
          attemptId,
          kind: 'workspace.stage_mutation',
          resourceKey: `workspace-stage:${spec.attemptPlan[0]!.stageId}`,
          controlLevel: 'advisory',
          status: 'intended',
          evidenceRefs: [],
          createdAt: timestamp,
        },
      },
    });
    append({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      missionId,
      attemptId,
      type: 'attempt.started',
      payload: {
        attempt: {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          attemptId,
          missionId,
          branchId: 'branch-root-legacy-dangling',
          profileId,
          stageId: spec.attemptPlan[0]!.stageId,
          status: 'running',
          startedAt: timestamp,
        },
      },
    });
    append({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      missionId,
      attemptId,
      type: 'runtime.observation',
      payload: {
        kind: 'runtime.process_started',
        data: {
          attemptId,
          stageId: spec.attemptPlan[0]!.stageId,
          harness: 'codex',
          pid: 2_147_483_647,
        },
      },
    });
  } finally {
    store.releaseWorkspaceLease(fence);
    store.close();
  }
  return missionId;
}
