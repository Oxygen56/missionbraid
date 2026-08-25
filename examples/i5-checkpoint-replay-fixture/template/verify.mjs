#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

const state = readFileSync('task-state.txt', 'utf8');
const source = existsSync('source.txt') ? readFileSync('source.txt', 'utf8') : null;
const future = existsSync('final.txt') ? readFileSync('final.txt', 'utf8') : null;

if (state !== 'REPLAY\n') {
  process.stderr.write(`Unexpected task state: ${JSON.stringify(state)}\n`);
  process.exit(1);
}
if (source !== 'source-sealed\n') {
  process.stderr.write(`Unexpected source.txt: ${JSON.stringify(source)}\n`);
  process.exit(2);
}
if (future !== 'source-future-complete\n') {
  process.stderr.write(`Unexpected final.txt: ${JSON.stringify(future)}\n`);
  process.exit(3);
}

process.stdout.write('verified REPLAY\n');
