import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMissionDraft, MissionDraftError } from './mission-draft.js';
import { loadMissionSpec } from './spec.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createMissionDraft', () => {
  it('creates a loadable planned Codex-to-Qoder Mission without writing a file itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);

    const draft = createMissionDraft(validInput(workspace));
    expect(draft.document.attemptPlan).toHaveLength(2);
    expect(draft.document.attemptPlan[0]).toMatchObject({
      stageId: 'codex-primary',
      profile: {
        harness: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        permissionMode: 'workspace-write',
      },
      onFailure: 'handoff',
    });
    expect(draft.document.attemptPlan[0]?.instruction).toContain('planned Qoder continuation');
    expect(draft.document.attemptPlan[1]?.instruction).toContain('Handoff Capsule');
    expect(draft.document.attemptPlan[1]?.onFailure).toBe('stop');

    const source = join(root, 'mission.yaml');
    writeFileSync(source, draft.yaml, 'utf8');
    const loaded = loadMissionSpec(source);
    expect(loaded.workspace).toBe(realpathSync(workspace));
    expect(loaded.attemptPlan.map((stage) => stage.profile.harness)).toEqual(['codex', 'qoder']);
    expect(loaded.acceptanceCriteria[0]?.verifier).toMatchObject({
      executable: 'node',
      args: ['--test'],
      cwd: realpathSync(workspace),
      env: {},
      timeoutMs: 30_000,
    });
  });

  it('preserves explicit instructions and keeps verifier arguments shell-free', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-args-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const input = validInput(workspace);
    const draft = createMissionDraft({
      ...input,
      verifier: {
        executable: 'node',
        args: ['verify.mjs', 'literal && not-a-shell-expression'],
        timeoutMs: 1_000,
      },
      stages: [
        {
          ...input.stages[0],
          instruction: 'Implement only the declared bounded stage.',
        },
      ],
    });
    expect(draft.document.attemptPlan[0]?.instruction).toBe(
      'Implement only the declared bounded stage.',
    );
    expect(draft.document.acceptanceCriteria[0]?.verifier.args).toEqual([
      'verify.mjs',
      'literal && not-a-shell-expression',
    ]);
  });

  it('creates a loadable Claude Code Mission with its native effort and permission names', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-claude-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const input = validInput(workspace);

    const draft = createMissionDraft({
      ...input,
      stages: [
        {
          stageId: 'claude-primary',
          harness: 'claude',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'medium',
          permissionMode: 'dontAsk',
          injectionBudgetTokens: 1_600,
        },
      ],
    });

    expect(draft.document.attemptPlan[0]).toMatchObject({
      stageId: 'claude-primary',
      profile: {
        harness: 'claude',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'medium',
        permissionMode: 'dontAsk',
      },
      onFailure: 'stop',
    });
    expect(draft.document.attemptPlan[0]?.instruction).toContain('Claude Code');

    const source = join(root, 'mission.yaml');
    writeFileSync(source, draft.yaml, 'utf8');
    expect(loadMissionSpec(source).attemptPlan[0]?.profile.harness).toBe('claude');
  });

  it('preserves an external Adapter and provider workspace binding in the generated Mission', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-adapter-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const input = validInput(workspace);

    const draft = createMissionDraft({
      ...input,
      stages: [
        {
          ...input.stages[0],
          harness: 'provider-example',
          adapterId: 'provider.example',
          providerWorkspaceRef: 'provider-workspace:fixture',
        },
      ],
    });
    expect(draft.document.attemptPlan[0]?.profile).toMatchObject({
      harness: 'provider-example',
      adapterId: 'provider.example',
      providerWorkspaceRef: 'provider-workspace:fixture',
    });

    const source = join(root, 'mission.yaml');
    writeFileSync(source, draft.yaml, 'utf8');
    expect(loadMissionSpec(source).attemptPlan[0]?.profile).toMatchObject({
      harness: 'provider-example',
      adapterId: 'provider.example',
    });
  });

  it('creates one ordered Codex-to-Qoder-to-Claude Mission for the unified Runtime path', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-three-runtime-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const input = validInput(workspace);

    const draft = createMissionDraft({
      ...input,
      stages: [
        ...input.stages,
        {
          stageId: 'claude-finish',
          harness: 'claude',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'medium',
          permissionMode: 'dontAsk',
          injectionBudgetTokens: 1_600,
        },
      ],
    });

    expect(draft.document.attemptPlan.map((stage) => stage.profile.harness)).toEqual([
      'codex',
      'qoder',
      'claude',
    ]);
    expect(draft.document.attemptPlan.map((stage) => stage.onFailure)).toEqual([
      'handoff',
      'handoff',
      'stop',
    ]);
    expect(draft.document.attemptPlan[1]?.instruction).toContain('Handoff Capsule');
    expect(draft.document.attemptPlan[2]?.instruction).toContain('Handoff Capsule');

    const source = join(root, 'mission.yaml');
    writeFileSync(source, draft.yaml, 'utf8');
    expect(loadMissionSpec(source).attemptPlan).toHaveLength(3);
  });

  it('creates a loadable explicit two-worker Plan with independent criteria and consolidation', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-plan-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);

    const draft = createMissionDraft(planInput(workspace));
    expect(draft.document.acceptanceCriteria.map((criterion) => criterion.id)).toEqual([
      'workstream-a',
      'workstream-b',
      'mission-outcome',
    ]);
    expect(draft.document.attemptPlan.map((stage) => stage.onFailure)).toEqual([
      'handoff',
      'handoff',
      'stop',
    ]);
    expect(draft.document.plan?.nodes.map((node) => node.nodeId)).toEqual([
      'workstream-a',
      'workstream-b',
      'consolidate',
    ]);

    const source = join(root, 'mission-plan.yaml');
    writeFileSync(source, draft.yaml, 'utf8');
    const loaded = loadMissionSpec(source);
    expect(loaded.plan?.edges).toEqual([
      {
        fromNodeId: 'workstream-a',
        toNodeId: 'consolidate',
        relation: 'join-input',
        evidenceRefs: ['artifact:workstream-a'],
      },
      {
        fromNodeId: 'workstream-b',
        toNodeId: 'consolidate',
        relation: 'join-input',
        evidenceRefs: ['artifact:workstream-b'],
      },
    ]);
    expect(loaded.plan?.nodes[2]).toMatchObject({
      kind: 'join',
      stageId: 'qoder-consolidation',
      acceptanceCriterionIds: ['mission-outcome'],
    });
  });

  it('canonicalizes a symlinked workspace for the Mission and every explicit verifier', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-workspace-alias-'));
    roots.push(root);
    const workspace = join(root, 'workspace-real');
    const workspaceAlias = join(root, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, workspaceAlias, 'dir');

    const draft = createMissionDraft(planInput(workspaceAlias));
    expect(draft.document.workspace).toBe(realpathSync(workspace));
    expect(draft.document.acceptanceCriteria.map((criterion) => criterion.verifier.cwd)).toEqual([
      realpathSync(workspace),
      realpathSync(workspace),
      realpathSync(workspace),
    ]);

    const source = join(root, 'mission-plan-alias.yaml');
    writeFileSync(source, draft.yaml, 'utf8');
    const loaded = loadMissionSpec(source);
    expect(loaded.workspace).toBe(realpathSync(workspace));
    expect(
      loaded.acceptanceCriteria.every((criterion) => criterion.verifier.cwd === loaded.workspace),
    ).toBe(true);
  });

  it('rejects an explicit Plan that references a requirement outside the Contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-plan-invalid-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const input = planInput(workspace);
    const plan = input.plan as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };

    expect(() =>
      createMissionDraft({
        ...input,
        plan: {
          ...plan,
          nodes: [{ ...plan.nodes[0], requirementIds: ['constraint-99'] }, ...plan.nodes.slice(1)],
        },
      }),
    ).toThrow(/unknown Contract requirement constraint-99/);
  });

  it('accepts a fourth declared Profile for a later regression or handoff target', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-four-profiles-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);

    const draft = createMissionDraft({
      ...validInput(workspace),
      stages: [
        stage('one', 'codex'),
        stage('two', 'qoder'),
        { ...stage('three', 'claude'), onFailure: 'stop' },
        stage('regression-target', 'claude'),
      ],
    });

    expect(draft.document.attemptPlan).toHaveLength(4);
    expect(draft.document.attemptPlan.map((candidate) => candidate.onFailure)).toEqual([
      'handoff',
      'handoff',
      'stop',
      'stop',
    ]);
    expect(draft.document.attemptPlan[3]?.stageId).toBe('regression-target');

    const source = join(root, 'mission-four-profiles.yaml');
    writeFileSync(source, draft.yaml, 'utf8');
    expect(loadMissionSpec(source).attemptPlan.map((candidate) => candidate.onFailure)).toEqual([
      'handoff',
      'handoff',
      'stop',
      'stop',
    ]);
  });

  it('rejects an invalid disposition and a final Profile that requests a handoff', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-disposition-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);

    expect(() =>
      createMissionDraft({
        ...validInput(workspace),
        stages: [{ ...stage('one', 'codex'), onFailure: 'retry' }],
      }),
    ).toThrow(/must be stop or handoff/);
    expect(() =>
      createMissionDraft({
        ...validInput(workspace),
        stages: [{ ...stage('one', 'codex'), onFailure: 'handoff' }],
      }),
    ).toThrow(/final Runtime Profile cannot hand off/);
  });

  it.each([
    ['relative workspace', { workspace: 'relative/workspace' }],
    ['blank objective', { objective: '   ' }],
    ['empty route', { stages: [] }],
    [
      'too many stages',
      {
        stages: Array.from({ length: 17 }, (_, index) =>
          stage(`stage-${String(index + 1)}`, index % 2 === 0 ? 'codex' : 'qoder'),
        ),
      },
    ],
    ['duplicate stage ids', { stages: [stage('duplicate', 'codex'), stage('duplicate', 'qoder')] }],
    ['unsupported harness', { stages: [{ ...stage('one', 'codex'), harness: 'opencode' }] }],
    [
      'wrong permission mode',
      { stages: [{ ...stage('one', 'codex'), permissionMode: 'bypass_permissions' }] },
    ],
    [
      'wrong Claude permission mode',
      { stages: [{ ...stage('one', 'claude'), permissionMode: 'dont_ask' }] },
    ],
    [
      'shell verifier',
      { verifier: { executable: '/bin/bash', args: ['-c', 'true'], timeoutMs: 1_000 } },
    ],
    [
      'verifier env field',
      { verifier: { executable: 'node', args: ['--test'], timeoutMs: 1_000, env: {} } },
    ],
    ['root secret field', { apiKey: 'not-even-accepted-as-a-field' }],
  ])('rejects %s', (_label, replacement) => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-invalid-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    expect(() => createMissionDraft({ ...validInput(workspace), ...replacement })).toThrow(
      MissionDraftError,
    );
  });

  it('rejects credential-like values before YAML is produced', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-draft-secret-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    expect(() =>
      createMissionDraft({
        ...validInput(workspace),
        objective: 'Use api_key=fixture-private-value to complete the task',
      }),
    ).toThrow(/Credential-like value/);
    expect(() =>
      createMissionDraft({
        ...validInput(workspace),
        verifier: {
          executable: 'node',
          args: ['--test', '--access-token=fixture-private-value'],
          timeoutMs: 1_000,
        },
      }),
    ).toThrow(/Credential-like value/);

    const clean = createMissionDraft(validInput(workspace));
    expect(clean.yaml).not.toContain('env:');
    expect(clean.yaml).not.toContain('api_key');
    expect(clean.yaml).not.toContain('fixture-private-value');
  });
});

function validInput(workspace: string) {
  return {
    title: 'Complete the local ledger',
    objective: 'Complete the implementation and satisfy the declared verifier.',
    workspace,
    constraints: ['Stay inside the provided workspace', 'Do not publish external changes'],
    verifier: {
      executable: 'node',
      args: ['--test'],
      timeoutMs: 30_000,
    },
    stages: [
      {
        stageId: 'codex-primary',
        harness: 'codex' as const,
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        permissionMode: 'workspace-write',
        injectionBudgetTokens: 1_600,
      },
      {
        stageId: 'qoder-continuation',
        harness: 'qoder' as const,
        model: 'Qwen3.8-Max',
        reasoningEffort: 'medium',
        permissionMode: 'bypass_permissions',
        injectionBudgetTokens: 1_600,
      },
    ],
  };
}

function planInput(workspace: string): Record<string, unknown> {
  return {
    title: 'Build two independent workstreams and integrate them',
    objective: 'Produce and verify one integrated result from both workstreams.',
    workspace,
    constraints: [
      'Implement the first independent workstream.',
      'Implement the second independent workstream.',
    ],
    acceptanceCriteria: [
      {
        id: 'workstream-a',
        description: 'The first workstream passes its deterministic verifier.',
        verifier: { executable: 'node', args: ['verify-a.mjs'], timeoutMs: 30_000 },
      },
      {
        id: 'workstream-b',
        description: 'The second workstream passes its deterministic verifier.',
        verifier: { executable: 'node', args: ['verify-b.mjs'], timeoutMs: 30_000 },
      },
      {
        id: 'mission-outcome',
        description: 'The consolidated result passes the final verifier.',
        verifier: { executable: 'node', args: ['verify-all.mjs'], timeoutMs: 30_000 },
      },
    ],
    stages: [
      {
        stageId: 'qoder-workstream',
        harness: 'qoder',
        model: 'Qwen3.8-Max',
        reasoningEffort: 'medium',
        permissionMode: 'bypass_permissions',
        injectionBudgetTokens: 1_600,
        instruction: 'Implement only workstream A and change only workstream-a.txt.',
      },
      {
        stageId: 'claude-workstream',
        harness: 'claude',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'medium',
        permissionMode: 'bypassPermissions',
        injectionBudgetTokens: 1_600,
        instruction: 'Implement only workstream B and change only workstream-b.txt.',
      },
      {
        stageId: 'qoder-consolidation',
        harness: 'qoder',
        model: 'Qwen3.8-Max',
        reasoningEffort: 'medium',
        permissionMode: 'bypass_permissions',
        injectionBudgetTokens: 1_600,
        instruction: 'Integrate both verified artifacts and change only integrated.txt.',
      },
    ],
    plan: {
      nodes: [
        {
          nodeId: 'workstream-a',
          kind: 'task',
          title: 'First workstream',
          requirementIds: ['constraint-1', 'acceptance-workstream-a'],
          stageId: 'qoder-workstream',
          acceptanceCriterionIds: ['workstream-a'],
          declaredOutputKeys: ['workstream-a.txt'],
          requiredAuthorityScopes: ['workspace'],
        },
        {
          nodeId: 'workstream-b',
          kind: 'task',
          title: 'Second workstream',
          requirementIds: ['constraint-2', 'acceptance-workstream-b'],
          stageId: 'claude-workstream',
          acceptanceCriterionIds: ['workstream-b'],
          declaredOutputKeys: ['workstream-b.txt'],
          requiredAuthorityScopes: ['workspace'],
        },
        {
          nodeId: 'consolidate',
          kind: 'join',
          title: 'Consolidate verified workstreams',
          requirementIds: [
            'objective',
            'acceptance-workstream-a',
            'acceptance-workstream-b',
            'acceptance-mission-outcome',
          ],
          stageId: 'qoder-consolidation',
          acceptanceCriterionIds: ['mission-outcome'],
          declaredOutputKeys: ['integrated.txt'],
          requiredAuthorityScopes: ['workspace'],
        },
      ],
      edges: [
        {
          fromNodeId: 'workstream-a',
          toNodeId: 'consolidate',
          relation: 'join-input',
          evidenceRefs: ['artifact:workstream-a'],
        },
        {
          fromNodeId: 'workstream-b',
          toNodeId: 'consolidate',
          relation: 'join-input',
          evidenceRefs: ['artifact:workstream-b'],
        },
      ],
    },
  };
}

function stage(stageId: string, harness: 'codex' | 'qoder' | 'claude') {
  return {
    stageId,
    harness,
    model: 'default',
    injectionBudgetTokens: 1_600,
  };
}
