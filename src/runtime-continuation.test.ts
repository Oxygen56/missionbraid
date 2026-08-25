import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { QoderAdapter } from './adapters/qoder.js';
import type { RuntimeAdapter } from './adapters/types.js';
import type {
  CheckpointEffectFrontierEntryV1,
  CheckpointInterventionV1,
} from './composite-checkpoint.js';
import { DOMAIN_SCHEMA_VERSION, type ContractV1 } from './domain.js';
import type { RuntimeContinuationInputV1, RuntimeForkEvidenceV1 } from './execution-fork.js';
import {
  NativeAdapterRuntimeContinuationPort,
  RuntimeContinuationConfigurationError,
  buildRuntimeContinuationPrompt,
  type RuntimeContinuationAdaptersV1,
} from './runtime-continuation.js';
import {
  MISSION_SPEC_VERSION,
  type AttemptStageSpecV1,
  type ResolvedMissionSpecV1,
  type SupportedHarnessV1,
} from './spec.js';
import { hashPayload } from './store.js';

const NOW = '2026-08-26T03:00:00.000Z';
const SECRET = 'sk-proj-native-output-must-be-redacted';
const disposableRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    disposableRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe('native Adapter RuntimeContinuationPort', () => {
  for (const harness of ['codex', 'qoder', 'claude'] as const) {
    it(`runs a fresh ${harness} process in the isolated worktree and completes only with tool and verifier proof`, async () => {
      const fixture = await createFixture(harness, 'success');

      const result = await fixture.port.continueFromCheckpoint(fixture.input);

      expect(result).toMatchObject({
        status: 'completed',
        unresolvedItems: [],
      });
      expect(result.toolExecutionEvidenceRefs).toHaveLength(1);
      expect(result.verificationEvidenceRefs).toHaveLength(1);
      expect(await readFile(join(fixture.child, 'result.txt'), 'utf8')).toBe('verified\n');
      await expect(readFile(join(fixture.source, 'result.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(fixture.child, 'runtime-cwd.txt'), 'utf8')).toBe(
        await realpath(fixture.child),
      );
      const argv = JSON.parse(
        await readFile(join(fixture.child, 'runtime-argv.json'), 'utf8'),
      ) as string[];
      expect(argv.some((argument) => /resume|fork/i.test(argument))).toBe(false);
      expect(new Set(fixture.evidence.map((entry) => entry.kind))).toEqual(
        new Set(['runtime', 'model', 'tool', 'workspace', 'verification']),
      );
      expect(JSON.stringify(fixture.evidence)).not.toContain(SECRET);
      const retainedArtifacts = await readTree(fixture.stateDir);
      expect(retainedArtifacts).not.toContain(SECRET);
      expect(retainedArtifacts).toContain('[REDACTED]');
    });
  }

  it('fails when native output has a tool result but no explicit tool request', async () => {
    const fixture = await createFixture('codex', 'result-only');

    const result = await fixture.port.continueFromCheckpoint(fixture.input);

    expect(result.status).toBe('failed');
    expect(result.toolExecutionEvidenceRefs).toEqual([]);
    expect(result.verificationEvidenceRefs).toHaveLength(1);
    expect(result.unresolvedItems).toContain('tool-request-evidence:missing');
  });

  it('fails on process error even when the tool event and deterministic verifier pass', async () => {
    const fixture = await createFixture('qoder', 'process-failure');

    const result = await fixture.port.continueFromCheckpoint(fixture.input);

    expect(result.status).toBe('failed');
    expect(result.toolExecutionEvidenceRefs).toHaveLength(1);
    expect(result.verificationEvidenceRefs).toHaveLength(1);
    expect(result.unresolvedItems).toContain('runtime-process:failed');
  });

  it('rebinds a verifier that passes in A to B, where the changed child state fails', async () => {
    const fixture = await createFixture('claude', 'bad-child', { sourceResult: 'verified\n' });
    expect(runSourceVerifier(fixture)).toBe(true);

    const result = await fixture.port.continueFromCheckpoint(fixture.input);

    expect(result.status).toBe('failed');
    expect(result.unresolvedItems).toContain('verification:file-written:failed');
    expect(await readFile(join(fixture.source, 'result.txt'), 'utf8')).toBe('verified\n');
    expect(await readFile(join(fixture.child, 'result.txt'), 'utf8')).toBe('not-verified\n');
  });

  it('rebinds a verifier that fails in A to B, where the child change passes', async () => {
    const fixture = await createFixture('codex', 'success', { sourceResult: 'not-verified\n' });
    expect(runSourceVerifier(fixture)).toBe(false);

    const result = await fixture.port.continueFromCheckpoint(fixture.input);

    expect(result.status).toBe('completed');
    expect(await readFile(join(fixture.source, 'result.txt'), 'utf8')).toBe('not-verified\n');
    expect(await readFile(join(fixture.child, 'result.txt'), 'utf8')).toBe('verified\n');
  });

  it('sanitizes the accepted prompt, enforces its byte budget, and rejects binding drift', async () => {
    const fixture = await createFixture('codex', 'success');
    const prompt = buildRuntimeContinuationPrompt(
      fixture.input,
      {
        ...fixture.contract,
        constraints: [...(fixture.contract.constraints ?? []), `Never copy ${SECRET}`],
      },
      fixture.stage,
      8_192,
    );

    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain('[REDACTED]');
    expect(() =>
      buildRuntimeContinuationPrompt(fixture.input, fixture.contract, fixture.stage, 10),
    ).toThrow(/exceeds/);

    const drifted = {
      ...fixture.input,
      intervention: { ...fixture.input.intervention, afterDigest: 'sha256:drifted' },
    };
    await expect(fixture.port.continueFromCheckpoint(drifted)).rejects.toBeInstanceOf(
      RuntimeContinuationConfigurationError,
    );
  });
});

type FakeBehavior = 'success' | 'result-only' | 'process-failure' | 'bad-child';

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly child: string;
  readonly stateDir: string;
  readonly stage: AttemptStageSpecV1;
  readonly contract: ContractV1;
  readonly input: RuntimeContinuationInputV1;
  readonly evidence: RuntimeForkEvidenceV1[];
  readonly port: NativeAdapterRuntimeContinuationPort;
  readonly verifierArgs: readonly string[];
}

async function createFixture(
  harness: SupportedHarnessV1,
  behavior: FakeBehavior,
  options: { readonly sourceResult?: string } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `missionbraid-continuation-${harness}-`));
  disposableRoots.push(root);
  const source = join(root, 'source');
  const child = join(root, 'child');
  const stateDir = join(root, 'state');
  await mkdir(source, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  git(source, ['init']);
  git(source, ['config', 'user.email', 'fixture@example.com']);
  git(source, ['config', 'user.name', 'MissionBraid Fixture']);
  await writeFile(join(source, 'base.txt'), 'base\n', 'utf8');
  if (options.sourceResult !== undefined) {
    await writeFile(join(source, 'result.txt'), options.sourceResult, 'utf8');
  }
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'base']);
  git(source, ['worktree', 'add', '-b', `child-${harness}-${behavior}`, child]);

  const command = await writeFakeHarness(root, behavior);
  const verifierArgs = [
    '-e',
    "const fs=require('node:fs'); process.exit(fs.readFileSync('result.txt','utf8')==='verified\\n'?0:7)",
  ];
  const verifier = {
    kind: 'command' as const,
    executable: process.execPath,
    args: verifierArgs,
    cwd: source,
    env: {},
    timeoutMs: 5_000,
  };
  const stage: AttemptStageSpecV1 = {
    stageId: `stage-${harness}`,
    profile: {
      harness,
      model: `model-${harness}`,
      reasoningEffort: 'medium',
      permissionMode: permissionMode(harness),
      injectionBudgetTokens: 4_096,
    },
    instruction: 'Write result.txt with the exact accepted value and inspect it with a tool.',
    onFailure: 'stop',
  };
  const missionSpec: ResolvedMissionSpecV1 = {
    schemaVersion: MISSION_SPEC_VERSION,
    title: 'Runtime continuation fixture',
    objective: 'Continue the accepted Mission in the isolated child worktree.',
    constraints: ['Keep the source worktree unchanged.'],
    workspace: source,
    missionSourceDir: source,
    acceptanceCriteria: [
      {
        id: 'file-written',
        description: 'The isolated result has the accepted content.',
        verifier,
      },
    ],
    attemptPlan: [stage],
  };
  const contract: ContractV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    contractId: 'contract-runtime-continuation',
    objective: missionSpec.objective,
    constraints: missionSpec.constraints,
    acceptanceCriteria: [
      {
        criterionId: 'file-written',
        description: missionSpec.acceptanceCriteria[0]!.description,
        verifier: {
          kind: 'command',
          configuration: {
            executable: verifier.executable,
            timeoutMs: verifier.timeoutMs,
            environmentKeys: [],
            configurationDigest: hashPayload(verifier),
          },
        },
      },
    ],
    createdAt: NOW,
  };
  const intervention: CheckpointInterventionV1 = {
    interventionId: 'intervention-guidance-child',
    kind: 'guidance',
    targetRef: `stage:${stage.stageId}`,
    beforeDigest: 'sha256:guidance-a',
    afterDigest: 'sha256:guidance-b',
    description: 'Use the accepted child-only guidance.',
    authorityChange: 'unchanged',
  };
  const evidence: RuntimeForkEvidenceV1[] = [];
  const input: RuntimeContinuationInputV1 = {
    forkId: 'fork-runtime-continuation',
    missionId: 'mission-runtime-continuation',
    contractId: contract.contractId,
    parentBranchId: 'branch-a',
    childBranchId: 'branch-b',
    parentCheckpointId: 'checkpoint-a',
    workspacePath: child,
    intervention,
    inheritedExternalEffectFrontier: [] as readonly CheckpointEffectFrontierEntryV1[],
    externalEffectDecisions: [],
    appendEvidence: async (entry) => {
      evidence.push(entry);
    },
  };
  const port = new NativeAdapterRuntimeContinuationPort({
    missionId: input.missionId,
    acceptedContract: contract,
    acceptedMissionSpec: missionSpec,
    acceptedStage: stage,
    acceptedIntervention: intervention,
    controllerStateDir: stateDir,
    adapters: adapterBinding(harness, command),
    now: () => new Date(NOW),
  });
  return {
    root,
    source,
    child,
    stateDir,
    stage,
    contract,
    input,
    evidence,
    port,
    verifierArgs,
  };
}

async function writeFakeHarness(root: string, behavior: FakeBehavior): Promise<string> {
  const command = join(root, `fake-harness-${behavior}`);
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (prompt.includes(${JSON.stringify(SECRET)})) process.exit(91);
  fs.writeFileSync('runtime-cwd.txt', process.cwd());
  fs.writeFileSync('runtime-argv.json', JSON.stringify(process.argv.slice(2)));
  fs.writeFileSync('result.txt', ${JSON.stringify(behavior === 'bad-child' ? 'not-verified\n' : 'verified\n')});
  process.stdout.write(JSON.stringify({ type: 'assistant_message', message: { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'continued' }] } }) + '\\n');
  ${behavior === 'result-only' ? '' : `process.stdout.write(JSON.stringify({ type: 'tool_request', id: 'tool-1', name: 'write_file', input: { authorization: 'Bearer ${SECRET}' } }) + '\\n');`}
  process.stdout.write(JSON.stringify({ type: 'tool_result', tool_use_id: 'tool-1', name: 'write_file', status: 'completed' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'workspace_change', changes: [{ path: 'result.txt', kind: 'updated' }] }) + '\\n');
  process.exit(${behavior === 'process-failure' ? '7' : '0'});
});
`,
    'utf8',
  );
  await chmod(command, 0o755);
  return command;
}

function adapterBinding(
  harness: SupportedHarnessV1,
  command: string,
): Partial<RuntimeContinuationAdaptersV1> {
  const adapter: RuntimeAdapter =
    harness === 'codex'
      ? new CodexAdapter({ command })
      : harness === 'qoder'
        ? new QoderAdapter({ command })
        : new ClaudeAdapter({ command });
  return { [harness]: adapter } as Partial<RuntimeContinuationAdaptersV1>;
}

function permissionMode(harness: SupportedHarnessV1): string {
  if (harness === 'codex') return 'workspace-write';
  if (harness === 'qoder') return 'accept_edits';
  return 'acceptEdits';
}

function runSourceVerifier(fixture: Fixture): boolean {
  try {
    execFileSync(process.execPath, [...fixture.verifierArgs], {
      cwd: fixture.source,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

async function readTree(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    contents.push(await readFile(join(entry.parentPath, entry.name), 'utf8'));
  }
  return contents.join('\n');
}
