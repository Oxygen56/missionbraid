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
});
