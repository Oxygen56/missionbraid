import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const baselineDirectory = resolve(sourceDirectory, '..', 'e1-fixture', 'template');
const protectedPaths = [
  'fixture-support.mjs',
  'test/core.test.mjs',
  'test/conflict-and-recovery.test.mjs',
  'test/cli.test.mjs',
];
const workspaceValue = process.env.MISSIONBRAID_TARGET_WORKSPACE;
assert.ok(workspaceValue && isAbsolute(workspaceValue), 'target workspace is required');
const workspace = await realpath(workspaceValue);

for (const path of protectedPaths) {
  assert.equal(
    await sha256File(join(workspace, path)),
    await sha256File(join(baselineDirectory, path)),
    `${path} differs from the committed fixture`,
  );
}

const result = spawnSync(process.execPath, ['--test'], {
  cwd: workspace,
  encoding: 'utf8',
  env: cleanEnvironment(),
  shell: false,
  timeout: 20_000,
  killSignal: 'SIGKILL',
  maxBuffer: 1_048_576,
});
assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function cleanEnvironment() {
  const environment = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  for (const key of ['PATH', 'HOME', 'TMPDIR']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}
