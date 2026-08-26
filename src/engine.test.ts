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
import { planExecution, type ExecutionPlannerInputV1 } from './execution-planner.js';
import type { QueryableEffectTarget } from './external-effect.js';
import { createMissionSpecSnapshot, loadMissionSpec } from './spec.js';
import { hashPayload, MissionStore } from './store.js';
import { createStageWorkspaceDelta, snapshotGitWorkspace } from './workspace.js';

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

  it('rejects an oversized initial controller prompt before starting the native Runtime', async () => {
    const fixture = await createFixture('claude');
    const missionSource = await readFile(fixture.missionFile, 'utf8');
    await writeFile(
      fixture.missionFile,
      missionSource.replace('injectionBudgetTokens: 4000', 'injectionBudgetTokens: 1'),
      'utf8',
    );
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });

      await expect(engine.resume(created.missionId)).rejects.toThrow(
        /Controller prompt is \d+ bytes, above the 4-byte Runtime Profile budget/,
      );

      const timeline = engine.timeline(created.missionId);
      expect(
        timeline.find((entry) => entry.kind === 'context.prompt_budget_exceeded'),
      ).toMatchObject({
        data: {
          stageId: 'claude-primary',
          promptBytes: expect.any(Number),
          promptBudgetBytes: 4,
          contextFactId: null,
        },
      });
      expect(timeline.some((entry) => entry.kind === 'runtime.process_started')).toBe(false);
      await expect(readFile(join(fixture.workspace, 'claude.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      engine.close();
    }
  });

  it('versions the Mission Plan when a Contract requirement changes', async () => {
    const fixture = await createFixture('resume');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      const before = engine.missionPlan(created.missionId);
      const contract = {
        ...before.contractRevision.contract,
        objective: 'Preserve a changed checkpoint and independently verify completion.',
      };
      const requirements = before.contractRevision.requirements.map((requirement) =>
        requirement.requirementId === 'objective'
          ? { ...requirement, statement: contract.objective }
          : requirement,
      );
      const revised = await engine.reviseMissionContract(created.missionId, {
        contract,
        requirements,
        reason: 'User changed the Mission objective before execution.',
        evidenceRefs: ['test:contract-revision'],
      });
      const after = engine.missionPlan(created.missionId);
      expect(revised.contractRevision.revisionNumber).toBe(2);
      expect(after.contractRevision.contractRevisionId).toBe(
        revised.contractRevision.contractRevisionId,
      );
      expect(after.planRevision.parentPlanRevisionId).toBe(before.planRevision.planRevisionId);
      expect(after.planRevision.contractRevisionId).toBe(
        revised.contractRevision.contractRevisionId,
      );
      expect(revised.invalidation.changedRequirementIds).toEqual(['objective']);
    } finally {
      engine.close();
    }
  });

  it('rejects Contract revisions that change the executable acceptance contract', async () => {
    const fixture = await createFixture('resume');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      const before = engine.missionPlan(created.missionId);
      const criterion = before.contractRevision.contract.acceptanceCriteria[0]!;

      await expect(
        engine.reviseMissionContract(created.missionId, {
          contract: {
            ...before.contractRevision.contract,
            acceptanceCriteria: [
              {
                ...criterion,
                verifier: {
                  ...criterion.verifier,
                  configuration: { ...criterion.verifier.configuration, timeoutMs: 1 },
                },
              },
            ],
          },
          requirements: before.contractRevision.requirements.map((requirement) =>
            requirement.requirementId === `acceptance-${criterion.criterionId}`
              ? { ...requirement, statement: 'Changed executable acceptance configuration.' }
              : requirement,
          ),
          reason: 'Attempt to replace the executable verifier in-place.',
          evidenceRefs: ['test:unsupported-verifier-revision'],
        }),
      ).rejects.toThrow(/executable acceptance criteria/i);

      await expect(
        engine.reviseMissionContract(created.missionId, {
          contract: {
            ...before.contractRevision.contract,
            acceptanceCriteria: [
              ...before.contractRevision.contract.acceptanceCriteria,
              {
                criterionId: 'new-criterion',
                description: 'A new executable criterion.',
                verifier: { kind: 'command', configuration: { command: 'new-verifier' } },
              },
            ],
          },
          requirements: before.contractRevision.requirements,
          reason: 'Attempt to add an executable criterion in-place.',
          evidenceRefs: ['test:unsupported-criterion-revision'],
        }),
      ).rejects.toThrow(/executable acceptance criteria/i);

      expect(engine.missionPlan(created.missionId).contractRevision.contractRevisionId).toBe(
        before.contractRevision.contractRevisionId,
      );
    } finally {
      engine.close();
    }
  });

  it('projects Mission Plan node readiness from persisted Attempts and Checkpoints', async () => {
    const fixture = await createFixture('handoff');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      expect(engine.missionPlanRuntime(created.missionId)).toMatchObject({
        readyNodeIds: ['codex-source'],
        runningNodeIds: [],
        completedNodeIds: [],
      });
      const first = await engine.resume(created.missionId);
      expect(first.status).toBe('succeeded');
      const projection = engine.missionPlanRuntime(created.missionId);
      expect(projection.completedNodeIds).toContain('codex-source');
      expect(projection.completedNodeIds).toContain('qoder-target');
      expect(projection.authority).toBe('derived-plan-evidence-only');
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

  it('verifies immediately after the preferred Runtime succeeds without starting a fallback', async () => {
    const fixture = await createFixture('claude');
    const missionSource = await readFile(fixture.missionFile, 'utf8');
    await writeFile(
      fixture.missionFile,
      missionSource.replace(
        '    onFailure: stop',
        `    onFailure: handoff
  - stageId: qoder-fallback
    profile:
      harness: qoder
      model: default
      reasoningEffort: medium
      permissionMode: bypass_permissions
      injectionBudgetTokens: 4000
    instruction: Run only if the preferred Runtime fails.
    onFailure: stop`,
      ),
      'utf8',
    );
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const result = await engine.run(fixture.missionFile, { workspace: fixture.workspace });

      expect(result).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      expect(engine.status(result.missionId).attempts).toMatchObject([
        { harness: 'claude', status: 'succeeded' },
      ]);
      expect(
        engine
          .timeline(result.missionId)
          .some((entry) => entry.kind === 'execution-planner.decision'),
      ).toBe(false);
      await expect(readFile(join(fixture.workspace, 'done.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      engine.close();
    }
  });

  it('starts an eligible fallback through the deterministic planner when the initial Runtime is unavailable', async () => {
    const fixture = await createFixture('claude');
    const missionSource = await readFile(fixture.missionFile, 'utf8');
    await writeFile(
      fixture.missionFile,
      missionSource.replace(
        /attemptPlan:\n[\s\S]*$/,
        `attemptPlan:
  - stageId: codex-unavailable
    profile:
      harness: codex
      model: default
      reasoningEffort: medium
      permissionMode: workspace-write
      injectionBudgetTokens: 4000
    instruction: Use the preferred Runtime when it is available.
    onFailure: handoff
  - stageId: claude-fallback
    profile:
      harness: claude
      model: deepseek-v4-pro
      reasoningEffort: medium
      permissionMode: acceptEdits
      injectionBudgetTokens: 4000
    instruction: Complete the fixture after deterministic fallback selection.
    onFailure: stop
`,
      ),
      'utf8',
    );
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: join(fixture.root, 'bin', 'missing-codex') }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const result = await engine.run(fixture.missionFile, { workspace: fixture.workspace });

      expect(result).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      expect(engine.status(result.missionId).attempts).toMatchObject([
        { harness: 'claude', status: 'succeeded' },
      ]);
      const plannerEntry = engine
        .timeline(result.missionId)
        .find((entry) => entry.kind === 'execution-planner.decision');
      const data = plannerEntry?.data as unknown as {
        trigger: { code: string };
        decision: {
          binding: { action: string; selectedHarness: string };
          filter: { eligibleProfileIds: string[] };
          rank: unknown[];
          handoffCompatibility: Array<{ overall: string }>;
        };
        sourceCompositeCheckpoint: unknown;
      };
      expect(data).toMatchObject({
        trigger: { code: 'RUNTIME_UNAVAILABLE' },
        decision: {
          binding: { action: 'start', selectedHarness: 'claude' },
          filter: { eligibleProfileIds: [expect.any(String)] },
        },
        sourceCompositeCheckpoint: null,
      });
      expect(data.decision.rank).toHaveLength(1);
      expect(data.decision.handoffCompatibility).toMatchObject([{ overall: 'exact' }]);
    } finally {
      engine.close();
    }
  });

  it('persists and applies an eligible preselected fallback Profile with its reason', async () => {
    const fixture = await createFixture('planner-credit');
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      expect(engine.executionPlannerCandidates(created.missionId)).toMatchObject([
        { stageId: 'qoder-primary', profileDefinition: { harness: 'qoder' } },
        {
          stageId: 'claude-read-only-rejected',
          profileDefinition: { harness: 'claude' },
        },
        { stageId: 'codex-credit-fallback', profileDefinition: { harness: 'codex' } },
      ]);
      expect(
        engine.executionPlannerCandidates(created.missionId).every((candidate) => {
          const fields = candidate as unknown as Record<string, unknown>;
          return fields.instruction === undefined && fields.prompt === undefined;
        }),
      ).toBe(true);
      const override = await engine.setExecutionPlannerOverride(created.missionId, {
        stageId: 'codex-credit-fallback',
        reason: 'Use the approved workspace-writing fallback Profile.',
      });

      expect(engine.executionPlannerOverride(created.missionId)).toEqual(override);
      const result = await engine.resume(created.missionId);
      expect(result).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      const plannerData = engine
        .timeline(created.missionId)
        .find((entry) => entry.kind === 'execution-planner.decision')?.data as unknown as {
        manualOverrideRequest: { overrideId: string; reason: string };
        decision: {
          manualOverride: { status: string; reason: string };
          binding: { reason: string; selectedHarness: string };
        };
      };
      expect(plannerData).toMatchObject({
        manualOverrideRequest: {
          overrideId: override.overrideId,
          reason: override.reason,
        },
        decision: {
          manualOverride: { status: 'applied', reason: override.reason },
          binding: { reason: 'manual_override', selectedHarness: 'codex' },
        },
      });
    } finally {
      engine.close();
    }
  });

  it('records an ineligible manual override rejection, clears it durably, and replans after restart', async () => {
    const fixture = await createFixture('planner-credit');
    const adapters = () => ({
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    const engine = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
    const override = await engine.setExecutionPlannerOverride(created.missionId, {
      stageId: 'claude-read-only-rejected',
      reason: 'Validate this explicitly requested read-only Profile.',
    });
    const blocked = await engine.resume(created.missionId);
    expect(blocked.status).toBe('waiting');
    const rejectedDecision = engine
      .timeline(created.missionId)
      .find((entry) => entry.kind === 'execution-planner.decision')?.data as unknown as {
      manualOverrideRequest: { overrideId: string };
      decision: {
        manualOverride: { status: string; reason: string };
        binding: { status: string; reason: string };
      };
    };
    expect(rejectedDecision).toMatchObject({
      manualOverrideRequest: { overrideId: override.overrideId },
      decision: {
        manualOverride: { status: 'rejected', reason: override.reason },
        binding: { status: 'blocked', reason: 'manual_override_rejected' },
      },
    });
    await engine.clearExecutionPlannerOverride(created.missionId, 'Return to automatic fallback.');
    expect(engine.executionPlannerOverride(created.missionId)).toBeUndefined();
    engine.close();

    const reopened = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    try {
      expect(reopened.executionPlannerOverride(created.missionId)).toBeUndefined();
      const resumed = await reopened.resume(created.missionId);
      expect(resumed).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      expect(reopened.status(created.missionId).attempts).toMatchObject([
        { harness: 'qoder', status: 'failed' },
        { harness: 'codex', status: 'succeeded' },
      ]);
      const decisions = reopened
        .timeline(created.missionId)
        .filter((entry) => entry.kind === 'execution-planner.decision');
      expect(decisions).toHaveLength(2);
      expect(decisions[1]?.data).toMatchObject({
        manualOverrideRequest: null,
        decision: {
          manualOverride: { status: 'none' },
          binding: { selectedHarness: 'codex' },
        },
      });
    } finally {
      reopened.close();
    }
  });

  it('creates a complete restorable Checkpoint from a stopped clean Attempt and restores it after restart', async () => {
    const fixture = await createFixture('claude');
    const adapters = () => ({
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    const engine = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    const result = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
    expect(result.status).toBe('succeeded');
    execFileSync('git', ['add', 'claude.txt'], { cwd: fixture.workspace });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=MissionBraid',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'agent revision boundary',
      ],
      { cwd: fixture.workspace },
    );
    const attemptId = result.receipt?.attemptIds?.[0];
    expect(attemptId).toBeDefined();
    const checkpoint = await engine.createCompositeCheckpoint(result.missionId, attemptId);
    expect(checkpoint).toMatchObject({
      source: {
        missionId: result.missionId,
        branchId: result.receipt?.branchId,
        attemptId,
      },
      workspace: {
        state: 'restorable-artifact',
        artifactRef: expect.stringMatching(/^git-commit:[0-9a-f]{40,64}$/),
        artifactDigest: expect.stringMatching(/^git-tree:[0-9a-f]{40,64}$/),
      },
      process: { status: 'stopped' },
      nativeSession: { status: 'unavailable', harness: 'claude' },
    });
    expect(new Set(checkpoint.components.map((component) => component.component)).size).toBe(12);
    expect(
      engine
        .timeline(result.missionId)
        .some(
          (entry) =>
            entry.kind === 'composite-checkpoint.created' &&
            entry.data !== null &&
            entry.data !== undefined &&
            !Array.isArray(entry.data) &&
            typeof entry.data === 'object' &&
            entry.data.checkpointId === checkpoint.checkpointId,
        ),
    ).toBe(true);
    engine.close();

    const reopened = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    try {
      expect(reopened.compositeCheckpoints(result.missionId)).toEqual([checkpoint]);
      expect(reopened.status(result.missionId).chainValid).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('executes a live native Harness only in child Branch B and issues a Branch-bound Receipt', async () => {
    const fixture = await createFixture('claude');
    await writeFile(
      join(fixture.workspace, 'verify.mjs'),
      await readFile(join(fixture.root, 'mission-source', 'verify.mjs'), 'utf8'),
      'utf8',
    );
    const missionSource = await readFile(fixture.missionFile, 'utf8');
    await writeFile(
      fixture.missionFile,
      missionSource.replace(/cwd:.*MISSION_FILE_DIR.*$/m, "cwd: '$" + "{WORKSPACE}'"),
      'utf8',
    );
    execFileSync('git', ['add', 'verify.mjs'], { cwd: fixture.workspace });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=MissionBraid',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'add branch-local verifier',
      ],
      { cwd: fixture.workspace },
    );
    const adapters = () => ({
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    const engine = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    const parent = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
    expect(parent.status).toBe('succeeded');
    execFileSync('git', ['add', 'claude.txt'], { cwd: fixture.workspace });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=MissionBraid',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'parent checkpoint boundary',
      ],
      { cwd: fixture.workspace },
    );
    const parentAttemptId = parent.receipt?.attemptIds?.[0];
    expect(parentAttemptId).toBeDefined();
    const checkpoint = await engine.createCompositeCheckpoint(parent.missionId, parentAttemptId);
    const sourceBeforeFork = snapshotGitWorkspace(fixture.workspace);

    await executable(
      fixture.claude,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--version') { console.log('2.1.245 (Claude Code)'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  writeFileSync('fork-result.txt', 'branch-b-only\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'fork-tool-1', name: 'write_file', input: { path: 'fork-result.txt' } }] } }));
  console.log(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fork-tool-1', content: 'write completed', is_error: false }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fork-session' }));
});
`,
    );
    const forked = await engine.executeFork(parent.missionId, {
      checkpointId: checkpoint.checkpointId,
      childBranchId: 'branch-b',
      intervention: {
        interventionId: 'intervention-guidance-b',
        kind: 'guidance',
        targetRef: 'stage:claude-primary',
        beforeDigest: 'sha256:parent-guidance',
        afterDigest: 'sha256:branch-b-guidance',
        description: 'Create one Branch-B-only evidence file while preserving the Contract.',
        authorityChange: 'unchanged',
      },
    });

    expect(forked.receipt).toMatchObject({
      branchId: 'branch-b',
      outcome: 'verified',
      unresolvedItems: [],
    });
    expect(forked.record.runtimeResult).toMatchObject({ status: 'completed' });
    expect(engine.branches(parent.missionId).map((branch) => branch.branchId)).toEqual(
      expect.arrayContaining([parent.receipt?.branchId, 'branch-b']),
    );
    expect(snapshotGitWorkspace(fixture.workspace)).toMatchObject({
      head: sourceBeforeFork.head,
      statusDigest: sourceBeforeFork.statusDigest,
      workspaceDigest: sourceBeforeFork.workspaceDigest,
    });
    await expect(
      readFile(join(fixture.workspace, 'fork-result.txt'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await readFile(join(forked.record.lineage.isolatedWorktreePath, 'fork-result.txt'), 'utf8'),
    ).toBe('branch-b-only\n');
    engine.close();

    const reopened = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    try {
      const recovered = await reopened.executionForks(parent.missionId);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        forkId: forked.record.forkId,
        phase: 'finished',
        lineage: { parentCheckpointId: checkpoint.checkpointId, childBranchId: 'branch-b' },
      });
      expect(reopened.status(parent.missionId)).toMatchObject({
        chainValid: true,
        mission: { receipt: { branchId: 'branch-b', outcome: 'verified' } },
      });
    } finally {
      reopened.close();
    }
  });

  it('binds a live Fork Runtime and deterministic verifier to the accepted Plan Contract revision without tracking controller state', async () => {
    const fixture = await createFixture('claude');
    const revisedObjective =
      'Preserve a checkpoint and prove the accepted Plan Contract revision inside the Fork.';
    await writeFile(
      join(fixture.workspace, 'verify.mjs'),
      `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const workspace = process.env.MISSIONBRAID_TARGET_WORKSPACE;
if (!workspace) process.exit(2);
const read = path => readFileSync(join(workspace, path), 'utf8');
if (read('claude.txt') !== 'claude-complete\\n') process.exit(3);
const controlPath = join(workspace, '.missionbraid', 'contract-revision.json');
if (!existsSync(controlPath)) process.exit(0);
const control = JSON.parse(readFileSync(controlPath, 'utf8'));
if (control.revisionNumber !== 2) process.exit(4);
if (control.requirements.find(item => item.requirementId === 'objective')?.statement !== ${JSON.stringify(revisedObjective)}) process.exit(5);
const declaration = JSON.parse(read('fork-result.txt'));
if (JSON.stringify(declaration) !== JSON.stringify(control)) process.exit(6);
`,
      'utf8',
    );
    const missionSource = await readFile(fixture.missionFile, 'utf8');
    const workspaceMissionSource = missionSource.replace(
      /cwd:.*MISSION_FILE_DIR.*$/m,
      "cwd: '${WORKSPACE}'",
    );
    await writeFile(
      fixture.missionFile,
      `${workspaceMissionSource}
  - stageId: claude-review
    profile:
      harness: claude
      model: deepseek-v4-pro
      reasoningEffort: medium
      permissionMode: dontAsk
      injectionBudgetTokens: 4000
    instruction: Review the declared Fork output.
    onFailure: stop
  - stageId: claude-join
    profile:
      harness: claude
      model: deepseek-v4-pro
      reasoningEffort: medium
      permissionMode: dontAsk
      injectionBudgetTokens: 4000
    instruction: Consolidate the declared Fork output.
    onFailure: stop
plan:
  nodes:
    - nodeId: fork-implementation
      kind: task
      title: Produce the Fork declaration
      requirementIds: [objective, constraint-1, acceptance-fixture]
      stageId: claude-primary
      acceptanceCriterionIds: [fixture]
      declaredOutputKeys: [fork-result.txt]
      requiredAuthorityScopes: [workspace]
    - nodeId: fork-review
      kind: task
      title: Review the Fork declaration
      requirementIds: [objective, constraint-1, acceptance-fixture]
      stageId: claude-review
      acceptanceCriterionIds: [fixture]
      declaredOutputKeys: [fork-review.txt]
      requiredAuthorityScopes: [workspace]
    - nodeId: fork-join
      kind: join
      title: Verify the Fork declaration
      requirementIds: [objective, constraint-1, acceptance-fixture]
      stageId: claude-join
      acceptanceCriterionIds: [fixture]
      declaredOutputKeys: [fork-result.txt]
      requiredAuthorityScopes: [workspace]
  edges:
    - fromNodeId: fork-implementation
      toNodeId: fork-join
      relation: join-input
      evidenceRefs: [test:fork-contract-revision]
    - fromNodeId: fork-review
      toNodeId: fork-join
      relation: join-input
      evidenceRefs: [test:fork-contract-revision]
`,
      'utf8',
    );
    execFileSync('git', ['add', 'verify.mjs'], { cwd: fixture.workspace });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=MissionBraid',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'add contract-aware fork verifier',
      ],
      { cwd: fixture.workspace },
    );

    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      const initial = engine.missionPlan(created.missionId);
      const revised = await engine.reviseMissionContract(created.missionId, {
        contract: { ...initial.contractRevision.contract, objective: revisedObjective },
        requirements: initial.contractRevision.requirements.map((requirement) =>
          requirement.requirementId === 'objective'
            ? { ...requirement, statement: revisedObjective }
            : requirement,
        ),
        reason: 'Accept the Contract revision exercised by the live Fork.',
        evidenceRefs: ['test:accepted-fork-contract-revision'],
      });
      expect(revised.contractRevision).toMatchObject({ revisionNumber: 2 });

      const parent = await engine.resume(created.missionId);
      expect(parent).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      execFileSync('git', ['add', 'claude.txt'], { cwd: fixture.workspace });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=MissionBraid',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'contract revision fork boundary',
        ],
        { cwd: fixture.workspace },
      );
      const parentAttemptId = parent.receipt?.attemptIds?.[0];
      expect(parentAttemptId).toBeDefined();
      const checkpoint = await engine.createCompositeCheckpoint(parent.missionId, parentAttemptId!);
      const expectedControl = {
        contractRevisionId: revised.contractRevision.contractRevisionId,
        revisionNumber: revised.contractRevision.revisionNumber,
        requirements: revised.contractRevision.requirements,
      };

      await executable(
        fixture.claude,
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('2.1.245 (Claude Code)'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  const control = JSON.parse(readFileSync(join(process.cwd(), '.missionbraid', 'contract-revision.json'), 'utf8'));
  writeFileSync(join(process.cwd(), 'fork-result.txt'), JSON.stringify(control) + '\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'fork-contract-tool', name: 'write_file', input: { path: 'fork-result.txt' } }] } }));
  console.log(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fork-contract-tool', content: 'write completed', is_error: false }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fork-contract-session' }));
});
`,
      );
      const forked = await engine.executeFork(parent.missionId, {
        checkpointId: checkpoint.checkpointId,
        childBranchId: 'branch-contract-revision',
        intervention: {
          interventionId: 'intervention-contract-revision',
          kind: 'guidance',
          targetRef: 'stage:claude-primary',
          beforeDigest: 'sha256:parent-contract-guidance',
          afterDigest: 'sha256:fork-contract-guidance',
          description: 'Read the accepted Contract revision and emit its declared output.',
          authorityChange: 'unchanged',
        },
      });

      expect(forked).toMatchObject({
        record: { runtimeResult: { status: 'completed' } },
        receipt: { outcome: 'verified', unresolvedItems: [] },
      });
      const childWorkspace = forked.record.lineage.isolatedWorktreePath;
      expect(
        JSON.parse(
          await readFile(join(childWorkspace, '.missionbraid', 'contract-revision.json'), 'utf8'),
        ),
      ).toEqual(expectedControl);
      expect(JSON.parse(await readFile(join(childWorkspace, 'fork-result.txt'), 'utf8'))).toEqual(
        expectedControl,
      );
      expect(
        createStageWorkspaceDelta(
          forked.record.baselineSnapshot!,
          forked.record.futureSnapshot!,
        ).changedPaths.map((change) => change.path),
      ).toEqual(['fork-result.txt']);
      expect(
        forked.record.futureSnapshot?.paths.some((path) => path.path.startsWith('.missionbraid/')),
      ).toBe(false);
      await expect(
        readFile(join(fixture.workspace, 'fork-result.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      engine.close();
    }
  });

  it('blocks a mutable Claude Profile-Rebound Fork until its native tool decision is persisted', async () => {
    const fixture = await createFixture('claude');
    const missionSource = await readFile(fixture.missionFile, 'utf8');
    await writeFile(
      join(fixture.workspace, 'verify.mjs'),
      await readFile(join(fixture.root, 'mission-source', 'verify.mjs'), 'utf8'),
      'utf8',
    );
    await writeFile(
      fixture.missionFile,
      missionSource
        .replace(
          `    instruction: Complete the Claude fixture.
    onFailure: stop`,
          `    instruction: Complete the Claude fixture.
    onFailure: stop
  - stageId: claude-gated-upgraded
    profile:
      harness: claude
      model: deepseek-v4-pro
      reasoningEffort: high
      permissionMode: dontAsk
      injectionBudgetTokens: 5000
    breakpoint: mutable-tools
    instruction: Execute one controller-gated Write in the isolated Fork.
    onFailure: stop`,
        )
        .replace(/cwd:.*MISSION_FILE_DIR.*$/m, "cwd: '$" + "{WORKSPACE}'"),
      'utf8',
    );
    execFileSync('git', ['add', 'verify.mjs'], { cwd: fixture.workspace });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=MissionBraid',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'add gated fork verifier',
      ],
      { cwd: fixture.workspace },
    );
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    const controller = new AbortController();
    let forkPromise: Promise<Awaited<ReturnType<typeof engine.executeFork>>> | undefined;
    try {
      const parent = await engine.run(fixture.missionFile, { workspace: fixture.workspace });
      expect(parent).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      execFileSync('git', ['add', 'claude.txt'], { cwd: fixture.workspace });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=MissionBraid',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'mutable fork checkpoint',
        ],
        { cwd: fixture.workspace },
      );
      const parentAttemptId = parent.receipt?.attemptIds?.[0];
      expect(parentAttemptId).toBeDefined();
      const checkpoint = await engine.createCompositeCheckpoint(parent.missionId, parentAttemptId!);
      const candidate = engine
        .executionPlannerCandidates(parent.missionId)
        .find((item) => item.stageId === 'claude-gated-upgraded');
      expect(candidate).toBeDefined();

      await executable(
        fixture.claude,
        `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('2.1.245 (Claude Code)'); process.exit(0); }
const settingsIndex = process.argv.indexOf('--settings');
if (settingsIndex < 0 || !process.argv[settingsIndex + 1]) process.exit(21);
const settings = JSON.parse(readFileSync(process.argv[settingsIndex + 1], 'utf8'));
const preCommand = settings.hooks.PreToolUse[0].hooks[0].command;
const postCommand = settings.hooks.PostToolUse[0].hooks[0].command;
const hookCwd = ${JSON.stringify(process.cwd())};
const toolInput = { file_path: 'fork-gated.txt', content: 'released\\n' };
const base = { session_id: 'fork-gated-session', tool_name: 'Write', tool_use_id: 'fork-gated-write', tool_input: toolInput };
const pre = JSON.parse(execFileSync('/bin/sh', ['-c', preCommand], {
  input: JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }),
  encoding: 'utf8',
  cwd: hookCwd,
}).trim());
if (pre.hookSpecificOutput?.permissionDecision !== 'allow') process.exit(22);
writeFileSync(join(process.cwd(), 'fork-gated.txt'), 'released\\n');
execFileSync('/bin/sh', ['-c', postCommand], {
  input: JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: { status: 'written' } }),
  encoding: 'utf8',
  cwd: hookCwd,
});
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fork-gated-session', model: 'deepseek-v4-pro', permissionMode: 'dontAsk', tools: ['Write'], claude_code_version: '2.1.245' }));
console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'fork-gated-write', name: 'Write', input: toolInput }] }, session_id: 'fork-gated-session' }));
console.log(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fork-gated-write', content: 'write completed', is_error: false }] }, session_id: 'fork-gated-session' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fork-gated-session', total_cost_usd: 0.01 }));
`,
      );

      forkPromise = engine.executeFork(
        parent.missionId,
        {
          checkpointId: checkpoint.checkpointId,
          stageId: candidate!.stageId,
          targetProfileDefinitionId: candidate!.profileDefinition.definitionId,
          childBranchId: 'branch-gated-profile-rebound',
          intervention: {
            interventionId: 'intervention-gated-profile-rebound',
            kind: 'guidance',
            targetRef: 'stage:claude-gated-upgraded',
            beforeDigest: 'sha256:source-guidance',
            afterDigest: 'sha256:upgraded-guidance',
            description: 'Run the upgraded Profile through one native gated Write.',
            authorityChange: 'unchanged',
          },
        },
        controller.signal,
      );
      let earlyForkError: unknown;
      void forkPromise.catch((error: unknown) => {
        earlyForkError = error;
      });
      const gate = await waitForValue(async () => {
        if (earlyForkError !== undefined) {
          const records = await engine.executionForks(parent.missionId);
          throw new Error(
            `Execution Fork failed before exposing its native tool gate: ${String(earlyForkError)}; ${JSON.stringify(records)}`,
          );
        }
        return (await engine.pendingToolGates(parent.missionId))[0];
      });
      const activeFork = await waitForValue(
        async () => (await engine.executionForks(parent.missionId))[0],
      );
      const gatedFile = join(activeFork.lineage.isolatedWorktreePath, 'fork-gated.txt');
      await expect(readFile(gatedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(gate).toMatchObject({
        attemptId: `fork-attempt-${activeFork.forkId}`,
        toolName: 'Write',
        controlLevel: 'enforced',
        scope: 'branch_local_workspace',
      });

      await engine.decideToolGate(parent.missionId, gate.attemptId, {
        gateId: gate.gateId,
        expectedRequestSha256: gate.requestSha256,
        decision: 'approve',
        reason: 'Integration test persists approval before dispatch.',
      });
      const forked = await forkPromise;
      forkPromise = undefined;

      expect(await readFile(gatedFile, 'utf8')).toBe('released\n');
      await expect(
        readFile(join(fixture.workspace, 'fork-gated.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(forked).toMatchObject({
        record: {
          phase: 'finished',
          runtimeResult: { status: 'completed', unresolvedItems: [] },
          lineage: {
            profileSelection: {
              sourceProfileId: checkpoint.source.profileId,
              targetStageId: 'claude-gated-upgraded',
              targetProfileDefinitionId: candidate!.profileDefinition.definitionId,
            },
          },
        },
        receipt: { outcome: 'verified', unresolvedItems: [] },
      });

      const childAttemptId = `fork-attempt-${forked.record.forkId}`;
      const timeline = engine.timeline(parent.missionId);
      const requested = timeline.find(
        (entry) => entry.kind === 'tool.gate.requested' && entry.attemptId === childAttemptId,
      );
      const decided = timeline.find(
        (entry) => entry.kind === 'tool.gate.decided' && entry.attemptId === childAttemptId,
      );
      const completed = timeline.find(
        (entry) => entry.kind === 'tool.gate.result' && entry.attemptId === childAttemptId,
      );
      expect(requested?.seq).toBeLessThan(decided?.seq ?? 0);
      expect(decided?.seq).toBeLessThan(completed?.seq ?? 0);

      const selection = timeline.find(
        (entry) => entry.kind === 'execution-fork.profile-rebound.selected',
      )?.data as unknown as { readonly targetProfileId: string };
      const binding = timeline.find(
        (entry) => entry.kind === 'attempt.bound' && entry.attemptId === childAttemptId,
      )?.data as unknown as {
        readonly profileId: string;
        readonly runtimeBinding: { readonly profileId: string };
      };
      expect(binding).toMatchObject({
        profileId: selection.targetProfileId,
        runtimeBinding: { profileId: selection.targetProfileId },
      });
      expect(
        timeline.find(
          (entry) => entry.kind === 'tool.gateway.armed' && entry.attemptId === childAttemptId,
        )?.data,
      ).toMatchObject({
        operation: 'execution-fork',
        attemptId: childAttemptId,
        capabilityFidelity: 'native',
        controlLevel: 'enforced',
      });
    } finally {
      controller.abort();
      await forkPromise?.catch(() => undefined);
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

  it('routes a Qoder native-protocol CREDIT_LIMIT fixture through a Composite Checkpoint and reaches a Receipt', async () => {
    const fixture = await createFixture('planner-credit');
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
        { harness: 'qoder', status: 'failed' },
        { harness: 'codex', status: 'succeeded' },
      ]);
      const checkpoints = engine.compositeCheckpoints(result.missionId);
      expect(checkpoints).toHaveLength(1);
      const composite = checkpoints[0]!;
      expect(composite).toMatchObject({
        source: { missionId: result.missionId, profileId: expect.stringMatching(/^profile-/) },
        workspace: { state: 'digest-only', workspaceDigest: expect.any(String) },
        process: { status: 'stopped' },
      });
      expect(composite.components).toHaveLength(12);
      expect(
        composite.components.find((component) => component.component === 'workspace'),
      ).toMatchObject({ disposition: 'inspect-only' });

      const timeline = engine.timeline(result.missionId);
      const plannerEntry = timeline.find((entry) => entry.kind === 'execution-planner.decision');
      const plannerData = plannerEntry?.data as unknown as {
        trigger: { code: string };
        plannerInput: ExecutionPlannerInputV1;
        decisionHash: string;
        decision: {
          decisionHash: string;
          binding: { action: string; selectedHarness: string };
          filter: {
            candidates: Array<{
              eligible: boolean;
              rejectionReasons: Array<{ code: string; subject: string }>;
            }>;
          };
          rank: Array<{
            profileId: string;
            harness: string;
            rankVector: Record<string, unknown>;
          }>;
          handoffCompatibility: Array<{
            profileId: string;
            overall: string;
            states: Array<{ stateId: string; classification: string }>;
            effectFrontier: { doNotRepeatEffectIds: string[]; conflictingEffectIds: string[] };
          }>;
        };
        sourceCompositeCheckpoint: {
          checkpointId: string;
          manifestHash: string;
          components: Array<{ component: string; disposition: string }>;
        };
      };
      expect(plannerData).toMatchObject({
        trigger: { code: 'CREDIT_LIMIT' },
        decision: {
          binding: { action: 'handoff', selectedHarness: 'codex' },
        },
        sourceCompositeCheckpoint: {
          checkpointId: composite.checkpointId,
          manifestHash: composite.manifestHash,
        },
      });
      expect(planExecution(plannerData.plannerInput).decisionHash).toBe(plannerData.decisionHash);
      expect(plannerData.decision.decisionHash).toBe(plannerData.decisionHash);
      expect(
        plannerData.decision.filter.candidates.some((candidate) =>
          candidate.rejectionReasons.some(
            (reason) =>
              reason.code === 'PROFILE_CAPABILITY_MISSING' && reason.subject === 'workspace-write',
          ),
        ),
      ).toBe(true);
      expect(plannerData.decision.rank).toMatchObject([
        { harness: 'codex', rankVector: expect.any(Object) },
      ]);
      const selectedCompatibility = plannerData.decision.handoffCompatibility.find(
        (candidate) => candidate.profileId === plannerData.decision.rank[0]?.profileId,
      );
      expect(selectedCompatibility).toMatchObject({
        overall: 'summarized',
        states: expect.arrayContaining([
          expect.objectContaining({ stateId: 'outcome-contract', classification: 'exact' }),
          expect.objectContaining({ stateId: 'workspace', classification: 'exact' }),
          expect.objectContaining({
            stateId: 'visible-context',
            classification: 'summarized',
          }),
          expect.objectContaining({ stateId: 'effect-frontier', classification: 'exact' }),
        ]),
        effectFrontier: {
          doNotRepeatEffectIds: [expect.stringMatching(/^effect-/)],
          conflictingEffectIds: [],
        },
      });
      const prepared = timeline.find((entry) => entry.kind === 'handoff.prepared')?.data as {
        checkpointId: string;
        compositeCheckpointId: string;
      };
      expect(prepared).toMatchObject({
        checkpointId: composite.checkpointId,
        compositeCheckpointId: composite.checkpointId,
      });
      expect(timeline.find((entry) => entry.kind === 'handoff.acknowledged')?.data).toMatchObject({
        checkpointId: composite.checkpointId,
        handoffOrderingEstablished: true,
        orderingEvidence: 'native-source-before-tool-request',
      });
      expect(result.receipt?.handoffIds).toHaveLength(1);
      expect(result.receipt?.effects).toMatchObject([
        { status: 'confirmed' },
        { status: 'confirmed' },
      ]);
    } finally {
      engine.close();
    }
  });

  it('refreshes a handed-off frontier after restart and carries confirmed plus ambiguous Effects as no-repeat', async () => {
    const fixture = await createFixture('planner-credit');
    await chmod(fixture.codex, 0o644);
    let dispatchCount = 0;
    const ambiguousTarget = {
      targetId: 'ambiguous-target',
      lookup: async () => ({
        status: 'ambiguous' as const,
        evidenceRefs: ['target:lookup-ambiguous'],
      }),
      dispatch: async () => {
        dispatchCount += 1;
        return {
          status: 'ambiguous' as const,
          evidenceRefs: ['target:dispatch-ambiguous'],
          detail: 'The target accepted no queryable terminal result.',
        };
      },
    } satisfies QueryableEffectTarget<JsonValue, JsonValue>;
    const adapters = () => ({
      codexAdapter: new CodexAdapter({ command: fixture.codex }),
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
      externalEffectTargets: [ambiguousTarget],
    });
    const firstEngine = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    const first = await firstEngine.run(fixture.missionFile, { workspace: fixture.workspace });
    expect(first.status).toBe('waiting');
    const sourceAttemptId = firstEngine.status(first.missionId).attempts[0]?.attemptId;
    expect(sourceAttemptId).toBeDefined();
    const ambiguousEffectId = 'effect-external-ambiguous';
    await expect(
      firstEngine.coordinateExternalEffect(first.missionId, {
        attemptId: sourceAttemptId!,
        effectId: ambiguousEffectId,
        targetId: ambiguousTarget.targetId,
        kind: 'publish-fixture',
        resourceKey: 'fixture-record',
        authorityRef: 'grant:test-only',
        idempotencyKey: 'fixture-ambiguous-key',
        payloadDigest: 'sha256:fixture-ambiguous-payload',
        payload: { operation: 'publish-fixture' },
      }),
    ).rejects.toMatchObject({
      name: 'ExternalEffectBlockedError',
      observedStatus: 'ambiguous',
    });
    expect(dispatchCount).toBe(1);
    expect(firstEngine.compositeCheckpoints(first.missionId)).toHaveLength(1);
    firstEngine.close();

    await chmod(fixture.codex, 0o755);
    const reopened = new MissionEngine({ stateDir: fixture.stateDir, ...adapters() });
    try {
      const resumed = await reopened.resume(first.missionId);

      expect(resumed).toMatchObject({
        status: 'failed',
        receipt: {
          outcome: 'rejected',
          unresolvedItems: [`effect:${ambiguousEffectId}:ambiguous`],
        },
      });
      expect(dispatchCount).toBe(1);
      expect(reopened.status(first.missionId).attempts).toMatchObject([
        { harness: 'qoder', status: 'failed' },
        { harness: 'codex', status: 'succeeded' },
      ]);
      const composites = reopened.compositeCheckpoints(first.missionId);
      expect(composites).toHaveLength(2);
      const refreshedComposite = composites.at(-1)!;
      expect(refreshedComposite.externalEffectFrontier).toMatchObject([
        { effectId: ambiguousEffectId, status: 'ambiguous' },
      ]);
      const timeline = reopened.timeline(first.missionId);
      const decisions = timeline.filter((entry) => entry.kind === 'execution-planner.decision');
      expect(decisions).toHaveLength(2);
      const resumedDecision = decisions.at(-1)?.data as unknown as {
        decision: {
          binding: { selectedHarness: string };
          handoffCompatibility: Array<{
            effectFrontier: { doNotRepeatEffectIds: string[]; conflictingEffectIds: string[] };
          }>;
        };
        sourceCompositeCheckpoint: { checkpointId: string };
      };
      expect(resumedDecision).toMatchObject({
        decision: { binding: { selectedHarness: 'codex' } },
        sourceCompositeCheckpoint: { checkpointId: refreshedComposite.checkpointId },
      });
      const noRepeatIds = new Set(
        resumedDecision.decision.handoffCompatibility.flatMap(
          (candidate) => candidate.effectFrontier.doNotRepeatEffectIds,
        ),
      );
      expect(noRepeatIds.has(ambiguousEffectId)).toBe(true);
      expect([...noRepeatIds].some((effectId) => effectId.startsWith('effect-attempt-'))).toBe(
        true,
      );
      expect(
        resumedDecision.decision.handoffCompatibility.every(
          (candidate) => candidate.effectFrontier.conflictingEffectIds.length === 0,
        ),
      ).toBe(true);
      const prepared = timeline.findLast((entry) => entry.kind === 'handoff.prepared')?.data as {
        checkpointId: string;
      };
      expect(prepared.checkpointId).toBe(refreshedComposite.checkpointId);
      const targetContext = timeline.findLast(
        (entry) => entry.kind === 'context.controller_prompt' && entry.harness === 'codex',
      )?.data as { nativeArtifact: { artifactId: string } };
      const promptArtifact = await reopened.artifact(targetContext.nativeArtifact.artifactId);
      expect(promptArtifact?.content).toContain(ambiguousEffectId);
    } finally {
      reopened.close();
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

async function createFixture(
  mode: 'resume' | 'handoff' | 'controller-crash' | 'claude' | 'planner-credit',
): Promise<{
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
  if (${JSON.stringify(mode)} === 'planner-credit') {
    if (!prompt.startsWith('MISSIONBRAID_HANDOFF_V1\\n')) process.exit(88);
    const ack = prompt.match(/^MISSIONBRAID_ACK (.+)$/m)?.[0];
    if (ack) console.log(JSON.stringify({ type: 'assistant', text: ack }));
    console.log(JSON.stringify({ type: 'tool_call', name: 'write_file', id: 'tool-codex-target' }));
    setTimeout(() => {
      writeFileSync(join(process.cwd(), 'done.txt'), 'credit-limit-recovered\\n');
      console.log(JSON.stringify({ type: 'tool_result', tool_use_id: 'tool-codex-target', status: 'completed' }));
      process.exit(0);
    }, 120);
    return;
  }
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
  if (${JSON.stringify(mode)} === 'planner-credit') {
    writeFileSync(join(process.cwd(), 'qoder.txt'), 'credit-limit-checkpoint\\n');
    console.log(JSON.stringify({ type: 'assistant', content: [{ text: 'workspace delta persisted before quota failure' }] }));
    console.log(JSON.stringify({ type: 'result', subtype: 'error', error_code: 118 }));
    process.exit(7);
  }
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
if (${JSON.stringify(mode)} === 'planner-credit') {
  if (readFileSync(join(workspace, 'qoder.txt'), 'utf8') !== 'credit-limit-checkpoint\\n') process.exit(3);
  if (readFileSync(join(workspace, 'done.txt'), 'utf8') !== 'credit-limit-recovered\\n') process.exit(4);
  const provenance = JSON.parse(readFileSync(provenanceFile, 'utf8'));
  if (provenance.stages.length !== 2) process.exit(5);
  if (provenance.stages[0].harness !== 'qoder' || provenance.stages[0].status !== 'handed_off') process.exit(6);
  if (provenance.stages[1].harness !== 'codex' || provenance.stages[1].status !== 'succeeded') process.exit(7);
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
        : mode === 'planner-credit'
          ? `  - stageId: qoder-primary
    profile:
      harness: qoder
      model: default
      reasoningEffort: medium
      permissionMode: bypass_permissions
      injectionBudgetTokens: 4000
    instruction: Continue until the native-protocol quota fixture reports its failure.
    onFailure: handoff
  - stageId: claude-read-only-rejected
    profile:
      harness: claude
      model: deepseek-v4-pro
      reasoningEffort: medium
      permissionMode: plan
      injectionBudgetTokens: 4000
    instruction: This candidate lacks the frozen workspace-write capability.
    onFailure: handoff
  - stageId: codex-credit-fallback
    profile:
      harness: codex
      model: default
      reasoningEffort: medium
      permissionMode: workspace-write
      injectionBudgetTokens: 4000
    instruction: Acknowledge the Composite Checkpoint Capsule and complete the Mission.
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
