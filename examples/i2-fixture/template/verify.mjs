#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const expected = new Map([
  ['codex.txt', 'codex\n'],
  ['qoder.txt', 'qoder\n'],
  ['claude.txt', 'claude\n'],
]);

for (const [file, content] of expected) {
  try {
    if (readFileSync(join(process.cwd(), file), 'utf8') !== content) process.exit(1);
  } catch {
    process.exit(1);
  }
}

process.stdout.write('Iteration 2 marker contract satisfied.\n');
