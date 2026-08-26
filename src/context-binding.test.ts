import {
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTEXT_CACHE_SCHEMA_VERSION,
  ContextBindingError,
  readContextBinding,
} from './context-binding.js';
import { createMissionDraft } from './mission-draft.js';
import { loadMissionSpec } from './spec.js';

const disposableRoots: string[] = [];

afterEach(() => {
  for (const root of disposableRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Context binding', () => {
  it('resolves relative Mission Context paths and survives a workspace symlink alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'missionbraid-context-paths-'));
    disposableRoots.push(root);
    const workspace = join(root, 'workspace');
    const workspaceAlias = join(root, 'workspace-alias');
    mkdirSync(join(workspace, '.missionbraid'), { recursive: true });
    writeFileSync(join(workspace, 'context.txt'), 'SOURCE:current\n', 'utf8');
    writeFileSync(
      join(workspace, '.missionbraid', 'context-cache.json'),
      JSON.stringify({
        schemaVersion: CONTEXT_CACHE_SCHEMA_VERSION,
        contextFactId: 'agent-context',
        boundWorkspaceDigest: 'sha256:baseline',
        content: 'OLD:cached',
      }),
      'utf8',
    );
    symlinkSync(workspace, workspaceAlias, 'dir');

    const draft = createMissionDraft({
      title: 'Context path fixture',
      objective: 'Keep the Context binding inside the workspace.',
      workspace: workspaceAlias,
      context: {
        factId: 'agent-context',
        source: 'context.txt',
        snapshot: '.missionbraid/context-cache.json',
      },
      verifier: { executable: 'node', args: ['--version'], timeoutMs: 1_000 },
      stages: [
        {
          stageId: 'codex',
          harness: 'codex',
          model: 'fixture',
          injectionBudgetTokens: 1_000,
        },
      ],
    });

    const sourceFile = join(root, 'mission.yaml');
    writeFileSync(sourceFile, draft.yaml, 'utf8');
    const loaded = loadMissionSpec(sourceFile);
    expect(loaded.context).toMatchObject({ factId: 'agent-context' });
    expect(loaded.context?.source).toBe(realpathSync(join(workspace, 'context.txt')));
    expect(loaded.context?.snapshot).toBe(
      realpathSync(join(workspace, '.missionbraid', 'context-cache.json')),
    );
    expect(relative(loaded.workspace, loaded.context!.source)).toBe('context.txt');
    expect(readlinkSync(workspaceAlias)).toBe(workspace);
  });

  it('reports a cached Context as stale while retaining both bound and current material', async () => {
    const fixture = createContextFixture();
    const result = await readContextBinding(fixture.spec, {
      workspacePath: fixture.workspace,
      currentWorkspaceDigest: 'sha256:current-frontier',
      mode: 'cached',
    });

    expect(result).toMatchObject({
      contextFactId: 'agent-context',
      mode: 'cached',
      sourceRef: 'context.txt',
      snapshotRef: '.missionbraid/context-cache.json',
      boundWorkspaceDigest: 'sha256:baseline-frontier',
      currentWorkspaceDigest: 'sha256:current-frontier',
      boundContent: 'OLD:cached',
      currentContent: 'SOURCE:current',
    });
    expect(result.boundContextDigest).not.toBe(result.currentContextDigest);
  });

  it('refreshes only the declared Context source and binds it to the restored frontier', async () => {
    const fixture = createContextFixture();
    const result = await readContextBinding(fixture.spec, {
      workspacePath: fixture.workspace,
      currentWorkspaceDigest: 'sha256:restored-frontier',
      mode: 'refreshed',
    });

    expect(result).toMatchObject({
      contextFactId: 'agent-context',
      mode: 'refreshed',
      boundWorkspaceDigest: 'sha256:restored-frontier',
      currentWorkspaceDigest: 'sha256:restored-frontier',
      boundContent: 'SOURCE:current',
      currentContent: 'SOURCE:current',
    });
    expect(result.boundContextDigest).toBe(result.currentContextDigest);
  });

  it('rejects Context paths that escape the Mission workspace', async () => {
    const fixture = createContextFixture();
    await expect(
      readContextBinding(
        { ...fixture.spec, source: join(fixture.workspace, '..', 'outside.txt') },
        {
          workspacePath: fixture.workspace,
          currentWorkspaceDigest: 'sha256:frontier',
          mode: 'cached',
        },
      ),
    ).rejects.toBeInstanceOf(ContextBindingError);
  });
});

function createContextFixture(): {
  readonly workspace: string;
  readonly spec: { readonly factId: string; readonly source: string; readonly snapshot: string };
} {
  const root = mkdtempSync(join(tmpdir(), 'missionbraid-context-binding-'));
  disposableRoots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.missionbraid'), { recursive: true });
  writeFileSync(join(workspace, 'context.txt'), 'SOURCE:current\n', 'utf8');
  writeFileSync(
    join(workspace, '.missionbraid', 'context-cache.json'),
    `${JSON.stringify({
      schemaVersion: CONTEXT_CACHE_SCHEMA_VERSION,
      contextFactId: 'agent-context',
      boundWorkspaceDigest: 'sha256:baseline-frontier',
      content: 'OLD:cached\n',
    })}\n`,
    'utf8',
  );
  return {
    workspace,
    spec: {
      factId: 'agent-context',
      source: join(workspace, 'context.txt'),
      snapshot: join(workspace, '.missionbraid', 'context-cache.json'),
    },
  };
}
