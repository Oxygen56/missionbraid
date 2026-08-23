import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runProcess } from './process-runner.js';
import type { ProcessOutputLine } from './types.js';

const disposableDirectories: string[] = [];

async function disposableDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'missionbraid-runner-'));
  disposableDirectories.push(directory);
  return directory;
}

async function fakeExecutable(directory: string, name: string, source: string): Promise<string> {
  const file = join(directory, name);
  await writeFile(file, `#!/usr/bin/env node\n${source}`, 'utf8');
  await chmod(file, 0o755);
  return file;
}

afterEach(async () => {
  await Promise.all(
    disposableDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('runProcess', () => {
  it('streams complete stdout and stderr lines and records process outcome', async () => {
    const workspace = await disposableDirectory();
    const executable = await fakeExecutable(
      workspace,
      'stream-fixture',
      `
process.stdout.write('{"type":"first"}\\npart');
setTimeout(() => {
  process.stdout.write('ial\\n');
  process.stderr.write('warning\\r\\n');
  process.exit(7);
}, 10);
`,
    );
    const events: ProcessOutputLine[] = [];

    const result = await runProcess(
      {
        command: executable,
        args: ['--fixture'],
        cwd: workspace,
        stdin: 'not-recorded',
      },
      {
        onOutput: (event) => {
          events.push(event);
        },
      },
    );

    expect(events.map(({ stream, line }) => ({ stream, line }))).toEqual([
      { stream: 'stdout', line: '{"type":"first"}' },
      { stream: 'stdout', line: 'partial' },
      { stream: 'stderr', line: 'warning' },
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.pid).toEqual(expect.any(Number));
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.stdoutLineCount).toBe(2);
    expect(result.stderrLineCount).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.invocation).toEqual({
      command: executable,
      args: ['--fixture'],
      cwd: workspace,
    });
    expect(result.invocation).not.toHaveProperty('stdin');
    expect(result.invocation).not.toHaveProperty('env');
  });

  it('terminates a running process when its AbortSignal fires', async () => {
    const workspace = await disposableDirectory();
    const executable = await fakeExecutable(
      workspace,
      'wait-fixture',
      `
process.stdout.write('ready\\n');
setInterval(() => {}, 1_000);
`,
    );
    const controller = new AbortController();

    const result = await runProcess(
      {
        command: executable,
        args: [],
        cwd: workspace,
      },
      {
        signal: controller.signal,
        abortGraceMs: 50,
        onOutput: (event) => {
          if (event.line === 'ready') {
            controller.abort();
          }
        },
      },
    );

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });

  it('awaits PID persistence before sending stdin or delivering output', async () => {
    const workspace = await disposableDirectory();
    const executable = await fakeExecutable(
      workspace,
      'start-barrier-fixture',
      `
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => process.stdout.write(stdin + '\\n'));
`,
    );
    const order: string[] = [];
    let persistedPid: number | undefined;

    const result = await runProcess(
      {
        command: executable,
        args: [],
        cwd: workspace,
        stdin: 'after-start',
      },
      {
        onStart: async (pid) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          persistedPid = pid;
          order.push('start');
        },
        onOutput: (event) => {
          order.push(`output:${event.line}`);
        },
      },
    );

    expect(persistedPid).toBe(result.pid);
    expect(order).toEqual(['start', 'output:after-start']);
    expect(result.startError).toBeUndefined();
  });

  it('terminates without sending the prompt when PID persistence fails', async () => {
    const workspace = await disposableDirectory();
    const executable = await fakeExecutable(
      workspace,
      'start-error-fixture',
      `
process.stdin.resume();
setInterval(() => {}, 1_000);
`,
    );

    const result = await runProcess(
      {
        command: executable,
        args: [],
        cwd: workspace,
        stdin: 'must-not-be-sent',
      },
      {
        abortGraceMs: 50,
        onStart: () => {
          throw new Error('persistence unavailable');
        },
      },
    );

    expect(result.startError).toMatchObject({
      name: 'Error',
      message: 'persistence unavailable',
    });
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
  });

  it('returns a structured spawn error for a missing executable', async () => {
    const workspace = await disposableDirectory();
    const missing = join(workspace, 'does-not-exist');

    const result = await runProcess({
      command: missing,
      args: [],
      cwd: workspace,
    });

    expect(result.pid).toBeNull();
    expect(result.spawnError?.code).toBe('ENOENT');
    expect(result.spawnError?.message).not.toBe('');
  });

  it('does not spawn when already aborted', async () => {
    const workspace = await disposableDirectory();
    const controller = new AbortController();
    controller.abort();

    const result = await runProcess(
      {
        command: join(workspace, 'irrelevant'),
        args: [],
        cwd: workspace,
      },
      { signal: controller.signal },
    );

    expect(result.aborted).toBe(true);
    expect(result.pid).toBeNull();
    expect(result.spawnError).toBeUndefined();
  });
});
