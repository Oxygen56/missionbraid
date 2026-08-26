#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { expectedPromptOutputMap, readActiveContractRevision } from './fixture-contract.mjs';

const revision = await readActiveContractRevision();
const expected = expectedPromptOutputMap(revision);

for (const path of ['prompts/triage.md', 'skills/triage/SKILL.md']) {
  const source = await readFile(path, 'utf8');
  assert.doesNotMatch(source, /\bTODO\b/, `${path} still contains a TODO`);
  assert.deepEqual(
    readOutputMap(source, path),
    expected,
    `${path} has the wrong Contract revision ${revision.revisionNumber} schema`,
  );
}

process.stdout.write(
  `verified Contract revision ${revision.revisionNumber} prompt and Skill schema\n`,
);

function readOutputMap(source, path) {
  const region = source.match(
    /<!-- TRIAGE_SCHEMA_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- TRIAGE_SCHEMA_END -->/u,
  );
  assert.notEqual(region, null, `${path} must preserve the triage schema markers`);
  return JSON.parse(region[1]);
}
