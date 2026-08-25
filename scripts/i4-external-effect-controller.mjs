#!/usr/bin/env node

import { resolve } from 'node:path';

import { createQueryableHttpEffectTarget } from './queryable-http-effect-target.mjs';

const [stateDirValue, targetUrl, targetId = 'iteration-4-http-target'] = process.argv.slice(2);
if (stateDirValue === undefined || targetUrl === undefined) {
  throw new Error('Expected state directory and queryable target URL.');
}
const stateDir = resolve(stateDirValue);
const { startMissionBraidApp } = await import('../dist/src/app.js');
const { MissionEngine } = await import('../dist/src/engine.js');
const target = createQueryableHttpEffectTarget(targetUrl, targetId);
const app = await startMissionBraidApp({
  stateDir,
  port: 0,
  engineFactory: (directory) =>
    new MissionEngine({
      stateDir: directory,
      externalEffectTargets: [target],
      beforeExternalEffectAppend: (event) => {
        if (event.type === 'effect.executed') process.kill(process.pid, 'SIGKILL');
      },
    }),
});
process.stdout.write(`${JSON.stringify({ url: app.url, pid: process.pid })}\n`);
await new Promise(() => undefined);
