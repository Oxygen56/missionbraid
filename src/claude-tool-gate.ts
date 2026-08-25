import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_MUTABLE_TOOL_ALLOWLIST = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
] as const;

export interface ClaudeToolGateBindingV1 {
  readonly settingsFile: string;
  readonly settingsSha256: string;
  readonly matcher: string;
  readonly tools: readonly string[];
  readonly control: 'native';
}

export async function createClaudeToolGateBinding(input: {
  readonly stateDir: string;
  readonly gatewayRoot: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly timeoutMs?: number;
}): Promise<ClaudeToolGateBindingV1> {
  for (const [name, value] of [
    ['stateDir', input.stateDir],
    ['gatewayRoot', input.gatewayRoot],
  ] as const) {
    if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  }
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new TypeError('Claude Tool Gateway timeout must be between 1000 and 600000ms');
  }
  const command = hookCommand(input.gatewayRoot, input.missionId, input.attemptId, timeoutMs);
  const matcher = 'Write|Edit|NotebookEdit|Bash|mcp__.*';
  const commandHook = { type: 'command', command, timeout: Math.ceil(timeoutMs / 1_000) };
  const settings = {
    hooks: {
      PreToolUse: [{ matcher, hooks: [commandHook] }],
      PostToolUse: [{ matcher, hooks: [commandHook] }],
      PostToolUseFailure: [{ matcher, hooks: [commandHook] }],
    },
  };
  const content = `${stableStringify(settings)}\n`;
  const settingsSha256 = sha256(content);
  const settingsFile = join(
    input.stateDir,
    'tool-gateway',
    'settings',
    `${input.missionId}-${input.attemptId}-${settingsSha256.slice(0, 16)}.json`,
  );
  await mkdir(dirname(settingsFile), { recursive: true, mode: 0o700 });
  try {
    await writeFile(settingsFile, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
  }
  await chmod(settingsFile, 0o600);
  return {
    settingsFile,
    settingsSha256,
    matcher,
    tools: CLAUDE_MUTABLE_TOOL_ALLOWLIST,
    control: 'native',
  };
}

function hookCommand(
  gatewayRoot: string,
  missionId: string,
  attemptId: string,
  timeoutMs: number,
): string {
  const moduleFile = fileURLToPath(import.meta.url);
  const bridgeFile = moduleFile.endsWith('.ts')
    ? fileURLToPath(new URL('./hook-bridge.ts', import.meta.url))
    : fileURLToPath(new URL('./hook-bridge.js', import.meta.url));
  const runtime = [shellQuote(process.execPath)];
  if (moduleFile.endsWith('.ts')) runtime.push('--import', 'tsx');
  runtime.push(shellQuote(bridgeFile));
  return [
    `MISSIONBRAID_TOOL_GATEWAY_ROOT=${shellQuote(gatewayRoot)}`,
    `MISSIONBRAID_MISSION_ID=${shellQuote(missionId)}`,
    `MISSIONBRAID_ATTEMPT_ID=${shellQuote(attemptId)}`,
    `MISSIONBRAID_GATE_TIMEOUT_MS=${String(timeoutMs)}`,
    `MISSIONBRAID_GATE_POLL_INTERVAL_MS=25`,
    ...runtime,
  ].join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
