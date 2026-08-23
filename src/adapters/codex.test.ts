import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCodexInvocation, CodexAdapter, createCodexAdapter } from './codex.js';
import type { RuntimeOutputLine } from './types.js';

const disposableDirectories: string[] = [];

async function disposableDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'missionbraid-codex-'));
  disposableDirectories.push(directory);
  return directory;
}

async function fakeCodex(directory: string): Promise<string> {
  const file = join(directory, 'fake-codex');
  await writeFile(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 9.8.7-test.1\\n');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'fixture', args, cwd: process.cwd(), stdin }) + '\\n');
  process.stderr.write('fixture warning\\n');
});
`,
    'utf8',
  );
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

describe('CodexAdapter', () => {
  it('constructs deterministic JSONL argv and keeps the prompt on stdin', async () => {
    const workspace = await disposableDirectory();

    const invocation = buildCodexInvocation(
      {
        workspace,
        prompt: 'continue the mission',
        sandbox: 'workspace-write',
        model: 'gpt-fixture',
        reasoningEffort: 'medium',
        profile: 'fixture-profile',
        ephemeral: true,
      },
      '/opt/bin/codex',
    );

    expect(invocation).toEqual({
      runtime: 'codex',
      outputProtocol: 'codex-jsonl',
      command: '/opt/bin/codex',
      args: [
        'exec',
        '--json',
        '--color',
        'never',
        '--cd',
        workspace,
        '--sandbox',
        'workspace-write',
        '--model',
        'gpt-fixture',
        '--config',
        'model_reasoning_effort=medium',
        '--profile',
        'fixture-profile',
        '--ephemeral',
        '-',
      ],
      cwd: workspace,
      stdin: 'continue the mission',
    });
  });

  it('detects a fake executable and its version', async () => {
    const workspace = await disposableDirectory();
    const command = await fakeCodex(workspace);
    const adapter = createCodexAdapter({ command, probeTimeoutMs: 3_000 });

    const detection = await adapter.detect();

    expect(detection.available).toBe(true);
    expect(detection.responsive).toBe(true);
    expect(detection.status).toBe('ready');
    expect(detection.version).toBe('9.8.7-test.1');
    expect(detection.versionSource).toBe('output');
  });

  it('runs in the selected workspace, parses JSONL, and records exit data', async () => {
    const workspace = await disposableDirectory();
    const command = await fakeCodex(workspace);
    const adapter = new CodexAdapter({ command });
    const events: RuntimeOutputLine[] = [];
    let startedPid: number | undefined;

    const result = await adapter.run({
      workspace,
      prompt: 'fixture prompt',
      sandbox: 'workspace-write',
      onStart: (pid) => {
        startedPid = pid;
      },
      onOutput: (event) => {
        events.push(event);
      },
    });
    const canonicalWorkspace = await realpath(workspace);

    const jsonEvent = events.find((event) => event.value !== undefined);
    expect(jsonEvent?.runtime).toBe('codex');
    expect(jsonEvent?.value).toEqual({
      type: 'fixture',
      args: [
        'exec',
        '--json',
        '--color',
        'never',
        '--cd',
        workspace,
        '--sandbox',
        'workspace-write',
        '-',
      ],
      cwd: canonicalWorkspace,
      stdin: 'fixture prompt',
    });
    expect(events.some((event) => event.line === 'fixture warning')).toBe(true);
    expect(result.process.exitCode).toBe(0);
    expect(result.process.pid).toEqual(expect.any(Number));
    expect(startedPid).toBe(result.process.pid);
    expect(result.process.invocation).not.toHaveProperty('stdin');
    expect(result.process.invocation).not.toHaveProperty('env');
  });

  it('reports a missing command without invoking it', async () => {
    const workspace = await disposableDirectory();
    const adapter = new CodexAdapter({
      command: join(workspace, 'missing-codex'),
    });

    await expect(adapter.detect()).resolves.toMatchObject({
      available: false,
      responsive: false,
      status: 'missing',
      executablePath: null,
    });
  });
});
