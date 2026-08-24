import { access } from 'node:fs/promises';

import { CodexAdapter } from './adapters/codex.js';
import { resolveExecutable, runProcess } from './adapters/process-runner.js';
import { QoderAdapter } from './adapters/qoder.js';
import type { RuntimeDetection } from './adapters/types.js';

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const SUPPORTED_RUNTIME_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_DEEPSEEK_WRAPPER_PATHS = ['/Applications/DeepSeek Harness.app'] as const;

export type RuntimeCatalogId =
  | 'codex'
  | 'qoder'
  | 'claude'
  | 'opencode'
  | 'hermes'
  | 'deepseek-harness';

export type RuntimeCatalogStatus =
  | 'ready-supported'
  | 'installed-unavailable'
  | 'installed-unsupported'
  | 'needs-bootstrap'
  | 'missing';

export type RuntimeCatalogSupport = 'supported' | 'unsupported';

export interface RuntimeCatalogEntry {
  readonly id: RuntimeCatalogId;
  readonly displayName: string;
  readonly status: RuntimeCatalogStatus;
  readonly support: RuntimeCatalogSupport;
  readonly path: string | null;
  readonly version: string | null;
  readonly reason: string;
  readonly capabilities: readonly string[];
  readonly checkedAt: string;
}

export type CommandProbeStatus = 'ready' | 'present-unresponsive' | 'present-error' | 'missing';

export interface CommandProbeResult {
  readonly command: string;
  readonly status: CommandProbeStatus;
  readonly path: string | null;
  readonly version: string | null;
}

export type CommandProbe = (command: string) => Promise<CommandProbeResult>;

export interface CommandVersionProbeOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export interface RuntimeCatalogOptions {
  readonly codexAdapter?: Pick<CodexAdapter, 'detect'>;
  readonly qoderAdapter?: Pick<QoderAdapter, 'detect'>;
  readonly commandProbe?: CommandProbe;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly deepSeekWrapperPaths?: readonly string[];
  readonly now?: () => Date;
}

interface UnsupportedRuntimeDefinition {
  readonly id: Extract<RuntimeCatalogId, 'claude' | 'opencode' | 'hermes'>;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: readonly string[];
}

const UNSUPPORTED_RUNTIME_DEFINITIONS: readonly UnsupportedRuntimeDefinition[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    capabilities: [
      'non-interactive',
      'stream-json-events',
      'model-selection',
      'reasoning-effort',
      'session-resume',
      'session-fork',
    ],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    capabilities: [
      'non-interactive',
      'json-events',
      'model-selection',
      'reasoning-variant',
      'session-resume',
      'session-fork',
      'acp',
    ],
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    command: 'hermes',
    capabilities: ['non-interactive', 'model-selection', 'usage-report', 'session-resume', 'acp'],
  },
] as const;

const SUPPORTED_CAPABILITIES = {
  codex: ['non-interactive', 'jsonl-events', 'workspace', 'model-selection', 'reasoning-effort'],
  qoder: [
    'non-interactive',
    'stream-json-events',
    'workspace',
    'model-selection',
    'reasoning-effort',
  ],
} as const;

/** Build a read-only probe that resolves one command and invokes only `--version`. */
export function createCommandVersionProbe(options: CommandVersionProbeOptions = {}): CommandProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Command probe timeoutMs must be a positive finite number.');
  }
  const cwd = options.cwd ?? process.cwd();

  return async (command: string): Promise<CommandProbeResult> => {
    if (command.trim().length === 0) {
      throw new TypeError('Command probe command must not be empty.');
    }

    const executablePath = await resolveExecutable(command, cwd);
    if (executablePath === null) {
      return {
        command,
        status: 'missing',
        path: null,
        version: null,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const output: string[] = [];
    const result = await runProcess(
      {
        command: executablePath,
        args: ['--version'],
        cwd,
      },
      {
        signal: controller.signal,
        abortGraceMs: 100,
        onOutput: (event) => {
          output.push(event.line);
        },
      },
    );
    clearTimeout(timer);

    const version = parseVersion(output);
    if (result.aborted) {
      return {
        command,
        status: 'present-unresponsive',
        path: executablePath,
        version,
      };
    }
    if (result.spawnError !== undefined || result.exitCode !== 0) {
      return {
        command,
        status: 'present-error',
        path: executablePath,
        version,
      };
    }
    return {
      command,
      status: 'ready',
      path: executablePath,
      version,
    };
  };
}

/**
 * Discover the fixed Runtime catalog without authenticating or invoking a model.
 * Array order and object fields are stable so callers can serialize the result directly.
 */
export async function discoverRuntimeCatalog(
  options: RuntimeCatalogOptions = {},
): Promise<readonly RuntimeCatalogEntry[]> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const commandProbe = options.commandProbe ?? createCommandVersionProbe();
  const pathExists = options.pathExists ?? defaultPathExists;
  const wrapperPaths = options.deepSeekWrapperPaths ?? DEFAULT_DEEPSEEK_WRAPPER_PATHS;
  const codexAdapter =
    options.codexAdapter ??
    new CodexAdapter({ probeTimeoutMs: SUPPORTED_RUNTIME_PROBE_TIMEOUT_MS });
  const qoderAdapter =
    options.qoderAdapter ??
    new QoderAdapter({ probeTimeoutMs: SUPPORTED_RUNTIME_PROBE_TIMEOUT_MS });

  const [codex, qoder, unsupported, dsh] = await Promise.all([
    codexAdapter.detect(),
    qoderAdapter.detect(),
    Promise.all(
      UNSUPPORTED_RUNTIME_DEFINITIONS.map(async (definition) => ({
        definition,
        probe: await commandProbe(definition.command),
      })),
    ),
    commandProbe('dsh'),
  ]);

  const deepSeekWrapperPath =
    dsh.path === null ? await firstExistingPath(wrapperPaths, pathExists) : null;

  return [
    supportedEntry('codex', 'Codex', codex, SUPPORTED_CAPABILITIES.codex, checkedAt),
    supportedEntry('qoder', 'Qoder', qoder, SUPPORTED_CAPABILITIES.qoder, checkedAt),
    ...unsupported.map(({ definition, probe }) => unsupportedEntry(definition, probe, checkedAt)),
    deepSeekEntry(dsh, deepSeekWrapperPath, checkedAt),
  ];
}

function supportedEntry(
  id: Extract<RuntimeCatalogId, 'codex' | 'qoder'>,
  displayName: string,
  detection: RuntimeDetection,
  capabilities: readonly string[],
  checkedAt: string,
): RuntimeCatalogEntry {
  const ready = detection.status === 'ready' && detection.responsive;
  const missing = detection.status === 'missing' || detection.executablePath === null;
  return {
    id,
    displayName,
    status: ready ? 'ready-supported' : missing ? 'missing' : 'installed-unavailable',
    support: 'supported',
    path: detection.executablePath,
    version: detection.version,
    reason: ready
      ? 'Supported adapter detected and version probe succeeded.'
      : missing
        ? 'Supported adapter command was not found.'
        : `Supported adapter is installed but its version probe reported ${detection.status}.`,
    capabilities,
    checkedAt,
  };
}

function unsupportedEntry(
  definition: UnsupportedRuntimeDefinition,
  probe: CommandProbeResult,
  checkedAt: string,
): RuntimeCatalogEntry {
  const installed = probe.path !== null;
  return {
    id: definition.id,
    displayName: definition.displayName,
    status: installed ? 'installed-unsupported' : 'missing',
    support: 'unsupported',
    path: probe.path,
    version: probe.version,
    reason: installed
      ? 'Installed and discoverable, but no MissionBraid runtime adapter is implemented.'
      : 'Command was not found and no MissionBraid runtime adapter is implemented.',
    capabilities: definition.capabilities,
    checkedAt,
  };
}

function deepSeekEntry(
  probe: CommandProbeResult,
  wrapperPath: string | null,
  checkedAt: string,
): RuntimeCatalogEntry {
  const dshInstalled = probe.path !== null;
  const needsBootstrap = !dshInstalled && wrapperPath !== null;
  return {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    status: dshInstalled ? 'installed-unsupported' : needsBootstrap ? 'needs-bootstrap' : 'missing',
    support: 'unsupported',
    path: probe.path ?? wrapperPath,
    version: probe.version,
    reason: dshInstalled
      ? 'DSH is installed, but no MissionBraid runtime adapter is implemented.'
      : needsBootstrap
        ? 'The DeepSeek Harness wrapper is installed, but dsh is not on PATH and requires bootstrap.'
        : 'Neither the dsh command nor the DeepSeek Harness wrapper was found.',
    capabilities: ['headless-profile'],
    checkedAt,
  };
}

function parseVersion(lines: readonly string[]): string | null {
  for (const line of lines) {
    const match = line.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(
  paths: readonly string[],
  pathExists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return null;
}
