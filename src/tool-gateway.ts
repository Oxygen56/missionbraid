/**
 * Filesystem hand-off between a pre-tool bridge, the Workbench, and the
 * Mission Kernel. Files here are transport records, never Mission authority.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { sanitizeNativeArtifact } from './artifact-store.js';
import type { JsonValue } from './domain.js';

export const TOOL_GATEWAY_SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const MAX_IDENTIFIER_LENGTH = 4_096;

export type JsonObject = { readonly [key: string]: JsonValue };
export type ToolDecision = 'approve' | 'reject' | 'modify';

export interface ToolGateIdentityV1 {
  readonly gateId: string;
  readonly effectId: string;
  readonly toolUseIdSha256: string;
  readonly sessionIdSha256: string;
  readonly originalInputSha256: string;
  readonly requestSha256: string;
}

export interface ToolGateRequestDraft {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly sessionId: string;
  readonly toolInput: JsonObject;
  readonly requestedAt?: string;
}

export interface ToolGateRequestV1 extends ToolGateIdentityV1 {
  readonly schemaVersion: typeof TOOL_GATEWAY_SCHEMA_VERSION;
  readonly missionId: string;
  readonly attemptId: string;
  readonly hookEventName: 'PreToolUse';
  readonly toolName: string;
  /** Sanitized copy only. The raw input is never written by this module. */
  readonly toolInput: JsonObject;
  readonly requestedAt: string;
}

export interface ToolDecisionIntentDraft {
  readonly gateId: string;
  readonly expectedRequestSha256: string;
  readonly decision: ToolDecision;
  readonly reason?: string;
  readonly updatedInput?: JsonObject;
  readonly createdAt?: string;
}

export interface ToolDecisionIntentV1 {
  readonly schemaVersion: typeof TOOL_GATEWAY_SCHEMA_VERSION;
  readonly decisionIntentId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly gateId: string;
  readonly effectId: string;
  readonly expectedRequestSha256: string;
  readonly decision: ToolDecision;
  readonly reason?: string;
  readonly updatedInput?: JsonObject;
  readonly createdAt: string;
}

/** Evidence that the engine persisted the decision before emitting a release. */
export interface PersistedKernelDecisionV1 {
  readonly eventId: string;
  readonly seq: number;
  readonly hash: string;
  readonly recordedAt: string;
}

export interface ToolReleaseDraft {
  readonly decisionIntentId: string;
  readonly kernelDecisionEvent: PersistedKernelDecisionV1;
  readonly releasedAt?: string;
}

export interface ToolReleaseV1 {
  readonly schemaVersion: typeof TOOL_GATEWAY_SCHEMA_VERSION;
  readonly releaseId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly gateId: string;
  readonly effectId: string;
  readonly requestSha256: string;
  readonly decisionIntentId: string;
  readonly decision: ToolDecision;
  readonly reason?: string;
  readonly updatedInput?: JsonObject;
  readonly kernelDecisionEvent: PersistedKernelDecisionV1;
  readonly releasedAt: string;
}

export interface ToolResultDraft {
  readonly gateId: string;
  readonly originalInputSha256: string;
  readonly hookEventName: 'PostToolUse' | 'PostToolUseFailure';
  readonly outcome: 'succeeded' | 'failed';
  readonly toolResponse?: JsonValue;
  readonly error?: string;
  readonly observedAt?: string;
}

export interface ToolResultV1 {
  readonly schemaVersion: typeof TOOL_GATEWAY_SCHEMA_VERSION;
  readonly resultId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly gateId: string;
  readonly effectId: string;
  readonly hookEventName: 'PostToolUse' | 'PostToolUseFailure';
  readonly outcome: 'succeeded' | 'failed';
  readonly resultSha256: string;
  readonly observedAt: string;
}

export interface WaitForReleaseOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface ToolGatewayOptions {
  readonly rootDir: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly maxFileBytes?: number;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

export class ToolGatewayTimeoutError extends Error {
  constructor(readonly gateId: string) {
    super(`Timed out waiting for a persisted release for ${gateId}`);
    this.name = 'ToolGatewayTimeoutError';
  }
}

export class ToolGateway {
  readonly missionId: string;
  readonly attemptId: string;
  readonly attemptDirectory: string;
  readonly #requestDirectory: string;
  readonly #intentDirectory: string;
  readonly #releaseDirectory: string;
  readonly #resultDirectory: string;
  readonly #maxFileBytes: number;
  readonly #maxEntries: number;
  readonly #now: () => Date;

  constructor(options: ToolGatewayOptions) {
    requireIdentifier(options.missionId, 'missionId');
    requireIdentifier(options.attemptId, 'attemptId');
    if (!isAbsolute(options.rootDir)) throw new TypeError('Tool Gateway rootDir must be absolute');
    const rootDir = resolve(options.rootDir);
    if (parse(rootDir).root === rootDir) {
      throw new TypeError('Tool Gateway rootDir cannot be a filesystem root');
    }
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (
      !Number.isSafeInteger(maxFileBytes) ||
      maxFileBytes < 1_024 ||
      maxFileBytes > 4 * 1024 * 1024
    ) {
      throw new TypeError('maxFileBytes must be a safe integer between 1024 and 4194304');
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
      throw new TypeError('maxEntries must be a safe integer between 1 and 100000');
    }
    this.missionId = options.missionId;
    this.attemptId = options.attemptId;
    this.#maxFileBytes = maxFileBytes;
    this.#maxEntries = maxEntries;
    this.#now = options.now ?? (() => new Date());
    const attemptKey = sha256(`${options.missionId}\0${options.attemptId}`).slice(0, 32);
    this.attemptDirectory = join(rootDir, 'attempts', `attempt-${attemptKey}`);
    this.#requestDirectory = join(this.attemptDirectory, 'requests');
    this.#intentDirectory = join(this.attemptDirectory, 'decision-intents');
    this.#releaseDirectory = join(this.attemptDirectory, 'releases');
    this.#resultDirectory = join(this.attemptDirectory, 'results');
  }

  async initialize(): Promise<void> {
    for (const directory of [
      this.attemptDirectory,
      this.#requestDirectory,
      this.#intentDirectory,
      this.#releaseDirectory,
      this.#resultDirectory,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  }

  identifyRequest(draft: Omit<ToolGateRequestDraft, 'requestedAt'>): ToolGateIdentityV1 {
    validateToolDraft(draft);
    const originalInputSha256 = sha256(stableStringify(draft.toolInput));
    const toolUseIdSha256 = sha256(draft.toolUseId);
    const sessionIdSha256 = sha256(draft.sessionId);
    const requestSha256 = sha256(
      stableStringify({
        missionId: this.missionId,
        attemptId: this.attemptId,
        toolName: draft.toolName,
        toolUseIdSha256,
        sessionIdSha256,
        originalInputSha256,
      }),
    );
    const gateId = `gate-${sha256(`gate\0${requestSha256}`).slice(0, 32)}`;
    return {
      gateId,
      effectId: `effect-${sha256(`effect\0${this.missionId}\0${this.attemptId}\0${gateId}`).slice(0, 32)}`,
      toolUseIdSha256,
      sessionIdSha256,
      originalInputSha256,
      requestSha256,
    };
  }

  /** Called by the bridge before Claude is allowed to dispatch the tool. */
  async writePending(draft: ToolGateRequestDraft): Promise<ToolGateRequestV1> {
    await this.initialize();
    validateToolDraft(draft);
    const identity = this.identifyRequest(draft);
    const request: ToolGateRequestV1 = {
      schemaVersion: TOOL_GATEWAY_SCHEMA_VERSION,
      ...identity,
      missionId: this.missionId,
      attemptId: this.attemptId,
      hookEventName: 'PreToolUse',
      toolName: draft.toolName,
      toolInput: sanitizeJsonObject(draft.toolInput),
      requestedAt: validTimestamp(draft.requestedAt ?? this.#now().toISOString(), 'requestedAt'),
    };
    return this.#writeRecord(
      this.#requestFile(request.gateId),
      request,
      isToolGateRequest,
      (existing) => existing.requestSha256 === request.requestSha256,
    );
  }

  /** Returns requests without a persisted engine release. */
  async listPending(): Promise<readonly ToolGateRequestV1[]> {
    await this.initialize();
    const requests = await this.#readDirectory(this.#requestDirectory, isToolGateRequest);
    const pending: ToolGateRequestV1[] = [];
    for (const request of requests) {
      if ((await this.readRelease(request.gateId)) === undefined) pending.push(request);
    }
    return pending.sort((left, right) =>
      left.requestedAt === right.requestedAt
        ? left.gateId.localeCompare(right.gateId)
        : left.requestedAt.localeCompare(right.requestedAt),
    );
  }

  /** Resolves a post-tool hook back to its original pre-tool request. */
  async findRequestByInvocation(input: {
    readonly toolName: string;
    readonly toolUseId: string;
    readonly sessionId: string;
  }): Promise<ToolGateRequestV1 | undefined> {
    await this.initialize();
    for (const [name, value] of [
      ['toolName', input.toolName],
      ['toolUseId', input.toolUseId],
      ['sessionId', input.sessionId],
    ] as const) {
      requireIdentifier(value, name);
    }
    const toolUseIdSha256 = sha256(input.toolUseId);
    const sessionIdSha256 = sha256(input.sessionId);
    const matches = (await this.#readDirectory(this.#requestDirectory, isToolGateRequest)).filter(
      (request) =>
        request.toolName === input.toolName &&
        request.toolUseIdSha256 === toolUseIdSha256 &&
        request.sessionIdSha256 === sessionIdSha256,
    );
    if (matches.length > 1) {
      throw new Error('Tool invocation maps to more than one pre-tool request');
    }
    return matches[0];
  }

  /** Called by the Workbench. This records intent but cannot release a tool. */
  async writeDecisionIntent(draft: ToolDecisionIntentDraft): Promise<ToolDecisionIntentV1> {
    await this.initialize();
    const request = await this.#requireRequest(draft.gateId);
    if (draft.expectedRequestSha256 !== request.requestSha256) {
      throw new Error('Decision intent targets a stale or different tool request');
    }
    validateDecision(draft.decision, draft.updatedInput);
    const reason = draft.reason === undefined ? undefined : sanitizeText(draft.reason, 'reason');
    const updatedInput =
      draft.updatedInput === undefined ? undefined : sanitizeJsonObject(draft.updatedInput);
    const decisionIntentId = `decision-intent-${sha256(
      stableStringify({
        gateId: request.gateId,
        effectId: request.effectId,
        expectedRequestSha256: request.requestSha256,
        decision: draft.decision,
        reason: reason ?? null,
        updatedInput: updatedInput ?? null,
      }),
    ).slice(0, 32)}`;
    const intent: ToolDecisionIntentV1 = {
      schemaVersion: TOOL_GATEWAY_SCHEMA_VERSION,
      decisionIntentId,
      missionId: this.missionId,
      attemptId: this.attemptId,
      gateId: request.gateId,
      effectId: request.effectId,
      expectedRequestSha256: request.requestSha256,
      decision: draft.decision,
      ...(reason === undefined ? {} : { reason }),
      ...(updatedInput === undefined ? {} : { updatedInput }),
      createdAt: validTimestamp(draft.createdAt ?? this.#now().toISOString(), 'createdAt'),
    };
    return this.#writeRecord(
      this.#intentFile(intent.decisionIntentId),
      intent,
      isToolDecisionIntent,
      (existing) => existing.decisionIntentId === intent.decisionIntentId,
    );
  }

  /** Called by the engine when consuming Workbench intents. */
  async readDecisionIntents(): Promise<readonly ToolDecisionIntentV1[]> {
    await this.initialize();
    return (await this.#readDirectory(this.#intentDirectory, isToolDecisionIntent)).sort(
      (left, right) =>
        left.createdAt === right.createdAt
          ? left.decisionIntentId.localeCompare(right.decisionIntentId)
          : left.createdAt.localeCompare(right.createdAt),
    );
  }

  /**
   * Called only after the engine has persisted the decision. The required
   * StoredEvent identity prevents an App intent from masquerading as release.
   */
  async writeRelease(draft: ToolReleaseDraft): Promise<ToolReleaseV1> {
    await this.initialize();
    validateKernelDecision(draft.kernelDecisionEvent);
    const intent = await this.#readRecord(
      this.#intentFile(draft.decisionIntentId),
      isToolDecisionIntent,
    );
    if (intent === undefined) throw new Error('Cannot release without a decision intent');
    const request = await this.#requireRequest(intent.gateId);
    if (
      intent.missionId !== this.missionId ||
      intent.attemptId !== this.attemptId ||
      intent.effectId !== request.effectId ||
      intent.expectedRequestSha256 !== request.requestSha256
    ) {
      throw new Error('Decision intent does not match the pending tool request');
    }
    const releaseId = `release-${sha256(
      stableStringify({
        decisionIntentId: intent.decisionIntentId,
        eventId: draft.kernelDecisionEvent.eventId,
        eventHash: draft.kernelDecisionEvent.hash,
      }),
    ).slice(0, 32)}`;
    const release: ToolReleaseV1 = {
      schemaVersion: TOOL_GATEWAY_SCHEMA_VERSION,
      releaseId,
      missionId: this.missionId,
      attemptId: this.attemptId,
      gateId: request.gateId,
      effectId: request.effectId,
      requestSha256: request.requestSha256,
      decisionIntentId: intent.decisionIntentId,
      decision: intent.decision,
      ...(intent.reason === undefined ? {} : { reason: intent.reason }),
      ...(intent.updatedInput === undefined ? {} : { updatedInput: intent.updatedInput }),
      kernelDecisionEvent: draft.kernelDecisionEvent,
      releasedAt: validTimestamp(draft.releasedAt ?? this.#now().toISOString(), 'releasedAt'),
    };
    return this.#writeRecord(
      this.#releaseFile(request.gateId),
      release,
      isToolRelease,
      (existing) => existing.releaseId === release.releaseId,
    );
  }

  async readRelease(gateId: string): Promise<ToolReleaseV1 | undefined> {
    await this.initialize();
    requireStableId(gateId, 'gate');
    const release = await this.#readRecord(this.#releaseFile(gateId), isToolRelease);
    if (
      release !== undefined &&
      (release.gateId !== gateId ||
        release.missionId !== this.missionId ||
        release.attemptId !== this.attemptId)
    ) {
      throw new Error('Tool release does not match its Attempt or gate path');
    }
    return release;
  }

  async waitForRelease(gateId: string, options: WaitForReleaseOptions): Promise<ToolReleaseV1> {
    requireStableId(gateId, 'gate');
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive number');
    }
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 5_000) {
      throw new TypeError('pollIntervalMs must be between 1 and 5000');
    }
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      if (options.signal?.aborted === true) throw abortError();
      const release = await this.readRelease(gateId);
      if (release !== undefined) return release;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ToolGatewayTimeoutError(gateId);
      await delay(Math.min(pollIntervalMs, remaining), options.signal);
    }
  }

  async markResult(draft: ToolResultDraft): Promise<ToolResultV1> {
    await this.initialize();
    const request = await this.#requireRequest(draft.gateId);
    if (request.originalInputSha256 !== draft.originalInputSha256) {
      throw new Error('Post-tool result does not match the pre-tool input digest');
    }
    if (
      (draft.hookEventName === 'PostToolUse' && draft.outcome !== 'succeeded') ||
      (draft.hookEventName === 'PostToolUseFailure' && draft.outcome !== 'failed')
    ) {
      throw new TypeError('Hook event and result outcome disagree');
    }
    const resultMaterial =
      draft.outcome === 'succeeded'
        ? stableStringify(draft.toolResponse ?? null)
        : sanitizeText(draft.error ?? 'tool failed', 'error');
    const resultSha256 = sha256(resultMaterial);
    const resultId = `tool-result-${sha256(
      `${request.gateId}\0${draft.hookEventName}\0${resultSha256}`,
    ).slice(0, 32)}`;
    const result: ToolResultV1 = {
      schemaVersion: TOOL_GATEWAY_SCHEMA_VERSION,
      resultId,
      missionId: this.missionId,
      attemptId: this.attemptId,
      gateId: request.gateId,
      effectId: request.effectId,
      hookEventName: draft.hookEventName,
      outcome: draft.outcome,
      resultSha256,
      observedAt: validTimestamp(draft.observedAt ?? this.#now().toISOString(), 'observedAt'),
    };
    return this.#writeRecord(
      join(this.#resultDirectory, `${resultId}.json`),
      result,
      isToolResult,
      (existing) => existing.resultId === result.resultId,
    );
  }

  async listResults(): Promise<readonly ToolResultV1[]> {
    await this.initialize();
    return (await this.#readDirectory(this.#resultDirectory, isToolResult)).sort((left, right) =>
      left.observedAt === right.observedAt
        ? left.resultId.localeCompare(right.resultId)
        : left.observedAt.localeCompare(right.observedAt),
    );
  }

  #requestFile(gateId: string): string {
    requireStableId(gateId, 'gate');
    return join(this.#requestDirectory, `${gateId}.json`);
  }

  #intentFile(intentId: string): string {
    requireStableId(intentId, 'decision-intent');
    return join(this.#intentDirectory, `${intentId}.json`);
  }

  #releaseFile(gateId: string): string {
    requireStableId(gateId, 'gate');
    return join(this.#releaseDirectory, `${gateId}.json`);
  }

  async #requireRequest(gateId: string): Promise<ToolGateRequestV1> {
    const request = await this.#readRecord(this.#requestFile(gateId), isToolGateRequest);
    if (request === undefined) throw new Error(`Unknown Tool Gateway request ${gateId}`);
    if (
      request.gateId !== gateId ||
      request.missionId !== this.missionId ||
      request.attemptId !== this.attemptId
    ) {
      throw new Error('Tool request does not match its Attempt or gate path');
    }
    return request;
  }

  async #writeRecord<T>(
    file: string,
    value: T,
    guard: (candidate: unknown) => candidate is T,
    equivalent: (existing: T) => boolean,
  ): Promise<T> {
    const content = `${stableStringify(value)}\n`;
    if (Buffer.byteLength(content, 'utf8') > this.#maxFileBytes) {
      throw new Error('Tool Gateway record exceeds maxFileBytes');
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    await acquireLock(lock);
    let temporary: string | undefined;
    try {
      const existing = await this.#readRecord(file, guard);
      if (existing !== undefined) {
        if (equivalent(existing)) return existing;
        throw new Error('Conflicting Tool Gateway record already exists');
      }
      temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      temporary = undefined;
      await chmod(file, 0o600);
      return value;
    } finally {
      if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
      await rmdir(lock).catch(() => undefined);
    }
  }

  async #readDirectory<T>(
    directory: string,
    guard: (candidate: unknown) => candidate is T,
  ): Promise<T[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > this.#maxEntries)
      throw new Error('Tool Gateway directory entry limit exceeded');
    const values: T[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-z0-9-]+\.json$/i.test(entry.name)) continue;
      const value = await this.#readRecord(join(directory, entry.name), guard);
      if (value !== undefined) values.push(value);
    }
    return values;
  }

  async #readRecord<T>(
    file: string,
    guard: (candidate: unknown) => candidate is T,
  ): Promise<T | undefined> {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const information = await handle.stat();
      if (!information.isFile()) throw new Error('Tool Gateway record is not a regular file');
      if (information.size > this.#maxFileBytes)
        throw new Error('Tool Gateway record exceeds maxFileBytes');
      const content = await handle.readFile({ encoding: 'utf8' });
      const parsed = JSON.parse(content) as unknown;
      if (!guard(parsed)) throw new Error('Invalid Tool Gateway record');
      return parsed;
    } finally {
      await handle.close();
    }
  }
}

async function acquireLock(lock: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      await delay(5);
    }
  }
  throw new Error('Timed out acquiring Tool Gateway record lock');
}

function validateToolDraft(draft: Omit<ToolGateRequestDraft, 'requestedAt'>): void {
  requireIdentifier(draft.toolName, 'toolName');
  requireIdentifier(draft.toolUseId, 'toolUseId');
  requireIdentifier(draft.sessionId, 'sessionId');
  if (!isJsonObject(draft.toolInput)) throw new TypeError('toolInput must be a JSON object');
}

function validateDecision(decision: ToolDecision, updatedInput: JsonObject | undefined): void {
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'modify') {
    throw new TypeError('Unsupported tool decision');
  }
  if (decision === 'modify' && updatedInput === undefined) {
    throw new TypeError('modify requires updatedInput');
  }
  if (decision !== 'modify' && updatedInput !== undefined) {
    throw new TypeError('updatedInput is only valid for modify');
  }
  if (updatedInput !== undefined && !isJsonObject(updatedInput)) {
    throw new TypeError('updatedInput must be a JSON object');
  }
}

function validateKernelDecision(value: PersistedKernelDecisionV1): void {
  requireIdentifier(value.eventId, 'kernelDecisionEvent.eventId');
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) {
    throw new TypeError('kernelDecisionEvent.seq must be a positive safe integer');
  }
  if (!/^[a-f0-9]{64}$/.test(value.hash)) {
    throw new TypeError('kernelDecisionEvent.hash must be a sha256 digest');
  }
  validTimestamp(value.recordedAt, 'kernelDecisionEvent.recordedAt');
}

function sanitizeJsonObject(value: JsonObject): JsonObject {
  const sanitized = sanitizeNativeArtifact(stableStringify(value));
  const parsed = JSON.parse(sanitized.content) as unknown;
  if (!isJsonObject(parsed)) throw new TypeError('Sanitized tool input is not a JSON object');
  return parsed;
}

function sanitizeText(value: string, name: string): string {
  if (value.length > 16_384) throw new TypeError(`${name} is too large`);
  return sanitizeNativeArtifact(value).content.trimEnd();
}

function validTimestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`);
  return value;
}

function requireIdentifier(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
}

function requireStableId(value: string, prefix: 'gate' | 'decision-intent'): void {
  const pattern = prefix === 'gate' ? /^gate-[a-f0-9]{32}$/ : /^decision-intent-[a-f0-9]{32}$/;
  if (!pattern.test(value)) throw new TypeError(`Invalid ${prefix} id`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((member) => stableStringify(member)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

function isToolGateRequest(value: unknown): value is ToolGateRequestV1 {
  return (
    isJsonObject(value) &&
    value.schemaVersion === TOOL_GATEWAY_SCHEMA_VERSION &&
    typeof value.gateId === 'string' &&
    typeof value.effectId === 'string' &&
    typeof value.missionId === 'string' &&
    typeof value.attemptId === 'string' &&
    value.hookEventName === 'PreToolUse' &&
    typeof value.toolName === 'string' &&
    typeof value.toolUseIdSha256 === 'string' &&
    typeof value.sessionIdSha256 === 'string' &&
    typeof value.originalInputSha256 === 'string' &&
    typeof value.requestSha256 === 'string' &&
    isJsonObject(value.toolInput) &&
    typeof value.requestedAt === 'string'
  );
}

function isToolDecisionIntent(value: unknown): value is ToolDecisionIntentV1 {
  return (
    isJsonObject(value) &&
    value.schemaVersion === TOOL_GATEWAY_SCHEMA_VERSION &&
    typeof value.decisionIntentId === 'string' &&
    typeof value.missionId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.gateId === 'string' &&
    typeof value.effectId === 'string' &&
    typeof value.expectedRequestSha256 === 'string' &&
    (value.decision === 'approve' || value.decision === 'reject' || value.decision === 'modify') &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.updatedInput === undefined || isJsonObject(value.updatedInput)) &&
    typeof value.createdAt === 'string'
  );
}

function isToolRelease(value: unknown): value is ToolReleaseV1 {
  return (
    isJsonObject(value) &&
    value.schemaVersion === TOOL_GATEWAY_SCHEMA_VERSION &&
    typeof value.releaseId === 'string' &&
    typeof value.missionId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.gateId === 'string' &&
    typeof value.effectId === 'string' &&
    typeof value.requestSha256 === 'string' &&
    typeof value.decisionIntentId === 'string' &&
    (value.decision === 'approve' || value.decision === 'reject' || value.decision === 'modify') &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.updatedInput === undefined || isJsonObject(value.updatedInput)) &&
    isPersistedKernelDecision(value.kernelDecisionEvent) &&
    typeof value.releasedAt === 'string'
  );
}

function isPersistedKernelDecision(value: unknown): value is PersistedKernelDecisionV1 {
  return (
    isJsonObject(value) &&
    typeof value.eventId === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.hash === 'string' &&
    typeof value.recordedAt === 'string'
  );
}

function isToolResult(value: unknown): value is ToolResultV1 {
  return (
    isJsonObject(value) &&
    value.schemaVersion === TOOL_GATEWAY_SCHEMA_VERSION &&
    typeof value.resultId === 'string' &&
    typeof value.missionId === 'string' &&
    typeof value.attemptId === 'string' &&
    typeof value.gateId === 'string' &&
    typeof value.effectId === 'string' &&
    (value.hookEventName === 'PostToolUse' || value.hookEventName === 'PostToolUseFailure') &&
    (value.outcome === 'succeeded' || value.outcome === 'failed') &&
    typeof value.resultSha256 === 'string' &&
    typeof value.observedAt === 'string'
  );
}

function isCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function abortError(): Error {
  const error = new Error('Tool Gateway wait aborted');
  error.name = 'AbortError';
  return error;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
