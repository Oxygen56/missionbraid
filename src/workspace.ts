import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const WORKSPACE_SNAPSHOT_VERSION = 1 as const;

export type WorkspacePathKindV1 = 'file' | 'symlink' | 'directory' | 'special' | 'missing';

export interface GitStatusEntryV1 {
  readonly code: string;
  readonly path: string;
  readonly originalPath?: string;
}

export interface WorkspacePathDigestV1 {
  readonly path: string;
  readonly kind: WorkspacePathKindV1;
  readonly sha256: string | null;
}

export interface GitWorkspaceSnapshotV1 {
  readonly schemaVersion: typeof WORKSPACE_SNAPSHOT_VERSION;
  readonly workspaceRoot: string;
  readonly head: string | null;
  readonly status: readonly GitStatusEntryV1[];
  /** Digests only. File contents are never retained in a snapshot. */
  readonly paths: readonly WorkspacePathDigestV1[];
  readonly statusDigest: string;
  readonly workspaceDigest: string;
  readonly capturedAt: string;
}

export interface StageChangedPathV1 {
  /** Always relative to workspaceRoot and never starts with `..`. */
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  readonly beforeKind: WorkspacePathKindV1;
  readonly afterKind: WorkspacePathKindV1;
  readonly beforeStatus: readonly string[];
  readonly afterStatus: readonly string[];
}

export interface StageWorkspaceDeltaV1 {
  readonly schemaVersion: typeof WORKSPACE_SNAPSHOT_VERSION;
  readonly beforeHead: string | null;
  readonly afterHead: string | null;
  readonly beforeWorkspaceDigest: string;
  readonly afterWorkspaceDigest: string;
  readonly changedPaths: readonly StageChangedPathV1[];
}

export interface SnapshotGitWorkspaceOptions {
  readonly now?: () => Date;
}

export class WorkspaceSnapshotError extends Error {}

/**
 * Capture a repeatable Git worktree snapshot without retaining file contents.
 * Ignored paths (including `.missionbraid/`) do not participate in the digest.
 */
export function snapshotGitWorkspace(
  workspaceRoot: string,
  options: SnapshotGitWorkspaceOptions = {},
): GitWorkspaceSnapshotV1 {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const headResult = runGit(root, ['rev-parse', '--verify', 'HEAD'], true);
  const head = headResult.ok ? headResult.stdout.toString('utf8').trim() : null;
  const status = parsePorcelainStatus(
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout,
  )
    .filter((entry) => entry.code !== '??' || !isMissionBraidRuntimePath(entry.path))
    .sort(compareStatusEntries);
  const trackedPaths = new Set(
    parseNullTerminatedPaths(runGit(root, ['ls-files', '-z', '--cached']).stdout),
  );
  const listedPaths = parseNullTerminatedPaths(
    runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).stdout,
  ).filter((path) => trackedPaths.has(path) || !isMissionBraidRuntimePath(path));
  const paths = [...new Set(listedPaths)]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((path) => digestWorkspacePath(root, path));
  const statusDigest = sha256(canonicalJson(status));
  const workspaceDigest = sha256(
    canonicalJson({
      head,
      status,
      paths,
    }),
  );

  return {
    schemaVersion: WORKSPACE_SNAPSHOT_VERSION,
    workspaceRoot: root,
    head,
    status,
    paths,
    statusDigest,
    workspaceDigest,
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

/** Build the stage-level changedPaths union from two immutable snapshots. */
export function createStageChangedPaths(
  before: GitWorkspaceSnapshotV1,
  after: GitWorkspaceSnapshotV1,
): StageChangedPathV1[] {
  if (before.workspaceRoot !== after.workspaceRoot) {
    throw new WorkspaceSnapshotError('Stage snapshots must belong to the same workspace root');
  }

  const beforePaths = new Map(before.paths.map((entry) => [entry.path, entry]));
  const afterPaths = new Map(after.paths.map((entry) => [entry.path, entry]));
  const beforeStatuses = statusCodesByPath(before.status);
  const afterStatuses = statusCodesByPath(after.status);
  const candidates = new Set([
    ...beforePaths.keys(),
    ...afterPaths.keys(),
    ...beforeStatuses.keys(),
    ...afterStatuses.keys(),
  ]);

  return [...candidates]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .flatMap((path): StageChangedPathV1[] => {
      const beforePath = beforePaths.get(path);
      const afterPath = afterPaths.get(path);
      const beforeStatus = beforeStatuses.get(path) ?? [];
      const afterStatus = afterStatuses.get(path) ?? [];
      const beforeKind = beforePath?.kind ?? 'missing';
      const afterKind = afterPath?.kind ?? 'missing';
      const beforeSha256 = beforePath?.sha256 ?? null;
      const afterSha256 = afterPath?.sha256 ?? null;
      if (
        beforeKind === afterKind &&
        beforeSha256 === afterSha256 &&
        arraysEqual(beforeStatus, afterStatus)
      ) {
        return [];
      }
      return [
        {
          path,
          beforeSha256,
          afterSha256,
          beforeKind,
          afterKind,
          beforeStatus,
          afterStatus,
        },
      ];
    });
}

export function createStageWorkspaceDelta(
  before: GitWorkspaceSnapshotV1,
  after: GitWorkspaceSnapshotV1,
): StageWorkspaceDeltaV1 {
  return {
    schemaVersion: WORKSPACE_SNAPSHOT_VERSION,
    beforeHead: before.head,
    afterHead: after.head,
    beforeWorkspaceDigest: before.workspaceDigest,
    afterWorkspaceDigest: after.workspaceDigest,
    changedPaths: createStageChangedPaths(before, after),
  };
}

function resolveWorkspaceRoot(workspaceRoot: string): string {
  if (workspaceRoot.trim().length === 0) {
    throw new WorkspaceSnapshotError('workspaceRoot must not be empty');
  }
  const requestedRoot = realpathSync(resolve(workspaceRoot));
  if (!statSync(requestedRoot).isDirectory()) {
    throw new WorkspaceSnapshotError('workspaceRoot must be a directory');
  }
  const result = runGit(requestedRoot, ['rev-parse', '--show-toplevel']);
  const gitRoot = realpathSync(result.stdout.toString('utf8').trim());
  if (gitRoot !== requestedRoot) {
    throw new WorkspaceSnapshotError('workspaceRoot must be the Git worktree root');
  }
  return requestedRoot;
}

function digestWorkspacePath(root: string, gitPath: string): WorkspacePathDigestV1 {
  const path = assertRelativeWorkspacePath(gitPath);
  const absolutePath = resolve(root, path);
  assertInsideWorkspace(root, absolutePath);

  try {
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      return {
        path,
        kind: 'symlink',
        sha256: sha256(`symlink\0${readlinkSync(absolutePath)}`),
      };
    }
    if (metadata.isFile()) {
      return { path, kind: 'file', sha256: sha256(readFileSync(absolutePath)) };
    }
    if (metadata.isDirectory()) {
      return { path, kind: 'directory', sha256: sha256('directory') };
    }
    return { path, kind: 'special', sha256: sha256('special') };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { path, kind: 'missing', sha256: null };
    }
    throw error;
  }
}

function parsePorcelainStatus(output: Buffer): GitStatusEntryV1[] {
  const tokens = output.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries: GitStatusEntryV1[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length < 4 || token[2] !== ' ') {
      throw new WorkspaceSnapshotError('Git returned malformed porcelain status');
    }
    const code = token.slice(0, 2);
    const path = assertRelativeWorkspacePath(token.slice(3));
    if (code.includes('R') || code.includes('C')) {
      const original = tokens[index + 1];
      if (original === undefined) {
        throw new WorkspaceSnapshotError('Git rename status omitted its original path');
      }
      entries.push({ code, path, originalPath: assertRelativeWorkspacePath(original) });
      index += 1;
    } else {
      entries.push({ code, path });
    }
  }
  return entries;
}

function parseNullTerminatedPaths(output: Buffer): string[] {
  const tokens = output.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  return tokens.map(assertRelativeWorkspacePath);
}

function isMissionBraidRuntimePath(path: string): boolean {
  const normalized = normalize(path);
  return normalized === '.missionbraid' || normalized.startsWith(`.missionbraid${sep}`);
}

function statusCodesByPath(entries: readonly GitStatusEntryV1[]): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const entry of entries) {
    addStatus(byPath, entry.path, entry.code);
    if (entry.originalPath !== undefined) addStatus(byPath, entry.originalPath, entry.code);
  }
  for (const codes of byPath.values()) codes.sort();
  return byPath;
}

function addStatus(statuses: Map<string, string[]>, path: string, code: string): void {
  const values = statuses.get(path) ?? [];
  values.push(code);
  statuses.set(path, values);
}

function assertRelativeWorkspacePath(path: string): string {
  if (path.length === 0 || isAbsolute(path)) {
    throw new WorkspaceSnapshotError('Git path must be relative to workspaceRoot');
  }
  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new WorkspaceSnapshotError('Git path escapes workspaceRoot');
  }
  return normalized;
}

function assertInsideWorkspace(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new WorkspaceSnapshotError('Resolved Git path escapes workspaceRoot');
  }
}

function compareStatusEntries(left: GitStatusEntryV1, right: GitStatusEntryV1): number {
  return (
    left.path.localeCompare(right.path, 'en') ||
    left.code.localeCompare(right.code, 'en') ||
    (left.originalPath ?? '').localeCompare(right.originalPath ?? '', 'en')
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function runGit(
  root: string,
  args: readonly string[],
  allowFailure = false,
): { readonly ok: boolean; readonly stdout: Buffer } {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new WorkspaceSnapshotError(`Unable to execute Git: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new WorkspaceSnapshotError(`Git command failed with status ${String(result.status)}`);
  }
  return { ok: result.status === 0, stdout: result.stdout ?? Buffer.alloc(0) };
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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
