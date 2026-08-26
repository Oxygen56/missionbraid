import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_OPERATION_SCHEMA_VERSION,
  type BranchingCheckpointPlanV1,
} from './composite-checkpoint.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type AttemptBindingV1,
  type ContractV1,
  type EventV1,
  type MissionV1,
  type ProfileV1,
} from './domain.js';
import {
  EXECUTION_FORK_SCHEMA_VERSION,
  FileExecutionForkEvidenceJournal,
  executionForkWorkspaceEffectId,
  type ExecutionForkEventPayloadV1,
  type ExecutionForkEventTypeV1,
  type ExecutionForkEventV1,
  type ExecutionForkLineageV1,
  type ExecutionForkReceiptInputV1,
} from './execution-fork.js';
import {
  MissionExecutionForkBridgeError,
  executionForkEventToMissionEvents,
  rebuildExecutionForkBridgeStateFromMissionEvents,
  type MissionExecutionForkContextV1,
} from './mission-execution-fork.js';
import { MissionStore } from './store.js';
import type { GitWorkspaceSnapshotV1 } from './workspace.js';

const NOW = '2026-08-26T02:00:00.000Z';
const MISSION_ID = 'mission-fork-bridge';
const FORK_ID = 'execution-fork-bridge-fixture';
const PARENT_BRANCH_ID = 'branch-parent';
const CHILD_BRANCH_ID = 'branch-child';
const CHECKPOINT_ID = 'checkpoint-parent-composite';
const CHILD_ATTEMPT_ID = 'attempt-child';
const CHILD_WORKSPACE_KEY = 'workspace-child';
const disposableDirectories: string[] = [];

afterEach(() => {
  for (const directory of disposableDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Mission Execution Fork bridge', () => {
  it('atomically projects a complete Fork into Branch, Attempt, Effect, and sanitized evidence without signing a Receipt', async () => {
    const source = await sourceLifecycle();
    const fixture = createStoreFixture();
    const batches: readonly EventV1[][] = [];

    for (const sourceEvent of source) {
      const batch = executionForkEventToMissionEvents(
        sourceEvent,
        contextFor(sourceEvent),
        fixture.store.listEvents(MISSION_ID),
      );
      (batches as EventV1[][]).push([...batch]);
      fixture.store.appendEvents(batch, fixture.fence);
    }

    expect(batches[0]?.map((event) => event.type)).toEqual([
      'branch.created',
      'runtime.observation',
      'effect.recorded',
    ]);
    expect(batches[3]?.map((event) => event.type)).toEqual([
      'runtime.observation',
      'attempt.bound',
      'attempt.started',
    ]);
    expect(batches[5]?.map((event) => event.type)).toEqual([
      'runtime.observation',
      'attempt.finished',
      'effect.status_changed',
    ]);
    expect(batches[6]?.map((event) => event.type)).toEqual([
      'runtime.observation',
      'effect.status_changed',
    ]);

    const persisted = fixture.store.listEvents(MISSION_ID);
    expect(fixture.store.getBranch(MISSION_ID, CHILD_BRANCH_ID)).toMatchObject({
      parentBranchId: PARENT_BRANCH_ID,
      baseCheckpointId: CHECKPOINT_ID,
    });
    expect(
      persisted.find((event) => event.type === 'attempt.started')?.type === 'attempt.started' &&
        persisted.find((event) => event.type === 'attempt.started')?.payload.attempt,
    ).toMatchObject({
      attemptId: CHILD_ATTEMPT_ID,
      branchId: CHILD_BRANCH_ID,
      continuedFromAttemptId: 'attempt-parent',
    });
    const effectEvents = persisted.filter(
      (event) =>
        (event.type === 'effect.recorded' &&
          event.payload.effect.kind === 'workspace.execution-fork') ||
        (event.type === 'effect.status_changed' && event.payload.effectId === workspaceEffectId()),
    );
    expect(
      effectEvents.map((event) => {
        if (event.type === 'effect.recorded') return event.payload.effect.status;
        if (event.type === 'effect.status_changed') return event.payload.status;
        throw new Error('Unexpected Effect event');
      }),
    ).toEqual(['intended', 'dispatch_started', 'executed', 'confirmed']);
    expect(persisted.some((event) => event.type === 'receipt.issued')).toBe(false);
    expect(fixture.store.getMission(MISSION_ID)?.receipt).toBeUndefined();

    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('super-secret-bridge-value');
    expect(serialized).not.toContain('raw-query-secret');
    expect(serialized).toContain('[REDACTED]');
    expect(rebuildExecutionForkBridgeStateFromMissionEvents(persisted, FORK_ID)).toMatchObject({
      lastSequence: 7,
      lastTransition: 'receipt-input.ready',
      childAttemptId: CHILD_ATTEMPT_ID,
      effectId: workspaceEffectId(),
      runtimeResult: { runtimeRunId: 'runtime-run-child', status: 'completed' },
      receiptInput: {
        receiptInputId: 'execution-fork-receipt-input-fixture',
        workspaceEffectId: workspaceEffectId(),
      },
    });

    const replay = executionForkEventToMissionEvents(source[6]!, contextFor(source[6]!), persisted);
    expect(
      fixture.store.appendEvents(replay, fixture.fence).map((result) => result.inserted),
    ).toEqual([false, false]);
    fixture.store.close();
  });

  it('fails closed on skipped source events, changed bindings, missing Kernel companions, and invalid source hashes', async () => {
    const source = await sourceLifecycle();
    const fixture = createStoreFixture();
    const planned = executionForkEventToMissionEvents(
      source[0]!,
      contextFor(source[0]!),
      fixture.store.listEvents(MISSION_ID),
    );
    fixture.store.appendEvents(planned, fixture.fence);
    const persisted = fixture.store.listEvents(MISSION_ID);

    expect(() =>
      executionForkEventToMissionEvents(source[2]!, contextFor(source[2]!), persisted),
    ).toThrow(/source chain/);

    const changedBinding: AttemptBindingV1 = {
      ...binding(),
      profileId: 'profile-conflicting',
    };
    expect(() =>
      executionForkEventToMissionEvents(
        source[1]!,
        contextFor(source[1]!, changedBinding),
        persisted,
      ),
    ).toThrow(/source chain or binding changed/);

    expect(() =>
      executionForkEventToMissionEvents(
        source[1]!,
        contextFor(source[1]!),
        persisted.filter((event) => event.type !== 'effect.recorded'),
      ),
    ).toThrow(/lacks Kernel effect.recorded/);

    expect(() =>
      executionForkEventToMissionEvents(
        { ...source[1]!, eventHash: 'sha256:tampered' },
        contextFor(source[1]!),
        persisted,
      ),
    ).toThrow(/source event hash is invalid/);
    fixture.store.close();
  });

  it('rejects a validly hash-chained Receipt input when Effect identity conflicts or the child Runtime failed', async () => {
    for (const variant of ['wrong-effect', 'failed-runtime'] as const) {
      const source = await sourceLifecycle(variant);
      const fixture = createStoreFixture();
      for (const sourceEvent of source.slice(0, -1)) {
        const batch = executionForkEventToMissionEvents(
          sourceEvent,
          contextFor(sourceEvent),
          fixture.store.listEvents(MISSION_ID),
        );
        fixture.store.appendEvents(batch, fixture.fence);
      }
      const finalEvent = source.at(-1)!;
      expect(() =>
        executionForkEventToMissionEvents(
          finalEvent,
          contextFor(finalEvent),
          fixture.store.listEvents(MISSION_ID),
        ),
      ).toThrow(MissionExecutionForkBridgeError);

      const effectStatuses = fixture.store
        .listEvents(MISSION_ID)
        .filter(
          (event) =>
            event.type === 'effect.status_changed' &&
            event.payload.effectId === workspaceEffectId(),
        )
        .map((event) => (event.type === 'effect.status_changed' ? event.payload.status : ''));
      expect(effectStatuses.at(-1)).toBe(variant === 'failed-runtime' ? 'failed' : 'executed');
      expect(fixture.store.getMission(MISSION_ID)?.receipt).toBeUndefined();
      fixture.store.close();
    }
  });

  it('keeps the source Profile immutable while binding a Profile-Rebound child Attempt to the target', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'missionbraid-fork-rebound-journal-'));
    disposableDirectories.push(directory);
    const journal = new FileExecutionForkEvidenceJournal(directory);
    const planned = await journal.append({
      forkId: FORK_ID,
      type: 'fork.planned',
      occurredAt: timestamp(1),
      payload: { lineage: reboundLineage(), plan: plan() },
    });
    const targetBinding: AttemptBindingV1 = {
      ...binding(),
      profileId: 'profile-fork-upgraded',
      planNodeId: 'stage-upgraded',
    };
    const fixture = createStoreFixture();
    const persisted = fixture.store.listEvents(MISSION_ID);

    expect(() =>
      executionForkEventToMissionEvents(planned, contextFor(planned, targetBinding), persisted),
    ).not.toThrow();
    expect(() =>
      executionForkEventToMissionEvents(planned, contextFor(planned, binding()), persisted),
    ).toThrow(/immutable child lineage/);
    expect(reboundLineage()).toMatchObject({
      profileId: 'profile-fork',
      sourceProfileId: 'profile-fork',
      targetProfileId: 'profile-fork-upgraded',
    });
    fixture.store.close();
  });
});

async function sourceLifecycle(
  variant: 'complete' | 'wrong-effect' | 'failed-runtime' = 'complete',
): Promise<readonly ExecutionForkEventV1[]> {
  const directory = mkdtempSync(join(tmpdir(), 'missionbraid-fork-bridge-journal-'));
  disposableDirectories.push(directory);
  const journal = new FileExecutionForkEvidenceJournal(directory);
  const resultStatus = variant === 'failed-runtime' ? 'failed' : 'completed';
  const events: ExecutionForkEventV1[] = [];
  const append = async (
    type: ExecutionForkEventTypeV1,
    offset: number,
    payload: ExecutionForkEventPayloadV1,
  ): Promise<void> => {
    events.push(
      await journal.append({
        forkId: FORK_ID,
        type,
        occurredAt: timestamp(offset),
        payload,
      }),
    );
  };

  await append('fork.planned', 1, { lineage: lineage(), plan: plan() });
  await append('worktree.create-started', 2, {
    repositoryRoot: '/tmp/missionbraid/source',
    worktreePath: '/tmp/missionbraid/child',
    gitBranchName: 'missionbraid/child',
  });
  await append('worktree.created', 3, {
    baselineSnapshot: snapshot('workspace-before'),
    sourceSnapshot: snapshot('workspace-source'),
  });
  await append('runtime.started', 4, { runtimeRunRef: `runtime-pending:${FORK_ID}` });
  await append('runtime.evidence', 5, {
    evidence: {
      evidenceId: 'evidence-child-tool',
      kind: 'tool',
      observedAt: timestamp(5),
      contentDigest: 'sha256:child-tool',
      evidenceRefs: ['tool:write:child-only.txt'],
      summary: 'authorization=super-secret-bridge-value',
    },
  });
  const result = {
    runtimeRunId: 'runtime-run-child',
    status: resultStatus,
    toolExecutionEvidenceRefs: ['tool:write:child-only.txt'],
    verificationEvidenceRefs: ['verification:child-output'],
    unresolvedItems: resultStatus === 'failed' ? ['runtime:failed'] : [],
  } as const;
  await append('runtime.finished', 6, {
    result,
    futureSnapshot: snapshot('workspace-after'),
    sourceSnapshot: snapshot('workspace-source'),
  });
  await append('receipt-input.ready', 7, {
    receiptInput: receiptInput(
      variant === 'wrong-effect' ? 'effect-conflicting' : workspaceEffectId(),
      resultStatus,
    ),
  });
  return events;
}

function lineage(): ExecutionForkLineageV1 {
  return {
    schemaVersion: EXECUTION_FORK_SCHEMA_VERSION,
    lineageId: 'execution-fork-lineage-fixture',
    forkId: FORK_ID,
    mode: 'execution-fork',
    missionId: MISSION_ID,
    contractId: 'contract-fork',
    profileId: 'profile-fork',
    parentAttemptId: 'attempt-parent',
    parentBranchId: PARENT_BRANCH_ID,
    childBranchId: CHILD_BRANCH_ID,
    parentCheckpointId: CHECKPOINT_ID,
    parentEventPrefix: { throughSeq: 5, headHash: 'sha256:parent-head' },
    intervention: intervention(),
    repositoryRoot: '/tmp/missionbraid/source',
    isolatedWorktreePath: '/tmp/missionbraid/child',
    gitBranchName: 'missionbraid/child',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    childWorkspaceKey: CHILD_WORKSPACE_KEY,
    inheritedExternalEffectFrontier: [],
    externalEffectDecisions: [],
    createdAt: timestamp(1),
  };
}

function reboundLineage(): ExecutionForkLineageV1 {
  return {
    ...lineage(),
    sourceProfileId: 'profile-fork',
    targetProfileId: 'profile-fork-upgraded',
    targetStageId: 'stage-upgraded',
    profileSelection: {
      selectionId: 'profile-rebound-selection-fixture',
      sourceProfileId: 'profile-fork',
      targetProfileId: 'profile-fork-upgraded',
      targetStageId: 'stage-upgraded',
      targetProfileDefinitionId: 'profile-definition-upgraded',
      plannerDecisionHash: 'a'.repeat(64),
      authorityChange: 'unchanged',
      evidenceRefs: ['event:planner-decision', 'event:profile-selected'],
      selectedAt: timestamp(1),
    },
  };
}

function plan(): BranchingCheckpointPlanV1 {
  return {
    schemaVersion: CHECKPOINT_OPERATION_SCHEMA_VERSION,
    mode: 'execution-fork',
    planId: 'checkpoint-plan-fixture',
    parentCheckpointId: CHECKPOINT_ID,
    parentBranchId: PARENT_BRANCH_ID,
    childBranchId: CHILD_BRANCH_ID,
    intervention: intervention(),
    isolatedWorktree: {
      worktreeId: 'worktree-child',
      workspaceKey: CHILD_WORKSPACE_KEY,
      absolutePath: '/tmp/missionbraid/child',
      isolationMechanism: 'git-worktree',
      baselineWorkspaceDigest: 'workspace-before',
      evidenceRefs: ['worktree-plan:child'],
    },
    inheritedExternalEffectFrontier: [],
    externalEffectDecisions: [],
    semantics: {
      createsBranch: true,
      producesNewEvidence: true,
      modelExecution: 'live',
      toolExecution: 'live',
      workspaceUse: 'isolated-writable',
      sourceHistory: 'immutable',
    },
  };
}

function intervention() {
  return {
    interventionId: 'intervention-guidance-child',
    kind: 'guidance' as const,
    targetRef: 'context:next-guidance',
    beforeDigest: 'sha256:guidance-before',
    afterDigest: 'sha256:guidance-after',
    description: 'Run the child with one changed instruction.',
    authorityChange: 'unchanged' as const,
  };
}

function receiptInput(
  effectId: string,
  runtimeStatus: 'completed' | 'failed',
): ExecutionForkReceiptInputV1 {
  return {
    schemaVersion: EXECUTION_FORK_SCHEMA_VERSION,
    receiptInputId: 'execution-fork-receipt-input-fixture',
    forkId: FORK_ID,
    missionId: MISSION_ID,
    contractId: 'contract-fork',
    parentBranchId: PARENT_BRANCH_ID,
    childBranchId: CHILD_BRANCH_ID,
    parentCheckpointId: CHECKPOINT_ID,
    runtimeRunId: 'runtime-run-child',
    runtimeStatus,
    intervention: intervention(),
    inheritedExternalEffectFrontier: [],
    externalEffectDecisions: [],
    workspaceEffectInput: {
      effectId,
      kind: 'workspace.execution-fork',
      resourceKey: CHILD_WORKSPACE_KEY,
      scope: 'branch_local_workspace',
      controlLevel: 'enforced',
      status: 'executed',
      beforeWorkspaceDigest: 'workspace-before',
      afterWorkspaceDigest: 'workspace-after',
      evidenceRefs: ['workspace:before', 'workspace:after'],
    },
    futureEvidenceRefs: [
      'workspace:after',
      'https://example.invalid/evidence?access_token=raw-query-secret',
    ],
    toolExecutionEvidenceRefs: ['tool:write:child-only.txt'],
    verificationEvidenceRefs: ['verification:child-output'],
    unresolvedItems: runtimeStatus === 'failed' ? ['runtime:failed'] : [],
    generatedAt: timestamp(7),
    authority: 'receipt-input-not-kernel-state',
  };
}

function snapshot(workspaceDigest: string): GitWorkspaceSnapshotV1 {
  return {
    schemaVersion: 1,
    workspaceRoot: '/tmp/missionbraid/fixture',
    head: 'a'.repeat(40),
    status: [],
    paths: [],
    statusDigest: `status-${workspaceDigest}`,
    workspaceDigest,
    capturedAt: timestamp(3),
  };
}

function binding(): AttemptBindingV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    bindingId: 'binding-child',
    missionId: MISSION_ID,
    attemptId: CHILD_ATTEMPT_ID,
    branchId: CHILD_BRANCH_ID,
    contractId: 'contract-fork',
    profileId: 'profile-fork',
    workspaceKey: CHILD_WORKSPACE_KEY,
    planNodeId: 'plan-node-child',
    authority: 'workspace',
    injectionBudgetTokens: 2_000,
    boundAt: timestamp(4),
  };
}

function contextFor(
  event: ExecutionForkEventV1,
  attemptBinding: AttemptBindingV1 = binding(),
): MissionExecutionForkContextV1 {
  return {
    missionId: MISSION_ID,
    childAttemptId: CHILD_ATTEMPT_ID,
    binding: attemptBinding,
    occurredAt: event.occurredAt,
  };
}

function workspaceEffectId(): string {
  return executionForkWorkspaceEffectId(FORK_ID, CHILD_WORKSPACE_KEY);
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.parse(NOW) + offsetSeconds * 1_000).toISOString();
}

function createStoreFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'missionbraid-fork-bridge-store-'));
  disposableDirectories.push(directory);
  const store = new MissionStore(join(directory, 'kernel.sqlite'), { now: () => new Date(NOW) });
  const contract: ContractV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    contractId: 'contract-fork',
    objective: 'Continue one child Branch with real tools',
    acceptanceCriteria: [
      {
        criterionId: 'child-output',
        description: 'The child output is verified',
        verifier: { kind: 'fixture', configuration: {} },
      },
    ],
    createdAt: NOW,
  };
  const profile: ProfileV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: 'profile-fork',
    harness: 'fixture-runtime',
    model: 'fixture-model',
    capabilities: ['workspace-write'],
    configurationDigest: 'd'.repeat(64),
  };
  const mission: MissionV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    missionId: MISSION_ID,
    title: 'Execution Fork bridge fixture',
    workspaceKey: 'workspace-parent',
    contractId: contract.contractId,
    initialProfileId: profile.profileId,
    rootBranchId: PARENT_BRANCH_ID,
    status: 'pending',
    createdAt: NOW,
  };
  const fence = store.acquireWorkspaceLease(mission.workspaceKey, 'fork-bridge-test', {
    ttlMs: 60_000,
  });
  store.createMission(
    { eventId: 'event-create-fork-bridge', occurredAt: NOW, mission, contract, profile },
    fence,
  );
  store.appendEvent(
    {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: 'event-root-branch-fork-bridge',
      missionId: MISSION_ID,
      occurredAt: NOW,
      type: 'branch.created',
      payload: {
        branch: {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          branchId: PARENT_BRANCH_ID,
          missionId: MISSION_ID,
          status: 'active',
          createdAt: NOW,
        },
      },
    },
    fence,
  );
  store.appendEvent(
    {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: 'event-composite-checkpoint-fork-bridge',
      missionId: MISSION_ID,
      occurredAt: NOW,
      type: 'runtime.observation',
      payload: {
        kind: 'composite-checkpoint.created',
        data: { checkpointId: CHECKPOINT_ID, branchId: PARENT_BRANCH_ID },
      },
    },
    fence,
  );
  return { store, fence };
}
