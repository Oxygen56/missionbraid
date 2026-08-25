#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(repositoryRoot, 'examples', 'i4-tool-gateway-fixture', 'template');
const requested = process.argv[2];
if (requested === undefined) throw new Error('Expected a new fixture directory path.');
const workspace = resolve(requested);
if (existsSync(workspace)) throw new Error(`Refusing to overwrite ${workspace}`);
mkdirSync(workspace, { recursive: true });
cpSync(template, workspace, { recursive: true, force: false, errorOnExist: true });
run('git', ['init', '-q']);
run('git', ['add', '.']);
run('git', [
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'controlled Iteration 4 fixture',
]);
process.stdout.write(`${JSON.stringify({ workspace: realpathSync(workspace) })}\n`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
}
