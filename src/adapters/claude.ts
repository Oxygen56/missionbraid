import { basename, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveExecutable, runProcess } from './process-runner.js';
import type {
  AdapterRunRequest,
  ProcessOutputLine,
  RuntimeAdapter,
  RuntimeAdapterCapabilities,
  RuntimeDetection,
  RuntimeInvocation,
  RuntimeOutputLine,
  RuntimeRunResult,
} from './types.js';

const DEFAULT_COMMAND = 'claude';
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_PERMISSION_MODE = 'dontAsk' as const;

export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan';

export interface ClaudeRunRequest extends AdapterRunRequest {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: ClaudePermissionMode;
  readonly maxTurns?: number;
  readonly noSessionPersistence?: boolean;
  readonly includeHookEvents?: boolean;
  readonly includePartialMessages?: boolean;
  /** Absolute path to request-scoped Claude settings, including native Hooks. */
  readonly settingsFile?: string;
  /** Built-in Claude tools available to this request. */
  readonly tools?: readonly string[];
  /**
   * Caller assertion that settingsFile contains a previously verified blocking
   * Hook. Merely supplying settings or a tool allowlist is not gate evidence.
   */
  readonly verifiedHookGate?: boolean;
}

export interface ClaudeAdapterOptions {
  readonly command?: string;
  readonly probeTimeoutMs?: number;
}

/**
 * Claims describe this direct one-shot adapter, not every feature Claude Code
 * may expose through interactive mode, hooks, the Agent SDK, or future flags.
 */
export const CLAUDE_ADAPTER_CAPABILITIES = {
  observe: {
    status: 'supported',
    control: 'native',
    detail: 'Claude stream-json supplies native system, message, hook, and result events.',
  },
  context_capture: {
    status: 'unknown',
    control: 'unknown',
    detail:
      'The adapter does not claim that stream-json exposes the complete effective model context.',
  },
  steer: {
    status: 'unsupported',
    control: 'none',
    detail: 'This adapter sends one text input and does not expose a live steering channel.',
  },
  interrupt: {
    status: 'supported',
    control: 'controller',
    detail:
      'AbortSignal terminates the owned Claude process; no semantic Claude cancel is claimed.',
  },
  pre_tool_gate: {
    status: 'unsupported',
    control: 'none',
    detail:
      'Ordinary requests only observe Hook events. Use request-scoped capabilities; only a bound, caller-verified blocking Hook may be declared enforced.',
  },
  resume: {
    status: 'unsupported',
    control: 'none',
    detail: 'This adapter does not expose Claude session resume arguments.',
  },
  native_fork: {
    status: 'unsupported',
    control: 'none',
    detail: 'This adapter does not expose Claude native session fork arguments.',
  },
  workspace_restore: {
    status: 'unsupported',
    control: 'none',
    detail: 'Workspace restoration remains outside the Claude process adapter.',
  },
  external_effect_control: {
    status: 'unknown',
    control: 'unknown',
    detail:
      'Effects outside the owned process and workspace are not controlled or reconciled here.',
  },
} as const satisfies RuntimeAdapterCapabilities;

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty.`);
  }
}

function validateRequest(request: ClaudeRunRequest): void {
  if (!isAbsolute(request.workspace)) {
    throw new TypeError('Claude workspace must be an absolute path.');
  }
  requireNonEmpty(request.prompt, 'Claude prompt');
  if (request.model !== undefined) {
    requireNonEmpty(request.model, 'Claude model');
  }
  if (request.reasoningEffort !== undefined) {
    requireNonEmpty(request.reasoningEffort, 'Claude reasoning effort');
  }
  if (request.settingsFile !== undefined && !isAbsolute(request.settingsFile)) {
    throw new TypeError('Claude settingsFile must be an absolute path.');
  }
  if (request.tools !== undefined) {
    if (request.tools.length === 0) {
      throw new TypeError('Claude tools must contain at least one tool.');
    }
    for (const tool of request.tools) {
      requireNonEmpty(tool, 'Claude tool');
    }
  }
  if (request.verifiedHookGate === true && request.settingsFile === undefined) {
    throw new TypeError('Claude verifiedHookGate requires settingsFile.');
  }
  if (request.verifiedHookGate === true && request.includeHookEvents === false) {
    throw new TypeError('Claude verifiedHookGate requires includeHookEvents.');
  }
  if (
    request.maxTurns !== undefined &&
    (!Number.isSafeInteger(request.maxTurns) || request.maxTurns <= 0)
  ) {
    throw new TypeError('Claude maxTurns must be a positive safe integer.');
  }
}

/**
 * Returns the capability boundary for one concrete request. The adapter-wide
 * declaration intentionally remains weaker because most requests bind no
 * blocking Hook.
 */
export function capabilitiesForRequest(request: ClaudeRunRequest): RuntimeAdapterCapabilities {
  validateRequest(request);
  if (request.verifiedHookGate !== true) {
    return CLAUDE_ADAPTER_CAPABILITIES;
  }

  return {
    ...CLAUDE_ADAPTER_CAPABILITIES,
    pre_tool_gate: {
      status: 'supported',
      control: 'native',
      detail:
        'This request binds a caller-verified blocking Hook through its settings file; the claim is limited to Claude tool dispatch covered by that Hook.',
    },
  };
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
    /claude(?:-code)?[-_]?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i,
  );
  return match?.[1] ?? null;
}

function parseJsonLine(event: ProcessOutputLine): RuntimeOutputLine {
  if (event.stream !== 'stdout') {
    return { ...event, runtime: 'claude' };
  }

  try {
    return {
      ...event,
      runtime: 'claude',
      value: JSON.parse(event.line) as unknown,
    };
  } catch {
    return { ...event, runtime: 'claude' };
  }
}

export function buildClaudeInvocation(
  request: ClaudeRunRequest,
  command = DEFAULT_COMMAND,
): RuntimeInvocation {
  validateRequest(request);
  requireNonEmpty(command, 'Claude command');

  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'text',
    '--verbose',
    '--permission-mode',
    request.permissionMode ?? DEFAULT_PERMISSION_MODE,
  ];

  if (request.includeHookEvents !== false) {
    args.push('--include-hook-events');
  }
  if (request.includePartialMessages === true) {
    args.push('--include-partial-messages');
  }
  if (request.model !== undefined) {
    args.push('--model', request.model);
  }
  if (request.reasoningEffort !== undefined) {
    args.push('--effort', request.reasoningEffort);
  }
  if (request.maxTurns !== undefined) {
    args.push('--max-turns', String(request.maxTurns));
  }
  if (request.noSessionPersistence === true) {
    args.push('--no-session-persistence');
  }
  if (request.settingsFile !== undefined) {
    args.push('--settings', request.settingsFile);
  }
  if (request.tools !== undefined) {
    args.push('--tools', request.tools.join(','));
  }

  return {
    runtime: 'claude',
    outputProtocol: 'claude-stream-json',
    command,
    args,
    cwd: request.workspace,
    stdin: request.prompt,
  };
}

export class ClaudeAdapter implements RuntimeAdapter<ClaudeRunRequest> {
  readonly runtime = 'claude' as const;
  readonly capabilities = CLAUDE_ADAPTER_CAPABILITIES;
  readonly command: string;
  readonly probeTimeoutMs: number;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.command = options.command ?? DEFAULT_COMMAND;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    requireNonEmpty(this.command, 'Claude command');
    if (!Number.isFinite(this.probeTimeoutMs) || this.probeTimeoutMs <= 0) {
      throw new TypeError('Claude probeTimeoutMs must be a positive number.');
    }
  }

  async detect(): Promise<RuntimeDetection> {
    const checkedAt = new Date().toISOString();
    const started = performance.now();
    const executablePath = await resolveExecutable(this.command);

    if (executablePath === null) {
      return {
        runtime: 'claude',
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
      runtime: 'claude',
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

  buildInvocation(request: ClaudeRunRequest): RuntimeInvocation {
    return buildClaudeInvocation(request, this.command);
  }

  capabilitiesForRequest(request: ClaudeRunRequest): RuntimeAdapterCapabilities {
    return capabilitiesForRequest(request);
  }

  async run(request: ClaudeRunRequest): Promise<RuntimeRunResult> {
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
      runtime: 'claude',
      outputProtocol: 'claude-stream-json',
      process: processResult,
    };
  }
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ClaudeAdapter {
  return new ClaudeAdapter(options);
}
