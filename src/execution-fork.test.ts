import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCompositeCheckpoint,
  type CompositeCheckpointInputV1,
  type CompositeCheckpointManifestV1,
} from './composite-checkpoint.js';
import type { EffectV1, ProfileV1 } from './domain.js';
import {
  CHECKPOINT_OPERATION_BOUNDARIES_V1,
  ExecutionForkService,
  FileExecutionForkEvidenceJournal,
  executionForkWorkspaceEffectId,
  type ExecutionForkRequestV1,
  type RuntimeContinuationPortV1,
} from './execution-fork.js';
import { snapshotGitWorkspace } from './workspace.js';

const disposableRoots: string[] = [];

afterEach(() => {
  for (const root of disposableRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('executable execution Fork', () => {
  it('continues with real tools in B while A stays immutable, then rebuilds and cleans after restart', async () => {
    const fixture = createGitFixture();
    const journalDirectory = join(fixture.repositoryRoot, '.missionbraid', 'execution-forks');
    const clock = fixedClock();
    const firstService = new ExecutionForkService({
      journal: new FileExecutionForkEvidenceJournal(journalDirectory),
      now: clock,
    });
    let runtimeCalls = 0;
    const runtime: RuntimeContinuationPortV1 = {
      continueFromCheckpoint: async (input) => {
        runtimeCalls += 1;
        expect(input.workspacePath).toBe(fixture.worktreePath);
        expect(input.parentBranchId).toBe('branch-a');
        expect(input.childBranchId).toBe('branch-b');
        expect(input.intervention).toMatchObject({
          interventionId: 'intervention-guidance-b',
          kind: 'guidance',
        });
        expect(input.inheritedExternalEffectFrontier).toEqual([
          expect.objectContaining({ effectId: 'effect-deploy-a', status: 'confirmed' }),
        ]);
        expect(input.externalEffectDecisions).toEqual([
          { effectId: 'effect-deploy-a', action: 'inherit-no-repeat' },
        ]);

        execFileSync(
          process.execPath,
          [
            '-e',
            [
              "const fs = require('node:fs')",
              "fs.appendFileSync('base.txt', 'B continued\\n')",
              "fs.writeFileSync('child-only.txt', 'created by the child runtime\\n')",
            ].join(';'),
          ],
          { cwd: input.workspacePath, stdio: 'pipe' },
        );
        await input.appendEvidence({
          evidenceId: 'evidence-child-process-write',
          kind: 'tool',
          observedAt: '2026-08-26T01:00:05.000Z',
          contentDigest: 'sha256:real-node-child-process-write',
          evidenceRefs: ['process:node:exit-0', 'workspace:path:child-only.txt'],
          summary: 'A real child process changed only the isolated worktree.',
        });
        return {
          runtimeRunId: 'runtime-run-b',
          status: 'completed',
          toolExecutionEvidenceRefs: ['process:node:exit-0'],
          verificationEvidenceRefs: ['verification:child-file-visible'],
          unresolvedItems: [],
        };
      },
    };

    const sourceHeadBefore = git(fixture.repositoryRoot, ['rev-parse', 'HEAD']).trim();
    const sourceSnapshotBefore = snapshotGitWorkspace(fixture.repositoryRoot);
    const result = await firstService.execute(fixture.request, runtime);

    expect(runtimeCalls).toBe(1);
    expect(result.phase).toBe('finished');
    expect(result.lineage).toMatchObject({
      mode: 'execution-fork',
      missionId: 'mission-fork',
      parentBranchId: 'branch-a',
      childBranchId: 'branch-b',
      parentCheckpointId: fixture.checkpoint.checkpointId,
      intervention: {
        interventionId: 'intervention-guidance-b',
        authorityChange: 'unchanged',
      },
      baseCommit: fixture.commit,
      baseTree: fixture.tree,
      isolatedWorktreePath: fixture.worktreePath,
    });
    expect(result.lineage.intervention).not.toBeInstanceOf(Array);
    expect(result.runtimeEvidence).toEqual([
      expect.objectContaining({
        evidenceId: 'evidence-child-process-write',
        kind: 'tool',
      }),
    ]);
    expect(result.baselineSnapshot?.workspaceDigest).toBe(
      fixture.checkpoint.workspace.workspaceDigest,
    );
    expect(result.futureSnapshot?.workspaceDigest).not.toBe(
      result.baselineSnapshot?.workspaceDigest,
    );
    expect(result.receiptInput).toMatchObject({
      forkId: result.forkId,
      missionId: 'mission-fork',
      parentBranchId: 'branch-a',
      childBranchId: 'branch-b',
      runtimeRunId: 'runtime-run-b',
      authority: 'receipt-input-not-kernel-state',
      inheritedExternalEffectFrontier: [
        expect.objectContaining({ effectId: 'effect-deploy-a', status: 'confirmed' }),
      ],
      externalEffectDecisions: [{ effectId: 'effect-deploy-a', action: 'inherit-no-repeat' }],
      workspaceEffectInput: {
        effectId: executionForkWorkspaceEffectId(result.forkId, result.lineage.childWorkspaceKey),
        scope: 'branch_local_workspace',
        status: 'executed',
        beforeWorkspaceDigest: result.baselineSnapshot?.workspaceDigest,
        afterWorkspaceDigest: result.futureSnapshot?.workspaceDigest,
      },
      toolExecutionEvidenceRefs: ['process:node:exit-0'],
    });
    expect(result.receiptInput?.futureEvidenceRefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^event:execution-fork-event-/),
        `workspace:${result.futureSnapshot?.workspaceDigest}`,
      ]),
    );
    expect(result.events.map((event) => event.sequence)).toEqual(
      result.events.map((_, index) => index + 1),
    );
    expect(
      result.events
        .slice(1)
        .every((event, index) => event.previousHash === result.events[index]?.eventHash),
    ).toBe(true);

    expect(readFileSync(join(fixture.repositoryRoot, 'base.txt'), 'utf8')).toBe('A original\n');
    expect(existsSync(join(fixture.repositoryRoot, 'child-only.txt'))).toBe(false);
    expect(git(fixture.repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(git(fixture.repositoryRoot, ['rev-parse', 'HEAD']).trim()).toBe(sourceHeadBefore);
    expect(git(fixture.repositoryRoot, ['status', '--porcelain'])).toBe('');
    expect(snapshotGitWorkspace(fixture.repositoryRoot).workspaceDigest).toBe(
      sourceSnapshotBefore.workspaceDigest,
    );
    expect(readFileSync(join(fixture.worktreePath, 'base.txt'), 'utf8')).toBe(
      'A original\nB continued\n',
    );
    expect(readFileSync(join(fixture.worktreePath, 'child-only.txt'), 'utf8')).toBe(
      'created by the child runtime\n',
    );

    const restartedService = new ExecutionForkService({
      journal: new FileExecutionForkEvidenceJournal(journalDirectory),
      now: clock,
    });
    const rebuilt = await restartedService.inspect(result.forkId);
    expect(rebuilt).toEqual(result);
    expect(runtimeCalls).toBe(1);

    const cleaned = await restartedService.cleanup(result.forkId);
    expect(cleaned.phase).toBe('cleaned');
    expect(cleaned.cleaned).toBe(true);
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(git(fixture.repositoryRoot, ['worktree', 'list', '--porcelain'])).not.toContain(
      fixture.worktreePath,
    );
    expect(readFileSync(join(fixture.repositoryRoot, 'base.txt'), 'utf8')).toBe('A original\n');
    expect(git(fixture.repositoryRoot, ['rev-parse', 'HEAD']).trim()).toBe(sourceHeadBefore);
    expect(git(fixture.repositoryRoot, ['status', '--porcelain'])).toBe('');
  });

  it('keeps playback, cached replay, counterfactual resampling, and execution Fork distinct', async () => {
    expect(CHECKPOINT_OPERATION_BOUNDARIES_V1).toEqual({
      playback: {
        createsWorktree: false,
        invokesRuntime: false,
        modelSource: 'none',
        toolSource: 'none',
        producesFutureEvidence: false,
      },
      'cached-replay': {
        createsWorktree: false,
        invokesRuntime: false,
        modelSource: 'cached',
        toolSource: 'cached',
        producesFutureEvidence: true,
      },
      'counterfactual-resample': {
        createsWorktree: false,
        invokesRuntime: true,
        modelSource: 'resampled',
        toolSource: 'cached',
        producesFutureEvidence: true,
      },
      'execution-fork': {
        createsWorktree: true,
        invokesRuntime: true,
        modelSource: 'live',
        toolSource: 'live',
        producesFutureEvidence: true,
      },
    });

    const fixture = createGitFixture();
    const service = new ExecutionForkService({
      journal: new FileExecutionForkEvidenceJournal(join(fixture.root, 'state')),
    });
    await expect(
      service.execute(
        { ...fixture.request, mode: 'playback' },
        rejectingRuntime('playback must not invoke a Runtime'),
      ),
    ).rejects.toMatchObject({ code: 'MODE_NOT_EXECUTABLE_FORK' });
    expect(existsSync(fixture.worktreePath)).toBe(false);
  });

  it('blocks ambiguous or incomplete external Effect frontiers before creating a worktree', async () => {
    const ambiguous = createGitFixture('ambiguous');
    const ambiguousService = new ExecutionForkService({
      journal: new FileExecutionForkEvidenceJournal(join(ambiguous.root, 'state')),
    });
    await expect(
      ambiguousService.execute(ambiguous.request, rejectingRuntime('frontier must block Runtime')),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_FRONTIER_UNRESOLVED',
    });
    expect(existsSync(ambiguous.worktreePath)).toBe(false);

    const incomplete = createGitFixture('confirmed-without-idempotency');
    const incompleteService = new ExecutionForkService({
      journal: new FileExecutionForkEvidenceJournal(join(incomplete.root, 'state')),
    });
    await expect(
      incompleteService.execute(
        incomplete.request,
        rejectingRuntime('frontier must block Runtime'),
      ),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_FRONTIER_INCOMPLETE',
    });
    expect(existsSync(incomplete.worktreePath)).toBe(false);
  });
});

type ExternalFixtureState = 'confirmed' | 'ambiguous' | 'confirmed-without-idempotency';

function createGitFixture(externalState: ExternalFixtureState = 'confirmed'): {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly checkpoint: CompositeCheckpointManifestV1;
  readonly request: ExecutionForkRequestV1;
  readonly commit: string;
  readonly tree: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'missionbraid-execution-fork-')));
  disposableRoots.push(root);
  const repositoryRoot = join(root, 'source-a');
  const worktreePath = join(root, 'child-b');
  git(root, ['init', '-b', 'main', repositoryRoot]);
  git(repositoryRoot, ['config', 'user.name', 'MissionBraid Fixture']);
  git(repositoryRoot, ['config', 'user.email', 'fixture@missionbraid.invalid']);
  writeFileSync(join(repositoryRoot, '.gitignore'), '.missionbraid/\n');
  writeFileSync(join(repositoryRoot, 'base.txt'), 'A original\n');
  git(repositoryRoot, ['add', '.gitignore', 'base.txt']);
  git(repositoryRoot, ['commit', '-m', 'fixture boundary']);
  const commit = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const tree = git(repositoryRoot, ['rev-parse', `${commit}^{tree}`]).trim();
  const workspace = snapshotGitWorkspace(repositoryRoot, {
    now: () => new Date('2026-08-26T01:00:00.000Z'),
  });
  const checkpoint = createCompositeCheckpoint(
    checkpointInput(workspace.workspaceDigest, commit, tree, externalState),
  );
  const request: ExecutionForkRequestV1 = {
    mode: 'execution-fork',
    checkpoint,
    repositoryRoot,
    childBranchId: 'branch-b',
    gitBranchName: 'missionbraid/fork-b',
    worktreeId: 'worktree-b',
    childWorkspaceKey: 'workspace-b',
    isolatedWorktreePath: worktreePath,
    intervention: {
      interventionId: 'intervention-guidance-b',
      kind: 'guidance',
      targetRef: 'context:next-guidance',
      beforeDigest: 'sha256:guidance-a',
      afterDigest: 'sha256:guidance-b',
      description: 'Ask the child Runtime to create the declared output.',
      authorityChange: 'unchanged',
    },
    externalEffectDecisions: [{ effectId: 'effect-deploy-a', action: 'inherit-no-repeat' }],
  };
  return { root, repositoryRoot, worktreePath, checkpoint, request, commit, tree };
}

function checkpointInput(
  workspaceDigest: string,
  commit: string,
  tree: string,
  externalState: ExternalFixtureState,
): CompositeCheckpointInputV1 {
  const profile: ProfileV1 = {
    schemaVersion: 1,
    profileId: 'profile-fork',
    harness: 'fixture-runtime',
    model: 'fixture-model',
    reasoningEffort: 'medium',
    permissionMode: 'workspace-write',
    capabilities: ['workspace-write', 'native-events'],
    configurationDigest: 'sha256:profile-fork',
  };
  const externalEffect: EffectV1 = {
    schemaVersion: 1,
    effectId: 'effect-deploy-a',
    missionId: 'mission-fork',
    attemptId: 'attempt-a',
    kind: 'external.deploy',
    resourceKey: 'deployment:fixture',
    controlLevel: 'guarded',
    scope: 'mission_global_external',
    status: externalState === 'ambiguous' ? 'ambiguous' : 'confirmed',
    authorityRef: 'grant:fixture-deploy',
    ...(externalState === 'confirmed-without-idempotency'
      ? {}
      : { idempotencyKey: 'deployment:fixture:v1' }),
    evidenceRefs: ['target:deployment-fixture', 'event:effect-boundary'],
    createdAt: '2026-08-26T00:59:55.000Z',
  };
  return {
    mission: {
      schemaVersion: 1,
      missionId: 'mission-fork',
      title: 'Continue in an isolated child Branch',
      workspaceKey: 'workspace-a',
      contractId: 'contract-fork',
      initialProfileId: 'profile-fork',
      rootBranchId: 'branch-a',
      status: 'waiting',
      createdAt: '2026-08-26T00:59:00.000Z',
    },
    branch: {
      schemaVersion: 1,
      branchId: 'branch-a',
      missionId: 'mission-fork',
      status: 'active',
      createdAt: '2026-08-26T00:59:00.000Z',
    },
    attempt: {
      schemaVersion: 1,
      attemptId: 'attempt-a',
      missionId: 'mission-fork',
      branchId: 'branch-a',
      profileId: 'profile-fork',
      status: 'failed',
      startedAt: '2026-08-26T00:59:10.000Z',
      endedAt: '2026-08-26T00:59:50.000Z',
    },
    contract: {
      schemaVersion: 1,
      contractId: 'contract-fork',
      objective: 'Create the declared child-only output.',
      constraints: ['Do not change Branch A.'],
      acceptanceCriteria: [
        {
          criterionId: 'criterion-child-output',
          description: 'The child output exists only in Branch B.',
          verifier: { kind: 'file', configuration: { path: 'child-only.txt' } },
        },
      ],
      createdAt: '2026-08-26T00:59:00.000Z',
    },
    profile,
    eventPrefix: {
      throughSeq: 24,
      headHash: 'sha256:event-head-a',
      evidenceRefs: ['event:24', 'event-chain:a'],
    },
    visibleContext: {
      status: 'captured',
      contextDigest: 'sha256:visible-context-a',
      artifactRefs: ['artifact:context-a'],
      evidenceRefs: ['runtime:context-a'],
    },
    workspace: {
      kind: 'restorable-artifact',
      workspaceKey: 'workspace-a',
      workspaceDigest,
      artifactRef: `git-commit:${commit}`,
      artifactDigest: `git-tree:${tree}`,
      evidenceRefs: [`git:commit:${commit}`, `git:tree:${tree}`],
    },
    permissions: {
      permissionMode: 'workspace-write',
      authorityRef: 'grant:workspace-fixture',
      evidenceRefs: ['profile:profile-fork'],
    },
    effects: [externalEffect],
    process: {
      status: 'stopped',
      stoppedAt: '2026-08-26T00:59:50.000Z',
      processRef: 'process:runtime-a',
      exitCode: 1,
      evidenceRefs: ['runtime-process:stopped-a'],
    },
    nativeSession: {
      status: 'available',
      harness: 'fixture-runtime',
      sessionRef: 'session:runtime-a',
      resumeSupported: true,
      evidenceRefs: ['runtime-session:a'],
    },
    capturedAt: '2026-08-26T01:00:00.000Z',
  };
}

function rejectingRuntime(message: string): RuntimeContinuationPortV1 {
  return {
    continueFromCheckpoint: async () => {
      throw new Error(message);
    },
  };
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.parse('2026-08-26T01:00:01.000Z') + tick++ * 1_000);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
