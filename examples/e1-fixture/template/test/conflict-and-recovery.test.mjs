import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { EffectConflictError, EffectLedger, LedgerCorruptionError } from '../src/ledger.mjs';
import { disposableLedger, readCommittedLines } from '../fixture-support.mjs';

test('same key with a different payload is a non-mutating conflict', async (t) => {
  const filePath = await disposableLedger(t);
  const ledger = new EffectLedger(filePath);
  await ledger.record({ key: 'release:demo', payload: { revision: 'one' } });

  await assert.rejects(
    ledger.record({ key: 'release:demo', payload: { revision: 'two' } }),
    (error) =>
      error instanceof EffectConflictError &&
      error.code === 'EFFECT_PAYLOAD_CONFLICT' &&
      error.key === 'release:demo',
  );

  assert.equal((await readCommittedLines(filePath)).length, 1);
  assert.deepEqual((await ledger.replay())[0].payload, { revision: 'one' });
});

test('an incomplete final line is discarded before replay and append', async (t) => {
  const filePath = await disposableLedger(t);
  await new EffectLedger(filePath).record({
    key: 'step:one',
    payload: { state: 'committed' },
  });
  await appendFile(filePath, '{"schemaVersion":1,"key":"crash', 'utf8');

  const restarted = new EffectLedger(filePath);
  assert.deepEqual(
    (await restarted.replay()).map((effect) => effect.key),
    ['step:one'],
  );
  await restarted.record({ key: 'step:two', payload: { state: 'committed' } });

  assert.deepEqual(
    (await restarted.replay()).map((effect) => effect.key),
    ['step:one', 'step:two'],
  );
  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.includes('"key":"crash'), false);
});

test('malformed committed JSON is reported as corruption', async (t) => {
  const filePath = await disposableLedger(t);
  await writeFile(filePath, '{"schemaVersion":1,bad}\n', 'utf8');

  await assert.rejects(
    new EffectLedger(filePath).replay(),
    (error) => error instanceof LedgerCorruptionError && error.code === 'LEDGER_CORRUPT',
  );
});

test('a committed record with an unknown schema is corruption', async (t) => {
  const filePath = await disposableLedger(t);
  await writeFile(filePath, '{"schemaVersion":2,"key":"future","payload":{}}\n', 'utf8');

  await assert.rejects(
    new EffectLedger(filePath).replay(),
    (error) => error instanceof LedgerCorruptionError && error.code === 'LEDGER_CORRUPT',
  );
});

test('a committed record with an extra top-level field is corruption', async (t) => {
  const filePath = await disposableLedger(t);
  await writeFile(
    filePath,
    '{"schemaVersion":1,"key":"effect","payload":{},"unexpected":true}\n',
    'utf8',
  );

  await assert.rejects(
    new EffectLedger(filePath).replay(),
    (error) => error instanceof LedgerCorruptionError && error.code === 'LEDGER_CORRUPT',
  );
});
