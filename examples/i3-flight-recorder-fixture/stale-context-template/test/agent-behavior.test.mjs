import assert from 'node:assert/strict';
import test from 'node:test';

import { answer } from '../src/agent.mjs';

test('the Agent behavior keeps the configured prefix contract', async () => {
  console.error('sanitization fixture: password=missionbraid-fake-value');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.match(await answer('context evidence'), /^[A-Z]+: context evidence$/);
});
