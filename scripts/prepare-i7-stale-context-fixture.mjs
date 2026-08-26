#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(
  repositoryRoot,
  'examples',
  'i3-flight-recorder-fixture',
  'stale-context-template',
);
const requested = process.argv[2];
if (requested === undefined) throw new Error('Expected a new fixture directory path.');
const workspace = resolve(requested);
if (existsSync(workspace)) throw new Error(`Refusing to overwrite ${workspace}`);
mkdirSync(workspace, { recursive: true });
cpSync(template, workspace, { recursive: true, force: false, errorOnExist: true });
run('git', ['init', '-q', '-b', 'main']);
run('git', ['add', '.']);
run('git', [
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'stale Context baseline',
]);
const baseline = spawnSync(process.execPath, ['--test'], {
  cwd: workspace,
  encoding: 'utf8',
  shell: false,
});
if (baseline.status !== 0) {
  throw new Error(`Stale Context fixture structural baseline failed: ${baseline.stderr}`);
}
process.stdout.write(
  `${JSON.stringify({ workspace: realpathSync(workspace), baselineExitCode: baseline.status })}\n`,
);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
}
