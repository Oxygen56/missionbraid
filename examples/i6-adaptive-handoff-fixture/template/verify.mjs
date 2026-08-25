#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

const mode = readFileSync('task-mode.txt', 'utf8');
const source = existsSync('source.txt') ? readFileSync('source.txt', 'utf8') : null;
const final = existsSync('final.txt') ? readFileSync('final.txt', 'utf8') : null;

if (source !== 'codex-source\n') {
  process.stderr.write(`Unexpected source.txt: ${JSON.stringify(source)}\n`);
  process.exit(1);
}

const expectedFinal =
  mode === 'ADAPTIVE\n'
    ? 'handoff-complete\n'
    : mode === 'PRIMARY-SUCCESS\n'
      ? 'primary-complete\n'
      : null;
if (expectedFinal === null) {
  process.stderr.write(`Unexpected task mode: ${JSON.stringify(mode)}\n`);
  process.exit(2);
}
if (final !== expectedFinal) {
  process.stderr.write(`Unexpected final.txt: ${JSON.stringify(final)}\n`);
  process.exit(3);
}

process.stdout.write(`verified ${mode.trim()}\n`);
