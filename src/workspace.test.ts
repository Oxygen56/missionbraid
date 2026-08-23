import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createStageWorkspaceDelta,
  snapshotGitWorkspace,
  WorkspaceSnapshotError,
} from './workspace.js';

const disposableRoots: string[] = [];

afterEach(() => {
  for (const root of disposableRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Git workspace evidence', () => {
  it('produces repeatable content-free snapshots and relative stage changedPaths', () => {
    const workspace = createRepository();
    const before = snapshotGitWorkspace(workspace, {
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });

    const secretText = 'fixture-private-value-that-must-not-enter-evidence';
    writeFileSync(join(workspace, 'src', 'tracked.txt'), `${secretText}\n`, 'utf8');
    writeFileSync(join(workspace, 'new file.txt'), 'new bytes\n', 'utf8');
    const after = snapshotGitWorkspace(workspace, {
      now: () => new Date('2026-08-24T00:00:01.000Z'),
    });
    const repeated = snapshotGitWorkspace(workspace, {
      now: () => new Date('2027-01-01T00:00:00.000Z'),
    });
    const delta = createStageWorkspaceDelta(before, after);

    expect(before.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(before.status).toEqual([]);
    expect(after.workspaceDigest).toBe(repeated.workspaceDigest);
    expect(after.statusDigest).toBe(repeated.statusDigest);
    expect(after.capturedAt).not.toBe(repeated.capturedAt);
    expect(delta.changedPaths.map((entry) => entry.path)).toEqual([
      'new file.txt',
      'src/tracked.txt',
    ]);
    expect(delta.changedPaths.every((entry) => !isAbsolute(entry.path))).toBe(true);
    expect(delta.changedPaths.find((entry) => entry.path === 'src/tracked.txt')).toMatchObject({
      beforeSha256: sha256('initial\n'),
      afterSha256: sha256(`${secretText}\n`),
      beforeKind: 'file',
      afterKind: 'file',
    });
    expect(delta.changedPaths.find((entry) => entry.path === 'new file.txt')).toMatchObject({
      beforeSha256: null,
      afterSha256: sha256('new bytes\n'),
      beforeKind: 'missing',
      afterKind: 'file',
    });
    expect(JSON.stringify({ before, after, delta })).not.toContain(secretText);
  });

  it('requires the explicit Git worktree root rather than an enclosing worktree subdirectory', () => {
    const workspace = createRepository();
    expect(() => snapshotGitWorkspace(join(workspace, 'src'))).toThrow(WorkspaceSnapshotError);
  });
});

function createRepository(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'missionbraid-workspace-'));
  disposableRoots.push(workspace);
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'tracked.txt'), 'initial\n', 'utf8');
  git(workspace, 'init', '--quiet');
  git(workspace, 'config', 'user.name', 'MissionBraid Fixture');
  git(workspace, 'config', 'user.email', 'fixture@missionbraid.invalid');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '--quiet', '-m', 'fixture baseline');
  return workspace;
}

function git(workspace: string, ...args: string[]): void {
  execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
