#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { readActiveContractRevision } from './fixture-contract.mjs';
import { triageIncident } from './src/agent.mjs';

const revision = await readActiveContractRevision();
runVerifier('verify-tool-node.mjs');
runVerifier('verify-prompt-node.mjs');

const tool = {
  classification: 'manual-review',
  rationale: 'High-severity payment incidents require manual review.',
};
const expected =
  revision.revisionNumber === 1 ? tool : { ...tool, evidenceSource: ['policy:payments-high-risk'] };
assert.deepEqual(await triageIncident({ product: 'payments', severity: 'high' }), expected);

const summary = JSON.parse(await readFile('integration/summary.json', 'utf8'));
assert.equal(summary.schemaVersion, 'missionbraid.dev/flagship-consolidation-summary/v1');
assert.equal(summary.contractRevisionNumber, revision.revisionNumber);
if (revision.revisionNumber === 1) {
  assert.deepEqual(summary.sourceOutputs, {
    bootstrap: [
      'agent-config.json',
      'src/tools/policy-lookup.mjs',
      'prompts/triage.md',
      'skills/triage/SKILL.md',
    ],
  });
} else {
  assert.deepEqual(summary.sourceOutputs, {
    'tool-implementation': ['agent-config.json', 'src/tools/policy-lookup.mjs'],
    'prompt-skill': ['prompts/triage.md', 'skills/triage/SKILL.md'],
  });
}
process.stdout.write(`verified flagship Contract revision ${revision.revisionNumber}\n`);

function runVerifier(file) {
  const result = spawnSync(process.execPath, [file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, MISSIONBRAID_TARGET_WORKSPACE: process.cwd() },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}
