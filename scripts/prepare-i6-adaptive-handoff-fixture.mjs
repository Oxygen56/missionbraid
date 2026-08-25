#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(repositoryRoot, 'examples', 'i6-adaptive-handoff-fixture', 'template');
const requested = process.argv[2];
const requestedMode = process.argv[3] ?? 'adaptive';
if (requested === undefined) throw new Error('Expected a new fixture directory path.');
if (requestedMode !== 'adaptive' && requestedMode !== 'primary-success') {
  throw new Error('Fixture mode must be adaptive or primary-success.');
}
const workspace = resolve(requested);
if (existsSync(workspace)) throw new Error(`Refusing to overwrite ${workspace}`);
mkdirSync(workspace, { recursive: true });
cpSync(template, workspace, { recursive: true, force: false, errorOnExist: true });
writeFileSync(
  join(workspace, 'task-mode.txt'),
  requestedMode === 'adaptive' ? 'ADAPTIVE\n' : 'PRIMARY-SUCCESS\n',
  'utf8',
);
run('git', ['init', '-q', '-b', 'main']);
run('git', ['add', '.']);
run('git', [
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  `controlled Iteration 6 ${requestedMode} fixture`,
]);
const baseline = spawnSync(process.execPath, ['verify.mjs'], {
  cwd: workspace,
  encoding: 'utf8',
  shell: false,
});
if (baseline.status === 0) throw new Error('Iteration 6 fixture unexpectedly passes.');
process.stdout.write(
  `${JSON.stringify({
    workspace: realpathSync(workspace),
    mode: requestedMode,
    baseline: 'failing-as-designed',
    baselineExitCode: baseline.status,
    head: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
    tree: run('git', ['rev-parse', 'HEAD^{tree}']).stdout.trim(),
  })}\n`,
);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result;
}
