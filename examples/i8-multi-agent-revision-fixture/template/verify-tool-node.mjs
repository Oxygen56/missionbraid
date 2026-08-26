#!/usr/bin/env node

import assert from 'node:assert/strict';

import { readActiveContractRevision, requireContractRequirement } from './fixture-contract.mjs';
import { lookupPolicy } from './src/tools/policy-lookup.mjs';

const revision = await readActiveContractRevision();
requireContractRequirement(revision, 'acceptance-tool-behavior');

assert.deepEqual(await lookupPolicy({ product: 'payments', severity: 'high' }), {
  decision: 'manual-review',
  rationale: 'High-severity payment incidents require manual review.',
  evidenceRefs: ['policy:payments-high-risk'],
});
assert.deepEqual(await lookupPolicy({ product: 'delivery', severity: 'low' }), {
  decision: 'auto-resolve',
  rationale: 'Low-severity delivery incidents may be resolved automatically.',
  evidenceRefs: ['policy:delivery-low-risk'],
});
assert.deepEqual(await lookupPolicy({ product: 'search', severity: 'medium' }), {
  decision: 'needs-context',
  rationale: 'No deterministic policy rule matched the incident.',
  evidenceRefs: ['policy:fallback'],
});
await assert.rejects(() => lookupPolicy({ product: '', severity: 'high' }), /product/i);
await assert.rejects(() => lookupPolicy({ product: 'payments' }), /severity/i);

process.stdout.write('verified policy lookup node\n');
