import assert from 'node:assert/strict';
import test from 'node:test';

import { disposableLedger } from '../fixture-support.mjs';
import { main } from '../src/cli.mjs';

async function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = await main(args, {
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  });
  return { status, stdout, stderr };
}

test('CLI record is idempotent and replay emits ordered JSONL', async (t) => {
  const filePath = await disposableLedger(t);
  const first = await runCli(['record', filePath, 'artifact:one', '{"digest":"abc","size":3}']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'recorded');

  const repeated = await runCli(['record', filePath, 'artifact:one', '{"size":3,"digest":"abc"}']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, 'replayed');

  const second = await runCli(['record', filePath, 'artifact:two', '{"digest":"def"}']);
  assert.equal(second.status, 0, second.stderr);

  const replay = await runCli(['replay', filePath]);
  assert.equal(replay.status, 0, replay.stderr);
  const effects = replay.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    effects.map((effect) => effect.key),
    ['artifact:one', 'artifact:two'],
  );
});

test('CLI reports payload conflicts without changing the ledger', async (t) => {
  const filePath = await disposableLedger(t);
  assert.equal((await runCli(['record', filePath, 'publish:one', '{"revision":"a"}'])).status, 0);

  const conflict = await runCli(['record', filePath, 'publish:one', '{"revision":"b"}']);
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stderr).error.code, 'EFFECT_PAYLOAD_CONFLICT');

  const replay = await runCli(['replay', filePath]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.stdout.trim().split('\n').length, 1);
});

test('CLI returns usage status for missing arguments and invalid JSON', async (t) => {
  const filePath = await disposableLedger(t);
  assert.equal((await runCli([])).status, 64);
  assert.equal((await runCli(['record', filePath, 'bad-json', '{'])).status, 64);
});
