#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('agent-config.json', 'utf8'));
if (config.requiredPrefix !== 'SOURCE:') process.exit(1);

const result = spawnSync(process.execPath, ['--test'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: false,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
