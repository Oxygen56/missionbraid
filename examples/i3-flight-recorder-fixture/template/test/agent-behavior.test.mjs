import assert from 'node:assert/strict';
import test from 'node:test';

import { answer } from '../src/agent.mjs';

test('the Agent labels answers with their visible evidence source', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(await answer('fixture evidence'), 'SOURCE: fixture evidence');
});
