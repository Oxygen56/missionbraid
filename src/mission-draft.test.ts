import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      cwd: workspace,
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

  it.each([
    ['relative workspace', { workspace: 'relative/workspace' }],
    ['blank objective', { objective: '   ' }],
    ['empty route', { stages: [] }],
    [
      'too many stages',
      {
        stages: [stage('one', 'codex'), stage('two', 'qoder'), stage('three', 'codex')],
      },
    ],
    ['duplicate stage ids', { stages: [stage('duplicate', 'codex'), stage('duplicate', 'qoder')] }],
    ['unsupported harness', { stages: [{ ...stage('one', 'codex'), harness: 'claude' }] }],
    [
      'wrong permission mode',
      { stages: [{ ...stage('one', 'codex'), permissionMode: 'bypass_permissions' }] },
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

function stage(stageId: string, harness: 'codex' | 'qoder') {
  return {
    stageId,
    harness,
    model: 'default',
    injectionBudgetTokens: 1_600,
  };
}
