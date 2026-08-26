import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  planCheckpointOperation,
  verifyCompositeCheckpoint,
  type BranchingCheckpointPlanV1,
  type CheckpointComponentNameV1,
  type CheckpointEffectFrontierEntryV1,
  type CheckpointInterventionV1,
  type CheckpointOperationModeV1,
  type CompositeCheckpointManifestV1,
  type ExternalEffectReplayDecisionV1,
} from './composite-checkpoint.js';
import { snapshotGitWorkspace, type GitWorkspaceSnapshotV1 } from './workspace.js';
import type { RuntimeBindingV1 } from './domain.js';

export const EXECUTION_FORK_SCHEMA_VERSION = 'missionbraid.dev/execution-fork/v1' as const;

/**
 * These modes are intentionally non-interchangeable. This service accepts only
 * execution-fork because it is the only mode that may run live tools in a
 * writable isolated worktree.
 */
export const CHECKPOINT_OPERATION_BOUNDARIES_V1 = {
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
} as const satisfies Record<CheckpointOperationModeV1, object>;

export type ExecutionForkErrorCodeV1 =
  | 'MODE_NOT_EXECUTABLE_FORK'
  | 'CHECKPOINT_INCOMPLETE'
  | 'WORKSPACE_ARTIFACT_UNSUPPORTED'
  | 'WORKSPACE_ARTIFACT_MISMATCH'
  | 'EXTERNAL_FRONTIER_INCOMPLETE'
  | 'EXTERNAL_FRONTIER_UNRESOLVED'
  | 'INVALID_REPOSITORY'
  | 'INVALID_WORKTREE_TARGET'
  | 'GIT_BRANCH_ALREADY_EXISTS'
  | 'SOURCE_BRANCH_MUTATED'
  | 'FORK_ALREADY_IN_PROGRESS'
  | 'FORK_EVIDENCE_CORRUPT'
  | 'PROFILE_SELECTION_INVALID'
  | 'RUNTIME_CONTINUATION_FAILED'
  | 'WORKTREE_NOT_OWNED';

export class ExecutionForkError extends Error {
  readonly code: ExecutionForkErrorCodeV1;

  constructor(code: ExecutionForkErrorCodeV1, message: string) {
    super(message);
    this.name = 'ExecutionForkError';
    this.code = code;
  }
}

export interface ExecutionForkRequestV1 {
  readonly mode: CheckpointOperationModeV1;
  readonly checkpoint: CompositeCheckpointManifestV1;
  readonly repositoryRoot: string;
  readonly childBranchId: string;
  readonly gitBranchName: string;
  readonly worktreeId: string;
  readonly childWorkspaceKey: string;
  readonly isolatedWorktreePath: string;
  /** Exactly one declared variable changed from the parent boundary. */
  readonly intervention: CheckpointInterventionV1;
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
  /**
   * An explicit deterministic Planner decision may rebind the child execution
   * to another already-declared Runtime Profile. The source Checkpoint remains
   * immutable and continues to identify the original Profile.
   */
  readonly profileSelection?: ExecutionForkProfileSelectionV1;
  readonly runtimeBinding?: RuntimeBindingV1;
}

export interface ExecutionForkProfileSelectionV1 {
  readonly selectionId: string;
  readonly sourceProfileId: string;
  readonly targetProfileId: string;
  readonly targetStageId: string;
  readonly targetProfileDefinitionId: string;
  readonly plannerDecisionHash: string;
  readonly authorityChange: 'unchanged' | 'narrowed';
  readonly evidenceRefs: readonly string[];
  readonly selectedAt: string;
}

export interface ExecutionForkLineageV1 {
  readonly schemaVersion: typeof EXECUTION_FORK_SCHEMA_VERSION;
  readonly lineageId: string;
  readonly forkId: string;
  readonly mode: 'execution-fork';
  readonly missionId: string;
  readonly contractId: string;
  /** Legacy source Profile identity retained for v1 journal compatibility. */
  readonly profileId: string;
  /** Present for Profile-Rebound Forks; absent historical records read as profileId. */
  readonly sourceProfileId?: string;
  /** Present for Profile-Rebound Forks; absent historical records read as profileId. */
  readonly targetProfileId?: string;
  readonly targetStageId?: string;
  readonly runtimeBinding?: RuntimeBindingV1;
  readonly profileSelection?: ExecutionForkProfileSelectionV1;
  readonly parentAttemptId: string;
  readonly parentBranchId: string;
  readonly childBranchId: string;
  readonly parentCheckpointId: string;
  readonly parentEventPrefix: {
    readonly throughSeq: number;
    readonly headHash: string;
  };
  /** A scalar by design: one Fork declares one Intervention. */
  readonly intervention: CheckpointInterventionV1;
  readonly repositoryRoot: string;
  readonly isolatedWorktreePath: string;
  readonly gitBranchName: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly childWorkspaceKey: string;
  readonly inheritedExternalEffectFrontier: readonly CheckpointEffectFrontierEntryV1[];
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
  readonly createdAt: string;
}

export type RuntimeForkEvidenceKindV1 = 'runtime' | 'model' | 'tool' | 'workspace' | 'verification';

export interface RuntimeForkEvidenceV1 {
  readonly evidenceId: string;
  readonly kind: RuntimeForkEvidenceKindV1;
  readonly observedAt: string;
  /** Content is retained by its native evidence store, not copied here. */
  readonly contentDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly summary?: string;
}

export interface RuntimeContinuationInputV1 {
  readonly forkId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly parentBranchId: string;
  readonly childBranchId: string;
  readonly parentCheckpointId: string;
  readonly workspacePath: string;
  readonly intervention: CheckpointInterventionV1;
  readonly inheritedExternalEffectFrontier: readonly CheckpointEffectFrontierEntryV1[];
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
  readonly appendEvidence: (evidence: RuntimeForkEvidenceV1) => Promise<void>;
}

export interface RuntimeContinuationResultV1 {
  readonly runtimeRunId: string;
  readonly status: 'completed' | 'failed';
  /** At least one reference proving that a real tool path was invoked. */
  readonly toolExecutionEvidenceRefs: readonly string[];
  /** Evidence refs proving how the visible Context was bound or refreshed. */
  readonly contextEvidenceRefs?: readonly string[];
  readonly verificationEvidenceRefs: readonly string[];
  readonly unresolvedItems: readonly string[];
}

export interface RuntimeContinuationPortV1 {
  continueFromCheckpoint(input: RuntimeContinuationInputV1): Promise<RuntimeContinuationResultV1>;
}

export interface ExecutionForkReceiptInputV1 {
  readonly schemaVersion: typeof EXECUTION_FORK_SCHEMA_VERSION;
  readonly receiptInputId: string;
  readonly forkId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly parentBranchId: string;
  readonly childBranchId: string;
  readonly parentCheckpointId: string;
  readonly runtimeRunId: string;
  readonly runtimeStatus: RuntimeContinuationResultV1['status'];
  readonly intervention: CheckpointInterventionV1;
  readonly inheritedExternalEffectFrontier: readonly CheckpointEffectFrontierEntryV1[];
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
  readonly workspaceEffectInput: {
    readonly effectId: string;
    readonly kind: 'workspace.execution-fork';
    readonly resourceKey: string;
    readonly scope: 'branch_local_workspace';
    readonly controlLevel: 'enforced';
    readonly status: 'executed';
    readonly beforeWorkspaceDigest: string;
    readonly afterWorkspaceDigest: string;
    readonly evidenceRefs: readonly string[];
  };
  readonly futureEvidenceRefs: readonly string[];
  readonly toolExecutionEvidenceRefs: readonly string[];
  readonly contextEvidenceRefs?: readonly string[];
  readonly verificationEvidenceRefs: readonly string[];
  readonly unresolvedItems: readonly string[];
  readonly generatedAt: string;
  /** The Kernel must still issue and verify a Receipt; this is evidence input only. */
  readonly authority: 'receipt-input-not-kernel-state';
}

/**
 * Stable Effect identity available as soon as the immutable Fork lineage is
 * durable. The Kernel can therefore record intent before any writable Runtime
 * continuation starts.
 */
export function executionForkWorkspaceEffectId(forkId: string, childWorkspaceKey: string): string {
  requireIdentifier(forkId, 'forkId');
  requireIdentifier(childWorkspaceKey, 'childWorkspaceKey');
  return `effect-${digest({
    kind: 'workspace.execution-fork',
    forkId,
    childWorkspaceKey,
  }).slice('sha256:'.length)}`;
}

export type ExecutionForkEventTypeV1 =
  | 'fork.planned'
  | 'worktree.create-started'
  | 'worktree.created'
  | 'runtime.started'
  | 'runtime.evidence'
  | 'runtime.finished'
  | 'receipt-input.ready'
  | 'fork.failed'
  | 'worktree.cleaned';

export type ExecutionForkEventPayloadV1 =
  | { readonly lineage: ExecutionForkLineageV1; readonly plan: BranchingCheckpointPlanV1 }
  | {
      readonly repositoryRoot: string;
      readonly worktreePath: string;
      readonly gitBranchName: string;
    }
  | {
      readonly baselineSnapshot: GitWorkspaceSnapshotV1;
      readonly sourceSnapshot: GitWorkspaceSnapshotV1;
    }
  | { readonly runtimeRunRef: string }
  | { readonly evidence: RuntimeForkEvidenceV1 }
  | {
      readonly result: RuntimeContinuationResultV1;
      readonly futureSnapshot: GitWorkspaceSnapshotV1;
      readonly sourceSnapshot: GitWorkspaceSnapshotV1;
    }
  | { readonly receiptInput: ExecutionForkReceiptInputV1 }
  | { readonly code: ExecutionForkErrorCodeV1; readonly detail: string }
  | { readonly worktreePath: string };

export interface ExecutionForkEventDraftV1 {
  readonly forkId: string;
  readonly type: ExecutionForkEventTypeV1;
  readonly occurredAt: string;
  readonly payload: ExecutionForkEventPayloadV1;
}

export interface ExecutionForkEventV1 extends ExecutionForkEventDraftV1 {
  readonly schemaVersion: typeof EXECUTION_FORK_SCHEMA_VERSION;
  readonly eventId: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly eventHash: string;
}

export interface ExecutionForkEvidenceJournalV1 {
  append(event: ExecutionForkEventDraftV1): Promise<ExecutionForkEventV1>;
  load(forkId: string): Promise<readonly ExecutionForkEventV1[]>;
}

interface ExecutionForkJournalFileState {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
}

interface ExecutionForkJournalTail {
  readonly sequence: number;
  readonly eventHash: string | null;
  readonly fileState: ExecutionForkJournalFileState | null;
}

/**
 * A small append-only, hash-chained evidence journal. It supports restart
 * reconstruction, but deliberately does not own Mission/Branch status.
 */
export class FileExecutionForkEvidenceJournal implements ExecutionForkEvidenceJournalV1 {
  readonly #directory: string;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #tails = new Map<string, ExecutionForkJournalTail>();

  constructor(directory: string) {
    if (!isAbsolute(directory)) {
      throw new ExecutionForkError(
        'FORK_EVIDENCE_CORRUPT',
        'Execution Fork evidence directory must be absolute',
      );
    }
    this.#directory = resolve(directory);
  }

  async append(draft: ExecutionForkEventDraftV1): Promise<ExecutionForkEventV1> {
    const prior = this.#queues.get(draft.forkId) ?? Promise.resolve();
    let stored!: ExecutionForkEventV1;
    const operation = prior.then(async () => {
      stored = await this.#appendNow(draft);
    });
    this.#queues.set(
      draft.forkId,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    await operation;
    return stored;
  }

  async load(forkId: string): Promise<readonly ExecutionForkEventV1[]> {
    requireIdentifier(forkId, 'forkId');
    let text: string;
    try {
      text = await readFile(this.#pathFor(forkId), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    if (text.length === 0) return [];
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const events = lines.map((line, index) => {
      try {
        return JSON.parse(line) as ExecutionForkEventV1;
      } catch {
        throw new ExecutionForkError(
          'FORK_EVIDENCE_CORRUPT',
          `Execution Fork journal contains invalid JSON at line ${index + 1}`,
        );
      }
    });
    verifyEventChain(forkId, events);
    return events;
  }

  async #appendNow(draft: ExecutionForkEventDraftV1): Promise<ExecutionForkEventV1> {
    requireIdentifier(draft.forkId, 'forkId');
    requireIsoTimestamp(draft.occurredAt, 'occurredAt');
    if (!eventTypes.has(draft.type)) {
      throw new ExecutionForkError('FORK_EVIDENCE_CORRUPT', `Unknown event type ${draft.type}`);
    }
    const tail = await this.#tailForAppend(draft.forkId);
    const core = {
      schemaVersion: EXECUTION_FORK_SCHEMA_VERSION,
      forkId: draft.forkId,
      type: draft.type,
      occurredAt: draft.occurredAt,
      payload: draft.payload,
      sequence: tail.sequence + 1,
      previousHash: tail.eventHash,
    } as const;
    const eventHash = digest(core);
    const event: ExecutionForkEventV1 = {
      ...core,
      eventId: `execution-fork-event-${eventHash.slice('sha256:'.length)}`,
      eventHash,
    };
    await mkdir(this.#directory, { recursive: true });
    const handle = await open(this.#pathFor(draft.forkId), 'a');
    try {
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const fileState = await this.#fileState(draft.forkId);
    if (fileState === null) {
      throw new ExecutionForkError(
        'FORK_EVIDENCE_CORRUPT',
        `Execution Fork journal ${draft.forkId} disappeared after append`,
      );
    }
    this.#tails.set(draft.forkId, {
      sequence: event.sequence,
      eventHash: event.eventHash,
      fileState,
    });
    return event;
  }

  async #tailForAppend(forkId: string): Promise<ExecutionForkJournalTail> {
    const cached = this.#tails.get(forkId);
    if (cached !== undefined) {
      const current = await this.#fileState(forkId);
      if (!sameFileState(current, cached.fileState)) {
        this.#tails.delete(forkId);
        throw new ExecutionForkError(
          'FORK_EVIDENCE_CORRUPT',
          `Execution Fork journal ${forkId} changed outside its append writer`,
        );
      }
      return cached;
    }
    const existing = await this.load(forkId);
    const tail: ExecutionForkJournalTail = {
      sequence: existing.length,
      eventHash: existing.at(-1)?.eventHash ?? null,
      fileState: await this.#fileState(forkId),
    };
    this.#tails.set(forkId, tail);
    return tail;
  }

  async #fileState(forkId: string): Promise<ExecutionForkJournalFileState | null> {
    try {
      const state = await lstat(this.#pathFor(forkId));
      if (!state.isFile()) {
        throw new ExecutionForkError(
          'FORK_EVIDENCE_CORRUPT',
          `Execution Fork journal ${forkId} is not a regular file`,
        );
      }
      return {
        device: state.dev,
        inode: state.ino,
        size: state.size,
        modifiedAtMs: state.mtimeMs,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #pathFor(forkId: string): string {
    return join(this.#directory, `${forkId}.jsonl`);
  }
}

function sameFileState(
  left: ExecutionForkJournalFileState | null,
  right: ExecutionForkJournalFileState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs
  );
}

export type ExecutionForkPhaseV1 =
  | 'planned'
  | 'worktree-created'
  | 'runtime-running'
  | 'finished'
  | 'failed'
  | 'cleaned';

export interface ExecutionForkRecordV1 {
  readonly forkId: string;
  readonly phase: ExecutionForkPhaseV1;
  readonly lineage: ExecutionForkLineageV1;
  readonly plan: BranchingCheckpointPlanV1;
  readonly events: readonly ExecutionForkEventV1[];
  readonly baselineSnapshot?: GitWorkspaceSnapshotV1;
  readonly futureSnapshot?: GitWorkspaceSnapshotV1;
  readonly runtimeEvidence: readonly RuntimeForkEvidenceV1[];
  readonly runtimeResult?: RuntimeContinuationResultV1;
  readonly receiptInput?: ExecutionForkReceiptInputV1;
  readonly failure?: { readonly code: ExecutionForkErrorCodeV1; readonly detail: string };
  readonly cleaned: boolean;
}

export interface ExecutionForkServiceOptionsV1 {
  readonly journal: ExecutionForkEvidenceJournalV1;
  readonly now?: () => Date;
}

const execFileAsync = promisify(execFile);

export class ExecutionForkService {
  readonly #journal: ExecutionForkEvidenceJournalV1;
  readonly #now: () => Date;

  constructor(options: ExecutionForkServiceOptionsV1) {
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(
    request: ExecutionForkRequestV1,
    runtime: RuntimeContinuationPortV1,
  ): Promise<ExecutionForkRecordV1> {
    if (request.mode !== 'execution-fork') {
      throw new ExecutionForkError(
        'MODE_NOT_EXECUTABLE_FORK',
        `${request.mode} cannot run live tools in an execution Fork`,
      );
    }

    verifyCompositeCheckpoint(request.checkpoint);
    assertCheckpointComplete(request.checkpoint);
    assertExternalFrontierComplete(request.checkpoint);
    if (request.profileSelection !== undefined) {
      validateProfileSelection(request.profileSelection, request.checkpoint.source.profileId);
    }

    const repositoryRoot = await resolveRepositoryRoot(request.repositoryRoot);
    const worktreePath = await resolveNewWorktreePath(repositoryRoot, request.isolatedWorktreePath);
    await assertValidNewBranch(repositoryRoot, request.gitBranchName);
    const artifact = await resolveGitArtifact(repositoryRoot, request.checkpoint);

    const planned = planCheckpointOperation({
      mode: 'execution-fork',
      checkpoint: request.checkpoint,
      childBranchId: request.childBranchId,
      intervention: request.intervention,
      isolatedWorktree: {
        worktreeId: request.worktreeId,
        workspaceKey: request.childWorkspaceKey,
        absolutePath: worktreePath,
        isolationMechanism: 'git-worktree',
        baselineWorkspaceDigest: requireWorkspaceDigest(request.checkpoint),
        evidenceRefs: [`worktree-plan:${request.worktreeId}`],
      },
      externalEffectDecisions: request.externalEffectDecisions,
    });
    if (!planned.ok) {
      const code =
        planned.blocker.code === 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED'
          ? 'EXTERNAL_FRONTIER_UNRESOLVED'
          : planned.blocker.code === 'EXTERNAL_EFFECT_DECISION_REQUIRED'
            ? 'EXTERNAL_FRONTIER_INCOMPLETE'
            : 'CHECKPOINT_INCOMPLETE';
      throw new ExecutionForkError(code, planned.blocker.detail);
    }
    if (planned.plan.mode !== 'execution-fork') {
      throw new ExecutionForkError(
        'MODE_NOT_EXECUTABLE_FORK',
        'Planner did not return an execution Fork',
      );
    }

    const createdAt = this.#timestamp();
    const lineageCore = {
      schemaVersion: EXECUTION_FORK_SCHEMA_VERSION,
      mode: 'execution-fork' as const,
      missionId: request.checkpoint.source.missionId,
      contractId: request.checkpoint.source.contractId,
      profileId: request.checkpoint.source.profileId,
      ...(request.runtimeBinding === undefined
        ? {}
        : {
            targetProfileId: request.runtimeBinding.profileId,
            runtimeBinding: { ...request.runtimeBinding },
          }),
      ...(request.profileSelection === undefined
        ? {}
        : {
            sourceProfileId: request.profileSelection.sourceProfileId,
            targetProfileId: request.profileSelection.targetProfileId,
            targetStageId: request.profileSelection.targetStageId,
            profileSelection: cloneProfileSelection(request.profileSelection),
          }),
      parentAttemptId: request.checkpoint.source.attemptId,
      parentBranchId: request.checkpoint.source.branchId,
      childBranchId: planned.plan.childBranchId,
      parentCheckpointId: request.checkpoint.checkpointId,
      parentEventPrefix: { ...request.checkpoint.eventPrefix },
      intervention: cloneIntervention(planned.plan.intervention),
      repositoryRoot,
      isolatedWorktreePath: worktreePath,
      gitBranchName: request.gitBranchName,
      baseCommit: artifact.commit,
      baseTree: artifact.tree,
      childWorkspaceKey: planned.plan.isolatedWorktree.workspaceKey,
      inheritedExternalEffectFrontier: cloneFrontier(planned.plan.inheritedExternalEffectFrontier),
      externalEffectDecisions: planned.plan.externalEffectDecisions.map((decision) => ({
        ...decision,
      })),
      createdAt,
    };
    const lineageId = `execution-fork-lineage-${digest(lineageCore).slice('sha256:'.length)}`;
    const forkId = `execution-fork-${digest({ lineageId, planId: planned.plan.planId }).slice(
      'sha256:'.length,
    )}`;
    const lineage: ExecutionForkLineageV1 = {
      ...lineageCore,
      lineageId,
      forkId,
      ...(request.runtimeBinding === undefined
        ? {}
        : {
            runtimeBinding: {
              ...request.runtimeBinding,
              attemptId: `fork-attempt-${forkId}`,
            },
          }),
    };

    const existing = await this.#journal.load(forkId);
    if (existing.length > 0) {
      const record = projectExecutionFork(existing);
      if (record.phase === 'finished' || record.phase === 'cleaned') return record;
      throw new ExecutionForkError(
        'FORK_ALREADY_IN_PROGRESS',
        'Existing durable Fork evidence requires explicit recovery; live tools will not be rerun blindly',
      );
    }

    const sourceBefore = snapshotGitWorkspace(repositoryRoot);
    let plannedPersisted = false;
    try {
      await this.#append(forkId, 'fork.planned', { lineage, plan: planned.plan });
      plannedPersisted = true;
      await this.#append(forkId, 'worktree.create-started', {
        repositoryRoot,
        worktreePath,
        gitBranchName: request.gitBranchName,
      });
      await git(repositoryRoot, [
        'worktree',
        'add',
        '-b',
        request.gitBranchName,
        worktreePath,
        artifact.commit,
      ]);

      const baselineSnapshot = snapshotGitWorkspace(worktreePath);
      if (baselineSnapshot.workspaceDigest !== requireWorkspaceDigest(request.checkpoint)) {
        throw new ExecutionForkError(
          'WORKSPACE_ARTIFACT_MISMATCH',
          'Restored Git worktree does not match the Composite Checkpoint workspace digest',
        );
      }
      const sourceAfterCreation = snapshotGitWorkspace(repositoryRoot);
      assertSourceUnchanged(sourceBefore, sourceAfterCreation);
      await this.#append(forkId, 'worktree.created', {
        baselineSnapshot,
        sourceSnapshot: sourceAfterCreation,
      });

      await this.#append(forkId, 'runtime.started', {
        runtimeRunRef: `runtime-pending:${forkId}`,
      });
      const result = normalizeRuntimeResult(
        await runtime.continueFromCheckpoint({
          forkId,
          missionId: lineage.missionId,
          contractId: lineage.contractId,
          parentBranchId: lineage.parentBranchId,
          childBranchId: lineage.childBranchId,
          parentCheckpointId: lineage.parentCheckpointId,
          workspacePath: lineage.isolatedWorktreePath,
          intervention: cloneIntervention(lineage.intervention),
          inheritedExternalEffectFrontier: cloneFrontier(lineage.inheritedExternalEffectFrontier),
          externalEffectDecisions: lineage.externalEffectDecisions.map((decision) => ({
            ...decision,
          })),
          appendEvidence: async (evidence) => {
            await this.#append(forkId, 'runtime.evidence', {
              evidence: normalizeRuntimeEvidence(evidence),
            });
          },
        }),
      );

      const futureSnapshot = snapshotGitWorkspace(worktreePath);
      const sourceAfterRuntime = snapshotGitWorkspace(repositoryRoot);
      assertSourceUnchanged(sourceBefore, sourceAfterRuntime);
      await this.#append(forkId, 'runtime.finished', {
        result,
        futureSnapshot,
        sourceSnapshot: sourceAfterRuntime,
      });

      if (result.status === 'failed') {
        return projectExecutionFork(await this.#journal.load(forkId));
      }

      const events = await this.#journal.load(forkId);
      const runtimeEvidenceEventRefs = events
        .filter((event) => event.type === 'runtime.evidence')
        .map((event) => `event:${event.eventId}`);
      const generatedAt = this.#timestamp();
      const receiptCore = {
        schemaVersion: EXECUTION_FORK_SCHEMA_VERSION,
        forkId,
        missionId: lineage.missionId,
        contractId: lineage.contractId,
        parentBranchId: lineage.parentBranchId,
        childBranchId: lineage.childBranchId,
        parentCheckpointId: lineage.parentCheckpointId,
        runtimeRunId: result.runtimeRunId,
        runtimeStatus: result.status,
        intervention: cloneIntervention(lineage.intervention),
        inheritedExternalEffectFrontier: cloneFrontier(lineage.inheritedExternalEffectFrontier),
        externalEffectDecisions: lineage.externalEffectDecisions.map((decision) => ({
          ...decision,
        })),
        workspaceEffectInput: {
          effectId: executionForkWorkspaceEffectId(forkId, lineage.childWorkspaceKey),
          kind: 'workspace.execution-fork' as const,
          resourceKey: lineage.childWorkspaceKey,
          scope: 'branch_local_workspace' as const,
          controlLevel: 'enforced' as const,
          status: 'executed' as const,
          beforeWorkspaceDigest: baselineSnapshot.workspaceDigest,
          afterWorkspaceDigest: futureSnapshot.workspaceDigest,
          evidenceRefs: uniqueSorted([
            `workspace:${baselineSnapshot.workspaceDigest}`,
            `workspace:${futureSnapshot.workspaceDigest}`,
            ...runtimeEvidenceEventRefs,
          ]),
        },
        futureEvidenceRefs: uniqueSorted([
          ...runtimeEvidenceEventRefs,
          ...(result.contextEvidenceRefs ?? []),
          `workspace:${futureSnapshot.workspaceDigest}`,
        ]),
        toolExecutionEvidenceRefs: [...result.toolExecutionEvidenceRefs],
        ...(result.contextEvidenceRefs === undefined
          ? {}
          : { contextEvidenceRefs: [...result.contextEvidenceRefs] }),
        verificationEvidenceRefs: [...result.verificationEvidenceRefs],
        unresolvedItems: [...result.unresolvedItems],
        generatedAt,
        authority: 'receipt-input-not-kernel-state' as const,
      };
      const receiptInput: ExecutionForkReceiptInputV1 = {
        ...receiptCore,
        receiptInputId: `execution-fork-receipt-input-${digest(receiptCore).slice(
          'sha256:'.length,
        )}`,
      };
      await this.#append(forkId, 'receipt-input.ready', { receiptInput });
      return projectExecutionFork(await this.#journal.load(forkId));
    } catch (error) {
      if (plannedPersisted) {
        const failure = normalizeFailure(error);
        await this.#append(forkId, 'fork.failed', failure);
      }
      throw error;
    }
  }

  async inspect(forkId: string): Promise<ExecutionForkRecordV1 | null> {
    const events = await this.#journal.load(forkId);
    return events.length === 0 ? null : projectExecutionFork(events);
  }

  /** Removes only the exact Git worktree created by this recorded Fork. */
  async cleanup(forkId: string): Promise<ExecutionForkRecordV1> {
    const events = await this.#journal.load(forkId);
    if (events.length === 0) {
      throw new ExecutionForkError('WORKTREE_NOT_OWNED', `No recorded execution Fork ${forkId}`);
    }
    const record = projectExecutionFork(events);
    if (record.cleaned) return record;
    if (!(await pathExists(record.lineage.isolatedWorktreePath))) {
      throw new ExecutionForkError(
        'WORKTREE_NOT_OWNED',
        'Recorded worktree is absent; cleanup will not infer or remove another path',
      );
    }
    const registered = await registeredWorktrees(record.lineage.repositoryRoot);
    if (!registered.includes(record.lineage.isolatedWorktreePath)) {
      throw new ExecutionForkError(
        'WORKTREE_NOT_OWNED',
        'Recorded path is not a Git worktree owned by the source repository',
      );
    }
    await git(record.lineage.repositoryRoot, [
      'worktree',
      'remove',
      '--force',
      record.lineage.isolatedWorktreePath,
    ]);
    await this.#append(forkId, 'worktree.cleaned', {
      worktreePath: record.lineage.isolatedWorktreePath,
    });
    return projectExecutionFork(await this.#journal.load(forkId));
  }

  async #append(
    forkId: string,
    type: ExecutionForkEventTypeV1,
    payload: ExecutionForkEventPayloadV1,
  ): Promise<ExecutionForkEventV1> {
    return this.#journal.append({ forkId, type, occurredAt: this.#timestamp(), payload });
  }

  #timestamp(): string {
    return requireIsoTimestamp(this.#now().toISOString(), 'now');
  }
}

export function projectExecutionFork(
  events: readonly ExecutionForkEventV1[],
): ExecutionForkRecordV1 {
  if (events.length === 0) {
    throw new ExecutionForkError('FORK_EVIDENCE_CORRUPT', 'Cannot project an empty Fork journal');
  }
  verifyEventChain(events[0]?.forkId ?? '', events);
  const planned = events.find((event) => event.type === 'fork.planned');
  if (planned === undefined) {
    throw new ExecutionForkError('FORK_EVIDENCE_CORRUPT', 'Fork journal has no immutable lineage');
  }
  const plannedPayload = planned.payload as {
    readonly lineage: ExecutionForkLineageV1;
    readonly plan: BranchingCheckpointPlanV1;
  };
  const runtimeEvidence: RuntimeForkEvidenceV1[] = [];
  let phase: ExecutionForkPhaseV1 = 'planned';
  let baselineSnapshot: GitWorkspaceSnapshotV1 | undefined;
  let futureSnapshot: GitWorkspaceSnapshotV1 | undefined;
  let runtimeResult: RuntimeContinuationResultV1 | undefined;
  let receiptInput: ExecutionForkReceiptInputV1 | undefined;
  let failure: ExecutionForkRecordV1['failure'];
  let cleaned = false;

  for (const event of events) {
    switch (event.type) {
      case 'worktree.created': {
        const payload = event.payload as {
          readonly baselineSnapshot: GitWorkspaceSnapshotV1;
        };
        baselineSnapshot = payload.baselineSnapshot;
        phase = 'worktree-created';
        break;
      }
      case 'runtime.started':
        phase = 'runtime-running';
        break;
      case 'runtime.evidence':
        runtimeEvidence.push(
          (event.payload as { readonly evidence: RuntimeForkEvidenceV1 }).evidence,
        );
        break;
      case 'runtime.finished': {
        const payload = event.payload as {
          readonly result: RuntimeContinuationResultV1;
          readonly futureSnapshot: GitWorkspaceSnapshotV1;
        };
        runtimeResult = payload.result;
        futureSnapshot = payload.futureSnapshot;
        phase = 'finished';
        break;
      }
      case 'receipt-input.ready':
        receiptInput = (event.payload as { readonly receiptInput: ExecutionForkReceiptInputV1 })
          .receiptInput;
        phase = 'finished';
        break;
      case 'fork.failed':
        failure = event.payload as ExecutionForkRecordV1['failure'];
        phase = 'failed';
        break;
      case 'worktree.cleaned':
        cleaned = true;
        phase = 'cleaned';
        break;
      default:
        break;
    }
  }

  return {
    forkId: plannedPayload.lineage.forkId,
    phase,
    lineage: plannedPayload.lineage,
    plan: plannedPayload.plan,
    events: [...events],
    ...(baselineSnapshot === undefined ? {} : { baselineSnapshot }),
    ...(futureSnapshot === undefined ? {} : { futureSnapshot }),
    runtimeEvidence,
    ...(runtimeResult === undefined ? {} : { runtimeResult }),
    ...(receiptInput === undefined ? {} : { receiptInput }),
    ...(failure === undefined ? {} : { failure }),
    cleaned,
  };
}

function assertCheckpointComplete(checkpoint: CompositeCheckpointManifestV1): void {
  const expected = new Set<CheckpointComponentNameV1>([
    'mission',
    'branch',
    'attempt',
    'contract',
    'profile',
    'event-prefix',
    'visible-context',
    'workspace',
    'permissions',
    'effect-frontier',
    'process',
    'native-session',
  ]);
  const seen = new Set(checkpoint.components.map((component) => component.component));
  if (seen.size !== checkpoint.components.length || [...expected].some((name) => !seen.has(name))) {
    throw new ExecutionForkError(
      'CHECKPOINT_INCOMPLETE',
      'Execution Fork requires every Composite Checkpoint component exactly once',
    );
  }
  for (const required of [
    'mission',
    'branch',
    'attempt',
    'contract',
    'profile',
    'event-prefix',
    'visible-context',
    'workspace',
    'permissions',
    'effect-frontier',
    'process',
  ] as const) {
    if (
      checkpoint.components.find((component) => component.component === required)?.disposition ===
      'unavailable'
    ) {
      throw new ExecutionForkError(
        'CHECKPOINT_INCOMPLETE',
        `Execution Fork cannot recover unavailable ${required} state`,
      );
    }
  }
  if (
    checkpoint.workspace.state !== 'restorable-artifact' ||
    checkpoint.components.find((component) => component.component === 'workspace')?.disposition !==
      'recoverable'
  ) {
    throw new ExecutionForkError(
      'CHECKPOINT_INCOMPLETE',
      'Execution Fork requires a recoverable workspace artifact',
    );
  }
  if (checkpoint.process.status !== 'stopped') {
    throw new ExecutionForkError(
      'CHECKPOINT_INCOMPLETE',
      'Execution Fork requires a stopped Runtime process boundary',
    );
  }
}

function assertExternalFrontierComplete(checkpoint: CompositeCheckpointManifestV1): void {
  for (const effect of checkpoint.externalEffectFrontier) {
    if (
      ['intended', 'dispatch_started', 'executed', 'ambiguous', 'conflict'].includes(effect.status)
    ) {
      throw new ExecutionForkError(
        'EXTERNAL_FRONTIER_UNRESOLVED',
        `External Effect ${effect.effectId} is ${effect.status}; reconcile before Fork`,
      );
    }
    if (
      effect.scope === 'unknown' ||
      effect.controlLevel === 'unknown' ||
      effect.evidenceRefs.length === 0
    ) {
      throw new ExecutionForkError(
        'EXTERNAL_FRONTIER_INCOMPLETE',
        `External Effect ${effect.effectId} has incomplete scope, control, or evidence`,
      );
    }
    if (
      effect.scope === 'mission_global_external' &&
      effect.status === 'confirmed' &&
      (effect.authorityRef === undefined || effect.idempotencyKey === undefined)
    ) {
      throw new ExecutionForkError(
        'EXTERNAL_FRONTIER_INCOMPLETE',
        `Confirmed external Effect ${effect.effectId} lacks authority or idempotency identity`,
      );
    }
  }
}

async function resolveRepositoryRoot(requested: string): Promise<string> {
  if (!isAbsolute(requested)) {
    throw new ExecutionForkError('INVALID_REPOSITORY', 'repositoryRoot must be absolute');
  }
  let root: string;
  try {
    root = await realpath(resolve(requested));
  } catch {
    throw new ExecutionForkError('INVALID_REPOSITORY', 'repositoryRoot does not exist');
  }
  const topLevel = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if ((await realpath(topLevel)) !== root) {
    throw new ExecutionForkError(
      'INVALID_REPOSITORY',
      'repositoryRoot must be the source Git worktree root',
    );
  }
  return root;
}

async function resolveNewWorktreePath(repositoryRoot: string, requested: string): Promise<string> {
  if (!isAbsolute(requested)) {
    throw new ExecutionForkError(
      'INVALID_WORKTREE_TARGET',
      'isolatedWorktreePath must be absolute',
    );
  }
  const absolute = resolve(requested);
  if (absolute === repositoryRoot || pathIsInside(repositoryRoot, absolute)) {
    throw new ExecutionForkError(
      'INVALID_WORKTREE_TARGET',
      'Isolated worktree must be outside the source worktree',
    );
  }
  if (await pathExists(absolute)) {
    throw new ExecutionForkError(
      'INVALID_WORKTREE_TARGET',
      'Isolated worktree target already exists',
    );
  }
  let parent: string;
  try {
    parent = await realpath(dirname(absolute));
  } catch {
    throw new ExecutionForkError(
      'INVALID_WORKTREE_TARGET',
      'Isolated worktree parent directory must already exist',
    );
  }
  return join(parent, absolute.slice(dirname(absolute).length + 1));
}

async function assertValidNewBranch(repositoryRoot: string, branch: string): Promise<void> {
  requireNonEmpty(branch, 'gitBranchName');
  const validation = await gitAllowFailure(repositoryRoot, [
    'check-ref-format',
    '--branch',
    branch,
  ]);
  if (validation.code !== 0) {
    throw new ExecutionForkError('INVALID_WORKTREE_TARGET', `Invalid Git branch name ${branch}`);
  }
  const existing = await gitAllowFailure(repositoryRoot, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (existing.code === 0) {
    throw new ExecutionForkError(
      'GIT_BRANCH_ALREADY_EXISTS',
      `Git branch ${branch} already exists and is not owned by this new Fork`,
    );
  }
}

async function resolveGitArtifact(
  repositoryRoot: string,
  checkpoint: CompositeCheckpointManifestV1,
): Promise<{ readonly commit: string; readonly tree: string }> {
  const artifactRef = checkpoint.workspace.artifactRef ?? '';
  const match = /^git-commit:([0-9a-f]{40,64})$/.exec(artifactRef);
  if (match?.[1] === undefined) {
    throw new ExecutionForkError(
      'WORKSPACE_ARTIFACT_UNSUPPORTED',
      'Executable Git Fork currently requires a git-commit:<object-id> workspace artifact',
    );
  }
  const resolved = await gitAllowFailure(repositoryRoot, [
    'rev-parse',
    '--verify',
    `${match[1]}^{commit}`,
  ]);
  if (resolved.code !== 0) {
    throw new ExecutionForkError(
      'WORKSPACE_ARTIFACT_UNSUPPORTED',
      'Checkpoint Git commit artifact is not present in the source object database',
    );
  }
  const commit = resolved.stdout.trim();
  const tree = (await git(repositoryRoot, ['rev-parse', `${commit}^{tree}`])).trim();
  if (checkpoint.workspace.artifactDigest !== `git-tree:${tree}`) {
    throw new ExecutionForkError(
      'WORKSPACE_ARTIFACT_MISMATCH',
      'Checkpoint artifact digest does not match the Git commit tree',
    );
  }
  return { commit, tree };
}

function requireWorkspaceDigest(checkpoint: CompositeCheckpointManifestV1): string {
  return requireNonEmpty(checkpoint.workspace.workspaceDigest ?? '', 'workspace.workspaceDigest');
}

function assertSourceUnchanged(
  before: GitWorkspaceSnapshotV1,
  after: GitWorkspaceSnapshotV1,
): void {
  if (
    before.head !== after.head ||
    before.statusDigest !== after.statusDigest ||
    before.workspaceDigest !== after.workspaceDigest
  ) {
    throw new ExecutionForkError(
      'SOURCE_BRANCH_MUTATED',
      'Execution Fork changed the source worktree; only the isolated child may be modified',
    );
  }
}

function normalizeRuntimeEvidence(evidence: RuntimeForkEvidenceV1): RuntimeForkEvidenceV1 {
  if (!['runtime', 'model', 'tool', 'workspace', 'verification'].includes(evidence.kind)) {
    throw new ExecutionForkError(
      'RUNTIME_CONTINUATION_FAILED',
      `Unsupported runtime evidence kind ${evidence.kind}`,
    );
  }
  const summary =
    evidence.summary === undefined ? undefined : requireNonEmpty(evidence.summary, 'summary');
  return {
    evidenceId: requireIdentifier(evidence.evidenceId, 'evidenceId'),
    kind: evidence.kind,
    observedAt: requireIsoTimestamp(evidence.observedAt, 'observedAt'),
    contentDigest: requireNonEmpty(evidence.contentDigest, 'contentDigest'),
    evidenceRefs: uniqueSorted(
      evidence.evidenceRefs.map((ref) => requireNonEmpty(ref, 'evidenceRef')),
    ),
    ...(summary === undefined ? {} : { summary }),
  };
}

function normalizeRuntimeResult(result: RuntimeContinuationResultV1): RuntimeContinuationResultV1 {
  if (result.status !== 'completed' && result.status !== 'failed') {
    throw new ExecutionForkError(
      'RUNTIME_CONTINUATION_FAILED',
      `Unsupported Runtime continuation status ${String(result.status)}`,
    );
  }
  const toolExecutionEvidenceRefs = uniqueSorted(
    result.toolExecutionEvidenceRefs.map((ref) => requireNonEmpty(ref, 'toolEvidenceRef')),
  );
  if (result.status === 'completed' && toolExecutionEvidenceRefs.length === 0) {
    throw new ExecutionForkError(
      'RUNTIME_CONTINUATION_FAILED',
      'A completed Runtime continuation must provide terminal evidence of at least one real tool execution',
    );
  }
  return {
    runtimeRunId: requireIdentifier(result.runtimeRunId, 'runtimeRunId'),
    status: result.status,
    toolExecutionEvidenceRefs,
    ...(result.contextEvidenceRefs === undefined
      ? {}
      : {
          contextEvidenceRefs: uniqueSorted(
            result.contextEvidenceRefs.map((ref) => requireNonEmpty(ref, 'contextEvidenceRef')),
          ),
        }),
    verificationEvidenceRefs: uniqueSorted(
      result.verificationEvidenceRefs.map((ref) => requireNonEmpty(ref, 'verificationEvidenceRef')),
    ),
    unresolvedItems: uniqueSorted(
      result.unresolvedItems.map((item) => requireNonEmpty(item, 'unresolvedItem')),
    ),
  };
}

function normalizeFailure(error: unknown): {
  readonly code: ExecutionForkErrorCodeV1;
  readonly detail: string;
} {
  if (error instanceof ExecutionForkError) return { code: error.code, detail: error.message };
  return {
    code: 'RUNTIME_CONTINUATION_FAILED',
    detail: error instanceof Error ? error.message : String(error),
  };
}

function verifyEventChain(forkId: string, events: readonly ExecutionForkEventV1[]): void {
  let previousHash: string | null = null;
  for (const [index, event] of events.entries()) {
    if (
      event.schemaVersion !== EXECUTION_FORK_SCHEMA_VERSION ||
      event.forkId !== forkId ||
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      !eventTypes.has(event.type)
    ) {
      throw new ExecutionForkError(
        'FORK_EVIDENCE_CORRUPT',
        `Execution Fork evidence chain is invalid at sequence ${index + 1}`,
      );
    }
    const core = {
      schemaVersion: event.schemaVersion,
      forkId: event.forkId,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: event.payload,
      sequence: event.sequence,
      previousHash: event.previousHash,
    };
    const expectedHash = digest(core);
    if (
      event.eventHash !== expectedHash ||
      event.eventId !== `execution-fork-event-${expectedHash.slice('sha256:'.length)}`
    ) {
      throw new ExecutionForkError(
        'FORK_EVIDENCE_CORRUPT',
        `Execution Fork evidence hash is invalid at sequence ${event.sequence}`,
      );
    }
    previousHash = event.eventHash;
  }
}

async function registeredWorktrees(repositoryRoot: string): Promise<string[]> {
  const output = await git(repositoryRoot, ['worktree', 'list', '--porcelain']);
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await gitAllowFailure(cwd, args);
  if (result.code !== 0) {
    throw new ExecutionForkError(
      'INVALID_REPOSITORY',
      `Git command failed (${args[0] ?? 'unknown'}): ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  return result.stdout;
}

async function gitAllowFailure(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    if (isExecError(error)) {
      return {
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? ''),
      };
    }
    throw error;
  }
}

function cloneIntervention(intervention: CheckpointInterventionV1): CheckpointInterventionV1 {
  return {
    interventionId: intervention.interventionId,
    kind: intervention.kind,
    targetRef: intervention.targetRef,
    ...(intervention.beforeDigest === undefined ? {} : { beforeDigest: intervention.beforeDigest }),
    afterDigest: intervention.afterDigest,
    description: intervention.description,
    authorityChange: intervention.authorityChange,
  };
}

function cloneFrontier(
  frontier: readonly CheckpointEffectFrontierEntryV1[],
): CheckpointEffectFrontierEntryV1[] {
  return frontier.map((effect) => ({ ...effect, evidenceRefs: [...effect.evidenceRefs] }));
}

function pathIsInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function requireIdentifier(value: string, path: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new ExecutionForkError('CHECKPOINT_INCOMPLETE', `${path} must be a stable identifier`);
  }
  return value;
}

function validateProfileSelection(
  selection: ExecutionForkProfileSelectionV1,
  checkpointProfileId: string,
): void {
  for (const [path, value] of [
    ['profileSelection.selectionId', selection.selectionId],
    ['profileSelection.sourceProfileId', selection.sourceProfileId],
    ['profileSelection.targetProfileId', selection.targetProfileId],
    ['profileSelection.targetStageId', selection.targetStageId],
    ['profileSelection.targetProfileDefinitionId', selection.targetProfileDefinitionId],
  ] as const) {
    requireIdentifier(value, path);
  }
  if (
    selection.sourceProfileId !== checkpointProfileId ||
    selection.sourceProfileId === selection.targetProfileId
  ) {
    throw new ExecutionForkError(
      'PROFILE_SELECTION_INVALID',
      'Profile selection must retain the Checkpoint source Profile and bind a distinct target Profile',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(selection.plannerDecisionHash)) {
    throw new ExecutionForkError(
      'PROFILE_SELECTION_INVALID',
      'Profile selection must bind a complete Planner decision hash',
    );
  }
  if (
    selection.evidenceRefs.length === 0 ||
    selection.evidenceRefs.some((ref) => ref.trim() === '')
  ) {
    throw new ExecutionForkError(
      'PROFILE_SELECTION_INVALID',
      'Profile selection must retain non-empty Planner evidence references',
    );
  }
  requireIsoTimestamp(selection.selectedAt, 'profileSelection.selectedAt');
}

function cloneProfileSelection(
  selection: ExecutionForkProfileSelectionV1,
): ExecutionForkProfileSelectionV1 {
  return { ...selection, evidenceRefs: [...selection.evidenceRefs] };
}

function requireNonEmpty(value: string, path: string): string {
  if (value.trim().length === 0) {
    throw new ExecutionForkError('CHECKPOINT_INCOMPLETE', `${path} must not be empty`);
  }
  return value;
}

function requireIsoTimestamp(value: string, path: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ExecutionForkError('FORK_EVIDENCE_CORRUPT', `${path} must be an ISO timestamp`);
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, candidate]) => candidate !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, candidate]) => [key, canonicalize(candidate)]),
    );
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isExecError(error: unknown): error is Error & {
  readonly code?: number | string;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
} {
  return error instanceof Error && ('stdout' in error || 'stderr' in error || 'code' in error);
}

const eventTypes = new Set<ExecutionForkEventTypeV1>([
  'fork.planned',
  'worktree.create-started',
  'worktree.created',
  'runtime.started',
  'runtime.evidence',
  'runtime.finished',
  'receipt-input.ready',
  'fork.failed',
  'worktree.cleaned',
]);
