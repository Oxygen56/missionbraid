#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(repositoryRoot, 'dist');

if (dirname(outputDirectory) !== repositoryRoot || basename(outputDirectory) !== 'dist') {
  throw new Error('Refusing to clean an unexpected package output directory');
}

await rm(outputDirectory, { recursive: true, force: true });

const compiler = resolve(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const child = spawn(process.execPath, [compiler, '-p', 'tsconfig.build.json'], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: 'inherit',
});

const exitCode = await new Promise((resolveExit, rejectExit) => {
  child.once('error', rejectExit);
  child.once('exit', (code, signal) => {
    if (signal !== null) {
      rejectExit(new Error(`TypeScript compiler exited on ${signal}`));
      return;
    }
    resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
