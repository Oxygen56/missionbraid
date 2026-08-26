#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv[2];
if (requested === undefined) throw new Error('Expected a new fixture directory path.');
const workspace = resolve(requested);
if (existsSync(workspace)) throw new Error(`Refusing to overwrite ${workspace}`);

mkdirSync(workspace, { recursive: true });
cpSync(join(repositoryRoot, 'examples', 'i8-multi-agent-revision-fixture', 'template'), workspace, {
  recursive: true,
  force: false,
  errorOnExist: true,
});
cpSync(join(repositoryRoot, 'examples', 'v1-flagship-fixture', 'template'), workspace, {
  recursive: true,
  force: true,
});

for (const file of [
  'fixture-contract.mjs',
  'hold-open.mjs',
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
  'flagship baseline with stale Context source',
]);

const { snapshotGitWorkspace } = await import('../dist/src/workspace.js');
const baseline = snapshotGitWorkspace(workspace);
const runtimeDirectory = join(workspace, '.missionbraid');
mkdirSync(runtimeDirectory, { recursive: true });
writeFileSync(
  join(runtimeDirectory, 'context-cache.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'missionbraid.dev/context-cache/v1',
      contextFactId: 'agent-behavior-source',
      boundWorkspaceDigest: baseline.workspaceDigest,
      content: '{"requiredPrefix":"OLD:","source":"baseline"}',
    },
    null,
    2,
  )}\n`,
  { encoding: 'utf8', mode: 0o600 },
);
writeFileSync(
  join(runtimeDirectory, 'contract-revision.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'missionbraid.dev/contract-revision/v1',
      contractRevisionId: 'contract-revision-flagship-bootstrap-1',
      missionId: 'mission-flagship-pending',
      revisionNumber: 1,
      requirements: [
        {
          requirementId: 'acceptance-context-current',
          statement:
            'The Agent behavior configuration matches the accepted current Context source.',
        },
        {
          requirementId: 'acceptance-tool-behavior',
          statement: 'The deterministic policy lookup satisfies the declared behavior.',
        },
        {
          requirementId: 'acceptance-prompt-schema',
          statement:
            'Both the prompt and Skill require exactly classification from tool.decision and rationale from tool.rationale.',
        },
        {
          requirementId: 'acceptance-final-outcome',
          statement: 'The assembled Agent satisfies the active Contract revision.',
        },
      ],
    },
    null,
    2,
  )}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

writeFileSync(
  join(workspace, 'context-source.json'),
  '{"requiredPrefix":"SOURCE:","source":"current"}\n',
  'utf8',
);
run('git', ['add', 'context-source.json']);
run('git', [
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'advance flagship Context source',
]);
const current = snapshotGitWorkspace(workspace);
if (current.workspaceDigest === baseline.workspaceDigest) {
  throw new Error('The flagship Context source did not advance the workspace frontier.');
}

const baselineExitCodes = Object.fromEntries(
  ['verify-tool-node.mjs', 'verify-prompt-node.mjs', 'verify-final.mjs'].map((file) => {
    const result = spawnSync(process.execPath, [file], {
      cwd: workspace,
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, MISSIONBRAID_TARGET_WORKSPACE: workspace },
    });
    if (result.status === 0) throw new Error(`${file} unexpectedly passed the stub baseline.`);
    return [file, result.status];
  }),
);

process.stdout.write(
  `${JSON.stringify({
    workspace: realpathSync(workspace),
    baselineWorkspaceDigest: baseline.workspaceDigest,
    currentWorkspaceDigest: current.workspaceDigest,
    head: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
    tree: run('git', ['rev-parse', 'HEAD^{tree}']).stdout.trim(),
    baselineExitCodes,
  })}\n`,
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}
