/** Claude Code hook bridge for the filesystem Tool Gateway. */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { ToolGateway, type JsonObject, type ToolReleaseV1 } from './tool-gateway.js';
import type { JsonValue } from './domain.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;

export type ClaudeToolHookEventName = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';

export interface ClaudeToolHookInput {
  readonly hook_event_name: ClaudeToolHookEventName;
  readonly session_id: string;
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly tool_input: JsonObject;
  readonly tool_response?: JsonValue;
  readonly error?: string;
}

export interface ClaudePreToolHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: 'allow' | 'deny';
    readonly permissionDecisionReason: string;
    readonly updatedInput?: JsonObject;
  };
}

export type ClaudeHookOutput = ClaudePreToolHookOutput | Readonly<Record<string, never>>;

export interface HandleClaudeHookOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface RunClaudeHookBridgeOptions extends HandleClaudeHookOptions {
  readonly gateway: ToolGateway;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly maxStdinBytes?: number;
}

/**
 * Handles one Claude hook invocation. For PreToolUse the raw input remains in
 * this process while only a sanitized request is written to the gateway.
 */
export async function handleClaudeHook(
  input: ClaudeToolHookInput,
  gateway: ToolGateway,
  options: HandleClaudeHookOptions = {},
): Promise<ClaudeHookOutput> {
  validateHookInput(input);

  if (input.hook_event_name === 'PreToolUse') {
    const request = await gateway.writePending({
      toolName: input.tool_name,
      toolUseId: input.tool_use_id,
      sessionId: input.session_id,
      toolInput: input.tool_input,
    });
    const release = await gateway.waitForRelease(request.gateId, {
      timeoutMs: positiveNumber(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs'),
      pollIntervalMs: positiveNumber(
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        'pollIntervalMs',
      ),
    });
    return releaseOutput(release);
  }

  const request = await gateway.findRequestByInvocation({
    toolName: input.tool_name,
    toolUseId: input.tool_use_id,
    sessionId: input.session_id,
  });
  if (request === undefined) throw new Error('Post-tool hook has no matching pre-tool request');

  if (input.hook_event_name === 'PostToolUse') {
    await gateway.markResult({
      gateId: request.gateId,
      originalInputSha256: request.originalInputSha256,
      hookEventName: 'PostToolUse',
      outcome: 'succeeded',
      ...(input.tool_response === undefined ? {} : { toolResponse: input.tool_response }),
    });
    return {};
  }

  await gateway.markResult({
    gateId: request.gateId,
    originalInputSha256: request.originalInputSha256,
    hookEventName: 'PostToolUseFailure',
    outcome: 'failed',
    error: input.error ?? 'tool failed',
  });
  return {};
}

/** Read one bounded stdin object and emit exactly one Claude-native JSON result. */
export async function runClaudeHookBridge(options: RunClaudeHookBridgeOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const maxStdinBytes = positiveInteger(
    options.maxStdinBytes ?? DEFAULT_MAX_STDIN_BYTES,
    'maxStdinBytes',
  );
  let parsed: unknown;
  try {
    const content = await readBoundedStdin(stdin, maxStdinBytes);
    parsed = JSON.parse(content) as unknown;
    if (!isClaudeToolHookInput(parsed)) throw new TypeError('Invalid Claude tool hook input');
    const output = await handleClaudeHook(parsed, options.gateway, options);
    stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    stdout.write(`${JSON.stringify(failureOutput(parsed))}\n`);
  }
}

/** Entry point suitable for a Claude command hook. */
export async function runClaudeHookBridgeFromEnvironment(): Promise<void> {
  const rootDir = requiredEnvironment('MISSIONBRAID_TOOL_GATEWAY_ROOT');
  const missionId = requiredEnvironment('MISSIONBRAID_MISSION_ID');
  const attemptId = requiredEnvironment('MISSIONBRAID_ATTEMPT_ID');
  const gateway = new ToolGateway({ rootDir, missionId, attemptId });
  await runClaudeHookBridge({
    gateway,
    timeoutMs: optionalEnvironmentNumber(
      'MISSIONBRAID_GATE_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS,
      1,
      10 * 60 * 1_000,
    ),
    pollIntervalMs: optionalEnvironmentNumber(
      'MISSIONBRAID_GATE_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
      1,
      5_000,
    ),
    maxStdinBytes: optionalEnvironmentNumber(
      'MISSIONBRAID_HOOK_MAX_STDIN_BYTES',
      DEFAULT_MAX_STDIN_BYTES,
      1_024,
      4 * 1024 * 1024,
    ),
  });
}

function releaseOutput(release: ToolReleaseV1): ClaudePreToolHookOutput {
  if (release.decision === 'reject') {
    return preToolOutput('deny', release.reason ?? 'Rejected by a persisted Mission decision.');
  }
  if (release.decision === 'modify') {
    if (release.updatedInput === undefined) {
      return preToolOutput(
        'deny',
        'Modified input was unavailable; the request was not dispatched.',
      );
    }
    return preToolOutput(
      'allow',
      release.reason ?? 'Modified input approved by a persisted Mission decision.',
      release.updatedInput,
    );
  }
  return preToolOutput('allow', release.reason ?? 'Approved by a persisted Mission decision.');
}

function failureOutput(input: unknown): ClaudeHookOutput {
  if (isJsonObject(input) && input.hook_event_name !== 'PreToolUse') return {};
  return preToolOutput(
    'deny',
    'MissionBraid could not obtain a valid persisted release; denied closed.',
  );
}

function preToolOutput(
  permissionDecision: 'allow' | 'deny',
  permissionDecisionReason: string,
  updatedInput?: JsonObject,
): ClaudePreToolHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
      ...(updatedInput === undefined ? {} : { updatedInput }),
    },
  };
}

function validateHookInput(input: ClaudeToolHookInput): void {
  for (const [name, value] of [
    ['session_id', input.session_id],
    ['tool_name', input.tool_name],
    ['tool_use_id', input.tool_use_id],
  ] as const) {
    if (value.trim().length === 0 || value.length > 4_096) {
      throw new TypeError(`${name} must be a non-empty bounded string`);
    }
  }
  if (!isJsonObject(input.tool_input)) throw new TypeError('tool_input must be a JSON object');
  if (input.hook_event_name === 'PostToolUseFailure' && typeof input.error !== 'string') {
    throw new TypeError('PostToolUseFailure requires error');
  }
}

function isClaudeToolHookInput(value: unknown): value is ClaudeToolHookInput {
  if (!isJsonObject(value)) return false;
  return (
    (value.hook_event_name === 'PreToolUse' ||
      value.hook_event_name === 'PostToolUse' ||
      value.hook_event_name === 'PostToolUseFailure') &&
    typeof value.session_id === 'string' &&
    typeof value.tool_name === 'string' &&
    typeof value.tool_use_id === 'string' &&
    isJsonObject(value.tool_input) &&
    (value.tool_response === undefined || isJsonValue(value.tool_response)) &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 50) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((member) => isJsonValue(member, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((member) =>
    isJsonValue(member, depth + 1),
  );
}

async function readBoundedStdin(stdin: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error('Claude hook input exceeds configured limit');
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error('Claude hook input is empty');
  return Buffer.concat(chunks).toString('utf8');
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function optionalEnvironmentNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    await runClaudeHookBridgeFromEnvironment();
  } catch {
    process.stdout.write(`${JSON.stringify(failureOutput(undefined))}\n`);
  }
}
