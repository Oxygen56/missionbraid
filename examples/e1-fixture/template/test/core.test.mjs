import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import { EffectLedger } from '../src/ledger.mjs';
import { disposableLedger, readCommittedLines } from '../fixture-support.mjs';

test('record persists an effect and replay restores it', async (t) => {
  const filePath = await disposableLedger(t);
  const ledger = new EffectLedger(filePath);
  const effect = {
    schemaVersion: 1,
    key: 'artifact:report',
    payload: { digest: 'sha256:abc', complete: true },
  };

  assert.deepEqual(await ledger.record({ key: effect.key, payload: effect.payload }), {
    status: 'recorded',
    effect,
  });
  await access(filePath);
  assert.deepEqual(await new EffectLedger(filePath).replay(), [effect]);
  assert.equal((await readCommittedLines(filePath)).length, 1);
  assert.equal(
    await readFile(filePath, 'utf8'),
    '{"schemaVersion":1,"key":"artifact:report","payload":{"complete":true,"digest":"sha256:abc"}}\n',
  );
});

test('a missing ledger replays as an empty sequence', async (t) => {
  const filePath = await disposableLedger(t);
  assert.deepEqual(await new EffectLedger(filePath).replay(), []);
});

test('same key and equivalent payload is an idempotent replay', async (t) => {
  const filePath = await disposableLedger(t);
  const ledger = new EffectLedger(filePath);

  await ledger.record({
    key: 'workspace:checkpoint',
    payload: { revision: 'abc', files: ['a.js', 'b.js'] },
  });
  const replayed = await ledger.record({
    key: 'workspace:checkpoint',
    payload: { files: ['a.js', 'b.js'], revision: 'abc' },
  });

  assert.equal(replayed.status, 'replayed');
  assert.equal(replayed.effect.key, 'workspace:checkpoint');
  assert.deepEqual(replayed.effect.payload, {
    revision: 'abc',
    files: ['a.js', 'b.js'],
  });
  assert.equal((await readCommittedLines(filePath)).length, 1);
});

test('the stage-owned core exposes deterministic JSON operations', async () => {
  const core = await import('../src/effect-core.mjs');
  assert.equal(core.canonicalJson({ z: 1, a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":1}');
  assert.equal(
    core.payloadsEqual(
      { nested: { y: 2, x: 1 }, list: [{ b: 2, a: 1 }] },
      { list: [{ a: 1, b: 2 }], nested: { x: 1, y: 2 } },
    ),
    true,
  );
  assert.equal(
    core.serializeEffect(core.createEffect({ key: 'core:one', payload: { z: 2, a: 1 } })),
    '{"schemaVersion":1,"key":"core:one","payload":{"a":1,"z":2}}',
  );
});
