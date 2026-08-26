import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { sanitizeNativeArtifact } from './artifact-store.js';

/** Versioned on-disk format for a controller-owned cached Context snapshot. */
export const CONTEXT_CACHE_SCHEMA_VERSION = 'missionbraid.dev/context-cache/v1' as const;

export interface ContextBindingSpecV1 {
  /** Stable identity for the observable Context fact. */
  readonly factId: string;
  /** Current source of truth, resolved to an absolute workspace path. */
  readonly source: string;
  /** Controller-owned cached snapshot, resolved to an absolute workspace path. */
  readonly snapshot: string;
}

export interface ContextCacheDocumentV1 {
  readonly schemaVersion: typeof CONTEXT_CACHE_SCHEMA_VERSION;
  readonly contextFactId: string;
  /** Workspace digest at the time this Context was captured. */
  readonly boundWorkspaceDigest: string;
  /** Sanitized Context content supplied to the Agent. */
  readonly content: string;
}

export type ContextBindingModeV1 = 'cached' | 'refreshed';

/**
 * Sanitized, content-addressed material used for one Runtime attempt. Raw
 * Context is kept out of Kernel events; only artifact references and digests
 * are projected there.
 */
export interface ContextBindingMaterialV1 {
  readonly contextFactId: string;
  readonly mode: ContextBindingModeV1;
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly sourceRef: string;
  readonly snapshotRef: string;
  readonly boundWorkspaceDigest: string;
  readonly currentWorkspaceDigest: string;
  readonly boundContextDigest: string;
  readonly currentContextDigest: string;
  readonly boundContent: string;
  readonly currentContent: string;
}

export class ContextBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextBindingError';
  }
}

export interface ReadContextBindingOptionsV1 {
  readonly workspacePath: string;
  readonly currentWorkspaceDigest: string;
  readonly mode: ContextBindingModeV1;
}

/**
 * Resolve one declarative Context binding at the Runtime boundary.
 *
 * `cached` reads the controller-owned snapshot and compares its capture
 * digest with the current Git workspace digest. `refreshed` deliberately
 * reads only the declared source and binds the new snapshot to the restored
 * workspace frontier. This is the single-variable Context intervention used
 * by diagnostic Forks.
 */
export async function readContextBinding(
  spec: ContextBindingSpecV1,
  options: ReadContextBindingOptionsV1,
): Promise<ContextBindingMaterialV1> {
  const workspacePath = canonicalizePath(resolve(options.workspacePath));
  if (!isAbsolute(workspacePath)) {
    throw new ContextBindingError('Context workspacePath must be absolute');
  }
  requireNonEmpty(spec.factId, 'context.factId');
  const sourcePath = assertInsideWorkspace(workspacePath, spec.source, 'context.source');
  const snapshotPath = assertInsideWorkspace(workspacePath, spec.snapshot, 'context.snapshot');
  requireNonEmpty(options.currentWorkspaceDigest, 'currentWorkspaceDigest');

  const sourceRaw = await readRequired(sourcePath, 'Context source');
  const currentContent = sanitizeNativeArtifact(sourceRaw).content.trimEnd();
  const currentContextDigest = digest(currentContent);

  let boundContent: string;
  let boundWorkspaceDigest: string;
  if (options.mode === 'refreshed') {
    boundContent = currentContent;
    boundWorkspaceDigest = options.currentWorkspaceDigest;
  } else {
    const snapshotRaw = await readRequired(snapshotPath, 'Context snapshot');
    const cache = parseCache(snapshotRaw, spec.factId);
    boundContent = sanitizeNativeArtifact(cache.content).content.trimEnd();
    boundWorkspaceDigest = cache.boundWorkspaceDigest;
  }

  return {
    contextFactId: spec.factId,
    mode: options.mode,
    sourcePath,
    snapshotPath,
    sourceRef: workspaceRelativeRef(workspacePath, sourcePath),
    snapshotRef: workspaceRelativeRef(workspacePath, snapshotPath),
    boundWorkspaceDigest,
    currentWorkspaceDigest: options.currentWorkspaceDigest,
    boundContextDigest: digest(boundContent),
    currentContextDigest,
    boundContent,
    currentContent,
  };
}

export function contextPrompt(material: ContextBindingMaterialV1): string {
  const modeLabel = material.mode === 'refreshed' ? 'refreshed' : 'cached';
  return [
    `MissionBraid Context Snapshot (${modeLabel})`,
    `contextFactId=${material.contextFactId}`,
    `boundWorkspaceDigest=${material.boundWorkspaceDigest}`,
    `contextDigest=${material.boundContextDigest}`,
    `sourceRef=${material.sourceRef}`,
    `snapshotRef=${material.snapshotRef}`,
    'Use this visible Context Snapshot as the current task input. Do not invent or silently merge another Context source.',
    'Context content:',
    material.boundContent,
  ].join('\n');
}

function parseCache(raw: string, factId: string): ContextCacheDocumentV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ContextBindingError('Context snapshot must be a JSON cache document');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContextBindingError('Context snapshot cache must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CONTEXT_CACHE_SCHEMA_VERSION) {
    throw new ContextBindingError(
      `Unsupported Context snapshot schema: ${String(record.schemaVersion)}`,
    );
  }
  if (record.contextFactId !== factId) {
    throw new ContextBindingError('Context snapshot factId does not match the Mission binding');
  }
  if (
    typeof record.boundWorkspaceDigest !== 'string' ||
    record.boundWorkspaceDigest.trim().length === 0
  ) {
    throw new ContextBindingError('Context snapshot boundWorkspaceDigest is required');
  }
  if (typeof record.content !== 'string' || record.content.trim().length === 0) {
    throw new ContextBindingError('Context snapshot content is required');
  }
  return {
    schemaVersion: CONTEXT_CACHE_SCHEMA_VERSION,
    contextFactId: factId,
    boundWorkspaceDigest: record.boundWorkspaceDigest,
    content: record.content,
  };
}

async function readRequired(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ContextBindingError(`${label} could not be read: ${detail}`);
  }
}

function assertInsideWorkspace(workspace: string, candidate: string, label: string): string {
  if (!isAbsolute(candidate)) {
    throw new ContextBindingError(`${label} must be an absolute path after resolution`);
  }
  const resolved = canonicalizePath(resolve(candidate));
  const path = relative(canonicalizePath(workspace), resolved);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new ContextBindingError(`${label} must remain inside the Mission workspace`);
  }
  return resolved;
}

function canonicalizePath(value: string): string {
  return existsSync(value) ? realpathSync(value) : value;
}

function workspaceRelativeRef(workspace: string, path: string): string {
  const value = relative(workspace, path);
  return value.length === 0 ? '.' : value;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new ContextBindingError(`${label} must not be empty`);
}
