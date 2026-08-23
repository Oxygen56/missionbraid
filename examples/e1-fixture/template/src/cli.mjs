#!/usr/bin/env node

import { EffectConflictError, EffectLedger, LedgerCorruptionError } from './ledger.mjs';

function usage() {
  return [
    'Usage:',
    '  node src/cli.mjs record <ledger-file> <key> <payload-json>',
    '  node src/cli.mjs replay <ledger-file>',
  ].join('\n');
}

export async function main(
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr },
) {
  // The second runtime implements the intentionally unfinished CLI contract.
  // Keep imports and the entry point in place so it can extend prior work.
  void argv;
  void io;
  void usage;
  void EffectLedger;
  void EffectConflictError;
  void LedgerCorruptionError;
  throw new Error('TODO: implement record and replay CLI commands');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
