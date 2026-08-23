#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(repositoryRoot, 'examples', 'e1-fixture', 'template');
const requested = process.argv[2];
const workspace =
  requested === undefined
    ? mkdtempSync(join(tmpdir(), 'missionbraid-e1-'))
    : prepareEmptyDirectory(resolve(requested));

cpSync(template, workspace, { recursive: true, force: false, errorOnExist: true });
run('git', ['init', '-q'], workspace);
run('git', ['add', '.'], workspace);
run(
  'git',
  [
    '-c',
    'user.name=MissionBraid',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'controlled E1 fixture',
  ],
  workspace,
);
const baseline = spawnSync(process.execPath, ['--test'], {
  cwd: workspace,
  encoding: 'utf8',
  env: minimalEnvironment(),
  shell: false,
});
if (baseline.status === 0) {
  throw new Error('E1 template unexpectedly satisfies its public contract before any Attempt');
}

process.stdout.write(
  `${JSON.stringify(
    {
      workspace: realpathSync(workspace),
      baseline: 'failing-as-designed',
      baselineExitCode: baseline.status,
    },
    null,
    2,
  )}\n`,
);

function prepareEmptyDirectory(path) {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite an existing path: ${path}`);
  }
  mkdirSync(path, { recursive: true });
  return path;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${String(result.status)}: ${result.stderr}`);
  }
}

function minimalEnvironment() {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LC_') && value !== undefined) environment[key] = value;
  }
  return environment;
}
