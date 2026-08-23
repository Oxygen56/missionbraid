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

const DEFAULT_COMMAND = 'qodercli';
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
// The current official CLI reference lists `dont_ask` as a permission mode:
// https://docs.qoder.com/cli/cli-reference. Local qodercli 1.1.6 help currently
// blocks without output, so real headless acceptance remains an E1 runtime test.
const DEFAULT_PERMISSION_MODE = 'dont_ask' as const;

export type QoderPermissionMode =
  | 'default'
  | 'plan'
  | 'auto'
  | 'bypass_permissions'
  | 'accept_edits'
  | 'dont_ask';

export interface QoderRunRequest extends AdapterRunRequest {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: QoderPermissionMode;
  readonly maxTurns?: number;
  readonly noSessionPersistence?: boolean;
}

export interface QoderAdapterOptions {
  readonly command?: string;
  readonly probeTimeoutMs?: number;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty.`);
  }
}

function validateRequest(request: QoderRunRequest): void {
  if (!isAbsolute(request.workspace)) {
    throw new TypeError('Qoder workspace must be an absolute path.');
  }
  requireNonEmpty(request.prompt, 'Qoder prompt');
  if (request.model !== undefined) {
    requireNonEmpty(request.model, 'Qoder model');
  }
  if (request.reasoningEffort !== undefined) {
    requireNonEmpty(request.reasoningEffort, 'Qoder reasoning effort');
  }
  if (
    request.maxTurns !== undefined &&
    (!Number.isSafeInteger(request.maxTurns) || request.maxTurns <= 0)
  ) {
    throw new TypeError('Qoder maxTurns must be a positive safe integer.');
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
    /qoder(?:cli)?[-_]?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i,
  );
  return match?.[1] ?? null;
}

function parseJsonLine(event: ProcessOutputLine): RuntimeOutputLine {
  if (event.stream !== 'stdout') {
    return { ...event, runtime: 'qoder' };
  }

  try {
    return {
      ...event,
      runtime: 'qoder',
      value: JSON.parse(event.line) as unknown,
    };
  } catch {
    return { ...event, runtime: 'qoder' };
  }
}

export function buildQoderInvocation(
  request: QoderRunRequest,
  command = DEFAULT_COMMAND,
): RuntimeInvocation {
  validateRequest(request);
  requireNonEmpty(command, 'Qoder command');

  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--cwd',
    request.workspace,
    '--permission-mode',
    request.permissionMode ?? DEFAULT_PERMISSION_MODE,
  ];

  if (request.model !== undefined) {
    args.push('--model', request.model);
  }
  if (request.reasoningEffort !== undefined) {
    args.push('--reasoning-effort', request.reasoningEffort);
  }
  if (request.maxTurns !== undefined) {
    args.push('--max-turns', String(request.maxTurns));
  }
  if (request.noSessionPersistence === true) {
    args.push('--no-session-persistence');
  }

  return {
    runtime: 'qoder',
    outputProtocol: 'qoder-stream-json',
    command,
    args,
    cwd: request.workspace,
    stdin: request.prompt,
  };
}

export class QoderAdapter implements RuntimeAdapter<QoderRunRequest> {
  readonly runtime = 'qoder' as const;
  readonly command: string;
  readonly probeTimeoutMs: number;

  constructor(options: QoderAdapterOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    requireNonEmpty(this.command, 'Qoder command');
    if (!Number.isFinite(this.probeTimeoutMs) || this.probeTimeoutMs <= 0) {
      throw new TypeError('Qoder probeTimeoutMs must be a positive number.');
    }
  }

  async detect(): Promise<RuntimeDetection> {
    const checkedAt = new Date().toISOString();
    const started = performance.now();
    const executablePath = await resolveExecutable(this.command);

    if (executablePath === null) {
      return {
        runtime: 'qoder',
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
      runtime: 'qoder',
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

  buildInvocation(request: QoderRunRequest): RuntimeInvocation {
    return buildQoderInvocation(request, this.command);
  }

  async run(request: QoderRunRequest): Promise<RuntimeRunResult> {
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
      runtime: 'qoder',
      outputProtocol: 'qoder-stream-json',
      process: processResult,
    };
  }
}

export function createQoderAdapter(options: QoderAdapterOptions = {}): QoderAdapter {
  return new QoderAdapter(options);
}
