import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type { JsonValue, NativeArtifactRefV1 } from './domain.js';

const REDACTED = '[REDACTED]';
const BLOCKED_KEY_PARTS = [
  'apikey',
  'authorization',
  'credential',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'accesstoken',
] as const;

export interface SanitizedNativeArtifact {
  readonly content: string;
  readonly mediaType: NativeArtifactRefV1['mediaType'];
  readonly redactionCount: number;
}

export interface NativeArtifactContent {
  readonly artifactId: string;
  readonly sha256: string;
  readonly mediaType: NativeArtifactRefV1['mediaType'];
  readonly content: string;
}

export class NativeArtifactStore {
  readonly #root: string;

  constructor(stateDir: string) {
    this.#root = resolve(stateDir, 'artifacts');
  }

  async putLine(line: string): Promise<NativeArtifactRefV1> {
    const sanitized = sanitizeNativeArtifact(line);
    const sha256 = createHash('sha256').update(sanitized.content, 'utf8').digest('hex');
    const extension = sanitized.mediaType === 'application/json' ? 'json' : 'txt';
    const file = join(this.#root, 'sha256', sha256.slice(0, 2), `${sha256}.${extension}`);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, sanitized.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readFile(file, 'utf8');
      const existingHash = createHash('sha256').update(existing, 'utf8').digest('hex');
      if (existingHash !== sha256) {
        throw new Error(`Native artifact hash collision at ${file}`);
      }
    }
    return {
      artifactId: `artifact-${sha256}`,
      sha256,
      relativePath: relative(this.#root, file),
      mediaType: sanitized.mediaType,
      byteLength: Buffer.byteLength(sanitized.content, 'utf8'),
      sanitized: true,
      redactionCount: sanitized.redactionCount,
    };
  }

  async get(artifactId: string): Promise<NativeArtifactContent | undefined> {
    const match = artifactId.match(/^artifact-([a-f0-9]{64})$/);
    if (match?.[1] === undefined) return undefined;
    const sha256 = match[1];
    for (const candidate of [
      { extension: 'json', mediaType: 'application/json' as const },
      { extension: 'txt', mediaType: 'text/plain' as const },
    ]) {
      const file = join(
        this.#root,
        'sha256',
        sha256.slice(0, 2),
        `${sha256}.${candidate.extension}`,
      );
      try {
        const content = await readFile(file, 'utf8');
        const actual = createHash('sha256').update(content, 'utf8').digest('hex');
        if (actual !== sha256)
          throw new Error(`Native artifact ${artifactId} failed hash verification`);
        return { artifactId, sha256, mediaType: candidate.mediaType, content };
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
    }
    return undefined;
  }
}

export function sanitizeNativeArtifact(line: string): SanitizedNativeArtifact {
  try {
    const parsed = JSON.parse(line) as unknown;
    const state = { redactions: 0 };
    const value = sanitizeValue(parsed, state);
    return {
      content: `${JSON.stringify(value)}\n`,
      mediaType: 'application/json',
      redactionCount: state.redactions,
    };
  } catch {
    const state = { redactions: 0 };
    return {
      content: `${sanitizeString(line, state)}\n`,
      mediaType: 'text/plain',
      redactionCount: state.redactions,
    };
  }
}

function sanitizeValue(value: unknown, state: { redactions: number }): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value, state);
  if (Array.isArray(value)) return value.map((member) => sanitizeValue(member, state));
  if (typeof value !== 'object') return String(value);

  const result: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedKey(key)) {
      result[key] = REDACTED;
      state.redactions += 1;
      continue;
    }
    result[key] = sanitizeValue(member, state);
  }
  return result;
}

function sanitizeString(value: string, state: { redactions: number }): string {
  let result = value;
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gi,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gi,
    /\bAKIA[A-Z0-9]{12,}\b/g,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
  ];
  for (const pattern of patterns) {
    result = result.replace(pattern, () => {
      state.redactions += 1;
      return REDACTED;
    });
  }
  return result;
}

function isBlockedKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
  return BLOCKED_KEY_PARTS.some((part) => normalized.includes(part));
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
