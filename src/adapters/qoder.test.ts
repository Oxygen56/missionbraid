import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildQoderInvocation, createQoderAdapter, QoderAdapter } from './qoder.js';
import type { RuntimeOutputLine } from './types.js';

const disposableDirectories: string[] = [];

async function disposableDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'missionbraid-qoder-'));
  disposableDirectories.push(directory);
  return directory;
}

async function fakeQoder(directory: string): Promise<string> {
  const file = join(directory, 'fake-qoder');
  await writeFile(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('qodercli 4.5.6-beta.2\\n');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', args, cwd: process.cwd(), stdin }) + '\\n');
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

describe('QoderAdapter', () => {
  it('constructs deterministic stream-json argv and keeps the prompt on stdin', async () => {
    const workspace = await disposableDirectory();

    const invocation = buildQoderInvocation(
      {
        workspace,
        prompt: 'continue the mission',
        permissionMode: 'accept_edits',
        model: 'qoder-fixture',
        reasoningEffort: 'high',
        maxTurns: 12,
        noSessionPersistence: true,
      },
      '/opt/bin/qodercli',
    );

    expect(invocation).toEqual({
      runtime: 'qoder',
      outputProtocol: 'qoder-stream-json',
      command: '/opt/bin/qodercli',
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--cwd',
        workspace,
        '--permission-mode',
        'accept_edits',
        '--model',
        'qoder-fixture',
        '--reasoning-effort',
        'high',
        '--max-turns',
        '12',
        '--no-session-persistence',
      ],
      cwd: workspace,
      stdin: 'continue the mission',
    });
  });

  it('uses a deny-without-interaction permission default', async () => {
    const workspace = await disposableDirectory();

    const invocation = buildQoderInvocation({
      workspace,
      prompt: 'inspect only',
    });

    expect(invocation.args).toContain('dont_ask');
    expect(invocation.args).not.toContain('bypass_permissions');
  });

  it('detects a fake executable and its version', async () => {
    const workspace = await disposableDirectory();
    const command = await fakeQoder(workspace);
    const adapter = createQoderAdapter({ command, probeTimeoutMs: 3_000 });

    const detection = await adapter.detect();

    expect(detection.available).toBe(true);
    expect(detection.responsive).toBe(true);
    expect(detection.status).toBe('ready');
    expect(detection.version).toBe('4.5.6-beta.2');
    expect(detection.versionSource).toBe('output');
  });

  it('reports a present but unresponsive executable without losing a path version', async () => {
    const workspace = await disposableDirectory();
    const command = join(workspace, 'qodercli-7.7.7');
    await writeFile(command, '#!/usr/bin/env node\nsetInterval(() => {}, 1_000);\n', 'utf8');
    await chmod(command, 0o755);
    const adapter = new QoderAdapter({ command, probeTimeoutMs: 100 });

    const detection = await adapter.detect();

    expect(detection).toMatchObject({
      available: true,
      responsive: false,
      status: 'present-unresponsive',
      version: '7.7.7',
      versionSource: 'path',
    });
  });

  it('runs in the selected workspace, parses stream-json, and records exit data', async () => {
    const workspace = await disposableDirectory();
    const command = await fakeQoder(workspace);
    const adapter = new QoderAdapter({ command });
    const events: RuntimeOutputLine[] = [];
    let startedPid: number | undefined;

    const result = await adapter.run({
      workspace,
      prompt: 'fixture prompt',
      permissionMode: 'accept_edits',
      onStart: (pid) => {
        startedPid = pid;
      },
      onOutput: (event) => {
        events.push(event);
      },
    });
    const canonicalWorkspace = await realpath(workspace);

    const jsonEvent = events.find((event) => event.value !== undefined);
    expect(jsonEvent?.runtime).toBe('qoder');
    expect(jsonEvent?.value).toEqual({
      type: 'result',
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--cwd',
        workspace,
        '--permission-mode',
        'accept_edits',
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
    const adapter = new QoderAdapter({
      command: join(workspace, 'missing-qoder'),
    });

    await expect(adapter.detect()).resolves.toMatchObject({
      available: false,
      responsive: false,
      status: 'missing',
      executablePath: null,
    });
  });

  it('rejects invalid turn limits before spawning', async () => {
    const workspace = await disposableDirectory();

    expect(() =>
      buildQoderInvocation({
        workspace,
        prompt: 'fixture',
        maxTurns: 0,
      }),
    ).toThrow('Qoder maxTurns must be a positive safe integer.');
  });
});
