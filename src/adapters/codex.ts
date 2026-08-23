import { basename, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveExecutable, runProcess } from './process-runner.js';
import type {
  AdapterRunRequest,
  ProcessOutputLine,
  RuntimeAdapter,
  RuntimeDetection,
  RuntimeInvocation,
  RuntimeOutputLine,
  RuntimeRunResult,
} from './types.js';

const DEFAULT_COMMAND = 'codex';
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexRunRequest extends AdapterRunRequest {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly profile?: string;
  readonly sandbox?: CodexSandbox;
  readonly ephemeral?: boolean;
}

export interface CodexAdapterOptions {
  readonly command?: string;
  readonly probeTimeoutMs?: number;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty.`);
  }
}

function validateRequest(request: CodexRunRequest): void {
  if (!isAbsolute(request.workspace)) {
    throw new TypeError('Codex workspace must be an absolute path.');
  }
  requireNonEmpty(request.prompt, 'Codex prompt');
  if (request.model !== undefined) {
    requireNonEmpty(request.model, 'Codex model');
  }
  if (request.reasoningEffort !== undefined) {
    requireNonEmpty(request.reasoningEffort, 'Codex reasoning effort');
  }
  if (request.profile !== undefined) {
    requireNonEmpty(request.profile, 'Codex profile');
  }
}

function parseVersion(lines: readonly string[]): string | null {
  for (const line of lines) {
    const match = line.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

function parseVersionFromPath(executablePath: string): string | null {
  const match = basename(executablePath).match(
    /codex(?:-cli)?[-_]?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i,
  );
  return match?.[1] ?? null;
}

function parseJsonLine(event: ProcessOutputLine): RuntimeOutputLine {
  if (event.stream !== 'stdout') {
    return { ...event, runtime: 'codex' };
  }

  try {
    return {
      ...event,
      runtime: 'codex',
      value: JSON.parse(event.line) as unknown,
    };
  } catch {
    return { ...event, runtime: 'codex' };
  }
}

export function buildCodexInvocation(
  request: CodexRunRequest,
  command = DEFAULT_COMMAND,
): RuntimeInvocation {
  validateRequest(request);
  requireNonEmpty(command, 'Codex command');

  const args: string[] = [
    'exec',
    '--json',
    '--color',
    'never',
    '--cd',
    request.workspace,
    '--sandbox',
    request.sandbox ?? 'read-only',
  ];

  if (request.model !== undefined) {
    args.push('--model', request.model);
  }
  if (request.reasoningEffort !== undefined) {
    args.push('--config', `model_reasoning_effort=${request.reasoningEffort}`);
  }
  if (request.profile !== undefined) {
    args.push('--profile', request.profile);
  }
  if (request.ephemeral === true) {
    args.push('--ephemeral');
  }
  args.push('-');

  return {
    runtime: 'codex',
    outputProtocol: 'codex-jsonl',
    command,
    args,
    cwd: request.workspace,
    stdin: request.prompt,
  };
}

export class CodexAdapter implements RuntimeAdapter<CodexRunRequest> {
  readonly runtime = 'codex' as const;
  readonly command: string;
  readonly probeTimeoutMs: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    requireNonEmpty(this.command, 'Codex command');
    if (!Number.isFinite(this.probeTimeoutMs) || this.probeTimeoutMs <= 0) {
      throw new TypeError('Codex probeTimeoutMs must be a positive number.');
    }
  }

  async detect(): Promise<RuntimeDetection> {
    const checkedAt = new Date().toISOString();
    const started = performance.now();
    const executablePath = await resolveExecutable(this.command);

    if (executablePath === null) {
      return {
        runtime: 'codex',
        command: this.command,
        executablePath: null,
        available: false,
        responsive: false,
        status: 'missing',
        version: null,
        versionSource: null,
        checkedAt,
        durationMs: performance.now() - started,
        probeExitCode: null,
        probeSignal: null,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.probeTimeoutMs);
    timeout.unref();
    const output: string[] = [];
    const probe = await runProcess(
      {
        command: executablePath,
        args: ['--version'],
        cwd: process.cwd(),
      },
      {
        signal: controller.signal,
        abortGraceMs: 100,
        onOutput: (event) => {
          output.push(event.line);
        },
      },
    );
    clearTimeout(timeout);

    const outputVersion = parseVersion(output);
    const pathVersion = parseVersionFromPath(executablePath);
    const version = outputVersion ?? pathVersion;
    const responsive = !probe.aborted && probe.spawnError === undefined && probe.exitCode === 0;
    const status = probe.aborted ? 'present-unresponsive' : responsive ? 'ready' : 'present-error';

    return {
      runtime: 'codex',
      command: this.command,
      executablePath,
      available: true,
      responsive,
      status,
      version,
      versionSource: outputVersion !== null ? 'output' : pathVersion !== null ? 'path' : null,
      checkedAt,
      durationMs: performance.now() - started,
      probeExitCode: probe.exitCode,
      probeSignal: probe.signal,
    };
  }

  buildInvocation(request: CodexRunRequest): RuntimeInvocation {
    return buildCodexInvocation(request, this.command);
  }

  async run(request: CodexRunRequest): Promise<RuntimeRunResult> {
    const invocation = this.buildInvocation(request);
    const processResult = await runProcess(invocation, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onStart === undefined ? {} : { onStart: request.onStart }),
      ...(request.onOutput === undefined
        ? {}
        : {
            onOutput: async (event: ProcessOutputLine) => {
              await request.onOutput?.(parseJsonLine(event));
            },
          }),
    });

    return {
      runtime: 'codex',
      outputProtocol: 'codex-jsonl',
      process: processResult,
    };
  }
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  return new CodexAdapter(options);
}
