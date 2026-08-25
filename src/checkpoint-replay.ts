import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  planCheckpointOperation,
  verifyCompositeCheckpoint,
  type BranchingCheckpointPlanV1,
  type CheckpointComponentNameV1,
  type CheckpointEffectFrontierEntryV1,
  type CheckpointInterventionV1,
  type CheckpointOperationPlanV1,
  type CompositeCheckpointManifestV1,
  type ExternalEffectReplayDecisionV1,
  type PlaybackPlanV1,
} from './composite-checkpoint.js';
import type { StoredEventV1 } from './domain.js';
import { computeEventHash, hashPayload } from './store.js';

export const CHECKPOINT_REPLAY_SCHEMA_VERSION = 'missionbraid.dev/checkpoint-replay/v1' as const;
export const CHECKPOINT_REPLAY_SOURCE_SCHEMA_VERSION =
  'missionbraid.dev/checkpoint-replay-source/v1' as const;

export type CheckpointReplayModeV1 = 'playback' | 'cached-replay' | 'counterfactual-resample';

export type ReplayArtifactFidelityV1 = 'exact-replay-safe' | 'sanitized-lossy' | 'opaque';

/** A reference only. Replay content remains in the caller's persisted Artifact store. */
export interface ReplayArtifactRefV1 {
  readonly artifactId: string;
  readonly contentDigest: string;
  readonly fidelity: ReplayArtifactFidelityV1;
  readonly evidenceRefs: readonly string[];
}

export type ReplayArtifactResolutionV1 =
  | {
      readonly status: 'found';
      readonly contentDigest: string;
      readonly fidelity: ReplayArtifactFidelityV1;
    }
  | { readonly status: 'absent'; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string };

export interface ReplayArtifactResolverV1 {
  resolve(reference: ReplayArtifactRefV1): Promise<ReplayArtifactResolutionV1>;
}

export interface ReplayInterventionArtifactV1 extends ReplayArtifactRefV1 {
  readonly targetRef: string;
}

export type CachedFutureEvidenceKindV1 =
  | 'model-input'
  | 'model-output'
  | 'message'
  | 'tool-request'
  | 'tool-result'
  | 'workspace-change'
  | 'verification'
  | 'effect'
  | 'failure'
  | 'unknown';

export interface CachedFutureEvidenceV1 {
  readonly evidenceId: string;
  readonly sourceSequence: number;
  readonly kind: CachedFutureEvidenceKindV1;
  readonly status: 'observed' | 'failed' | 'unknown';
  readonly targetRef: string;
  readonly contentDigest: string;
  readonly artifactRefs: readonly ReplayArtifactRefV1[];
  readonly evidenceRefs: readonly string[];
  readonly requestDigest?: string;
}

interface CachedReplaySourceBundleCoreV1 {
  readonly schemaVersion: typeof CHECKPOINT_REPLAY_SOURCE_SCHEMA_VERSION;
  readonly checkpointId: string;
  readonly sourceBranchId: string;
  readonly sourceEventPrefix: {
    readonly throughSeq: number;
    readonly headHash: string;
  };
  readonly evidence: readonly CachedFutureEvidenceV1[];
}

export interface CachedReplaySourceBundleV1 extends CachedReplaySourceBundleCoreV1 {
  readonly bundleId: string;
  readonly manifestDigest: string;
}

export interface CachedReplaySourceBundleInputV1 {
  readonly checkpointId: string;
  readonly sourceBranchId: string;
  readonly sourceEventPrefix: {
    readonly throughSeq: number;
    readonly headHash: string;
  };
  readonly evidence: readonly CachedFutureEvidenceV1[];
}

interface CachedContextBundleCoreV1 {
  readonly schemaVersion: typeof CHECKPOINT_REPLAY_SOURCE_SCHEMA_VERSION;
  readonly checkpointId: string;
  readonly contextDigest: string;
  readonly artifactRefs: readonly ReplayArtifactRefV1[];
  readonly targetDigests: readonly {
    readonly targetRef: string;
    readonly contentDigest: string;
  }[];
  readonly evidenceRefs: readonly string[];
}

export interface CachedContextBundleV1 extends CachedContextBundleCoreV1 {
  readonly bundleId: string;
  readonly manifestDigest: string;
}

export interface CachedContextBundleInputV1 {
  readonly checkpointId: string;
  readonly contextDigest: string;
  readonly artifactRefs: readonly ReplayArtifactRefV1[];
  readonly targetDigests: readonly {
    readonly targetRef: string;
    readonly contentDigest: string;
  }[];
  readonly evidenceRefs: readonly string[];
}

export interface CheckpointPlaybackRequestV1 {
  readonly mode: 'playback';
  readonly checkpoint: CompositeCheckpointManifestV1;
  readonly history: readonly StoredEventV1[];
}

interface BranchReplayRequestCoreV1 {
  readonly checkpoint: CompositeCheckpointManifestV1;
  readonly childBranchId: string;
  readonly childWorkspaceKey: string;
  /** A scalar by design: one replay changes one declared variable. */
  readonly intervention: CheckpointInterventionV1;
  readonly interventionArtifact: ReplayInterventionArtifactV1;
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
}

export interface CachedReplayRequestV1 extends BranchReplayRequestCoreV1 {
  readonly mode: 'cached-replay';
  readonly sourceFuture: CachedReplaySourceBundleV1;
}

export interface CounterfactualResampleRequestV1 extends BranchReplayRequestCoreV1 {
  readonly mode: 'counterfactual-resample';
  readonly cachedContext: CachedContextBundleV1;
}

export interface ModelOnlyResampleInputV1 {
  readonly replayId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly parentBranchId: string;
  readonly childBranchId: string;
  readonly parentCheckpointId: string;
  readonly cachedContext: CachedContextBundleV1;
  readonly intervention: CheckpointInterventionV1;
  readonly interventionArtifact: ReplayInterventionArtifactV1;
  readonly inheritedExternalEffectFrontier: readonly CheckpointEffectFrontierEntryV1[];
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
  readonly liveToolAccess: 'forbidden';
  readonly liveWorkspaceAccess: 'forbidden';
}

export type ModelOnlyEvidenceKindV1 = 'model-output' | 'message' | 'usage' | 'failure' | 'unknown';

export interface ModelOnlyEvidenceV1 {
  readonly evidenceId: string;
  readonly kind: ModelOnlyEvidenceKindV1;
  readonly observedAt: string;
  readonly contentDigest: string;
  readonly artifactRefs: readonly ReplayArtifactRefV1[];
  readonly evidenceRefs: readonly string[];
}

export interface ModelOnlyResampleResultV1 {
  readonly responseId: string;
  readonly status: 'completed' | 'failed' | 'unknown';
  readonly modelEvidence: readonly ModelOnlyEvidenceV1[];
  /** Any non-empty prohibited collection makes the operation fail closed. */
  readonly toolRequestEvidenceRefs: readonly string[];
  readonly effectEvidenceRefs: readonly string[];
  readonly workspaceEvidenceRefs: readonly string[];
  readonly unresolvedItems: readonly string[];
}

export interface ModelOnlyResamplePortV1 {
  resample(input: ModelOnlyResampleInputV1): Promise<ModelOnlyResampleResultV1>;
}

export type CheckpointReplayErrorCodeV1 =
  | 'CHECKPOINT_INVALID'
  | 'CHECKPOINT_INCOMPLETE'
  | 'HISTORY_PREFIX_INVALID'
  | 'SOURCE_BUNDLE_INVALID'
  | 'INTERVENTION_INVALID'
  | 'EXTERNAL_EFFECT_DECISION_REQUIRED'
  | 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED'
  | 'EXTERNAL_EFFECT_FRONTIER_INCOMPLETE'
  | 'ARTIFACT_ABSENT'
  | 'ARTIFACT_UNKNOWN'
  | 'ARTIFACT_NOT_REPLAY_SAFE'
  | 'ARTIFACT_DIGEST_MISMATCH'
  | 'MODEL_ONLY_PORT_FAILED'
  | 'PROHIBITED_MODEL_OUTPUT'
  | 'REPLAY_EVIDENCE_CORRUPT'
  | 'REPLAY_ID_CONFLICT';

export class CheckpointReplayError extends Error {
  readonly code: CheckpointReplayErrorCodeV1;

  constructor(code: CheckpointReplayErrorCodeV1, message: string) {
    super(message);
    this.name = 'CheckpointReplayError';
    this.code = code;
  }
}

export interface PlaybackLineageV1 {
  readonly schemaVersion: typeof CHECKPOINT_REPLAY_SCHEMA_VERSION;
  readonly replayId: string;
  readonly lineageId: string;
  readonly mode: 'playback';
  readonly missionId: string;
  readonly parentBranchId: string;
  readonly parentCheckpointId: string;
  readonly sourceEventPrefix: {
    readonly throughSeq: number;
    readonly headHash: string;
    readonly eventRefs: readonly string[];
  };
  readonly createdAt: string;
}

interface BranchReplayLineageCoreV1 {
  readonly schemaVersion: typeof CHECKPOINT_REPLAY_SCHEMA_VERSION;
  readonly replayId: string;
  readonly lineageId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly profileId: string;
  readonly parentAttemptId: string;
  readonly parentBranchId: string;
  readonly childBranchId: string;
  readonly childWorkspaceKey: string;
  readonly parentCheckpointId: string;
  readonly intervention: CheckpointInterventionV1;
  readonly interventionArtifact: ReplayInterventionArtifactV1;
  readonly inheritedExternalEffectFrontier: readonly CheckpointEffectFrontierEntryV1[];
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
  readonly createdAt: string;
}

export interface CachedReplayLineageV1 extends BranchReplayLineageCoreV1 {
  readonly mode: 'cached-replay';
  readonly sourceFuture: CachedReplaySourceBundleV1;
}

export interface CounterfactualResampleLineageV1 extends BranchReplayLineageCoreV1 {
  readonly mode: 'counterfactual-resample';
  readonly cachedContext: CachedContextBundleV1;
}

export type CheckpointReplayLineageV1 =
  | PlaybackLineageV1
  | CachedReplayLineageV1
  | CounterfactualResampleLineageV1;

export interface CheckpointReplayReceiptInputV1 {
  readonly schemaVersion: typeof CHECKPOINT_REPLAY_SCHEMA_VERSION;
  readonly receiptInputId: string;
  readonly replayId: string;
  readonly mode: 'cached-replay' | 'counterfactual-resample';
  readonly missionId: string;
  readonly contractId: string;
  readonly parentBranchId: string;
  readonly childBranchId: string;
  readonly parentCheckpointId: string;
  readonly evidenceRefs: readonly string[];
  readonly unresolvedItems: readonly string[];
  readonly outcome: 'unknown';
  readonly generatedAt: string;
  /** Only the Mission Kernel may evaluate and sign a Receipt. */
  readonly authority: 'receipt-input-not-kernel-state';
}

export type CheckpointReplayFailureV1 = {
  readonly code: CheckpointReplayErrorCodeV1;
  readonly detail: string;
};

export type CheckpointReplayUnknownV1 = {
  readonly code:
    | 'MODEL_RESULT_UNRESOLVED_AFTER_RESTART'
    | 'MODEL_RESULT_UNKNOWN'
    | 'MODEL_ONLY_PORT_OUTCOME_UNKNOWN'
    | 'MODEL_EVIDENCE_ARTIFACT_UNKNOWN';
  readonly detail: string;
};

export type CheckpointReplayEventTypeV1 =
  | 'replay.planned'
  | 'source-prefix.validated'
  | 'source-future.referenced'
  | 'model.started'
  | 'model.evidence'
  | 'model.finished'
  | 'receipt-input.ready'
  | 'replay.completed'
  | 'replay.failed'
  | 'replay.unknown';

export type CheckpointReplayEventPayloadV1 =
  | {
      readonly lineage: CheckpointReplayLineageV1;
      readonly plan: CheckpointOperationPlanV1;
    }
  | { readonly eventRefs: readonly string[]; readonly headHash: string }
  | {
      readonly sourceBundleId: string;
      readonly sourceBundleDigest: string;
      readonly evidenceRefs: readonly string[];
    }
  | { readonly requestDigest: string }
  | { readonly evidence: ModelOnlyEvidenceV1 }
  | {
      readonly responseId: string;
      readonly status: ModelOnlyResampleResultV1['status'];
      readonly evidenceIds: readonly string[];
      readonly unresolvedItems: readonly string[];
    }
  | { readonly receiptInput: CheckpointReplayReceiptInputV1 }
  | { readonly result: 'playback-only' | 'evidence-only' | 'model-only' }
  | CheckpointReplayFailureV1
  | CheckpointReplayUnknownV1;

export interface CheckpointReplayEventDraftV1 {
  readonly replayId: string;
  readonly type: CheckpointReplayEventTypeV1;
  readonly occurredAt: string;
  readonly payload: CheckpointReplayEventPayloadV1;
}

export interface CheckpointReplayEventV1 extends CheckpointReplayEventDraftV1 {
  readonly schemaVersion: typeof CHECKPOINT_REPLAY_SCHEMA_VERSION;
  readonly eventId: string;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly payloadDigest: string;
  readonly eventHash: string;
}

export interface CheckpointReplayJournalV1 {
  append(event: CheckpointReplayEventDraftV1): Promise<CheckpointReplayEventV1>;
  load(replayId: string): Promise<readonly CheckpointReplayEventV1[]>;
}

export type CheckpointReplayPhaseV1 =
  | 'planned'
  | 'source-validated'
  | 'model-running'
  | 'model-finished'
  | 'completed'
  | 'failed'
  | 'unknown';

export interface CheckpointReplayRecordV1 {
  readonly replayId: string;
  readonly mode: CheckpointReplayModeV1;
  readonly phase: CheckpointReplayPhaseV1;
  readonly lineage: CheckpointReplayLineageV1;
  readonly plan: CheckpointOperationPlanV1;
  readonly events: readonly CheckpointReplayEventV1[];
  readonly modelEvidence: readonly ModelOnlyEvidenceV1[];
  readonly modelResult?: {
    readonly responseId: string;
    readonly status: ModelOnlyResampleResultV1['status'];
    readonly evidenceIds: readonly string[];
    readonly unresolvedItems: readonly string[];
  };
  readonly receiptInput?: CheckpointReplayReceiptInputV1;
  readonly failure?: CheckpointReplayFailureV1;
  readonly unknown?: CheckpointReplayUnknownV1;
}

export interface CheckpointPlaybackResultV1 {
  readonly schemaVersion: typeof CHECKPOINT_REPLAY_SCHEMA_VERSION;
  readonly mode: 'playback';
  readonly replayId: string;
  readonly checkpointId: string;
  readonly parentBranchId: string;
  readonly eventPrefix: {
    readonly throughSeq: number;
    readonly headHash: string;
  };
  readonly history: readonly StoredEventV1[];
  readonly createsBranch: false;
  readonly futureEvidenceRefs: readonly [];
  readonly modelExecution: 'none';
  readonly toolExecution: 'none';
  readonly kernelWrite: 'none';
  readonly audit: CheckpointReplayRecordV1;
}

export function createCachedReplaySourceBundle(
  input: CachedReplaySourceBundleInputV1,
): CachedReplaySourceBundleV1 {
  const evidence = normalizeCachedFutureEvidence(
    input.evidence,
    input.sourceEventPrefix.throughSeq,
  );
  const core: CachedReplaySourceBundleCoreV1 = {
    schemaVersion: CHECKPOINT_REPLAY_SOURCE_SCHEMA_VERSION,
    checkpointId: requireIdentifier(input.checkpointId, 'sourceFuture.checkpointId'),
    sourceBranchId: requireIdentifier(input.sourceBranchId, 'sourceFuture.sourceBranchId'),
    sourceEventPrefix: {
      throughSeq: requireNonNegativeInteger(
        input.sourceEventPrefix.throughSeq,
        'sourceFuture.sourceEventPrefix.throughSeq',
      ),
      headHash: requireDigest(input.sourceEventPrefix.headHash, 'sourceFuture.headHash', false),
    },
    evidence,
  };
  const manifestDigest = digest(core);
  return {
    ...core,
    bundleId: `cached-source-${manifestDigest.slice('sha256:'.length)}`,
    manifestDigest,
  };
}

export function verifyCachedReplaySourceBundle(bundle: CachedReplaySourceBundleV1): void {
  const normalized = createCachedReplaySourceBundle({
    checkpointId: bundle.checkpointId,
    sourceBranchId: bundle.sourceBranchId,
    sourceEventPrefix: bundle.sourceEventPrefix,
    evidence: bundle.evidence,
  });
  if (
    bundle.schemaVersion !== CHECKPOINT_REPLAY_SOURCE_SCHEMA_VERSION ||
    bundle.bundleId !== normalized.bundleId ||
    bundle.manifestDigest !== normalized.manifestDigest ||
    canonicalJson(bundle.evidence) !== canonicalJson(normalized.evidence)
  ) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      'Cached source bundle identity does not match its normalized content',
    );
  }
}

export function createCachedContextBundle(
  input: CachedContextBundleInputV1,
): CachedContextBundleV1 {
  const targetDigests = [...input.targetDigests]
    .map((target) => ({
      targetRef: requireNonEmpty(target.targetRef, 'cachedContext.targetRef'),
      contentDigest: requireDigest(
        target.contentDigest,
        `cachedContext target ${target.targetRef}`,
      ),
    }))
    .sort((left, right) => compare(left.targetRef, right.targetRef));
  if (new Set(targetDigests.map((target) => target.targetRef)).size !== targetDigests.length) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      'Cached context target references must be unique',
    );
  }
  const core: CachedContextBundleCoreV1 = {
    schemaVersion: CHECKPOINT_REPLAY_SOURCE_SCHEMA_VERSION,
    checkpointId: requireIdentifier(input.checkpointId, 'cachedContext.checkpointId'),
    contextDigest: requireDigest(input.contextDigest, 'cachedContext.contextDigest'),
    artifactRefs: normalizeArtifactRefs(input.artifactRefs, 'cachedContext.artifactRefs'),
    targetDigests,
    evidenceRefs: normalizeRefs(input.evidenceRefs, 'cachedContext.evidenceRefs'),
  };
  const manifestDigest = digest(core);
  return {
    ...core,
    bundleId: `cached-context-${manifestDigest.slice('sha256:'.length)}`,
    manifestDigest,
  };
}

export function verifyCachedContextBundle(bundle: CachedContextBundleV1): void {
  const normalized = createCachedContextBundle({
    checkpointId: bundle.checkpointId,
    contextDigest: bundle.contextDigest,
    artifactRefs: bundle.artifactRefs,
    targetDigests: bundle.targetDigests,
    evidenceRefs: bundle.evidenceRefs,
  });
  if (
    bundle.schemaVersion !== CHECKPOINT_REPLAY_SOURCE_SCHEMA_VERSION ||
    bundle.bundleId !== normalized.bundleId ||
    bundle.manifestDigest !== normalized.manifestDigest ||
    canonicalJson(bundle) !== canonicalJson(normalized)
  ) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      'Cached context bundle identity does not match its normalized content',
    );
  }
}

/**
 * Hash-chained replay journal. It is operation audit, never authoritative
 * Mission state or a substitute for a Kernel Branch/Receipt event.
 */
export class FileCheckpointReplayJournal implements CheckpointReplayJournalV1 {
  readonly #directory: string;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(directory: string) {
    if (!isAbsolute(directory)) {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        'Checkpoint replay journal directory must be absolute',
      );
    }
    this.#directory = resolve(directory);
  }

  async append(draft: CheckpointReplayEventDraftV1): Promise<CheckpointReplayEventV1> {
    const prior = this.#queues.get(draft.replayId) ?? Promise.resolve();
    let stored!: CheckpointReplayEventV1;
    const operation = prior.then(async () => {
      stored = await this.#appendNow(draft);
    });
    this.#queues.set(
      draft.replayId,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    await operation;
    return stored;
  }

  async load(replayId: string): Promise<readonly CheckpointReplayEventV1[]> {
    requireIdentifier(replayId, 'replayId');
    let text: string;
    try {
      text = await readFile(this.#pathFor(replayId), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    if (text.length === 0) return [];
    if (!text.endsWith('\n')) {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        'Checkpoint replay journal has an incomplete final record',
      );
    }
    const events = text
      .slice(0, -1)
      .split('\n')
      .map((line, index) => {
        try {
          return JSON.parse(line) as CheckpointReplayEventV1;
        } catch {
          throw new CheckpointReplayError(
            'REPLAY_EVIDENCE_CORRUPT',
            `Checkpoint replay journal contains invalid JSON at line ${index + 1}`,
          );
        }
      });
    verifyReplayEventChain(replayId, events);
    return events;
  }

  async #appendNow(draft: CheckpointReplayEventDraftV1): Promise<CheckpointReplayEventV1> {
    requireIdentifier(draft.replayId, 'replayId');
    requireIsoTimestamp(draft.occurredAt, 'occurredAt');
    if (!eventTypes.has(draft.type)) {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        `Unsupported replay event type ${draft.type}`,
      );
    }
    const existing = await this.load(draft.replayId);
    const previous = existing.at(-1);
    const sequence = existing.length + 1;
    const previousHash = previous?.eventHash ?? null;
    const payloadDigest = digest(draft.payload);
    const identityCore = {
      schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
      replayId: draft.replayId,
      type: draft.type,
      occurredAt: draft.occurredAt,
      sequence,
      previousHash,
      payloadDigest,
    };
    const eventId = `checkpoint-replay-event-${digest(identityCore).slice('sha256:'.length)}`;
    const eventCore = { ...identityCore, eventId };
    const event: CheckpointReplayEventV1 = {
      ...eventCore,
      payload: draft.payload,
      eventHash: digest(eventCore),
    };
    verifyNextReplayTransition(existing, event);
    await mkdir(this.#directory, { recursive: true });
    const handle = await open(this.#pathFor(draft.replayId), 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  }

  #pathFor(replayId: string): string {
    return join(this.#directory, `${replayId}.jsonl`);
  }
}

export interface CheckpointReplayServiceOptionsV1 {
  readonly journal: CheckpointReplayJournalV1;
  readonly now?: () => Date;
}

export class CheckpointReplayService {
  readonly #journal: CheckpointReplayJournalV1;
  readonly #now: () => Date;

  constructor(options: CheckpointReplayServiceOptionsV1) {
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date());
  }

  async playback(request: CheckpointPlaybackRequestV1): Promise<CheckpointPlaybackResultV1> {
    if (request.mode !== 'playback') {
      throw new CheckpointReplayError('HISTORY_PREFIX_INVALID', 'Playback mode is required');
    }
    const plan = preparePlaybackPlan(request.checkpoint);
    const history = validateHistoricalPrefix(request.checkpoint, request.history);
    const eventRefs = history.map((event) => `kernel-event:${event.eventId}@${event.hash}`);
    const identity = {
      schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
      mode: 'playback' as const,
      planId: plan.planId,
      checkpointId: request.checkpoint.checkpointId,
      sourceEventPrefix: request.checkpoint.eventPrefix,
      eventRefs,
    };
    const replayId = `checkpoint-playback-${digest(identity).slice('sha256:'.length)}`;
    const lineageId = `checkpoint-replay-lineage-${digest({ replayId, identity }).slice(
      'sha256:'.length,
    )}`;
    const existing = await this.#journal.load(replayId);
    if (existing.length === 0) {
      const lineage: PlaybackLineageV1 = {
        schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
        replayId,
        lineageId,
        mode: 'playback',
        missionId: request.checkpoint.source.missionId,
        parentBranchId: request.checkpoint.source.branchId,
        parentCheckpointId: request.checkpoint.checkpointId,
        sourceEventPrefix: {
          ...request.checkpoint.eventPrefix,
          eventRefs,
        },
        createdAt: this.#timestamp(),
      };
      await this.#append(replayId, 'replay.planned', { lineage, plan });
    } else {
      assertReplayIdentity(existing, 'playback', replayId);
    }

    let record = projectCheckpointReplay(await this.#journal.load(replayId));
    if (record.phase === 'planned') {
      await this.#append(replayId, 'source-prefix.validated', {
        eventRefs,
        headHash: request.checkpoint.eventPrefix.headHash,
      });
      record = projectCheckpointReplay(await this.#journal.load(replayId));
    }
    if (record.phase === 'source-validated' && record.receiptInput === undefined) {
      await this.#append(replayId, 'replay.completed', { result: 'playback-only' });
      record = projectCheckpointReplay(await this.#journal.load(replayId));
    }
    if (record.phase !== 'completed') {
      throw new CheckpointReplayError(
        'REPLAY_ID_CONFLICT',
        `Playback ${replayId} is already terminal as ${record.phase}`,
      );
    }
    return {
      schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
      mode: 'playback',
      replayId,
      checkpointId: request.checkpoint.checkpointId,
      parentBranchId: request.checkpoint.source.branchId,
      eventPrefix: { ...request.checkpoint.eventPrefix },
      history,
      createsBranch: false,
      futureEvidenceRefs: [],
      modelExecution: 'none',
      toolExecution: 'none',
      kernelWrite: 'none',
      audit: record,
    };
  }

  async cachedReplay(
    request: CachedReplayRequestV1,
    artifacts: ReplayArtifactResolverV1,
  ): Promise<CheckpointReplayRecordV1> {
    if (request.mode !== 'cached-replay') {
      throw new CheckpointReplayError('SOURCE_BUNDLE_INVALID', 'Cached replay mode is required');
    }
    verifyCachedReplaySourceBundle(request.sourceFuture);
    assertBundleMatchesCheckpoint(request.sourceFuture, request.checkpoint);
    const prepared = prepareBranchReplay(request);
    assertInterventionSourceDigest(
      prepared.plan.intervention,
      request.sourceFuture.evidence.map((evidence) => ({
        targetRef: evidence.targetRef,
        contentDigest: evidence.contentDigest,
      })),
    );
    await assertArtifactsAvailable(
      [
        request.interventionArtifact,
        ...request.sourceFuture.evidence.flatMap((evidence) => evidence.artifactRefs),
      ],
      artifacts,
    );
    const identity = {
      schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
      mode: 'cached-replay' as const,
      planId: prepared.plan.planId,
      sourceBundleId: request.sourceFuture.bundleId,
      sourceBundleDigest: request.sourceFuture.manifestDigest,
      interventionArtifactDigest: request.interventionArtifact.contentDigest,
    };
    const replayId = `checkpoint-cached-replay-${digest(identity).slice('sha256:'.length)}`;
    const lineageIdentity = branchLineageIdentity(
      replayId,
      'cached-replay',
      request,
      prepared.plan,
    );
    const lineageId = `checkpoint-replay-lineage-${digest(lineageIdentity).slice(
      'sha256:'.length,
    )}`;
    const existing = await this.#journal.load(replayId);
    if (existing.length === 0) {
      const lineage: CachedReplayLineageV1 = {
        ...lineageIdentity,
        lineageId,
        mode: 'cached-replay',
        sourceFuture: request.sourceFuture,
        createdAt: this.#timestamp(),
      };
      await this.#append(replayId, 'replay.planned', { lineage, plan: prepared.plan });
    } else {
      assertReplayIdentity(existing, 'cached-replay', replayId);
    }

    let record = projectCheckpointReplay(await this.#journal.load(replayId));
    if (isTerminal(record.phase)) return record;
    if (record.phase === 'planned') {
      await this.#append(replayId, 'source-future.referenced', {
        sourceBundleId: request.sourceFuture.bundleId,
        sourceBundleDigest: request.sourceFuture.manifestDigest,
        evidenceRefs: cachedEvidenceReferences(request.sourceFuture.evidence),
      });
      record = projectCheckpointReplay(await this.#journal.load(replayId));
    }
    if (record.phase === 'source-validated') {
      const receiptInput = buildCachedReplayReceiptInput(record);
      await this.#append(replayId, 'receipt-input.ready', { receiptInput });
      record = projectCheckpointReplay(await this.#journal.load(replayId));
    }
    if (record.phase === 'model-finished') {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        'Cached replay cannot contain model execution evidence',
      );
    }
    if (record.receiptInput !== undefined && record.phase !== 'completed') {
      await this.#append(replayId, 'replay.completed', { result: 'evidence-only' });
      record = projectCheckpointReplay(await this.#journal.load(replayId));
    }
    return record;
  }

  async counterfactualResample(
    request: CounterfactualResampleRequestV1,
    artifacts: ReplayArtifactResolverV1,
    model: ModelOnlyResamplePortV1,
  ): Promise<CheckpointReplayRecordV1> {
    if (request.mode !== 'counterfactual-resample') {
      throw new CheckpointReplayError(
        'SOURCE_BUNDLE_INVALID',
        'Counterfactual resample mode is required',
      );
    }
    verifyCachedContextBundle(request.cachedContext);
    if (request.cachedContext.checkpointId !== request.checkpoint.checkpointId) {
      throw new CheckpointReplayError(
        'SOURCE_BUNDLE_INVALID',
        'Cached context belongs to another Checkpoint',
      );
    }
    const prepared = prepareBranchReplay(request);
    assertInterventionSourceDigest(prepared.plan.intervention, request.cachedContext.targetDigests);
    await assertArtifactsAvailable(
      [request.interventionArtifact, ...request.cachedContext.artifactRefs],
      artifacts,
    );
    const identity = {
      schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
      mode: 'counterfactual-resample' as const,
      planId: prepared.plan.planId,
      contextBundleId: request.cachedContext.bundleId,
      contextBundleDigest: request.cachedContext.manifestDigest,
      interventionArtifactDigest: request.interventionArtifact.contentDigest,
    };
    const replayId = `checkpoint-counterfactual-${digest(identity).slice('sha256:'.length)}`;
    const lineageIdentity = branchLineageIdentity(
      replayId,
      'counterfactual-resample',
      request,
      prepared.plan,
    );
    const lineageId = `checkpoint-replay-lineage-${digest(lineageIdentity).slice(
      'sha256:'.length,
    )}`;
    const existing = await this.#journal.load(replayId);
    if (existing.length === 0) {
      const lineage: CounterfactualResampleLineageV1 = {
        ...lineageIdentity,
        lineageId,
        mode: 'counterfactual-resample',
        cachedContext: request.cachedContext,
        createdAt: this.#timestamp(),
      };
      await this.#append(replayId, 'replay.planned', { lineage, plan: prepared.plan });
    } else {
      assertReplayIdentity(existing, 'counterfactual-resample', replayId);
    }

    let record = projectCheckpointReplay(await this.#journal.load(replayId));
    if (isTerminal(record.phase)) return record;
    if (record.phase === 'model-running') {
      await this.#append(replayId, 'replay.unknown', {
        code: 'MODEL_RESULT_UNRESOLVED_AFTER_RESTART',
        detail:
          'A durable model-only start has no terminal result; restart recovery will not resample again blindly.',
      });
      return projectCheckpointReplay(await this.#journal.load(replayId));
    }
    if (record.phase === 'model-finished') {
      return this.#finishCounterfactual(record);
    }
    if (record.phase !== 'planned') {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        `Counterfactual replay cannot continue from ${record.phase}`,
      );
    }

    const requestDigest = digest({
      replayId,
      cachedContext: request.cachedContext.manifestDigest,
      intervention: prepared.plan.intervention,
      interventionArtifact: request.interventionArtifact.contentDigest,
      inheritedExternalEffectFrontier: prepared.plan.inheritedExternalEffectFrontier,
      externalEffectDecisions: prepared.plan.externalEffectDecisions,
      liveToolAccess: 'forbidden',
      liveWorkspaceAccess: 'forbidden',
    });
    await this.#append(replayId, 'model.started', { requestDigest });

    let result: ModelOnlyResampleResultV1;
    try {
      result = normalizeModelOnlyResult(
        await model.resample({
          replayId,
          missionId: request.checkpoint.source.missionId,
          contractId: request.checkpoint.source.contractId,
          parentBranchId: request.checkpoint.source.branchId,
          childBranchId: prepared.plan.childBranchId,
          parentCheckpointId: request.checkpoint.checkpointId,
          cachedContext: request.cachedContext,
          intervention: prepared.plan.intervention,
          interventionArtifact: request.interventionArtifact,
          inheritedExternalEffectFrontier: cloneFrontier(
            prepared.plan.inheritedExternalEffectFrontier,
          ),
          externalEffectDecisions: prepared.plan.externalEffectDecisions.map((decision) => ({
            ...decision,
          })),
          liveToolAccess: 'forbidden',
          liveWorkspaceAccess: 'forbidden',
        }),
      );
      assertNoProhibitedModelEvidence(result);
      await assertArtifactsAvailable(
        result.modelEvidence.flatMap((evidence) => evidence.artifactRefs),
        artifacts,
      );
    } catch (error) {
      if (!(error instanceof CheckpointReplayError) || error.code === 'ARTIFACT_UNKNOWN') {
        await this.#append(replayId, 'replay.unknown', {
          code:
            error instanceof CheckpointReplayError
              ? 'MODEL_EVIDENCE_ARTIFACT_UNKNOWN'
              : 'MODEL_ONLY_PORT_OUTCOME_UNKNOWN',
          detail:
            error instanceof CheckpointReplayError
              ? 'Model evidence Artifact availability is unknown.'
              : 'Model-only execution started but did not return a trustworthy terminal result.',
        });
        return projectCheckpointReplay(await this.#journal.load(replayId));
      }
      const normalized = normalizeModelFailure(error);
      await this.#append(replayId, 'replay.failed', normalized);
      throw error;
    }

    for (const evidence of result.modelEvidence) {
      await this.#append(replayId, 'model.evidence', { evidence });
    }
    await this.#append(replayId, 'model.finished', {
      responseId: result.responseId,
      status: result.status,
      evidenceIds: result.modelEvidence.map((evidence) => evidence.evidenceId),
      unresolvedItems: result.unresolvedItems,
    });
    record = projectCheckpointReplay(await this.#journal.load(replayId));
    return this.#finishCounterfactual(record);
  }

  async inspect(replayId: string): Promise<CheckpointReplayRecordV1 | null> {
    const events = await this.#journal.load(replayId);
    return events.length === 0 ? null : projectCheckpointReplay(events);
  }

  async #finishCounterfactual(
    initial: CheckpointReplayRecordV1,
  ): Promise<CheckpointReplayRecordV1> {
    let record = initial;
    if (record.modelResult === undefined) {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        'Counterfactual replay has no model-only terminal result',
      );
    }
    if (record.modelResult.status === 'failed') {
      await this.#append(record.replayId, 'replay.failed', {
        code: 'MODEL_ONLY_PORT_FAILED',
        detail: 'Model-only resampling returned a definite failed result.',
      });
      return projectCheckpointReplay(await this.#journal.load(record.replayId));
    }
    const modelStatus = record.modelResult.status;
    if (record.receiptInput === undefined) {
      await this.#append(record.replayId, 'receipt-input.ready', {
        receiptInput: buildCounterfactualReceiptInput(record),
      });
      record = projectCheckpointReplay(await this.#journal.load(record.replayId));
    }
    if (modelStatus === 'unknown') {
      await this.#append(record.replayId, 'replay.unknown', {
        code: 'MODEL_RESULT_UNKNOWN',
        detail: 'Model-only resampling returned evidence but no trustworthy terminal result.',
      });
    } else {
      await this.#append(record.replayId, 'replay.completed', { result: 'model-only' });
    }
    return projectCheckpointReplay(await this.#journal.load(record.replayId));
  }

  async #append(
    replayId: string,
    type: CheckpointReplayEventTypeV1,
    payload: CheckpointReplayEventPayloadV1,
  ): Promise<CheckpointReplayEventV1> {
    return this.#journal.append({ replayId, type, occurredAt: this.#timestamp(), payload });
  }

  #timestamp(): string {
    return requireIsoTimestamp(this.#now().toISOString(), 'now');
  }
}

export function projectCheckpointReplay(
  events: readonly CheckpointReplayEventV1[],
): CheckpointReplayRecordV1 {
  if (events.length === 0) {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'Cannot project an empty Checkpoint replay journal',
    );
  }
  const replayId = events[0]?.replayId ?? '';
  verifyReplayEventChain(replayId, events);
  for (let index = 0; index < events.length; index += 1) {
    verifyNextReplayTransition(events.slice(0, index), events[index]!);
  }
  const planned = events[0];
  if (planned?.type !== 'replay.planned') {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'Replay journal must start with immutable lineage',
    );
  }
  const plannedPayload = planned.payload as {
    readonly lineage: CheckpointReplayLineageV1;
    readonly plan: CheckpointOperationPlanV1;
  };
  if (
    plannedPayload.lineage.replayId !== replayId ||
    plannedPayload.lineage.mode !== plannedPayload.plan.mode
  ) {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'Replay lineage, plan, and journal identity disagree',
    );
  }

  let phase: CheckpointReplayPhaseV1 = 'planned';
  const modelEvidence: ModelOnlyEvidenceV1[] = [];
  let modelResult: CheckpointReplayRecordV1['modelResult'];
  let receiptInput: CheckpointReplayReceiptInputV1 | undefined;
  let failure: CheckpointReplayFailureV1 | undefined;
  let unknown: CheckpointReplayUnknownV1 | undefined;

  for (const event of events.slice(1)) {
    switch (event.type) {
      case 'source-prefix.validated':
      case 'source-future.referenced':
        phase = 'source-validated';
        break;
      case 'model.started':
        phase = 'model-running';
        break;
      case 'model.evidence':
        modelEvidence.push((event.payload as { readonly evidence: ModelOnlyEvidenceV1 }).evidence);
        break;
      case 'model.finished': {
        const payload = event.payload as NonNullable<CheckpointReplayRecordV1['modelResult']>;
        modelResult = {
          responseId: payload.responseId,
          status: payload.status,
          evidenceIds: [...payload.evidenceIds],
          unresolvedItems: [...payload.unresolvedItems],
        };
        phase = 'model-finished';
        break;
      }
      case 'receipt-input.ready':
        receiptInput = (event.payload as { readonly receiptInput: CheckpointReplayReceiptInputV1 })
          .receiptInput;
        break;
      case 'replay.completed':
        phase = 'completed';
        break;
      case 'replay.failed':
        failure = event.payload as CheckpointReplayFailureV1;
        phase = 'failed';
        break;
      case 'replay.unknown':
        unknown = event.payload as CheckpointReplayUnknownV1;
        phase = 'unknown';
        break;
      default:
        break;
    }
  }

  return {
    replayId,
    mode: plannedPayload.lineage.mode,
    phase,
    lineage: plannedPayload.lineage,
    plan: plannedPayload.plan,
    events: [...events],
    modelEvidence,
    ...(modelResult === undefined ? {} : { modelResult }),
    ...(receiptInput === undefined ? {} : { receiptInput }),
    ...(failure === undefined ? {} : { failure }),
    ...(unknown === undefined ? {} : { unknown }),
  };
}

function preparePlaybackPlan(checkpoint: CompositeCheckpointManifestV1): PlaybackPlanV1 {
  assertCheckpointComplete(checkpoint, false);
  const planned = callCheckpointPlanner({ mode: 'playback', checkpoint });
  if (planned.mode !== 'playback') {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'Checkpoint planner returned a branching plan for playback',
    );
  }
  return planned;
}

function prepareBranchReplay(request: CachedReplayRequestV1 | CounterfactualResampleRequestV1): {
  readonly plan: BranchingCheckpointPlanV1;
} {
  assertCheckpointComplete(request.checkpoint, true);
  assertExternalFrontierComplete(request.checkpoint);
  assertSingleIntervention(request.intervention, request.interventionArtifact);
  const childBranchId = requireIdentifier(request.childBranchId, 'childBranchId');
  const childWorkspaceKey = requireIdentifier(request.childWorkspaceKey, 'childWorkspaceKey');
  if (childWorkspaceKey === request.checkpoint.source.workspaceKey) {
    throw new CheckpointReplayError(
      'CHECKPOINT_INCOMPLETE',
      'Replay child must use a distinct logical workspace identity',
    );
  }
  const workspaceDigest = requireHash(
    request.checkpoint.workspace.workspaceDigest ?? '',
    'checkpoint.workspace.workspaceDigest',
  );
  const logicalIsolationId = digest({
    checkpointId: request.checkpoint.checkpointId,
    childBranchId,
    childWorkspaceKey,
    mode: request.mode,
  }).slice('sha256:'.length);
  const plan = callCheckpointPlanner({
    mode: request.mode,
    checkpoint: request.checkpoint,
    childBranchId,
    intervention: request.intervention,
    isolatedWorktree: {
      worktreeId: `read-only-replay-${logicalIsolationId}`,
      workspaceKey: childWorkspaceKey,
      absolutePath: resolve('/.missionbraid-read-only-replay', logicalIsolationId),
      isolationMechanism: 'copy-on-write',
      baselineWorkspaceDigest: workspaceDigest,
      evidenceRefs: [`checkpoint:${request.checkpoint.checkpointId}`],
    },
    externalEffectDecisions: request.externalEffectDecisions,
  });
  if (plan.mode === 'playback' || plan.mode === 'execution-fork') {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      `Checkpoint planner returned ${plan.mode} for ${request.mode}`,
    );
  }
  assertExactConfirmedEffectDecisions(plan);
  return { plan };
}

function callCheckpointPlanner(
  request: Parameters<typeof planCheckpointOperation>[0],
): CheckpointOperationPlanV1 {
  try {
    const planned = planCheckpointOperation(request);
    if (planned.ok) return planned.plan;
    const code =
      planned.blocker.code === 'EXTERNAL_EFFECT_DECISION_REQUIRED'
        ? 'EXTERNAL_EFFECT_DECISION_REQUIRED'
        : planned.blocker.code === 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED'
          ? 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED'
          : 'CHECKPOINT_INCOMPLETE';
    throw new CheckpointReplayError(code, planned.blocker.detail);
  } catch (error) {
    if (error instanceof CheckpointReplayError) throw error;
    throw new CheckpointReplayError(
      'CHECKPOINT_INVALID',
      error instanceof Error ? error.message : 'Checkpoint planner rejected invalid input',
    );
  }
}

function assertCheckpointComplete(
  checkpoint: CompositeCheckpointManifestV1,
  requireRestorableWorkspace: boolean,
): void {
  try {
    verifyCompositeCheckpoint(checkpoint);
  } catch (error) {
    throw new CheckpointReplayError(
      'CHECKPOINT_INVALID',
      error instanceof Error ? error.message : 'Composite Checkpoint integrity is invalid',
    );
  }
  if (checkpoint.schemaVersion !== 'missionbraid.dev/composite-checkpoint/v1') {
    throw new CheckpointReplayError(
      'CHECKPOINT_INVALID',
      'Unsupported Composite Checkpoint schema version',
    );
  }
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
    throw new CheckpointReplayError(
      'CHECKPOINT_INCOMPLETE',
      'Replay requires every Composite Checkpoint component exactly once',
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
    'permissions',
    'effect-frontier',
    'process',
  ] as const) {
    if (
      checkpoint.components.find((component) => component.component === required)?.disposition ===
      'unavailable'
    ) {
      throw new CheckpointReplayError(
        'CHECKPOINT_INCOMPLETE',
        `Replay cannot use unavailable ${required} state`,
      );
    }
  }
  if (checkpoint.workspace.state === 'unavailable') {
    throw new CheckpointReplayError(
      'CHECKPOINT_INCOMPLETE',
      'Replay requires observed workspace state',
    );
  }
  if (
    requireRestorableWorkspace &&
    (checkpoint.workspace.state !== 'restorable-artifact' ||
      checkpoint.components.find((component) => component.component === 'workspace')
        ?.disposition !== 'recoverable')
  ) {
    throw new CheckpointReplayError(
      'CHECKPOINT_INCOMPLETE',
      'Branch-producing replay requires a recoverable workspace artifact',
    );
  }
  if (checkpoint.process.status !== 'stopped') {
    throw new CheckpointReplayError(
      'CHECKPOINT_INCOMPLETE',
      'Replay requires a stopped Runtime process boundary',
    );
  }
}

function assertExternalFrontierComplete(checkpoint: CompositeCheckpointManifestV1): void {
  for (const effect of checkpoint.externalEffectFrontier) {
    if (
      effect.scope === 'unknown' ||
      effect.controlLevel === 'unknown' ||
      effect.evidenceRefs.length === 0
    ) {
      throw new CheckpointReplayError(
        'EXTERNAL_EFFECT_FRONTIER_INCOMPLETE',
        `External Effect ${effect.effectId} lacks exact scope, control, or evidence`,
      );
    }
    if (
      effect.status === 'confirmed' &&
      (effect.authorityRef === undefined || effect.idempotencyKey === undefined)
    ) {
      throw new CheckpointReplayError(
        'EXTERNAL_EFFECT_FRONTIER_INCOMPLETE',
        `Confirmed external Effect ${effect.effectId} lacks authority or idempotency identity`,
      );
    }
  }
}

function assertExactConfirmedEffectDecisions(plan: BranchingCheckpointPlanV1): void {
  const expected = plan.inheritedExternalEffectFrontier
    .filter((effect) => effect.status === 'confirmed')
    .map((effect) => effect.effectId)
    .sort(compare);
  const actual = plan.externalEffectDecisions.map((decision) => decision.effectId).sort(compare);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new CheckpointReplayError(
      'EXTERNAL_EFFECT_DECISION_REQUIRED',
      'Replay decisions must exactly match confirmed external Effects as inherit-no-repeat',
    );
  }
}

function validateHistoricalPrefix(
  checkpoint: CompositeCheckpointManifestV1,
  history: readonly StoredEventV1[],
): StoredEventV1[] {
  const sorted = [...history].sort((left, right) => left.seq - right.seq);
  if (sorted.length !== checkpoint.eventPrefix.throughSeq) {
    throw new CheckpointReplayError(
      'HISTORY_PREFIX_INVALID',
      'Playback history does not contain the complete Checkpoint event prefix',
    );
  }
  let previousHash: string | null = null;
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index]!;
    const expectedSequence = index + 1;
    if (
      event.seq !== expectedSequence ||
      event.missionId !== checkpoint.source.missionId ||
      event.prevHash !== previousHash
    ) {
      throw new CheckpointReplayError(
        'HISTORY_PREFIX_INVALID',
        `Playback history is not the exact Mission prefix at sequence ${expectedSequence}`,
      );
    }
    const payloadHash = hashPayload(event.payload);
    const eventHash = computeEventHash({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      missionId: event.missionId,
      attemptId: event.attemptId ?? null,
      seq: event.seq,
      type: event.type,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      payloadHash,
      prevHash: event.prevHash,
    });
    if (payloadHash !== event.payloadHash || eventHash !== event.hash) {
      throw new CheckpointReplayError(
        'HISTORY_PREFIX_INVALID',
        `Playback history content hash is invalid at sequence ${event.seq}`,
      );
    }
    previousHash = event.hash;
  }
  if (previousHash !== checkpoint.eventPrefix.headHash) {
    throw new CheckpointReplayError(
      'HISTORY_PREFIX_INVALID',
      'Playback history head does not match the Composite Checkpoint',
    );
  }
  return sorted.map((event) => ({ ...event }));
}

function assertBundleMatchesCheckpoint(
  bundle: CachedReplaySourceBundleV1,
  checkpoint: CompositeCheckpointManifestV1,
): void {
  if (
    bundle.checkpointId !== checkpoint.checkpointId ||
    bundle.sourceBranchId !== checkpoint.source.branchId ||
    bundle.sourceEventPrefix.throughSeq !== checkpoint.eventPrefix.throughSeq ||
    bundle.sourceEventPrefix.headHash !== checkpoint.eventPrefix.headHash
  ) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      'Cached source future is not bound to the supplied Checkpoint prefix',
    );
  }
}

function assertSingleIntervention(
  intervention: CheckpointInterventionV1,
  artifact: ReplayInterventionArtifactV1,
): void {
  if (intervention === null || typeof intervention !== 'object' || Array.isArray(intervention)) {
    throw new CheckpointReplayError(
      'INTERVENTION_INVALID',
      'Replay requires exactly one scalar Intervention',
    );
  }
  if (artifact.targetRef !== intervention.targetRef) {
    throw new CheckpointReplayError(
      'INTERVENTION_INVALID',
      'Intervention Artifact target does not match the declared Intervention',
    );
  }
  if (artifact.contentDigest !== intervention.afterDigest) {
    throw new CheckpointReplayError(
      'INTERVENTION_INVALID',
      'Intervention Artifact does not match the declared afterDigest',
    );
  }
  normalizeArtifactRef(artifact, 'interventionArtifact');
}

function assertInterventionSourceDigest(
  intervention: CheckpointInterventionV1,
  targets: readonly { readonly targetRef: string; readonly contentDigest: string }[],
): void {
  if (intervention.beforeDigest === undefined) return;
  const matches = targets.filter(
    (target) =>
      target.targetRef === intervention.targetRef &&
      target.contentDigest === intervention.beforeDigest,
  );
  if (matches.length !== 1) {
    throw new CheckpointReplayError(
      'INTERVENTION_INVALID',
      'Intervention beforeDigest must match exactly one cached source target',
    );
  }
}

async function assertArtifactsAvailable(
  references: readonly ReplayArtifactRefV1[],
  resolver: ReplayArtifactResolverV1,
): Promise<void> {
  const normalized = normalizeArtifactRefs(references, 'replay.artifacts');
  for (const reference of normalized) {
    if (reference.fidelity !== 'exact-replay-safe') {
      throw new CheckpointReplayError(
        'ARTIFACT_NOT_REPLAY_SAFE',
        `Artifact ${reference.artifactId} is ${reference.fidelity}, not exact-replay-safe`,
      );
    }
    const resolution = await resolver.resolve(reference);
    if (resolution.status === 'absent') {
      throw new CheckpointReplayError(
        'ARTIFACT_ABSENT',
        `Artifact ${reference.artifactId} is absent from persisted storage`,
      );
    }
    if (resolution.status === 'unknown') {
      throw new CheckpointReplayError(
        'ARTIFACT_UNKNOWN',
        `Artifact ${reference.artifactId} availability is unknown`,
      );
    }
    if (
      resolution.contentDigest !== reference.contentDigest ||
      resolution.fidelity !== reference.fidelity
    ) {
      throw new CheckpointReplayError(
        'ARTIFACT_DIGEST_MISMATCH',
        `Artifact ${reference.artifactId} resolution does not match its persisted reference`,
      );
    }
  }
}

function branchLineageIdentity(
  replayId: string,
  mode: 'cached-replay' | 'counterfactual-resample',
  request: CachedReplayRequestV1 | CounterfactualResampleRequestV1,
  plan: BranchingCheckpointPlanV1,
): Omit<BranchReplayLineageCoreV1, 'lineageId' | 'createdAt'> & {
  readonly mode: 'cached-replay' | 'counterfactual-resample';
} {
  return {
    schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
    replayId,
    mode,
    missionId: request.checkpoint.source.missionId,
    contractId: request.checkpoint.source.contractId,
    profileId: request.checkpoint.source.profileId,
    parentAttemptId: request.checkpoint.source.attemptId,
    parentBranchId: request.checkpoint.source.branchId,
    childBranchId: plan.childBranchId,
    childWorkspaceKey: request.childWorkspaceKey,
    parentCheckpointId: request.checkpoint.checkpointId,
    intervention: cloneIntervention(plan.intervention),
    interventionArtifact: normalizeInterventionArtifact(request.interventionArtifact),
    inheritedExternalEffectFrontier: cloneFrontier(plan.inheritedExternalEffectFrontier),
    externalEffectDecisions: plan.externalEffectDecisions.map((decision) => ({ ...decision })),
  };
}

function buildCachedReplayReceiptInput(
  record: CheckpointReplayRecordV1,
): CheckpointReplayReceiptInputV1 {
  if (record.lineage.mode !== 'cached-replay') {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'Cached Receipt input requires cached replay lineage',
    );
  }
  const evidenceRefs = uniqueSorted([
    ...cachedEvidenceReferences(record.lineage.sourceFuture.evidence),
    ...record.events.map((event) => `replay-event:${event.eventId}`),
  ]);
  const unresolvedItems = uniqueSorted([
    'child-branch-requires-independent-verification',
    'cached-evidence-was-referenced-not-reexecuted',
    ...record.lineage.sourceFuture.evidence
      .filter((evidence) => evidence.status !== 'observed')
      .map((evidence) => `source-evidence:${evidence.evidenceId}:${evidence.status}`),
  ]);
  return receiptInput(record, evidenceRefs, unresolvedItems, record.lineage.createdAt);
}

function buildCounterfactualReceiptInput(
  record: CheckpointReplayRecordV1,
): CheckpointReplayReceiptInputV1 {
  if (record.lineage.mode !== 'counterfactual-resample' || record.modelResult === undefined) {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'Counterfactual Receipt input requires model-only evidence',
    );
  }
  const evidenceRefs = uniqueSorted([
    ...record.modelEvidence.flatMap((evidence) => evidenceArtifactReferences(evidence)),
    ...record.events.map((event) => `replay-event:${event.eventId}`),
  ]);
  const unresolvedItems = uniqueSorted([
    'child-branch-requires-independent-verification',
    'model-only-resample-did-not-run-live-tools-or-workspace',
    ...record.modelResult.unresolvedItems,
  ]);
  return receiptInput(record, evidenceRefs, unresolvedItems, record.lineage.createdAt);
}

function receiptInput(
  record: CheckpointReplayRecordV1,
  evidenceRefs: readonly string[],
  unresolvedItems: readonly string[],
  generatedAt: string,
): CheckpointReplayReceiptInputV1 {
  if (record.lineage.mode === 'playback') {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'Playback cannot create Receipt input',
    );
  }
  const core = {
    schemaVersion: CHECKPOINT_REPLAY_SCHEMA_VERSION,
    replayId: record.replayId,
    mode: record.lineage.mode,
    missionId: record.lineage.missionId,
    contractId: record.lineage.contractId,
    parentBranchId: record.lineage.parentBranchId,
    childBranchId: record.lineage.childBranchId,
    parentCheckpointId: record.lineage.parentCheckpointId,
    evidenceRefs: uniqueSorted(evidenceRefs),
    unresolvedItems: uniqueSorted(unresolvedItems),
    outcome: 'unknown' as const,
    generatedAt,
    authority: 'receipt-input-not-kernel-state' as const,
  };
  return {
    ...core,
    receiptInputId: `checkpoint-replay-receipt-input-${digest(core).slice('sha256:'.length)}`,
  };
}

function normalizeModelOnlyResult(result: ModelOnlyResampleResultV1): ModelOnlyResampleResultV1 {
  if (!['completed', 'failed', 'unknown'].includes(result.status)) {
    throw new CheckpointReplayError(
      'MODEL_ONLY_PORT_FAILED',
      `Unsupported model-only result status ${String(result.status)}`,
    );
  }
  const modelEvidence = [...result.modelEvidence]
    .map(normalizeModelEvidence)
    .sort((left, right) => compare(left.evidenceId, right.evidenceId));
  if (new Set(modelEvidence.map((evidence) => evidence.evidenceId)).size !== modelEvidence.length) {
    throw new CheckpointReplayError(
      'MODEL_ONLY_PORT_FAILED',
      'Model-only evidence identities must be unique',
    );
  }
  if (
    result.status === 'completed' &&
    !modelEvidence.some((evidence) => evidence.kind === 'model-output')
  ) {
    throw new CheckpointReplayError(
      'MODEL_ONLY_PORT_FAILED',
      'Completed model-only resampling requires persisted model-output evidence',
    );
  }
  const unresolvedItems = uniqueSorted(
    result.unresolvedItems.map((item) => requireNonEmpty(item, 'model.unresolvedItem')),
  );
  return {
    responseId: requireIdentifier(result.responseId, 'model.responseId'),
    status: result.status,
    modelEvidence,
    toolRequestEvidenceRefs: uniqueSorted(
      result.toolRequestEvidenceRefs.map((reference) =>
        requireNonEmpty(reference, 'model.toolRequestEvidenceRef'),
      ),
    ),
    effectEvidenceRefs: uniqueSorted(
      result.effectEvidenceRefs.map((reference) =>
        requireNonEmpty(reference, 'model.effectEvidenceRef'),
      ),
    ),
    workspaceEvidenceRefs: uniqueSorted(
      result.workspaceEvidenceRefs.map((reference) =>
        requireNonEmpty(reference, 'model.workspaceEvidenceRef'),
      ),
    ),
    unresolvedItems:
      result.status === 'unknown' && unresolvedItems.length === 0
        ? ['model-only-port-reported-unknown']
        : unresolvedItems,
  };
}

function normalizeModelEvidence(evidence: ModelOnlyEvidenceV1): ModelOnlyEvidenceV1 {
  if (!modelEvidenceKinds.has(evidence.kind)) {
    throw new CheckpointReplayError(
      'PROHIBITED_MODEL_OUTPUT',
      `Model-only port returned prohibited evidence kind ${String(evidence.kind)}`,
    );
  }
  return {
    evidenceId: requireIdentifier(evidence.evidenceId, 'model.evidenceId'),
    kind: evidence.kind,
    observedAt: requireIsoTimestamp(evidence.observedAt, 'model.observedAt'),
    contentDigest: requireDigest(evidence.contentDigest, 'model.contentDigest'),
    artifactRefs: normalizeArtifactRefs(evidence.artifactRefs, 'model.artifactRefs'),
    evidenceRefs: normalizeRefs(evidence.evidenceRefs, 'model.evidenceRefs'),
  };
}

function assertNoProhibitedModelEvidence(result: ModelOnlyResampleResultV1): void {
  if (
    result.toolRequestEvidenceRefs.length > 0 ||
    result.effectEvidenceRefs.length > 0 ||
    result.workspaceEvidenceRefs.length > 0
  ) {
    throw new CheckpointReplayError(
      'PROHIBITED_MODEL_OUTPUT',
      'Counterfactual resampling returned tool-request, Effect, or workspace evidence',
    );
  }
}

function normalizeModelFailure(error: unknown): CheckpointReplayFailureV1 {
  if (error instanceof CheckpointReplayError) {
    return { code: error.code, detail: error.message };
  }
  return {
    code: 'MODEL_ONLY_PORT_FAILED',
    detail: 'Model-only port failed without a trustworthy terminal result.',
  };
}

function normalizeCachedFutureEvidence(
  evidence: readonly CachedFutureEvidenceV1[],
  throughSeq: number,
): CachedFutureEvidenceV1[] {
  const normalized = [...evidence]
    .map((candidate): CachedFutureEvidenceV1 => {
      if (!cachedEvidenceKinds.has(candidate.kind)) {
        throw new CheckpointReplayError(
          'SOURCE_BUNDLE_INVALID',
          `Unsupported cached evidence kind ${String(candidate.kind)}`,
        );
      }
      if (!['observed', 'failed', 'unknown'].includes(candidate.status)) {
        throw new CheckpointReplayError(
          'SOURCE_BUNDLE_INVALID',
          `Unsupported cached evidence status ${String(candidate.status)}`,
        );
      }
      const sourceSequence = requirePositiveInteger(
        candidate.sourceSequence,
        'cachedEvidence.sourceSequence',
      );
      if (sourceSequence <= throughSeq) {
        throw new CheckpointReplayError(
          'SOURCE_BUNDLE_INVALID',
          'Cached source-future evidence must occur after the Checkpoint prefix',
        );
      }
      const requestDigest =
        candidate.requestDigest === undefined
          ? undefined
          : requireDigest(candidate.requestDigest, 'cachedEvidence.requestDigest');
      return {
        evidenceId: requireIdentifier(candidate.evidenceId, 'cachedEvidence.evidenceId'),
        sourceSequence,
        kind: candidate.kind,
        status: candidate.status,
        targetRef: requireNonEmpty(candidate.targetRef, 'cachedEvidence.targetRef'),
        contentDigest: requireDigest(candidate.contentDigest, 'cachedEvidence.contentDigest'),
        artifactRefs: normalizeArtifactRefs(candidate.artifactRefs, 'cachedEvidence.artifactRefs'),
        evidenceRefs: normalizeRefs(candidate.evidenceRefs, 'cachedEvidence.evidenceRefs'),
        ...(requestDigest === undefined ? {} : { requestDigest }),
      };
    })
    .sort(
      (left, right) =>
        left.sourceSequence - right.sourceSequence || compare(left.evidenceId, right.evidenceId),
    );
  if (normalized.length === 0) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      'Cached replay requires persisted source-future evidence',
    );
  }
  if (
    new Set(normalized.map((candidate) => candidate.evidenceId)).size !== normalized.length ||
    new Set(normalized.map((candidate) => candidate.sourceSequence)).size !== normalized.length
  ) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      'Cached source-future evidence identities and sequences must be unique',
    );
  }
  return normalized;
}

function normalizeArtifactRefs(
  references: readonly ReplayArtifactRefV1[],
  path: string,
): ReplayArtifactRefV1[] {
  const normalized = [...references]
    .map((reference, index) => normalizeArtifactRef(reference, `${path}[${index}]`))
    .sort(
      (left, right) =>
        compare(left.contentDigest, right.contentDigest) ||
        compare(left.artifactId, right.artifactId),
    );
  if (normalized.length === 0) {
    throw new CheckpointReplayError('SOURCE_BUNDLE_INVALID', `${path} must not be empty`);
  }
  if (new Set(normalized.map((reference) => reference.artifactId)).size !== normalized.length) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      `${path} contains duplicate Artifact identities`,
    );
  }
  return normalized;
}

function normalizeArtifactRef(reference: ReplayArtifactRefV1, path: string): ReplayArtifactRefV1 {
  if (!artifactFidelities.has(reference.fidelity)) {
    throw new CheckpointReplayError('SOURCE_BUNDLE_INVALID', `${path}.fidelity is unsupported`);
  }
  return {
    artifactId: requireIdentifier(reference.artifactId, `${path}.artifactId`),
    contentDigest: requireDigest(reference.contentDigest, `${path}.contentDigest`),
    fidelity: reference.fidelity,
    evidenceRefs: normalizeRefs(reference.evidenceRefs, `${path}.evidenceRefs`),
  };
}

function normalizeInterventionArtifact(
  artifact: ReplayInterventionArtifactV1,
): ReplayInterventionArtifactV1 {
  return {
    ...normalizeArtifactRef(artifact, 'interventionArtifact'),
    targetRef: requireNonEmpty(artifact.targetRef, 'interventionArtifact.targetRef'),
  };
}

function cachedEvidenceReferences(evidence: readonly CachedFutureEvidenceV1[]): string[] {
  return uniqueSorted(
    evidence.flatMap((candidate) => [
      `cached-evidence:${candidate.evidenceId}@${candidate.contentDigest}`,
      ...candidate.artifactRefs.map(
        (artifact) => `artifact:${artifact.artifactId}@${artifact.contentDigest}`,
      ),
      ...candidate.evidenceRefs,
    ]),
  );
}

function evidenceArtifactReferences(evidence: ModelOnlyEvidenceV1): string[] {
  return uniqueSorted([
    `model-evidence:${evidence.evidenceId}@${evidence.contentDigest}`,
    ...evidence.artifactRefs.map(
      (artifact) => `artifact:${artifact.artifactId}@${artifact.contentDigest}`,
    ),
    ...evidence.evidenceRefs,
  ]);
}

function verifyReplayEventChain(
  replayId: string,
  events: readonly CheckpointReplayEventV1[],
): void {
  let previousHash: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (
      event.schemaVersion !== CHECKPOINT_REPLAY_SCHEMA_VERSION ||
      event.replayId !== replayId ||
      event.sequence !== index + 1 ||
      event.previousHash !== previousHash ||
      !eventTypes.has(event.type)
    ) {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        `Checkpoint replay journal identity is invalid at sequence ${index + 1}`,
      );
    }
    const payloadDigest = digest(event.payload);
    const identityCore = {
      schemaVersion: event.schemaVersion,
      replayId: event.replayId,
      type: event.type,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      previousHash: event.previousHash,
      payloadDigest,
    };
    const eventId = `checkpoint-replay-event-${digest(identityCore).slice('sha256:'.length)}`;
    const eventHash = digest({ ...identityCore, eventId });
    if (
      payloadDigest !== event.payloadDigest ||
      eventId !== event.eventId ||
      eventHash !== event.eventHash
    ) {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        `Checkpoint replay content hash is invalid at sequence ${event.sequence}`,
      );
    }
    previousHash = event.eventHash;
  }
}

function verifyNextReplayTransition(
  prior: readonly CheckpointReplayEventV1[],
  next: CheckpointReplayEventV1,
): void {
  if (prior.length === 0) {
    if (next.type !== 'replay.planned') {
      throw new CheckpointReplayError(
        'REPLAY_EVIDENCE_CORRUPT',
        'Replay journal must begin with replay.planned',
      );
    }
    validatePlannedPayload(next);
    return;
  }
  const record = projectCheckpointReplayWithoutTransitionRecheck(prior);
  if (isTerminal(record.phase)) {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      `Replay journal cannot append ${next.type} after terminal ${record.phase}`,
    );
  }
  const allowed = allowedTransitions(record);
  if (!allowed.has(next.type)) {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      `Replay ${record.mode} cannot append ${next.type} from ${record.phase}`,
    );
  }
  validateEventPayload(next, record);
}

function projectCheckpointReplayWithoutTransitionRecheck(
  events: readonly CheckpointReplayEventV1[],
): CheckpointReplayRecordV1 {
  verifyReplayEventChain(events[0]?.replayId ?? '', events);
  const planned = events[0];
  if (planned?.type !== 'replay.planned') {
    throw new CheckpointReplayError('REPLAY_EVIDENCE_CORRUPT', 'Replay lineage is absent');
  }
  const plannedPayload = planned.payload as {
    readonly lineage: CheckpointReplayLineageV1;
    readonly plan: CheckpointOperationPlanV1;
  };
  let phase: CheckpointReplayPhaseV1 = 'planned';
  const modelEvidence: ModelOnlyEvidenceV1[] = [];
  let modelResult: CheckpointReplayRecordV1['modelResult'];
  let receiptInput: CheckpointReplayReceiptInputV1 | undefined;
  let failure: CheckpointReplayFailureV1 | undefined;
  let unknown: CheckpointReplayUnknownV1 | undefined;
  for (const event of events.slice(1)) {
    if (event.type === 'source-prefix.validated' || event.type === 'source-future.referenced') {
      phase = 'source-validated';
    } else if (event.type === 'model.started') {
      phase = 'model-running';
    } else if (event.type === 'model.evidence') {
      modelEvidence.push((event.payload as { readonly evidence: ModelOnlyEvidenceV1 }).evidence);
    } else if (event.type === 'model.finished') {
      modelResult = event.payload as NonNullable<CheckpointReplayRecordV1['modelResult']>;
      phase = 'model-finished';
    } else if (event.type === 'receipt-input.ready') {
      receiptInput = (event.payload as { readonly receiptInput: CheckpointReplayReceiptInputV1 })
        .receiptInput;
    } else if (event.type === 'replay.completed') {
      phase = 'completed';
    } else if (event.type === 'replay.failed') {
      failure = event.payload as CheckpointReplayFailureV1;
      phase = 'failed';
    } else if (event.type === 'replay.unknown') {
      unknown = event.payload as CheckpointReplayUnknownV1;
      phase = 'unknown';
    }
  }
  return {
    replayId: plannedPayload.lineage.replayId,
    mode: plannedPayload.lineage.mode,
    phase,
    lineage: plannedPayload.lineage,
    plan: plannedPayload.plan,
    events: [...events],
    modelEvidence,
    ...(modelResult === undefined ? {} : { modelResult }),
    ...(receiptInput === undefined ? {} : { receiptInput }),
    ...(failure === undefined ? {} : { failure }),
    ...(unknown === undefined ? {} : { unknown }),
  };
}

function allowedTransitions(record: CheckpointReplayRecordV1): Set<CheckpointReplayEventTypeV1> {
  if (record.mode === 'playback') {
    if (record.phase === 'planned') return new Set(['source-prefix.validated', 'replay.failed']);
    if (record.phase === 'source-validated') return new Set(['replay.completed', 'replay.failed']);
    return new Set();
  }
  if (record.mode === 'cached-replay') {
    if (record.phase === 'planned') return new Set(['source-future.referenced', 'replay.failed']);
    if (record.phase === 'source-validated' && record.receiptInput === undefined) {
      return new Set(['receipt-input.ready', 'replay.failed']);
    }
    if (record.phase === 'source-validated' && record.receiptInput !== undefined) {
      return new Set(['replay.completed', 'replay.failed']);
    }
    return new Set();
  }
  if (record.phase === 'planned') return new Set(['model.started', 'replay.failed']);
  if (record.phase === 'model-running') {
    return new Set(['model.evidence', 'model.finished', 'replay.failed', 'replay.unknown']);
  }
  if (record.phase === 'model-finished' && record.modelResult?.status === 'failed') {
    return new Set(['replay.failed']);
  }
  if (record.phase === 'model-finished' && record.receiptInput === undefined) {
    return new Set(['receipt-input.ready', 'replay.failed']);
  }
  if (record.phase === 'model-finished' && record.receiptInput !== undefined) {
    return new Set(['replay.completed', 'replay.unknown', 'replay.failed']);
  }
  return new Set();
}

function validatePlannedPayload(event: CheckpointReplayEventV1): void {
  const payload = event.payload as {
    readonly lineage?: CheckpointReplayLineageV1;
    readonly plan?: CheckpointOperationPlanV1;
  };
  if (
    payload.lineage === undefined ||
    payload.plan === undefined ||
    payload.lineage.replayId !== event.replayId ||
    payload.lineage.mode !== payload.plan.mode
  ) {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      'replay.planned payload has inconsistent lineage or plan',
    );
  }
}

function validateEventPayload(
  event: CheckpointReplayEventV1,
  record: CheckpointReplayRecordV1,
): void {
  switch (event.type) {
    case 'source-prefix.validated': {
      const payload = event.payload as {
        readonly eventRefs?: unknown;
        readonly headHash?: unknown;
      };
      if (
        record.lineage.mode !== 'playback' ||
        !Array.isArray(payload.eventRefs) ||
        payload.headHash !== record.lineage.sourceEventPrefix.headHash ||
        canonicalJson(payload.eventRefs) !==
          canonicalJson(record.lineage.sourceEventPrefix.eventRefs)
      ) {
        throw new CheckpointReplayError(
          'REPLAY_EVIDENCE_CORRUPT',
          'Playback prefix validation payload does not match lineage',
        );
      }
      break;
    }
    case 'source-future.referenced': {
      const payload = event.payload as {
        readonly sourceBundleId?: string;
        readonly sourceBundleDigest?: string;
      };
      if (
        record.lineage.mode !== 'cached-replay' ||
        payload.sourceBundleId !== record.lineage.sourceFuture.bundleId ||
        payload.sourceBundleDigest !== record.lineage.sourceFuture.manifestDigest
      ) {
        throw new CheckpointReplayError(
          'REPLAY_EVIDENCE_CORRUPT',
          'Cached source reference does not match replay lineage',
        );
      }
      break;
    }
    case 'model.started':
      if (record.lineage.mode !== 'counterfactual-resample') {
        throw new CheckpointReplayError(
          'REPLAY_EVIDENCE_CORRUPT',
          'Only counterfactual resampling may start a model',
        );
      }
      break;
    case 'model.evidence':
      normalizeModelEvidence(
        (event.payload as { readonly evidence: ModelOnlyEvidenceV1 }).evidence,
      );
      break;
    case 'receipt-input.ready': {
      const input = (event.payload as { readonly receiptInput?: CheckpointReplayReceiptInputV1 })
        .receiptInput;
      if (
        input === undefined ||
        input.replayId !== record.replayId ||
        input.outcome !== 'unknown' ||
        input.authority !== 'receipt-input-not-kernel-state'
      ) {
        throw new CheckpointReplayError(
          'REPLAY_EVIDENCE_CORRUPT',
          'Replay Receipt input claims unsupported authority or outcome',
        );
      }
      break;
    }
    default:
      break;
  }
}

function assertReplayIdentity(
  events: readonly CheckpointReplayEventV1[],
  mode: CheckpointReplayModeV1,
  replayId: string,
): void {
  const record = projectCheckpointReplay(events);
  if (record.replayId !== replayId || record.mode !== mode) {
    throw new CheckpointReplayError(
      'REPLAY_ID_CONFLICT',
      'Existing replay evidence conflicts with the content-addressed request',
    );
  }
}

function isTerminal(phase: CheckpointReplayPhaseV1): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'unknown';
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
  return frontier.map((effect) => ({
    ...effect,
    evidenceRefs: [...effect.evidenceRefs],
  }));
}

function requireIdentifier(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new CheckpointReplayError(
      'REPLAY_EVIDENCE_CORRUPT',
      `${path} contains unsupported characters`,
    );
  }
  return value;
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new CheckpointReplayError('REPLAY_EVIDENCE_CORRUPT', `${path} must be non-empty`);
  }
  return value;
}

function requireDigest(value: string, path: string, requireShaPrefix = true): string {
  requireNonEmpty(value, path);
  if (requireShaPrefix && !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      `${path} must be a full sha256 content digest`,
    );
  }
  return value;
}

function requireHash(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (!/^(?:sha256:)?[0-9a-f]{64}$/.test(value)) {
    throw new CheckpointReplayError(
      'CHECKPOINT_INCOMPLETE',
      `${path} must be a complete SHA-256 hash`,
    );
  }
  return value;
}

function requirePositiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      `${path} must be a positive safe integer`,
    );
  }
  return value;
}

function requireNonNegativeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CheckpointReplayError(
      'SOURCE_BUNDLE_INVALID',
      `${path} must be a non-negative safe integer`,
    );
  }
  return value;
}

function requireIsoTimestamp(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new CheckpointReplayError('REPLAY_EVIDENCE_CORRUPT', `${path} must be an ISO timestamp`);
  }
  return value;
}

function normalizeRefs(values: readonly string[], path: string): string[] {
  const normalized = uniqueSorted(values.map((value) => requireNonEmpty(value, path)));
  if (normalized.length === 0) {
    throw new CheckpointReplayError('SOURCE_BUNDLE_INVALID', `${path} must contain evidence`);
  }
  return normalized;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, candidate]) => candidate !== undefined)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, candidate]) => [key, canonicalize(candidate)]),
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new CheckpointReplayError(
    'REPLAY_EVIDENCE_CORRUPT',
    `Replay evidence contains unsupported ${typeof value}`,
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const eventTypes = new Set<CheckpointReplayEventTypeV1>([
  'replay.planned',
  'source-prefix.validated',
  'source-future.referenced',
  'model.started',
  'model.evidence',
  'model.finished',
  'receipt-input.ready',
  'replay.completed',
  'replay.failed',
  'replay.unknown',
]);

const cachedEvidenceKinds = new Set<CachedFutureEvidenceKindV1>([
  'model-input',
  'model-output',
  'message',
  'tool-request',
  'tool-result',
  'workspace-change',
  'verification',
  'effect',
  'failure',
  'unknown',
]);

const modelEvidenceKinds = new Set<ModelOnlyEvidenceKindV1>([
  'model-output',
  'message',
  'usage',
  'failure',
  'unknown',
]);

const artifactFidelities = new Set<ReplayArtifactFidelityV1>([
  'exact-replay-safe',
  'sanitized-lossy',
  'opaque',
]);
