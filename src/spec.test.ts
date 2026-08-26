import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createMissionSpecSnapshot,
  loadMissionSpec,
  MissionSpecError,
  restoreMissionSpecSnapshot,
} from './spec.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('loadMissionSpec', () => {
  it('expands only explicit path variables and freezes a resolved workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-spec-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const hidden = join(root, 'hidden');
    mkdirSync(workspace);
    mkdirSync(hidden);
    const source = join(root, 'mission.yaml');
    writeFileSync(
      source,
      `schemaVersion: missionbraid.dev/mission/v1
title: Fixture
objective: Complete it
workspace: \${WORKSPACE}
constraints: [No network]
acceptanceCriteria:
  - id: tests
    description: Tests pass
    verifier:
      kind: command
      executable: node
      args: [--test, "\${MISSION_FILE_DIR}/hidden/test.mjs"]
      cwd: \${WORKSPACE}
      timeoutMs: 1000
attemptPlan:
  - stageId: source
    profile:
      harness: codex
      model: default
      reasoningEffort: medium
      injectionBudgetTokens: 8000
    instruction: Implement the core
`,
    );

    const spec = loadMissionSpec(source, { workspace });
    const canonicalWorkspace = realpathSync(workspace);
    expect(spec.workspace).toBe(canonicalWorkspace);
    expect(spec.acceptanceCriteria[0]?.verifier).toMatchObject({
      cwd: canonicalWorkspace,
      env: {},
      args: ['--test', join(realpathSync(root), 'hidden/test.mjs')],
    });
    expect(spec.attemptPlan[0]?.profile.harness).toBe('codex');
    expect(spec.plan).toBeUndefined();

    const snapshot = createMissionSpecSnapshot(spec);
    expect(snapshot).not.toHaveProperty('spec.sourceFile');
    rmSync(source);
    expect(restoreMissionSpecSnapshot(snapshot, spec.sourceFile)).toEqual(spec);
    expect(() =>
      createMissionSpecSnapshot({
        ...spec,
        objective: 'sk-proj-fixture-private-value',
      }),
    ).toThrow(/Credential-like value/);
  });

  it('loads and restores a Claude Code Runtime Profile without changing its native names', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-spec-claude-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const source = join(root, 'mission.yaml');
    writeFileSync(
      source,
      `schemaVersion: missionbraid.dev/mission/v1
title: Claude fixture
objective: Complete it
workspace: ${JSON.stringify(workspace)}
acceptanceCriteria:
  - id: tests
    description: Tests pass
    verifier:
      kind: command
      executable: node
      args: [--test]
      cwd: ${JSON.stringify(workspace)}
      timeoutMs: 1000
attemptPlan:
  - stageId: claude-primary
    profile:
      harness: claude
      model: deepseek-v4-pro
      reasoningEffort: medium
      permissionMode: dontAsk
      injectionBudgetTokens: 8000
    instruction: Implement the core
`,
    );

    const spec = loadMissionSpec(source);
    expect(spec.attemptPlan[0]?.profile).toEqual({
      harness: 'claude',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'medium',
      permissionMode: 'dontAsk',
      injectionBudgetTokens: 8000,
    });
    expect(restoreMissionSpecSnapshot(createMissionSpecSnapshot(spec), spec.sourceFile)).toEqual(
      spec,
    );
  });

  it('loads and restores an external provider-backed Adapter profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-spec-adapter-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const source = join(root, 'mission.yaml');
    writeFileSync(
      source,
      `schemaVersion: missionbraid.dev/mission/v1
title: Adapter fixture
objective: Complete it
workspace: ${JSON.stringify(workspace)}
acceptanceCriteria:
  - id: result
    description: Result passes
    verifier:
      kind: command
      executable: node
      args: [verify.mjs]
      cwd: ${JSON.stringify(workspace)}
      timeoutMs: 1000
attemptPlan:
  - stageId: provider-adapter
    profile:
      harness: provider-example
      adapterId: provider.example
      providerWorkspaceRef: provider-workspace:fixture
      model: default
      permissionMode: workspace-write
      injectionBudgetTokens: 4000
    instruction: Complete the provider fixture.
    onFailure: stop
`,
    );

    const spec = loadMissionSpec(source);
    expect(spec.attemptPlan[0]?.profile).toMatchObject({
      harness: 'provider-example',
      adapterId: 'provider.example',
      providerWorkspaceRef: 'provider-workspace:fixture',
    });
    expect(restoreMissionSpecSnapshot(createMissionSpecSnapshot(spec), spec.sourceFile)).toEqual(
      spec,
    );
  });

  it('rejects unknown variables and duplicate identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-spec-invalid-'));
    roots.push(root);
    mkdirSync(join(root, 'workspace'));
    const source = join(root, 'mission.yaml');
    writeFileSync(
      source,
      `schemaVersion: missionbraid.dev/mission/v1
title: Fixture
objective: Complete it
workspace: \${UNKNOWN}
acceptanceCriteria: []
attemptPlan: []
`,
    );
    expect(() => loadMissionSpec(source)).toThrow(MissionSpecError);
  });

  it('refuses verifier environment values before they can enter a snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-spec-secret-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const source = join(root, 'mission.yaml');
    writeFileSync(
      source,
      `schemaVersion: missionbraid.dev/mission/v1
title: Fixture
objective: Complete it
workspace: ${JSON.stringify(workspace)}
acceptanceCriteria:
  - id: tests
    description: Tests pass
    verifier:
      kind: command
      executable: node
      args: [--test]
      cwd: ${JSON.stringify(workspace)}
      env:
        OPENAI_API_KEY: sk-proj-fixture-private-value
      timeoutMs: 1000
attemptPlan:
  - stageId: source
    profile:
      harness: codex
      model: default
      injectionBudgetTokens: 8000
    instruction: Implement the core
`,
    );

    expect(() => loadMissionSpec(source, { workspace })).toThrow(
      /Verifier env values cannot enter the Mission Kernel/,
    );
  });

  it('loads an explicit multi-Agent Mission plan and restores it without losing bindings', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-spec-plan-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const source = join(root, 'mission.yaml');
    writeFileSync(source, explicitPlanFixture(workspace));

    const spec = loadMissionSpec(source);
    expect(spec.plan?.nodes).toHaveLength(3);
    expect(spec.plan?.nodes.find((node) => node.kind === 'join')).toMatchObject({
      nodeId: 'consolidate',
      stageId: 'consolidate-agent',
      requirementIds: ['objective', 'acceptance-behavior'],
      acceptanceCriterionIds: ['behavior'],
    });
    expect(spec.plan?.edges).toEqual([
      {
        fromNodeId: 'tool-implementation',
        toNodeId: 'consolidate',
        relation: 'join-input',
        evidenceRefs: ['decision:initial-plan'],
      },
      {
        fromNodeId: 'prompt-policy',
        toNodeId: 'consolidate',
        relation: 'join-input',
        evidenceRefs: ['decision:initial-plan'],
      },
    ]);
    expect(restoreMissionSpecSnapshot(createMissionSpecSnapshot(spec), spec.sourceFile)).toEqual(
      spec,
    );
  });

  it('rejects unknown plan references, duplicate stage bindings, and a join without an Agent stage', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-spec-plan-invalid-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const fixture = explicitPlanFixture(workspace);
    const invalidFixtures = [
      fixture.replace(
        'requirementIds: [objective, constraint-1, acceptance-behavior]',
        'requirementIds: [objective, constraint-99, acceptance-behavior]',
      ),
      fixture.replace('acceptanceCriterionIds: [behavior]', 'acceptanceCriterionIds: [missing]'),
      fixture.replace(
        '    stageId: prompt-agent\n    acceptanceCriterionIds:',
        '    stageId: tool-agent\n    acceptanceCriterionIds:',
      ),
      fixture.replace('    stageId: consolidate-agent\n', ''),
    ];

    invalidFixtures.forEach((yaml, index) => {
      const source = join(root, `invalid-${index}.yaml`);
      writeFileSync(source, yaml);
      expect(() => loadMissionSpec(source)).toThrow(MissionSpecError);
    });
  });
});

function explicitPlanFixture(workspace: string): string {
  return `schemaVersion: missionbraid.dev/mission/v1
title: Multi-Agent fixture
objective: Build and consolidate the feature
workspace: ${JSON.stringify(workspace)}
constraints:
  - Preserve the tool implementation
  - Return a Chinese status
acceptanceCriteria:
  - id: behavior
    description: Behavior is correct
    verifier:
      kind: command
      executable: node
      args: [--test]
      cwd: ${JSON.stringify(workspace)}
      timeoutMs: 1000
attemptPlan:
  - stageId: tool-agent
    profile:
      harness: qoder
      model: qwen3.8-max
      injectionBudgetTokens: 8000
    instruction: Implement the tool
  - stageId: prompt-agent
    profile:
      harness: claude
      model: default
      injectionBudgetTokens: 8000
    instruction: Implement the prompt policy
  - stageId: consolidate-agent
    profile:
      harness: qoder
      model: qwen3.8-max
      injectionBudgetTokens: 8000
    instruction: Consolidate verified inputs
plan:
  nodes:
  - nodeId: tool-implementation
    kind: task
    title: Implement tool
    requirementIds: [objective, constraint-1, acceptance-behavior]
    stageId: tool-agent
    acceptanceCriterionIds: [behavior]
    declaredOutputKeys: [tool-artifact]
    requiredAuthorityScopes: [workspace]
  - nodeId: prompt-policy
    kind: task
    title: Implement prompt policy
    requirementIds: [objective, constraint-2, acceptance-behavior]
    stageId: prompt-agent
    acceptanceCriterionIds: [behavior]
    declaredOutputKeys: [prompt-artifact]
    requiredAuthorityScopes: [workspace]
  - nodeId: consolidate
    kind: join
    title: Consolidate outputs
    requirementIds: [objective, acceptance-behavior]
    stageId: consolidate-agent
    acceptanceCriterionIds: [behavior]
    declaredOutputKeys: [combined-artifact]
    requiredAuthorityScopes: [workspace]
  edges:
  - fromNodeId: tool-implementation
    toNodeId: consolidate
    relation: join-input
    evidenceRefs: ["decision:initial-plan"]
  - fromNodeId: prompt-policy
    toNodeId: consolidate
    relation: join-input
    evidenceRefs: ["decision:initial-plan"]
`;
}
