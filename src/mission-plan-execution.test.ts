import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from './adapters/claude.js';
import { QoderAdapter } from './adapters/qoder.js';
import { MissionEngine } from './engine.js';
import type { PlanArtifactV1 } from './mission-plan.js';
import { snapshotGitWorkspace } from './workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Mission Plan native orchestration', () => {
  it('runs independent nodes in parallel, selectively revises live work, reuses verified output, and receipts the latest Plan', async () => {
    const fixture = await createPlanExecutionFixture();
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    const runController = new AbortController();
    let execution: ReturnType<MissionEngine['executeMissionPlan']> | undefined;
    try {
      const created = await engine.create(fixture.missionFile, {
        workspace: fixture.workspace,
      });
      const initial = engine.missionPlan(created.missionId);
      execution = engine.executeMissionPlan(created.missionId, runController.signal);

      const live = await waitForValue(() => {
        const view = engine.missionPlan(created.missionId);
        const toolArtifact = view.execution.artifacts.find(
          (record) =>
            record.artifact.producedByNodeId === 'tool-implementation' &&
            record.artifact.planRevisionId === initial.planRevision.planRevisionId,
        );
        const promptAttempt = view.execution.attempts.find(
          (attempt) =>
            attempt.nodeId === 'prompt-policy' &&
            attempt.planRevisionId === initial.planRevision.planRevisionId &&
            attempt.status === 'running',
        );
        return toolArtifact === undefined || promptAttempt === undefined
          ? undefined
          : { view, toolArtifact, promptAttempt };
      });

      const beforeRevisionTimeline = engine.timeline(created.missionId);
      const toolStarted = eventSequence(
        beforeRevisionTimeline,
        'runtime.process_started',
        'tool-implementation',
      );
      const promptStarted = eventSequence(
        beforeRevisionTimeline,
        'runtime.process_started',
        'prompt-policy',
      );
      const toolFinished = eventSequence(
        beforeRevisionTimeline,
        'runtime.process_finished',
        'tool-implementation',
      );
      expect(toolStarted).toBeLessThan(toolFinished);
      expect(promptStarted).toBeLessThan(toolFinished);

      const revisedPrompt =
        'The prompt output must contain classification, rationale, and evidenceSource.';
      const revised = await engine.reviseMissionContract(created.missionId, {
        contract: {
          ...initial.contractRevision.contract,
          acceptanceCriteria: initial.contractRevision.contract.acceptanceCriteria.map(
            (criterion) =>
              criterion.criterionId === 'prompt'
                ? { ...criterion, description: revisedPrompt }
                : criterion,
          ),
        },
        requirements: initial.contractRevision.requirements.map((requirement) =>
          requirement.requirementId === 'acceptance-prompt'
            ? { ...requirement, statement: revisedPrompt }
            : requirement,
        ),
        reason: 'The user added evidenceSource while the prompt Agent was running.',
        evidenceRefs: ['test:live-prompt-revision'],
      });

      expect(revised.invalidation.directlyImpactedNodeIds).toEqual([
        'consolidate',
        'prompt-policy',
      ]);
      expect(revised.invalidation.invalidatedNodeIds).toEqual(['consolidate', 'prompt-policy']);
      expect(revised.invalidation.reusableNodeIds).toContain('tool-implementation');
      expect(revised.invalidation.staleAttemptFences).toEqual([
        expect.objectContaining({
          attemptId: live.promptAttempt.attemptId,
          nodeId: 'prompt-policy',
          action: 'interrupt-and-preserve-evidence',
          acceptsFurtherEffects: false,
        }),
      ]);
      expect(
        revised.invalidation.staleAttemptFences.some(
          (fence) => fence.nodeId === 'tool-implementation',
        ),
      ).toBe(false);

      const result = await execution;
      expect(result).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      expect(result.receipt).toMatchObject({
        contractRevisionId: revised.contractRevision.contractRevisionId,
        planRevisionId: revised.planRevision.planRevisionId,
      });

      const final = engine.missionPlan(created.missionId);
      const attemptsByNode = groupBy(final.execution.attempts, (attempt) => attempt.nodeId);
      expect(attemptsByNode.get('tool-implementation')).toEqual([
        expect.objectContaining({
          harness: 'qoder',
          planRevisionId: initial.planRevision.planRevisionId,
          status: 'succeeded',
          fence: null,
        }),
      ]);
      expect(attemptsByNode.get('prompt-policy')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            harness: 'claude',
            planRevisionId: initial.planRevision.planRevisionId,
            status: 'abandoned',
            fence: expect.objectContaining({ nodeId: 'prompt-policy' }),
          }),
          expect.objectContaining({
            harness: 'claude',
            planRevisionId: revised.planRevision.planRevisionId,
            contractRevisionId: revised.contractRevision.contractRevisionId,
            status: 'succeeded',
            fence: null,
          }),
        ]),
      );

      const reusedTool = final.execution.artifacts.find(
        (record) =>
          record.artifact.producedByNodeId === 'tool-implementation' &&
          record.artifact.planRevisionId === revised.planRevision.planRevisionId,
      );
      expect(reusedTool).toMatchObject({
        reusedFromArtifactId: live.toolArtifact.artifact.artifactId,
        invalidationId: revised.invalidation.invalidationId,
        artifact: {
          contractRevisionId: revised.contractRevision.contractRevisionId,
          producerNodeVersion: live.toolArtifact.artifact.producerNodeVersion,
        },
      });

      const consolidation = final.execution.consolidations.at(-1);
      expect(consolidation).toMatchObject({
        plan: {
          planRevisionId: revised.planRevision.planRevisionId,
          contractRevisionId: revised.contractRevision.contractRevisionId,
          joinNodeId: 'consolidate',
          lineage: { sourceHistory: 'immutable' },
        },
        outcome: { conclusion: 'confirmed' },
      });
      expect(consolidation?.sourceCommitsAfter).toEqual(consolidation?.sourceCommitsBefore);

      const sourceIds = new Set(consolidation?.sourceArtifactIds ?? []);
      const sourceArtifacts = final.execution.artifacts.filter((record) =>
        sourceIds.has(record.artifact.artifactId),
      );
      expect(sourceArtifacts.map((record) => record.artifact.producedByNodeId).sort()).toEqual([
        'prompt-policy',
        'tool-implementation',
      ]);
      expect(sourceArtifacts.every((record) => hasBoundPassingVerifier(record.artifact))).toBe(
        true,
      );
      expect(
        sourceArtifacts.every(
          (record) =>
            record.artifact.planRevisionId === revised.planRevision.planRevisionId &&
            record.artifact.contractRevisionId === revised.contractRevision.contractRevisionId,
        ),
      ).toBe(true);

      expect(engine.missionPlanRuntime(created.missionId)).toMatchObject({
        planRevisionId: revised.planRevision.planRevisionId,
        contractRevisionId: revised.contractRevision.contractRevisionId,
        completedNodeIds: ['consolidate', 'prompt-policy', 'tool-implementation'],
        staleNodeIds: [],
      });
      const latestArtifacts = final.execution.artifacts.filter(
        (record) => record.artifact.planRevisionId === revised.planRevision.planRevisionId,
      );
      expect(latestArtifacts).toHaveLength(3);
      for (const record of latestArtifacts) {
        const snapshot = snapshotGitWorkspace(record.workspacePath);
        expect(snapshot.head).toBe(record.sourceCommit);
        expect(snapshot.status).toEqual([]);
        expect(snapshot.workspaceDigest).toBe(record.artifact.artifactDigest);
      }
    } finally {
      runController.abort();
      await execution?.catch(() => undefined);
      engine.close();
    }
  }, 20_000);

  it('blocks execution when a Contract revision adds an unplanned requirement', async () => {
    const fixture = await createPlanExecutionFixture();
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      const initial = engine.missionPlan(created.missionId);
      const revised = await engine.reviseMissionContract(created.missionId, {
        contract: {
          ...initial.contractRevision.contract,
          constraints: [
            ...(initial.contractRevision.contract.constraints ?? []),
            'Generate a migration note that no Plan node currently owns.',
          ],
        },
        requirements: [
          ...initial.contractRevision.requirements,
          {
            requirementId: 'constraint-migration-note',
            kind: 'constraint',
            statement: 'Generate a migration note that no Plan node currently owns.',
            acceptanceCriterionIds: [],
            evidenceRefs: ['test:unplanned-requirement'],
          },
        ],
        reason: 'Add a requirement that needs an explicit replan.',
        evidenceRefs: ['test:unplanned-requirement'],
      });

      expect(revised.invalidation.unplannedRequirementIds).toEqual(['constraint-migration-note']);
      await expect(engine.executeMissionPlan(created.missionId)).resolves.toMatchObject({
        status: 'waiting',
        waitingReason: expect.stringMatching(/unplanned requirement/i),
      });
      expect(engine.missionPlan(created.missionId).execution.attempts).toEqual([]);
      expect(engine.status(created.missionId).mission.receipt).toBeUndefined();
    } finally {
      engine.close();
    }
  });

  it('does not let a Contract revision during consolidation detection sign the obsolete Plan', async () => {
    const fixture = await createPlanExecutionFixture();
    const qoder = new DelayedConsolidationDetectionQoderAdapter(fixture.qoder);
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      qoderAdapter: qoder,
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    let execution: ReturnType<MissionEngine['executeMissionPlan']> | undefined;
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      await revisePromptToThreeFields(engine, created.missionId);
      const initial = engine.missionPlan(created.missionId);
      execution = engine.executeMissionPlan(created.missionId);
      await qoder.consolidationDetectionStarted;

      const revisedDescription = 'The latest integration must still pass after a live revision.';
      const revised = await engine.reviseMissionContract(created.missionId, {
        contract: {
          ...initial.contractRevision.contract,
          acceptanceCriteria: initial.contractRevision.contract.acceptanceCriteria.map(
            (criterion) =>
              criterion.criterionId === 'final'
                ? { ...criterion, description: revisedDescription }
                : criterion,
          ),
        },
        requirements: initial.contractRevision.requirements.map((requirement) =>
          requirement.requirementId === 'acceptance-final'
            ? { ...requirement, statement: revisedDescription }
            : requirement,
        ),
        reason: 'Revise the final integration requirement while detection is pending.',
        evidenceRefs: ['test:consolidation-detection-race'],
      });
      qoder.releaseConsolidationDetection();

      const result = await execution;
      expect(result).toMatchObject({
        status: 'succeeded',
        receipt: {
          contractRevisionId: revised.contractRevision.contractRevisionId,
          planRevisionId: revised.planRevision.planRevisionId,
        },
      });
      const consolidations = engine.missionPlan(created.missionId).execution.consolidations;
      expect(consolidations).toHaveLength(1);
      expect(consolidations[0]?.plan.planRevisionId).toBe(revised.planRevision.planRevisionId);
    } finally {
      qoder.releaseConsolidationDetection();
      await execution?.catch(() => undefined);
      engine.close();
    }
  }, 20_000);

  it('rejects undeclared files created by the consolidation Agent', async () => {
    const fixture = await createPlanExecutionFixture({ consolidationWritesExtra: true });
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      await revisePromptToThreeFields(engine, created.missionId);
      await expect(engine.executeMissionPlan(created.missionId)).rejects.toThrow(/undeclared/i);
      expect(engine.status(created.missionId).mission.receipt).toBeUndefined();
    } finally {
      engine.close();
    }
  }, 20_000);

  it('rechecks immutable sources after the final verifier', async () => {
    const fixture = await createPlanExecutionFixture({ finalVerifierMutatesSource: true });
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      await revisePromptToThreeFields(engine, created.missionId);
      await expect(engine.executeMissionPlan(created.missionId)).rejects.toThrow(
        /immutable source/i,
      );
      expect(engine.status(created.missionId).mission.receipt).toBeUndefined();
    } finally {
      engine.close();
    }
  }, 20_000);

  it('rejects undeclared files created by a Plan node verifier', async () => {
    const fixture = await createPlanExecutionFixture({ toolVerifierWritesExtra: true });
    const engine = new MissionEngine({
      stateDir: fixture.stateDir,
      qoderAdapter: new QoderAdapter({ command: fixture.qoder }),
      claudeAdapter: new ClaudeAdapter({ command: fixture.claude }),
    });
    try {
      const created = await engine.create(fixture.missionFile, { workspace: fixture.workspace });
      await revisePromptToThreeFields(engine, created.missionId);
      await expect(engine.executeMissionPlan(created.missionId)).resolves.toMatchObject({
        status: 'waiting',
        waitingReason: expect.stringMatching(/verifier changed undeclared paths/i),
      });
      expect(engine.status(created.missionId).mission.receipt).toBeUndefined();
    } finally {
      engine.close();
    }
  }, 20_000);

  it('requires exactly one terminal join in an explicit executable Plan', async () => {
    const fixture = await createPlanExecutionFixture();
    const source = await readFile(fixture.missionFile, 'utf8');
    await writeFile(fixture.missionFile, source.replace('kind: join', 'kind: task'), 'utf8');
    const engine = new MissionEngine({ stateDir: fixture.stateDir });
    try {
      await expect(
        engine.create(fixture.missionFile, { workspace: fixture.workspace }),
      ).rejects.toThrow(/exactly one terminal join/i);
    } finally {
      engine.close();
    }
  });
});

interface PlanExecutionFixtureOptions {
  readonly consolidationWritesExtra?: boolean;
  readonly finalVerifierMutatesSource?: boolean;
  readonly toolVerifierWritesExtra?: boolean;
}

async function createPlanExecutionFixture(options: PlanExecutionFixtureOptions = {}): Promise<{
  root: string;
  workspace: string;
  stateDir: string;
  missionFile: string;
  qoder: string;
  claude: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'missionbraid-plan-execution-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const source = join(root, 'mission-source');
  const bin = join(root, 'bin');
  const coordination = join(root, 'coordination');
  const stateDir = join(source, '.missionbraid');
  await Promise.all([mkdir(workspace), mkdir(source), mkdir(bin), mkdir(coordination)]);

  await writeFile(join(workspace, 'AGENTS.md'), 'Stay inside this disposable fixture.\n');
  await writeFile(
    join(workspace, 'verify-plan.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const workspace = process.env.MISSIONBRAID_TARGET_WORKSPACE;
const criterion = process.argv[2];
if (!workspace) process.exit(2);
const read = (path) => readFileSync(join(workspace, path), 'utf8');
if (criterion === 'tool') {
  if (read('tool.txt') !== 'verified-tool\\n') process.exit(3);
  ${options.toolVerifierWritesExtra === true ? "writeFileSync(join(workspace, 'verifier-extra.txt'), 'undeclared\\n');" : ''}
} else if (criterion === 'prompt') {
  const contract = JSON.parse(read('.missionbraid/contract-revision.json'));
  const expected = contract.revisionNumber === 1 ? 'two-fields\\n' : 'three-fields\\n';
  if (read('prompt.txt') !== expected) process.exit(4);
} else if (criterion === 'final') {
  if (read('tool.txt') !== 'verified-tool\\n') process.exit(5);
  if (read('prompt.txt') !== 'three-fields\\n') process.exit(6);
  const integration = JSON.parse(read('integration.json'));
  if (integration.tool !== 'verified-tool' || integration.prompt !== 'three-fields') process.exit(7);
  ${options.finalVerifierMutatesSource === true ? "writeFileSync(join(workspace, 'tool.txt'), 'tampered-by-verifier\\n');" : ''}
} else process.exit(8);
`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['add', '.'], { cwd: workspace });
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

  const qoder = join(bin, 'qodercli');
  await executable(
    qoder,
    `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('qodercli 4.5.6'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (prompt.includes('MissionBraid Mission Plan node tool-implementation')) {
    writeFileSync(join(process.cwd(), 'tool.txt'), 'verified-tool\\n');
    writeFileSync(${JSON.stringify(join(coordination, 'tool-started'))}, 'started\\n');
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (existsSync(${JSON.stringify(join(coordination, 'prompt-started'))})) {
        clearInterval(timer);
        console.log(JSON.stringify({ type: 'assistant', content: [{ text: 'tool complete' }] }));
        process.exit(0);
      }
      if (Date.now() > deadline) process.exit(9);
    }, 10);
    return;
  }
  if (prompt.includes('MissionBraid consolidation node consolidate')) {
    writeFileSync(join(process.cwd(), 'integration.json'), JSON.stringify({ tool: 'verified-tool', prompt: 'three-fields' }) + '\\n');
    ${options.consolidationWritesExtra === true ? "writeFileSync(join(process.cwd(), 'extra.txt'), 'undeclared\\n');" : ''}
    console.log(JSON.stringify({ type: 'assistant', content: [{ text: 'integration complete' }] }));
    process.exit(0);
  }
  process.exit(10);
});
`,
  );

  const claude = join(bin, 'claude');
  await executable(
    claude,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { console.log('2.1.245 (Claude Code)'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
	  const contract = JSON.parse(readFileSync(join(process.cwd(), '.missionbraid', 'contract-revision.json'), 'utf8'));
	  const initial = contract.revisionNumber === 1;
	  writeFileSync(join(process.cwd(), 'prompt.txt'), initial ? 'two-fields\\n' : 'three-fields\\n');
	  writeFileSync(${JSON.stringify(join(coordination, 'prompt-started'))}, 'started\\n');
	  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-' + contract.revisionNumber, model: 'fixture-model', permissionMode: 'dontAsk', tools: ['Read', 'Write'], skills: [], mcp_servers: [], claude_code_version: '2.1.245' }));
	  if (initial) {
	    setInterval(() => {}, 1000);
    return;
  }
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'message-revised', model: 'fixture-model' }, session_id: 'session-2' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'session-2', total_cost_usd: 0, modelUsage: { 'fixture-model': { contextWindow: 1000 } } }));
});
`,
  );

  const missionFile = join(source, 'mission.yaml');
  await writeFile(
    missionFile,
    `schemaVersion: missionbraid.dev/mission/v1
title: Selectively revise a multi-Agent Mission
objective: Build and consolidate a verified tool and prompt.
workspace: '\${WORKSPACE}'
constraints:
  - Preserve verified unaffected outputs across a prompt-only revision.
acceptanceCriteria:
  - id: tool
    description: The tool output is deterministic.
    verifier:
      kind: command
      executable: node
      args: [verify-plan.mjs, tool]
      cwd: '\${WORKSPACE}'
      timeoutMs: 5000
  - id: prompt
    description: The prompt output initially contains two fields.
    verifier:
      kind: command
      executable: node
      args: [verify-plan.mjs, prompt]
      cwd: '\${WORKSPACE}'
      timeoutMs: 5000
  - id: final
    description: The integrated workspace satisfies the latest Contract revision.
    verifier:
      kind: command
      executable: node
      args: [verify-plan.mjs, final]
      cwd: '\${WORKSPACE}'
      timeoutMs: 5000
attemptPlan:
  - stageId: qoder-tool
    profile:
      harness: qoder
      model: fixture-model
      injectionBudgetTokens: 4000
    instruction: Implement the tool output.
  - stageId: claude-prompt
    profile:
      harness: claude
      model: fixture-model
      injectionBudgetTokens: 4000
    instruction: Implement the active prompt Contract.
  - stageId: qoder-consolidate
    profile:
      harness: qoder
      model: fixture-model
      injectionBudgetTokens: 4000
    instruction: Consolidate only verified source artifacts.
plan:
  nodes:
    - nodeId: tool-implementation
      kind: task
      title: Implement tool
      requirementIds: [acceptance-tool]
      stageId: qoder-tool
      acceptanceCriterionIds: [tool]
      declaredOutputKeys: [tool.txt]
      requiredAuthorityScopes: [workspace]
    - nodeId: prompt-policy
      kind: task
      title: Implement prompt policy
      requirementIds: [acceptance-prompt]
      stageId: claude-prompt
      acceptanceCriterionIds: [prompt]
      declaredOutputKeys: [prompt.txt]
      requiredAuthorityScopes: [workspace]
    - nodeId: consolidate
      kind: join
      title: Consolidate verified outputs
      requirementIds: [acceptance-tool, acceptance-prompt, acceptance-final]
      stageId: qoder-consolidate
      acceptanceCriterionIds: [final]
      declaredOutputKeys: [integration.json]
      requiredAuthorityScopes: [workspace]
  edges:
    - fromNodeId: tool-implementation
      toNodeId: consolidate
      relation: join-input
      evidenceRefs: [test:tool-to-consolidate]
    - fromNodeId: prompt-policy
      toNodeId: consolidate
      relation: join-input
      evidenceRefs: [test:prompt-to-consolidate]
`,
  );
  return { root, workspace, stateDir, missionFile, qoder, claude };
}

class DelayedConsolidationDetectionQoderAdapter extends QoderAdapter {
  readonly #started = deferred<void>();
  readonly #release = deferred<void>();
  #detectionCount = 0;

  constructor(command: string) {
    super({ command });
  }

  get consolidationDetectionStarted(): Promise<void> {
    return this.#started.promise;
  }

  releaseConsolidationDetection(): void {
    this.#release.resolve();
  }

  override async detect(): ReturnType<QoderAdapter['detect']> {
    this.#detectionCount += 1;
    if (this.#detectionCount === 3) {
      this.#started.resolve();
      await this.#release.promise;
    }
    return await super.detect();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T): void {
      resolvePromise(value as T);
    },
  };
}

async function revisePromptToThreeFields(engine: MissionEngine, missionId: string): Promise<void> {
  const current = engine.missionPlan(missionId);
  const revisedPrompt =
    'The prompt output must contain classification, rationale, and evidenceSource.';
  await engine.reviseMissionContract(missionId, {
    contract: {
      ...current.contractRevision.contract,
      acceptanceCriteria: current.contractRevision.contract.acceptanceCriteria.map((criterion) =>
        criterion.criterionId === 'prompt'
          ? { ...criterion, description: revisedPrompt }
          : criterion,
      ),
    },
    requirements: current.contractRevision.requirements.map((requirement) =>
      requirement.requirementId === 'acceptance-prompt'
        ? { ...requirement, statement: revisedPrompt }
        : requirement,
    ),
    reason: 'Prepare the three-field Contract for the deterministic fixture.',
    evidenceRefs: ['test:prepare-three-field-contract'],
  });
}

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
}

async function waitForValue<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms`);
}

function eventSequence(
  timeline: ReturnType<MissionEngine['timeline']>,
  kind: string,
  nodeId: string,
): number {
  const event = timeline.find(
    (entry) =>
      entry.kind === kind &&
      typeof entry.data === 'object' &&
      entry.data !== null &&
      !Array.isArray(entry.data) &&
      entry.data.nodeId === nodeId,
  );
  if (event === undefined) throw new Error(`Missing ${kind} for ${nodeId}`);
  return event.seq;
}

function hasBoundPassingVerifier(artifact: PlanArtifactV1): boolean {
  return artifact.verifierEvidence.some(
    (evidence) =>
      evidence.evaluator === 'deterministic' &&
      evidence.subjectId === artifact.artifactId &&
      evidence.subjectDigest === artifact.artifactDigest &&
      ('passed' in evidence.result ? evidence.result.passed : evidence.result.status === 'passed'),
  );
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const existing = grouped.get(id);
    if (existing === undefined) grouped.set(id, [item]);
    else existing.push(item);
  }
  return grouped;
}
