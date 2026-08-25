import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeInvocation,
  capabilitiesForRequest,
  CLAUDE_ADAPTER_CAPABILITIES,
  ClaudeAdapter,
  createClaudeAdapter,
} from './claude.js';
import type { RuntimeOutputLine } from './types.js';

const disposableDirectories: string[] = [];

async function disposableDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'missionbraid-claude-'));
  disposableDirectories.push(directory);
  return directory;
}

async function fakeClaude(directory: string): Promise<string> {
  const file = join(directory, 'fake-claude');
  await writeFile(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('2.1.245 (Claude Code)\\n');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', args, cwd: process.cwd() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: stdin }) + '\\n');
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

describe('ClaudeAdapter', () => {
  it('constructs deterministic stream-json argv and keeps the prompt on stdin', async () => {
    const workspace = await disposableDirectory();
    const settingsFile = join(workspace, 'missionbraid-hooks.json');

    const invocation = buildClaudeInvocation(
      {
        workspace,
        prompt: 'continue the mission',
        permissionMode: 'acceptEdits',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
        maxTurns: 12,
        noSessionPersistence: true,
        includePartialMessages: true,
        settingsFile,
        tools: ['Read', 'Edit', 'Bash(git status)'],
      },
      '/opt/bin/claude',
    );

    expect(invocation).toEqual({
      runtime: 'claude',
      outputProtocol: 'claude-stream-json',
      command: '/opt/bin/claude',
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--include-hook-events',
        '--include-partial-messages',
        '--model',
        'deepseek-v4-pro',
        '--effort',
        'high',
        '--max-turns',
        '12',
        '--no-session-persistence',
        '--settings',
        settingsFile,
        '--tools',
        'Read,Edit,Bash(git status)',
      ],
      cwd: workspace,
      stdin: 'continue the mission',
    });
  });

  it('uses deny-without-interaction defaults and declares unsupported boundaries', async () => {
    const workspace = await disposableDirectory();
    const invocation = buildClaudeInvocation({ workspace, prompt: 'inspect only' });

    expect(invocation.args).toContain('dontAsk');
    expect(invocation.args).not.toContain('bypassPermissions');
    expect(CLAUDE_ADAPTER_CAPABILITIES.observe).toMatchObject({
      status: 'supported',
      control: 'native',
    });
    expect(CLAUDE_ADAPTER_CAPABILITIES.interrupt).toMatchObject({
      status: 'supported',
      control: 'controller',
    });
    expect(CLAUDE_ADAPTER_CAPABILITIES.context_capture.status).toBe('unknown');
    expect(CLAUDE_ADAPTER_CAPABILITIES.pre_tool_gate.status).toBe('unsupported');
    expect(CLAUDE_ADAPTER_CAPABILITIES.resume.status).toBe('unsupported');
  });

  it('only declares a pre-tool gate for a request with an explicitly verified Hook binding', async () => {
    const workspace = await disposableDirectory();
    const settingsFile = join(workspace, 'missionbraid-hooks.json');
    const adapter = new ClaudeAdapter();

    expect(
      capabilitiesForRequest({
        workspace,
        prompt: 'inspect only',
        settingsFile,
        tools: ['Read', 'Edit'],
      }).pre_tool_gate,
    ).toMatchObject({ status: 'unsupported', control: 'none' });

    expect(
      adapter.capabilitiesForRequest({
        workspace,
        prompt: 'inspect only',
        settingsFile,
        tools: ['Read', 'Edit'],
        verifiedHookGate: true,
      }).pre_tool_gate,
    ).toMatchObject({ status: 'supported', control: 'native' });
    expect(adapter.capabilities.pre_tool_gate.status).toBe('unsupported');
  });

  it('detects a fake executable and its version', async () => {
    const workspace = await disposableDirectory();
    const command = await fakeClaude(workspace);
    const adapter = createClaudeAdapter({ command, probeTimeoutMs: 3_000 });

    const detection = await adapter.detect();

    expect(detection.available).toBe(true);
    expect(detection.responsive).toBe(true);
    expect(detection.status).toBe('ready');
    expect(detection.version).toBe('2.1.245');
    expect(detection.versionSource).toBe('output');
  });

  it('runs in the selected workspace, parses stream-json, and records exit data', async () => {
    const workspace = await disposableDirectory();
    const command = await fakeClaude(workspace);
    const adapter = new ClaudeAdapter({ command });
    const events: RuntimeOutputLine[] = [];
    let startedPid: number | undefined;

    const result = await adapter.run({
      workspace,
      prompt: 'fixture prompt',
      permissionMode: 'dontAsk',
      onStart: (pid) => {
        startedPid = pid;
      },
      onOutput: (event) => {
        events.push(event);
      },
    });
    const canonicalWorkspace = await realpath(workspace);

    expect(events.find((event) => event.value !== undefined)?.value).toMatchObject({
      type: 'system',
      subtype: 'init',
      cwd: canonicalWorkspace,
    });
    expect(events.some((event) => event.value !== undefined && event.runtime === 'claude')).toBe(
      true,
    );
    expect(events.some((event) => event.line === 'fixture warning')).toBe(true);
    expect(result.runtime).toBe('claude');
    expect(result.outputProtocol).toBe('claude-stream-json');
    expect(result.process.exitCode).toBe(0);
    expect(result.process.pid).toEqual(expect.any(Number));
    expect(startedPid).toBe(result.process.pid);
    expect(result.process.invocation).not.toHaveProperty('stdin');
    expect(result.process.invocation).not.toHaveProperty('env');
  });

  it('reports a missing command without invoking it', async () => {
    const workspace = await disposableDirectory();
    const adapter = new ClaudeAdapter({
      command: join(workspace, 'missing-claude'),
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
      buildClaudeInvocation({
        workspace,
        prompt: 'fixture',
        maxTurns: 0,
      }),
    ).toThrow('Claude maxTurns must be a positive safe integer.');
  });

  it('rejects invalid settings, tools, and Hook capability assertions', async () => {
    const workspace = await disposableDirectory();

    expect(() =>
      buildClaudeInvocation({
        workspace,
        prompt: 'fixture',
        settingsFile: 'relative-settings.json',
      }),
    ).toThrow('Claude settingsFile must be an absolute path.');
    expect(() =>
      buildClaudeInvocation({
        workspace,
        prompt: 'fixture',
        tools: [],
      }),
    ).toThrow('Claude tools must contain at least one tool.');
    expect(() =>
      buildClaudeInvocation({
        workspace,
        prompt: 'fixture',
        tools: ['Read', '   '],
      }),
    ).toThrow('Claude tool must not be empty.');
    expect(() =>
      capabilitiesForRequest({
        workspace,
        prompt: 'fixture',
        verifiedHookGate: true,
      }),
    ).toThrow('Claude verifiedHookGate requires settingsFile.');
    expect(() =>
      capabilitiesForRequest({
        workspace,
        prompt: 'fixture',
        settingsFile: join(workspace, 'missionbraid-hooks.json'),
        verifiedHookGate: true,
        includeHookEvents: false,
      }),
    ).toThrow('Claude verifiedHookGate requires includeHookEvents.');
  });
});
