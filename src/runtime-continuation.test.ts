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
import { DOMAIN_SCHEMA_VERSION, type ContractV1, type ProfileV1 } from './domain.js';
import type { RuntimeContinuationInputV1, RuntimeForkEvidenceV1 } from './execution-fork.js';
import {
  NativeAdapterRuntimeContinuationPort,
  RuntimeContinuationConfigurationError,
  buildRuntimeContinuationPrompt,
  type NativeAdapterRuntimeContinuationOptionsV1,
  type RuntimeContinuationAdaptersV1,
  type RuntimeContinuationCheckpointBindingV1,
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

  for (const harness of ['codex', 'qoder', 'claude'] as const) {
    it(`accepts a terminal ${harness} tool result as execution evidence without treating a request as execution`, async () => {
      const fixture = await createFixture(harness, 'result-only');

      const result = await fixture.port.continueFromCheckpoint(fixture.input);

      expect(result.status).toBe('completed');
      expect(result.toolExecutionEvidenceRefs).toHaveLength(1);
      expect(result.verificationEvidenceRefs).toHaveLength(1);
    });

    it(`returns a terminal failed result for a ${harness} request-only transcript`, async () => {
      const fixture = await createFixture(harness, 'request-only');

      const result = await fixture.port.continueFromCheckpoint(fixture.input);

      expect(result.status).toBe('failed');
      expect(result.toolExecutionEvidenceRefs).toEqual([]);
      expect(result.unresolvedItems).toContain('tool-completion-evidence:missing');
      expect(
        fixture.evidence.some((entry) =>
          entry.evidenceRefs.includes('tool-completion-evidence:missing'),
        ),
      ).toBe(true);
    });
  }

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

  it('maps verifier cwd, executable, exact path args, and embedded path args from A to B', async () => {
    const fixture = await createFixture('codex', 'success', {
      sourceResult: 'not-verified\n',
      verifierInsideWorkspace: true,
    });
    expect(runSourceVerifier(fixture)).toBe(false);

    const result = await fixture.port.continueFromCheckpoint(fixture.input);

    expect(result.status).toBe('completed');
    expect(await readFile(join(fixture.child, 'result.txt'), 'utf8')).toBe('verified\n');
    expect(await readFile(join(fixture.source, 'result.txt'), 'utf8')).toBe('not-verified\n');
  });

  it('rejects incomplete or duplicate Contract criterion sets', async () => {
    const fixture = await createFixture('codex', 'success');
    const secondVerifier = {
      ...fixture.missionSpec.acceptanceCriteria[0]!.verifier,
      args: ['-e', 'process.exit(0)'],
    };
    const missionSpec: ResolvedMissionSpecV1 = {
      ...fixture.missionSpec,
      acceptanceCriteria: [
        ...fixture.missionSpec.acceptanceCriteria,
        {
          id: 'second-criterion',
          description: 'A distinct second criterion.',
          verifier: secondVerifier,
        },
      ],
    };
    const duplicatedContract: ContractV1 = {
      ...fixture.contract,
      acceptanceCriteria: [
        fixture.contract.acceptanceCriteria[0]!,
        fixture.contract.acceptanceCriteria[0]!,
      ],
    };

    expect(
      () =>
        new NativeAdapterRuntimeContinuationPort({
          ...fixture.portOptions,
          acceptedContract: duplicatedContract,
          acceptedMissionSpec: missionSpec,
        }),
    ).toThrow(/complete unique Mission criterion set/);
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

    await expect(
      fixture.port.continueFromCheckpoint({
        ...fixture.input,
        parentCheckpointId: 'checkpoint-drifted',
      }),
    ).rejects.toThrow(/Checkpoint .* is not accepted/);

    expect(
      () =>
        new NativeAdapterRuntimeContinuationPort({
          ...fixture.portOptions,
          acceptedProfile: { ...fixture.profile, model: 'drifted-model' },
        }),
    ).toThrow(/does not match stage/);
  });
});

type FakeBehavior = 'success' | 'result-only' | 'request-only' | 'process-failure' | 'bad-child';

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly child: string;
  readonly stateDir: string;
  readonly stage: AttemptStageSpecV1;
  readonly contract: ContractV1;
  readonly missionSpec: ResolvedMissionSpecV1;
  readonly checkpoint: RuntimeContinuationCheckpointBindingV1;
  readonly profile: ProfileV1;
  readonly input: RuntimeContinuationInputV1;
  readonly evidence: RuntimeForkEvidenceV1[];
  readonly port: NativeAdapterRuntimeContinuationPort;
  readonly portOptions: NativeAdapterRuntimeContinuationOptionsV1;
}

async function createFixture(
  harness: SupportedHarnessV1,
  behavior: FakeBehavior,
  options: {
    readonly sourceResult?: string;
    readonly verifierInsideWorkspace?: boolean;
  } = {},
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
  const workspaceVerifier = join(source, 'verify-result.js');
  if (options.verifierInsideWorkspace === true) {
    await writeFile(
      workspaceVerifier,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const exactWorkspace = process.argv[2];
const embeddedWorkspace = process.argv[3];
const cwd = process.cwd();
if (exactWorkspace !== cwd || embeddedWorkspace !== '--workspace=' + cwd) process.exit(8);
process.exit(fs.readFileSync(path.join(exactWorkspace, 'result.txt'), 'utf8') === 'verified\\n' ? 0 : 7);
`,
      'utf8',
    );
    await chmod(workspaceVerifier, 0o755);
  }
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'base']);
  git(source, ['worktree', 'add', '-b', `child-${harness}-${behavior}`, child]);

  const command = await writeFakeHarness(root, harness, behavior);
  const verifierArgs =
    options.verifierInsideWorkspace === true
      ? [source, `--workspace=${source}`]
      : [
          '-e',
          "const fs=require('node:fs'); process.exit(fs.readFileSync('result.txt','utf8')==='verified\\n'?0:7)",
        ];
  const verifier = {
    kind: 'command' as const,
    executable: options.verifierInsideWorkspace === true ? workspaceVerifier : process.execPath,
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
  const profile: ProfileV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: `profile-${harness}`,
    harness: stage.profile.harness,
    model: stage.profile.model,
    ...(stage.profile.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: stage.profile.reasoningEffort }),
    ...(stage.profile.permissionMode === undefined
      ? {}
      : { permissionMode: stage.profile.permissionMode }),
    injectionBudgetTokens: stage.profile.injectionBudgetTokens,
    capabilities: [],
    configurationDigest: hashPayload(stage.profile),
  };
  const checkpoint: RuntimeContinuationCheckpointBindingV1 = {
    checkpointId: 'checkpoint-a',
    missionId: 'mission-runtime-continuation',
    contractId: contract.contractId,
    profileId: profile.profileId,
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
    parentCheckpointId: checkpoint.checkpointId,
    workspacePath: child,
    intervention,
    inheritedExternalEffectFrontier: [] as readonly CheckpointEffectFrontierEntryV1[],
    externalEffectDecisions: [],
    appendEvidence: async (entry) => {
      evidence.push(entry);
    },
  };
  const portOptions: NativeAdapterRuntimeContinuationOptionsV1 = {
    missionId: input.missionId,
    acceptedContract: contract,
    acceptedMissionSpec: missionSpec,
    acceptedStage: stage,
    acceptedCheckpoint: checkpoint,
    acceptedProfile: profile,
    acceptedIntervention: intervention,
    controllerStateDir: stateDir,
    adapters: adapterBinding(harness, command),
    now: () => new Date(NOW),
  };
  const port = new NativeAdapterRuntimeContinuationPort(portOptions);
  return {
    root,
    source,
    child,
    stateDir,
    stage,
    contract,
    missionSpec,
    checkpoint,
    profile,
    input,
    evidence,
    port,
    portOptions,
  };
}

async function writeFakeHarness(
  root: string,
  harness: SupportedHarnessV1,
  behavior: FakeBehavior,
): Promise<string> {
  const command = join(root, `fake-harness-${behavior}`);
  const requestEvent =
    harness === 'codex'
      ? {
          type: 'item.started',
          item: {
            id: 'tool-1',
            type: 'command_execution',
            command: 'write result.txt',
            status: 'in_progress',
            input: { authorization: `Bearer ${SECRET}` },
          },
        }
      : {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'write_file',
                input: { authorization: `Bearer ${SECRET}` },
              },
            ],
          },
        };
  const resultEvent =
    harness === 'codex'
      ? {
          type: 'item.completed',
          item: {
            id: 'tool-1',
            type: 'command_execution',
            command: 'write result.txt',
            status: 'completed',
            exit_code: 0,
          },
        }
      : {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'write completed',
                is_error: false,
              },
            ],
          },
        };
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
  ${behavior === 'result-only' ? '' : `process.stdout.write(${JSON.stringify(`${JSON.stringify(requestEvent)}\n`)});`}
  ${behavior === 'request-only' ? '' : `process.stdout.write(${JSON.stringify(`${JSON.stringify(resultEvent)}\n`)});`}
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
    const verifier = fixture.missionSpec.acceptanceCriteria[0]!.verifier;
    execFileSync(verifier.executable, [...verifier.args], {
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
