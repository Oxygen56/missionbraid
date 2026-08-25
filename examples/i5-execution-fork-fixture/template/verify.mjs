#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const mode = readFileSync('mode.txt', 'utf8');
if (mode !== 'PARENT\n' && mode !== 'FORK-GUIDANCE\n') {
  process.stderr.write(`Unexpected mode: ${JSON.stringify(mode)}\n`);
  process.exit(1);
}
process.stdout.write(`verified ${mode.trim()}\n`);
