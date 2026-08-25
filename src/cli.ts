#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MissionEngine, type MissionExecutionResult } from './engine.js';
import { startMissionBraidApp } from './app.js';
import {
  kandevProviderCheckUsage,
  runKandevProviderCheckCommand,
} from './kandev-provider-check-cli.js';
import { discoverRuntimeCatalog } from './runtime-catalog.js';

interface ParsedArguments {
  readonly command: 'create' | 'run' | 'resume' | 'status' | 'verify' | 'list';
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
  if (argv[0] === 'runtimes') {
    if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
      process.stdout.write(`${runtimeCatalogUsage()}\n`);
      return 0;
    }
    if (
      argv.length < 2 ||
      argv[1] !== 'list' ||
      argv.slice(2).some((argument) => argument !== '--json')
    ) {
      process.stderr.write(`Expected: ${runtimeCatalogUsage()}\n`);
      return 64;
    }
    process.stdout.write(`${JSON.stringify(await discoverRuntimeCatalog(), null, 2)}\n`);
    return 0;
  }
  if (argv[0] === 'app') {
    if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
      process.stdout.write(`${appUsage()}\n`);
      return 0;
    }
    try {
      const options = parseAppArguments(argv.slice(1));
      const app = await startMissionBraidApp(options);
      process.stdout.write(`MissionBraid is ready at ${app.url}\n`);
      await waitForInterrupt();
      await app.close();
      return 0;
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n\n${appUsage()}\n`,
      );
      return 64;
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
    if (parsed.command === 'create') {
      const result = await engine.create(parsed.subject!, {
        ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  let missionId: string;
  let action: 'resume' | 'verify';
  switch (parsed.command) {
    case 'run': {
      const created = await engine.create(parsed.subject!, {
        ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
      });
      missionId = created.missionId;
      action = 'resume';
      break;
    }
    case 'resume':
      missionId = parsed.subject!;
      action = 'resume';
      break;
    case 'verify':
      missionId = parsed.subject!;
      action = 'verify';
      break;
    case 'status':
      throw new Error('status is handled before execution');
    case 'list':
      throw new Error('list is handled before execution');
    case 'create':
      throw new Error('create is handled before execution');
  }
  const active = engine
    .commands(missionId)
    .find((command) => command.status === 'pending' || command.status === 'dispatching');
  const command =
    active ?? (await engine.acceptCommand(missionId, action, `cli:${action}:${randomUUID()}`));
  if (command.status === 'pending') {
    engine.claimCommand(command.commandId, `cli-${String(process.pid)}-${randomUUID()}`);
  } else if (command.status === 'dispatching') {
    throw new Error(
      `Mission ${missionId} already has a command claimed by another controller (${command.commandId})`,
    );
  }
  return await engine.executeCommand(command.commandId, signal);
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
    rawCommand !== 'create' &&
    rawCommand !== 'run' &&
    rawCommand !== 'resume' &&
    rawCommand !== 'status' &&
    rawCommand !== 'verify' &&
    rawCommand !== 'list'
  ) {
    throw new Error('Expected one of: create, run, resume, status, verify, list');
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
  if (rawCommand !== 'create' && rawCommand !== 'run' && workspace !== undefined) {
    throw new Error('--workspace is only valid with create or run');
  }
  return {
    command: rawCommand,
    ...(rawSubject === undefined || rawCommand === 'list'
      ? {}
      : {
          subject:
            rawCommand === 'create' || rawCommand === 'run' ? resolve(rawSubject) : rawSubject,
        }),
    stateDir,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function usage(): string {
  return `MissionBraid

  missionbraid create <mission.yaml> [--workspace <git-worktree>] [--state-dir <dir>]
  missionbraid run <mission.yaml> [--workspace <git-worktree>] [--state-dir <dir>]
  missionbraid resume <mission-id> [--state-dir <dir>]
  missionbraid status <mission-id> [--state-dir <dir>] [--json]
  missionbraid verify <mission-id> [--state-dir <dir>]
  missionbraid list [--state-dir <dir>]
  ${appUsage()}
  ${runtimeCatalogUsage()}
  ${kandevProviderCheckUsage()}`;
}

function runtimeCatalogUsage(): string {
  return 'missionbraid runtimes list [--json]';
}

function appUsage(): string {
  return 'missionbraid app [--state-dir <dir>] [--port <number>]';
}

export function parseAppArguments(argv: readonly string[]): {
  readonly stateDir: string;
  readonly port: number;
} {
  let stateDir = resolve(homedir(), '.missionbraid');
  let port = 4317;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--state-dir' && flag !== '--port') {
      throw new Error(`Unknown app option ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === '--state-dir') {
      stateDir = resolve(value);
    } else {
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535');
      }
    }
    index += 1;
  }
  return { stateDir, port };
}

function waitForInterrupt(): Promise<void> {
  return new Promise((resolveInterrupt) => {
    const finish = (): void => {
      process.removeListener('SIGINT', finish);
      process.removeListener('SIGTERM', finish);
      resolveInterrupt();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

const executable = process.argv[1];
if (executable !== undefined && import.meta.url === pathToFileURL(executable).href) {
  process.exitCode = await main();
}
