#!/usr/bin/env node

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MissionEngine, type MissionExecutionResult } from './engine.js';
import {
  kandevProviderCheckUsage,
  runKandevProviderCheckCommand,
} from './kandev-provider-check-cli.js';

interface ParsedArguments {
  readonly command: 'run' | 'resume' | 'status' | 'verify' | 'list';
  readonly subject?: string;
  readonly stateDir: string;
  readonly workspace?: string;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (argv[0] === 'provider-check') {
    if (argv[1] === 'kandev' && argv.length === 3 && (argv[2] === '--help' || argv[2] === '-h')) {
      process.stdout.write(`${kandevProviderCheckUsage()}\n`);
      return 0;
    }
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try {
      return await runKandevProviderCheckCommand(argv.slice(1), {
        signal: controller.signal,
        ...(process.env.MISSIONBRAID_KANDEV_TOKEN === undefined
          ? {}
          : { bearerToken: process.env.MISSIONBRAID_KANDEV_TOKEN }),
      });
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    return 64;
  }

  const engine = new MissionEngine({ stateDir: parsed.stateDir });
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    if (parsed.command === 'status') {
      process.stdout.write(`${JSON.stringify(engine.status(parsed.subject!), null, 2)}\n`);
      return 0;
    }
    if (parsed.command === 'list') {
      process.stdout.write(`${JSON.stringify(engine.list(), null, 2)}\n`);
      return 0;
    }
    const result = await execute(engine, parsed, controller.signal);
    process.stdout.write(`${JSON.stringify(publicResult(result), null, 2)}\n`);
    return result.status === 'succeeded' ? 0 : result.status === 'waiting' ? 2 : 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          error: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    engine.close();
  }
}

async function execute(
  engine: MissionEngine,
  parsed: ParsedArguments,
  signal: AbortSignal,
): Promise<MissionExecutionResult> {
  switch (parsed.command) {
    case 'run':
      return await engine.run(parsed.subject!, {
        ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
        signal,
      });
    case 'resume':
      return await engine.resume(parsed.subject!, { signal });
    case 'verify':
      return await engine.verify(parsed.subject!);
    case 'status':
      throw new Error('status is handled before execution');
    case 'list':
      throw new Error('list is handled before execution');
  }
}

function publicResult(result: MissionExecutionResult): Record<string, unknown> {
  return {
    missionId: result.missionId,
    status: result.status,
    ...(result.waitingReason === undefined ? {} : { waitingReason: result.waitingReason }),
    ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    ...(result.verificationResults === undefined
      ? {}
      : {
          verification: result.verificationResults.map((verification) => ({
            passed: verification.passed,
            executable: verification.executable,
            exitCode: verification.exitCode,
            signal: verification.signal,
            timedOut: verification.timedOut,
            stdout: verification.stdout,
            stderr: verification.stderr,
          })),
        }),
  };
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const [rawCommand, rawSubject, ...rest] = argv;
  if (
    rawCommand !== 'run' &&
    rawCommand !== 'resume' &&
    rawCommand !== 'status' &&
    rawCommand !== 'verify' &&
    rawCommand !== 'list'
  ) {
    throw new Error('Expected one of: run, resume, status, verify, list');
  }
  if (rawCommand !== 'list' && (rawSubject === undefined || rawSubject.startsWith('--'))) {
    throw new Error(`${rawCommand} requires a Mission file or Mission id`);
  }
  const optionArguments =
    rawCommand === 'list' ? (rawSubject === undefined ? rest : [rawSubject, ...rest]) : rest;
  let stateDir = resolve(homedir(), '.missionbraid');
  let workspace: string | undefined;
  for (let index = 0; index < optionArguments.length; index += 1) {
    const flag = optionArguments[index];
    if (flag === '--json') continue;
    if (flag !== '--state-dir' && flag !== '--workspace') {
      throw new Error(`Unknown option ${String(flag)}`);
    }
    const value = optionArguments[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === '--state-dir') stateDir = resolve(value);
    else workspace = resolve(value);
    index += 1;
  }
  if (rawCommand !== 'run' && workspace !== undefined) {
    throw new Error('--workspace is only valid with run');
  }
  return {
    command: rawCommand,
    ...(rawSubject === undefined || rawCommand === 'list'
      ? {}
      : { subject: rawCommand === 'run' ? resolve(rawSubject) : rawSubject }),
    stateDir,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function usage(): string {
  return `MissionBraid

  missionbraid run <mission.yaml> [--workspace <git-worktree>] [--state-dir <dir>]
  missionbraid resume <mission-id> [--state-dir <dir>]
  missionbraid status <mission-id> [--state-dir <dir>] [--json]
  missionbraid verify <mission-id> [--state-dir <dir>]
  missionbraid list [--state-dir <dir>]
  ${kandevProviderCheckUsage()}`;
}

const executable = process.argv[1];
if (executable !== undefined && import.meta.url === pathToFileURL(executable).href) {
  process.exitCode = await main();
}
