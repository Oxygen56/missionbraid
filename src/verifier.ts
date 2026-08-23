import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { CommandVerifierSpecV1 } from './spec.js';

const DEFAULT_SUMMARY_BYTES = 4_096;
const KILL_GRACE_MS = 250;

export interface VerificationOutputV1 {
  readonly sha256: string;
  readonly byteCount: number;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly summaryRedacted: boolean;
}

export interface CommandVerificationResultV1 {
  readonly schemaVersion: 1;
  readonly passed: boolean;
  readonly invocationDigest: string;
  readonly executable: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly stdout: VerificationOutputV1;
  readonly stderr: VerificationOutputV1;
  readonly spawnError?: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
  };
}

export interface RunCommandVerifierOptions {
  readonly workspace: string;
  readonly missionSourceDir: string;
  readonly controllerStateDir: string;
  readonly provenanceFile: string;
  readonly maxSummaryBytes?: number;
  readonly now?: () => Date;
}

export class VerifierBoundaryError extends Error {}

/**
 * Execute an acceptance command without a shell or importing target code into
 * MissionBraid. Environment and recorded output are deliberately constrained.
 */
export async function runCommandVerifier(
  spec: CommandVerifierSpecV1,
  options: RunCommandVerifierOptions,
): Promise<CommandVerificationResultV1> {
  const workspace = realDirectory(options.workspace, 'workspace');
  const missionSourceDir = realDirectory(options.missionSourceDir, 'missionSourceDir');
  const controllerStateDir = realDirectory(options.controllerStateDir, 'controllerStateDir');
  const cwd = realDirectory(spec.cwd, 'verifier cwd');
  if (!isInside(workspace, cwd) && !isInside(missionSourceDir, cwd)) {
    throw new VerifierBoundaryError(
      'Verifier cwd must be inside the explicit workspace or mission source directory',
    );
  }
  const provenanceFile = resolveProvenanceFile(options.provenanceFile);
  if (!isInside(controllerStateDir, provenanceFile)) {
    throw new VerifierBoundaryError(
      'PROVENANCE_FILE must be inside the controller state directory',
    );
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new VerifierBoundaryError('Verifier timeoutMs must be a positive safe integer');
  }
  const maxSummaryBytes = options.maxSummaryBytes ?? DEFAULT_SUMMARY_BYTES;
  if (!Number.isSafeInteger(maxSummaryBytes) || maxSummaryBytes <= 0) {
    throw new VerifierBoundaryError('maxSummaryBytes must be a positive safe integer');
  }
  if (spec.executable.trim().length === 0) {
    throw new VerifierBoundaryError('Verifier executable must not be empty');
  }

  const environment = cleanEnvironment(spec.env, workspace, provenanceFile);
  const invocationDigest = sha256(
    canonicalJson({ executable: spec.executable, args: spec.args, cwd }),
  );
  const startedAtDate = (options.now ?? (() => new Date()))();
  const startedAt = startedAtDate.toISOString();
  const startedMonotonic = performance.now();
  const stdout = new BoundedOutput(maxSummaryBytes);
  const stderr = new BoundedOutput(maxSummaryBytes);

  return await new Promise<CommandVerificationResultV1>((resolveResult) => {
    let child;
    let spawnError: CommandVerificationResultV1['spawnError'];
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      const endedAt = (options.now ?? (() => new Date()))().toISOString();
      const durationMs = performance.now() - startedMonotonic;
      resolveResult({
        schemaVersion: 1,
        passed: !timedOut && spawnError === undefined && exitCode === 0,
        invocationDigest,
        executable: spec.executable,
        cwd,
        exitCode,
        signal,
        timedOut,
        startedAt,
        endedAt,
        durationMs,
        stdout: stdout.result(),
        stderr: stderr.result(),
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    try {
      child = spawn(spec.executable, [...spec.args], {
        cwd,
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      spawnError = serializeError(error);
      finish(null, null);
      return;
    }

    child.stdout.on('data', (chunk: Buffer | string) => stdout.add(chunk));
    child.stderr.on('data', (chunk: Buffer | string) => stderr.add(chunk));
    child.once('error', (error) => {
      spawnError = serializeError(error);
    });
    child.once('close', (exitCode, signal) => finish(exitCode, signal));

    timeout = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, spec.timeoutMs);
  });
}

export function cleanVerifierEnvironment(
  specEnvironment: Readonly<Record<string, string>>,
  workspace: string,
  provenanceFile: string,
): NodeJS.ProcessEnv {
  return cleanEnvironment(specEnvironment, workspace, provenanceFile);
}

function cleanEnvironment(
  specEnvironment: Readonly<Record<string, string>>,
  workspace: string,
  provenanceFile: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LC_') && value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(specEnvironment)) environment[key] = value;
  environment.MISSIONBRAID_TARGET_WORKSPACE = workspace;
  environment.MISSIONBRAID_PROVENANCE_FILE = provenanceFile;
  environment.PROVENANCE_FILE = provenanceFile;
  return environment;
}

class BoundedOutput {
  readonly #hash = createHash('sha256');
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #retainedBytes = 0;
  #byteCount = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#hash.update(buffer);
    this.#byteCount += buffer.byteLength;
    if (this.#retainedBytes >= this.#limit) return;
    const retained = buffer.subarray(0, this.#limit - this.#retainedBytes);
    this.#chunks.push(retained);
    this.#retainedBytes += retained.byteLength;
  }

  result(): VerificationOutputV1 {
    const rawSummary = Buffer.concat(this.#chunks).toString('utf8');
    const sanitized = redactOutput(rawSummary);
    const bounded = truncateUtf8(sanitized.text, this.#limit);
    return {
      sha256: this.#hash.digest('hex'),
      byteCount: this.#byteCount,
      summary: bounded.text,
      summaryTruncated: this.#byteCount > this.#retainedBytes || bounded.truncated,
      summaryRedacted: sanitized.redacted,
    };
  }
}

function redactOutput(value: string): { readonly text: string; readonly redacted: boolean } {
  const patterns: RegExp[] = [
    /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*([^\s,;]+)/gi,
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/g,
    /\bAKIA[A-Z0-9]{12,}\b/g,
  ];
  let text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '\ufffd');
  let redacted = false;
  for (const pattern of patterns) {
    text = text.replace(pattern, (match, prefix: string | undefined) => {
      redacted = true;
      return typeof prefix === 'string' ? `${prefix} [REDACTED]` : '[REDACTED]';
    });
  }
  return { text, redacted };
}

function realDirectory(value: string, label: string): string {
  if (value.trim().length === 0 || !isAbsolute(value)) {
    throw new VerifierBoundaryError(`${label} must be an absolute path`);
  }
  const path = realpathSync(value);
  if (!statSync(path).isDirectory())
    throw new VerifierBoundaryError(`${label} must be a directory`);
  return path;
}

function resolveProvenanceFile(value: string): string {
  if (value.trim().length === 0 || !isAbsolute(value)) {
    throw new VerifierBoundaryError('PROVENANCE_FILE must be an absolute path');
  }
  const parent = realpathSync(dirname(value));
  const candidate = resolve(parent, basename(value));
  return existsSync(candidate) ? realpathSync(candidate) : candidate;
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximumBytes) return { text: value, truncated: false };
  for (let end = maximumBytes; end >= 0; end -= 1) {
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch {
      // Back up to the previous complete UTF-8 code point.
    }
  }
  return { text: '', truncated: true };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function serializeError(error: unknown): NonNullable<CommandVerificationResultV1['spawnError']> {
  if (!(error instanceof Error)) return { name: 'Error', message: 'Verifier process failed' };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return {
    name: error.name,
    message: redactOutput(error.message).text,
    ...(code === undefined ? {} : { code }),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
