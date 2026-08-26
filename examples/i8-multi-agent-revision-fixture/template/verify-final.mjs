#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { readActiveContractRevision } from './fixture-contract.mjs';
import { triageIncident } from './src/agent.mjs';

const revision = await readActiveContractRevision();
assert.equal(revision.revisionNumber, 2, 'Final verification requires Contract revision 2');

runVerifier('verify-tool-node.mjs');
runVerifier('verify-prompt-node.mjs');

assert.deepEqual(await triageIncident({ product: 'payments', severity: 'high' }), {
  classification: 'manual-review',
  rationale: 'High-severity payment incidents require manual review.',
  evidenceSource: ['policy:payments-high-risk'],
});
assert.deepEqual(JSON.parse(await readFile('integration/summary.json', 'utf8')), {
  schemaVersion: 'missionbraid.dev/i8-consolidation-summary/v1',
  contractRevisionNumber: 2,
  sourceOutputs: {
    'tool-implementation': ['src/tools/policy-lookup.mjs'],
    'prompt-skill': ['prompts/triage.md', 'skills/triage/SKILL.md'],
  },
});

process.stdout.write('verified revised Policy Triage Agent outcome\n');

function runVerifier(file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
