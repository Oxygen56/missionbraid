#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(repositoryRoot, 'examples', 'i8-multi-agent-revision-fixture');
const template = join(fixtureRoot, 'template');
const missionFile = join(fixtureRoot, 'mission.yaml');
const requested = process.argv[2];

if (requested === undefined) throw new Error('Expected a new fixture directory path.');
const workspace = resolve(requested);
if (existsSync(workspace)) throw new Error(`Refusing to overwrite ${workspace}`);

mkdirSync(workspace, { recursive: true });
cpSync(template, workspace, { recursive: true, force: false, errorOnExist: true });

for (const file of [
  'hold-open.mjs',
  'fixture-contract.mjs',
  'verify-tool-node.mjs',
  'verify-prompt-node.mjs',
  'verify-final.mjs',
  'src/agent.mjs',
  'src/tools/policy-lookup.mjs',
]) {
  run(process.execPath, ['--check', file]);
}

run('git', ['init', '-q', '-b', 'main']);
run('git', ['add', '.']);
run('git', [
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'controlled Iteration 8 multi-Agent revision baseline',
]);

const runtimeStateDirectory = join(workspace, '.missionbraid');
const contractRevisionFile = join(runtimeStateDirectory, 'contract-revision.json');
mkdirSync(runtimeStateDirectory, { recursive: true });
writeFileSync(
  contractRevisionFile,
  `${JSON.stringify({
    schemaVersion: 'missionbraid.dev/contract-revision/v1',
    contractRevisionId: 'contract-revision-fixture-1',
    missionId: 'mission-fixture',
    revisionNumber: 1,
    requirements: [
      {
        requirementId: 'acceptance-tool-behavior',
        statement:
          'The policy lookup tool deterministically returns policy fields and rejects malformed input.',
      },
      {
        requirementId: 'acceptance-prompt-schema',
        statement:
          'Both the prompt and Skill require exactly classification from tool.decision and rationale from tool.rationale.',
      },
      {
        requirementId: 'acceptance-final-outcome',
        statement: 'The consolidation workspace satisfies the active Contract.',
      },
    ],
  })}\n`,
  'utf8',
);

const baselineTool = runExpectedFailure(process.execPath, ['verify-tool-node.mjs']);
const baselinePrompt = runExpectedFailure(process.execPath, ['verify-prompt-node.mjs']);
const baselineFinal = runExpectedFailure(process.execPath, ['verify-final.mjs']);

process.stdout.write(
  `${JSON.stringify({
    workspace: realpathSync(workspace),
    missionFile: realpathSync(missionFile),
    contractRevisionFile: realpathSync(contractRevisionFile),
    baseline: {
      toolExitCode: baselineTool.status,
      promptExitCode: baselinePrompt.status,
      finalExitCode: baselineFinal.status,
    },
    head: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
    tree: run('git', ['rev-parse', 'HEAD^{tree}']).stdout.trim(),
  })}\n`,
);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function runExpectedFailure(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, MISSIONBRAID_TARGET_WORKSPACE: workspace },
  });
  if (result.status === 0) {
    throw new Error(`${command} ${args.join(' ')} unexpectedly passed in the baseline fixture`);
  }
  return result;
}
