import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

await assert.rejects(access('original.txt', constants.F_OK));
assert.equal(await readFile('approved.txt', 'utf8'), 'APPROVED\n');
process.stdout.write('verified modified pre-tool input\n');
