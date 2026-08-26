#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const phase = process.argv[2] ?? 'initial';
const stateDirectory = resolve('.missionbraid');
const marker = resolve(stateDirectory, 'i8-prompt-attempt-ready.json');

mkdirSync(stateDirectory, { recursive: true });
writeFileSync(
  marker,
  `${JSON.stringify({ phase, pid: process.pid, state: 'waiting-for-contract-revision' })}\n`,
  'utf8',
);
process.stdout.write(`prompt Attempt ready for ${phase} Contract revision\n`);

const finish = (signal) => {
  writeFileSync(
    marker,
    `${JSON.stringify({ phase, pid: process.pid, signal, state: 'interrupted' })}\n`,
    'utf8',
  );
  process.exit(0);
};

process.once('SIGINT', () => finish('SIGINT'));
process.once('SIGTERM', () => finish('SIGTERM'));
setInterval(() => {}, 1_000);
