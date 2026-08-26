/**
 * Branch-scoped bridge from authoritative Mission Kernel evidence to the
 * rebuildable Failure Intelligence projection.
 *
 * This module deliberately does not add a second failure model. It validates
 * and narrows persisted evidence before handing it to failure-intelligence.ts.
 */
import { createHash } from 'node:crypto';

import {
  verifyCompositeCheckpoint,
  type CheckpointInterventionKindV1,
  type CheckpointInterventionV1,
  type CompositeCheckpointManifestV1,
} from './composite-checkpoint.js';
import type { ContextGraphV1 } from './context-graph.js';
import type { JsonValue, ReceiptV1, StoredEventV1, VerificationResultV1 } from './domain.js';
import type { ExecutionForkRecordV1 } from './execution-fork.js';
import {
  deriveFailureIntelligence,
  type AdapterFailureEvidenceV1,
  type ContextFreshnessEvidenceV1,
  type DiagnosticBranchOutcomeV1,
  type DiagnosticCheckpointEvidenceV1,
  type DiagnosticVariableV1,
  type FailureConclusionStatusV1,
  type FailureEvidenceGraphV1,
  type FailureIntelligenceInputV1,
  type FailureLayerV1,
  type FailureVerificationEvidenceV1,
  type WorkspaceComparisonEvidenceV1,
} from './failure-intelligence.js';
import type { RuntimeSemanticFactV1, RuntimeSemanticPhaseV1 } from './runtime-semantics.js';
import type {
  ToolDecisionIntentV1,
  ToolGateRequestV1,
  ToolReleaseV1,
  ToolResultV1,
} from './tool-gateway.js';
import type { RuntimeDetection, RuntimeRunResult } from './adapters/types.js';
import { computeEventHash, hashPayload } from './store.js';

export const MISSION_FAILURE_INTELLIGENCE_SCHEMA_VERSION = 1 as const;

export type MissionFailureEvidenceGapKindV1 =
  | 'semantic-fact-derived'
  | 'semantic-fact-opaque'
  | 'semantic-fact-invalid'
  | 'context-evidence-outside-branch'
  | 'process-failure-without-adapter-record'
  | 'adapter-evidence-unbound'
  | 'adapter-detection-unavailable'
  | 'runtime-failure-unattributed'
  | 'diagnostic-checkpoint-incomplete'
  | 'diagnostic-receipt-unavailable';

export interface MissionFailureEvidenceGapV1 {
  readonly gapId: string;
  readonly kind: MissionFailureEvidenceGapKindV1;
  readonly layer: FailureLayerV1 | 'unknown';
  readonly status: FailureConclusionStatusV1;
  readonly evidenceRefs: readonly string[];
  /** Bounded explanation only; raw native content is never copied here. */
  readonly detail: string;
}

/**
 * Adapter evidence remains external evidence. The marker makes the caller
 * explicitly attest that prompts, credentials, and raw secrets were removed
 * before a RuntimeRunResult is supplied to this bridge.
 */
export interface BoundAdapterFailureEvidenceV1 {
  readonly sanitized: true;
  readonly sourceEventIds: readonly string[];
  readonly evidence: AdapterFailureEvidenceV1;
}

export interface DiagnosticForkProjectionInputV1 {
  readonly candidateId: string;
  readonly changedVariable: DiagnosticVariableV1;
  readonly fork: ExecutionForkRecordV1;
  readonly evaluation: 'deterministic' | 'model-assisted';
  /** Kernel receipt.issued event identity, not ExecutionForkReceiptInputV1. */
  readonly receiptEventId?: string;
  /** Must occur in both Fork verifier evidence and Kernel Receipt evidence. */
  readonly evaluationEvidenceRefs?: readonly string[];
}

export interface ProjectMissionFailureIntelligenceOptionsV1 {
  readonly missionId: string;
  readonly branchId: string;
  /** Complete persisted event chain for this Mission; input order is irrelevant. */
  readonly events: readonly StoredEventV1[];
  readonly contextGraph?: ContextGraphV1;
  readonly checkpoint?: CompositeCheckpointManifestV1;
  readonly adapterEvidence?: readonly BoundAdapterFailureEvidenceV1[];
  readonly diagnosticForks?: readonly DiagnosticForkProjectionInputV1[];
}

export interface MissionFailureIntelligenceProjectionV1 {
  readonly schemaVersion: typeof MISSION_FAILURE_INTELLIGENCE_SCHEMA_VERSION;
  readonly authority: 'derived-evidence-only';
  readonly missionId: string;
  readonly branchId: string;
  readonly throughSeq: number;
  readonly headHash: string;
  readonly failureIntelligenceInput: FailureIntelligenceInputV1;
  readonly graph: FailureEvidenceGraphV1;
  readonly unavailable: readonly MissionFailureEvidenceGapV1[];
}

export interface ProjectDiagnosticBranchOutcomeOptionsV1 extends DiagnosticForkProjectionInputV1 {
  readonly events: readonly StoredEventV1[];
  readonly checkpoint: CompositeCheckpointManifestV1;
}

export class MissionFailureIntelligenceProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionFailureIntelligenceProjectionError';
  }
}

/**
 * Derive one branch-scoped graph from persisted evidence. Removing evidence and
 * calling this function again always rebuilds the conclusion from scratch.
 */
export function deriveMissionFailureIntelligence(
  options: ProjectMissionFailureIntelligenceOptionsV1,
): MissionFailureIntelligenceProjectionV1 {
  const projected = projectMissionFailureEvidence(options);
  return {
    ...projected,
    graph: deriveFailureIntelligence(projected.failureIntelligenceInput),
  };
}

/** Returns only the existing FailureIntelligenceInputV1 for direct integration. */
export function projectMissionFailureIntelligenceInput(
  options: ProjectMissionFailureIntelligenceOptionsV1,
): FailureIntelligenceInputV1 {
  return projectMissionFailureEvidence(options).failureIntelligenceInput;
}

function projectMissionFailureEvidence(
  options: ProjectMissionFailureIntelligenceOptionsV1,
): Omit<MissionFailureIntelligenceProjectionV1, 'graph'> {
  requireIdentifier(options.missionId, 'missionId');
  requireIdentifier(options.branchId, 'branchId');
  const events = validateAndOrderMissionEvents(options.events, options.missionId);
  const throughSeq = events.at(-1)?.seq ?? 0;
  const headHash = events.at(-1)?.hash ?? 'sha256:empty-mission-event-chain';
  const scope = branchScope(events, options.branchId);
  const gaps: MissionFailureEvidenceGapV1[] = [];

  const runtimeFacts = collectRuntimeFacts(scope.runtimeEvents, gaps);
  const contextGraph =
    options.contextGraph === undefined
      ? undefined
      : filterContextGraph(options.contextGraph, scope.runtimeEvents, gaps);
  const contextFreshness = collectContextFreshness(scope.observations);
  const workspaceComparisons = collectWorkspaceComparisons(scope.observations, options.checkpoint);
  const verifications = collectVerifications(scope.events);
  const toolGateway = collectToolGateway(scope.observations);
  const adapters = collectAdapterEvidence(options.adapterEvidence ?? [], scope.events, gaps);
  collectUnmappedRuntimeFailures(scope.observations, adapters.boundEventIds, gaps);

  const checkpoint =
    options.checkpoint === undefined
      ? undefined
      : projectDiagnosticCheckpoint(options.checkpoint, options.missionId, options.branchId, gaps);

  const diagnosticOutcomes: DiagnosticBranchOutcomeV1[] = [];
  for (const diagnostic of options.diagnosticForks ?? []) {
    if (options.checkpoint === undefined) {
      gaps.push(
        gap(
          'diagnostic-receipt-unavailable',
          'unknown',
          'unknown',
          [diagnostic.fork.forkId],
          'A diagnostic Fork cannot be evaluated without its exact parent Composite Checkpoint.',
        ),
      );
      continue;
    }
    diagnosticOutcomes.push(
      projectDiagnosticBranchOutcome({
        ...diagnostic,
        events,
        checkpoint: options.checkpoint,
      }),
    );
  }

  const failureIntelligenceInput: FailureIntelligenceInputV1 = {
    persistedRuntimeFacts: runtimeFacts,
    ...(contextGraph === undefined ? {} : { contextGraph }),
    ...(contextFreshness.length === 0 ? {} : { contextFreshness }),
    ...(workspaceComparisons.length === 0 ? {} : { workspaceComparisons }),
    ...(verifications.length === 0 ? {} : { verifications }),
    ...(toolGateway.requests.length === 0 &&
    toolGateway.decisionIntents.length === 0 &&
    toolGateway.releases.length === 0 &&
    toolGateway.results.length === 0
      ? {}
      : {
          toolGateway: {
            ...(toolGateway.requests.length === 0 ? {} : { requests: toolGateway.requests }),
            ...(toolGateway.decisionIntents.length === 0
              ? {}
              : { decisionIntents: toolGateway.decisionIntents }),
            ...(toolGateway.releases.length === 0 ? {} : { releases: toolGateway.releases }),
            ...(toolGateway.results.length === 0 ? {} : { results: toolGateway.results }),
          },
        }),
    ...(adapters.evidence.length === 0 ? {} : { adapters: adapters.evidence }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(diagnosticOutcomes.length === 0 ? {} : { diagnosticOutcomes }),
  };

  return {
    schemaVersion: MISSION_FAILURE_INTELLIGENCE_SCHEMA_VERSION,
    authority: 'derived-evidence-only',
    missionId: options.missionId,
    branchId: options.branchId,
    throughSeq,
    headHash,
    failureIntelligenceInput,
    unavailable: deduplicateGaps(gaps),
  };
}

/**
 * Converts one completed single-variable execution Fork into evidence for the
 * existing diagnostic-outcome input. Receipt input alone is never sufficient.
 */
export function projectDiagnosticBranchOutcome(
  options: ProjectDiagnosticBranchOutcomeOptionsV1,
): DiagnosticBranchOutcomeV1 {
  verifyCompositeCheckpoint(options.checkpoint);
  validateForkLineage(options.fork, options.checkpoint);
  validateVariableForIntervention(options.changedVariable, options.fork.lineage.intervention);
  requireIdentifier(options.candidateId, 'candidateId');

  const events = validateAndOrderMissionEvents(options.events, options.checkpoint.source.missionId);
  const receiptEvent =
    options.receiptEventId === undefined
      ? undefined
      : events.find((event) => event.eventId === options.receiptEventId);
  const receipt =
    receiptEvent?.type === 'receipt.issued' ? receiptEvent.payload.receipt : undefined;
  const receiptIsKernelBound =
    receipt !== undefined &&
    receiptEvent !== undefined &&
    receiptMatchesFork(receipt, receiptEvent, events, options.fork);
  const forkSucceeded = successfulDiagnosticFork(options.fork);
  const evaluationRefs = uniqueSorted(options.evaluationEvidenceRefs ?? []);
  const deterministicEvidence =
    options.evaluation === 'deterministic' &&
    receipt !== undefined &&
    hasDeterministicEvaluationBinding(options.fork, receipt, evaluationRefs);

  let result: DiagnosticBranchOutcomeV1['result'] = 'inconclusive';
  if (
    forkSucceeded &&
    receiptIsKernelBound &&
    deterministicEvidence &&
    hasRequiredInterventionEvidence(options.fork) &&
    receipt !== undefined
  ) {
    const verificationStatuses = receipt.verifications.map((verification) => verification.status);
    if (
      receipt.outcome === 'verified' &&
      verificationStatuses.length > 0 &&
      verificationStatuses.every((status) => status === 'passed') &&
      (receipt.unresolvedItems?.length ?? 0) === 0
    ) {
      result = 'mechanism-confirmed';
    } else if (
      receipt.outcome === 'rejected' &&
      verificationStatuses.some((status) => status === 'failed')
    ) {
      result = 'mechanism-refuted';
    }
  }

  const evidenceRefs = uniqueSorted([
    `checkpoint:${options.checkpoint.checkpointId}`,
    options.fork.forkId,
    options.fork.lineage.lineageId,
    options.fork.lineage.intervention.interventionId,
    ...options.fork.events.map((event) => event.eventId),
    ...options.fork.runtimeEvidence.flatMap((evidence) => [
      evidence.evidenceId,
      ...evidence.evidenceRefs,
    ]),
    ...(options.fork.runtimeResult?.toolExecutionEvidenceRefs ?? []),
    ...(options.fork.runtimeResult?.verificationEvidenceRefs ?? []),
    ...(options.fork.receiptInput === undefined ? [] : [options.fork.receiptInput.receiptInputId]),
    ...(receiptEvent === undefined ? [] : [`event:${receiptEvent.eventId}`]),
    ...(receipt === undefined
      ? []
      : [receipt.receiptId, ...receipt.verifications.flatMap((item) => item.evidenceRefs)]),
    ...evaluationRefs,
  ]);
  const core = {
    candidateId: options.candidateId,
    changedVariable: options.changedVariable,
    preservedCheckpointDigest: options.checkpoint.manifestHash,
    evaluation: options.evaluation,
    result,
    evidenceRefs,
  } as const;
  return {
    outcomeId: `diagnostic-outcome-${shortHash(stableStringify(core))}`,
    ...core,
  };
}

function validateAndOrderMissionEvents(
  supplied: readonly StoredEventV1[],
  missionId: string,
): StoredEventV1[] {
  const events = supplied
    .filter((event) => event.missionId === missionId)
    .sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));
  const ids = new Set<string>();
  let previousHash: string | null = null;
  for (const [index, event] of events.entries()) {
    if (ids.has(event.eventId)) {
      throw new MissionFailureIntelligenceProjectionError(
        `Mission event chain contains duplicate eventId ${event.eventId}`,
      );
    }
    ids.add(event.eventId);
    if (event.seq !== index + 1 || event.prevHash !== previousHash) {
      throw new MissionFailureIntelligenceProjectionError(
        `Mission event chain is not contiguous at sequence ${String(event.seq)}`,
      );
    }
    const payloadHash = hashPayload(event.payload);
    const expectedHash = computeEventHash({
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
    if (event.payloadHash !== payloadHash || event.hash !== expectedHash) {
      throw new MissionFailureIntelligenceProjectionError(
        `Mission event chain integrity failed at sequence ${String(event.seq)}`,
      );
    }
    previousHash = event.hash;
  }
  return events;
}

interface BranchScope {
  readonly events: readonly StoredEventV1[];
  readonly runtimeEvents: readonly Extract<StoredEventV1, { readonly type: 'runtime.event' }>[];
  readonly observations: readonly Extract<
    StoredEventV1,
    { readonly type: 'runtime.observation' }
  >[];
}

function branchScope(events: readonly StoredEventV1[], branchId: string): BranchScope {
  const rootBranchId = events.find((event) => event.type === 'mission.created')?.payload.mission
    .rootBranchId;
  const attemptBranches = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'attempt.bound') {
      attemptBranches.set(event.payload.binding.attemptId, event.payload.binding.branchId);
    } else if (event.type === 'attempt.started') {
      attemptBranches.set(event.payload.attempt.attemptId, event.payload.attempt.branchId);
    }
  }
  const belongs = (event: StoredEventV1): boolean => {
    if (event.type === 'runtime.event') return event.payload.event.branchId === branchId;
    if (event.type === 'receipt.issued') {
      return (event.payload.receipt.branchId ?? event.payload.receipt.rootBranchId) === branchId;
    }
    if (event.type === 'branch.created') return event.payload.branch.branchId === branchId;
    if (event.type === 'attempt.bound') return event.payload.binding.branchId === branchId;
    if (event.type === 'attempt.started') return event.payload.attempt.branchId === branchId;
    if (event.attemptId !== undefined) return attemptBranches.get(event.attemptId) === branchId;
    if (event.type === 'runtime.observation' && isRecord(event.payload.data)) {
      if (typeof event.payload.data.branchId === 'string') {
        return event.payload.data.branchId === branchId;
      }
      if (typeof event.payload.data.attemptId === 'string') {
        return attemptBranches.get(event.payload.data.attemptId) === branchId;
      }
    }
    return rootBranchId === branchId;
  };
  const selected = events.filter(belongs);
  return {
    events: selected,
    runtimeEvents: selected.filter(
      (event): event is Extract<StoredEventV1, { readonly type: 'runtime.event' }> =>
        event.type === 'runtime.event',
    ),
    observations: selected.filter(
      (event): event is Extract<StoredEventV1, { readonly type: 'runtime.observation' }> =>
        event.type === 'runtime.observation',
    ),
  };
}

function collectRuntimeFacts(
  events: BranchScope['runtimeEvents'],
  gaps: MissionFailureEvidenceGapV1[],
): RuntimeSemanticFactV1[] {
  const facts = new Map<string, RuntimeSemanticFactV1>();
  const identities = new Map<string, string>();
  for (const outer of events) {
    const event = outer.payload.event;
    const normalized = isRecord(event.normalized) ? event.normalized : undefined;
    const candidates = normalized?.semanticFacts;
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      const fact = validatedRuntimeFact(candidate, event);
      if (fact === undefined) {
        gaps.push(
          gap(
            'semantic-fact-invalid',
            'unknown',
            'unknown',
            [`event:${outer.eventId}`, event.runtimeEventId],
            'A persisted semantic fact did not match its enclosing Runtime Event identity.',
          ),
        );
        continue;
      }
      if (fact.fidelity === 'opaque' || fact.evidence === 'unknown') {
        gaps.push(
          gap(
            'semantic-fact-opaque',
            layerForRuntimeFact(fact),
            'unknown',
            [fact.factId, fact.sourceRuntimeEventId, fact.artifact.artifactId],
            'Opaque or unknown Runtime evidence is retained as a boundary, not an observed cause.',
          ),
        );
        continue;
      }
      if (fact.fidelity !== 'native' || fact.evidence !== 'explicit') {
        gaps.push(
          gap(
            'semantic-fact-derived',
            layerForRuntimeFact(fact),
            'inferred',
            [fact.factId, fact.sourceRuntimeEventId, fact.artifact.artifactId],
            'Derived Runtime semantics may guide investigation but cannot become an observed cause.',
          ),
        );
        continue;
      }
      const identity = stableStringify(fact);
      const previousIdentity = identities.get(fact.factId);
      if (previousIdentity !== undefined && previousIdentity !== identity) {
        gaps.push(
          gap(
            'semantic-fact-invalid',
            layerForRuntimeFact(fact),
            'unknown',
            [fact.factId],
            'Conflicting persisted semantic facts share one fact identity; neither conflict is selected.',
          ),
        );
        facts.delete(fact.factId);
        identities.set(fact.factId, 'conflict');
        continue;
      }
      if (previousIdentity === 'conflict') continue;
      identities.set(fact.factId, identity);
      facts.set(fact.factId, fact);
    }
  }
  return [...facts.values()].sort((left, right) => left.factId.localeCompare(right.factId));
}

function filterContextGraph(
  graph: ContextGraphV1,
  runtimeEvents: BranchScope['runtimeEvents'],
  gaps: MissionFailureEvidenceGapV1[],
): ContextGraphV1 {
  if (graph.schemaVersion !== 1 || graph.authority !== 'derived-evidence-only') {
    throw new MissionFailureIntelligenceProjectionError(
      'Context Graph must be a version 1 derived-evidence-only projection',
    );
  }
  const runtimeIds = new Set(runtimeEvents.map((event) => event.payload.event.runtimeEventId));
  const artifactIds = new Set(
    runtimeEvents.map((event) => event.payload.event.nativeArtifact.artifactId),
  );
  const evidenceMatches = (reference: string): boolean =>
    [...runtimeIds].some(
      (runtimeId) => reference === runtimeId || reference.startsWith(`${runtimeId}:`),
    ) || artifactIds.has(reference);
  const nodes = graph.nodes.filter(
    (node) =>
      (node.runtimeEventId !== undefined && runtimeIds.has(node.runtimeEventId)) ||
      node.evidenceRefs.some(evidenceMatches),
  );
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const edges = graph.edges.filter(
    (edge) =>
      nodeIds.has(edge.fromNodeId) &&
      nodeIds.has(edge.toNodeId) &&
      edge.evidenceRefs.some(evidenceMatches),
  );
  const contextDiffs = graph.contextDiffs.filter(
    (diff) => runtimeIds.has(diff.fromRuntimeEventId) && runtimeIds.has(diff.toRuntimeEventId),
  );
  const unavailable = graph.unavailable.filter(
    (boundary) =>
      boundary.runtimeEventIds.length === 0 ||
      boundary.runtimeEventIds.every((runtimeEventId) => runtimeIds.has(runtimeEventId)),
  );
  const removed = graph.nodes.length - nodes.length;
  if (removed > 0) {
    gaps.push(
      gap(
        'context-evidence-outside-branch',
        'context',
        'unknown',
        [],
        `${String(removed)} Context Graph nodes belonged to another Branch or lacked a Branch-bound evidence reference.`,
      ),
    );
  }
  return {
    schemaVersion: 1,
    authority: 'derived-evidence-only',
    runtimeEventCount: runtimeIds.size,
    nativeArtifactCount: artifactIds.size,
    nodes: clone(nodes),
    edges: clone(edges),
    contextDiffs: clone(contextDiffs),
    unavailable: clone(unavailable),
  };
}

function collectContextFreshness(
  observations: BranchScope['observations'],
): ContextFreshnessEvidenceV1[] {
  const records: ContextFreshnessEvidenceV1[] = [];
  for (const event of observations) {
    if (
      event.payload.kind !== 'context.freshness' &&
      event.payload.kind !== 'context.workspace_freshness'
    ) {
      continue;
    }
    const data = isRecord(event.payload.data) ? event.payload.data : undefined;
    if (
      data === undefined ||
      !nonEmptyString(data.contextFactId) ||
      !nonEmptyString(data.boundWorkspaceDigest) ||
      !nonEmptyString(data.currentWorkspaceDigest)
    ) {
      continue;
    }
    records.push({
      evidenceId: nonEmptyString(data.evidenceId) ? data.evidenceId : event.eventId,
      contextFactId: data.contextFactId,
      boundWorkspaceDigest: data.boundWorkspaceDigest,
      currentWorkspaceDigest: data.currentWorkspaceDigest,
      ...(nonEmptyString(data.boundContextDigest)
        ? { boundContextDigest: data.boundContextDigest }
        : {}),
      ...(nonEmptyString(data.currentContextDigest)
        ? { currentContextDigest: data.currentContextDigest }
        : {}),
      evidenceRefs: uniqueSorted([`event:${event.eventId}`, ...stringArray(data.evidenceRefs)]),
    });
  }
  return deduplicate(records, (item) => item.evidenceId);
}

function collectWorkspaceComparisons(
  observations: BranchScope['observations'],
  checkpoint: CompositeCheckpointManifestV1 | undefined,
): WorkspaceComparisonEvidenceV1[] {
  const comparisons: WorkspaceComparisonEvidenceV1[] = [];
  for (const event of observations) {
    const data = isRecord(event.payload.data) ? event.payload.data : undefined;
    if (data === undefined) continue;
    if (
      event.payload.kind === 'failure.observed' &&
      data.code === 'WORKSPACE_DIVERGED' &&
      nonEmptyString(data.checkpointId) &&
      nonEmptyString(data.expectedWorkspaceDigest) &&
      nonEmptyString(data.observedWorkspaceDigest)
    ) {
      comparisons.push({
        evidenceId: event.eventId,
        boundaryId: data.checkpointId,
        expectedWorkspaceDigest: data.expectedWorkspaceDigest,
        observedWorkspaceDigest: data.observedWorkspaceDigest,
        evidenceRefs: [`event:${event.eventId}`],
      });
      continue;
    }
    if (
      event.payload.kind === 'workspace.comparison' &&
      nonEmptyString(data.boundaryId) &&
      nonEmptyString(data.expectedWorkspaceDigest) &&
      nonEmptyString(data.observedWorkspaceDigest)
    ) {
      comparisons.push({
        evidenceId: nonEmptyString(data.evidenceId) ? data.evidenceId : event.eventId,
        boundaryId: data.boundaryId,
        expectedWorkspaceDigest: data.expectedWorkspaceDigest,
        observedWorkspaceDigest: data.observedWorkspaceDigest,
        evidenceRefs: uniqueSorted([`event:${event.eventId}`, ...stringArray(data.evidenceRefs)]),
      });
    }
  }
  const boundCheckpoint = checkpoint;
  if (boundCheckpoint !== undefined && boundCheckpoint.workspace.workspaceDigest !== null) {
    for (const event of observations) {
      if (event.payload.kind !== 'checkpoint.created' || !isRecord(event.payload.data)) continue;
      const data = event.payload.data;
      const delta = isRecord(data.delta) ? data.delta : undefined;
      if (
        data.attemptId !== boundCheckpoint.source.attemptId ||
        !nonEmptyString(data.checkpointId) ||
        delta === undefined ||
        !nonEmptyString(delta.afterWorkspaceDigest)
      ) {
        continue;
      }
      comparisons.push({
        evidenceId: `workspace-comparison-${shortHash(
          `${event.eventId}\0${boundCheckpoint.checkpointId}`,
        )}`,
        boundaryId: data.checkpointId,
        expectedWorkspaceDigest: delta.afterWorkspaceDigest,
        observedWorkspaceDigest: boundCheckpoint.workspace.workspaceDigest,
        evidenceRefs: [`event:${event.eventId}`, `checkpoint:${boundCheckpoint.checkpointId}`],
      });
    }
  }
  return deduplicate(comparisons, (item) => item.evidenceId);
}

function collectVerifications(events: readonly StoredEventV1[]): FailureVerificationEvidenceV1[] {
  const completed = new Map<string, FailureVerificationEvidenceV1>();
  const receipts = new Map<string, FailureVerificationEvidenceV1>();
  for (const event of events) {
    if (event.type === 'runtime.observation' && event.payload.kind === 'verification.completed') {
      const data = isRecord(event.payload.data) ? event.payload.data : undefined;
      if (
        data === undefined ||
        !nonEmptyString(data.criterionId) ||
        typeof data.passed !== 'boolean'
      ) {
        continue;
      }
      const result: VerificationResultV1 = {
        criterionId: data.criterionId,
        status: data.passed ? 'passed' : 'failed',
        evidenceRefs: uniqueSorted([`event:${event.eventId}`, ...digestEvidenceRefs(data)]),
      };
      completed.set(data.criterionId, {
        evidenceId: event.eventId,
        criterionId: data.criterionId,
        result,
        evidenceRefs: result.evidenceRefs,
      });
    }
    if (event.type === 'receipt.issued') {
      for (const verification of event.payload.receipt.verifications) {
        const result: VerificationResultV1 = {
          criterionId: verification.criterionId,
          status: verification.status,
          evidenceRefs: uniqueSorted([
            `event:${event.eventId}`,
            event.payload.receipt.receiptId,
            ...verification.evidenceRefs,
          ]),
          ...(verification.detail === undefined ? {} : { detail: verification.detail }),
        };
        receipts.set(verification.criterionId, {
          evidenceId: `${event.eventId}:${verification.criterionId}`,
          criterionId: verification.criterionId,
          result,
          evidenceRefs: result.evidenceRefs,
        });
      }
    }
  }
  for (const criterionId of receipts.keys()) completed.delete(criterionId);
  return [...completed.values(), ...receipts.values()].sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId),
  );
}

function collectToolGateway(observations: BranchScope['observations']): {
  readonly requests: readonly ToolGateRequestV1[];
  readonly decisionIntents: readonly ToolDecisionIntentV1[];
  readonly releases: readonly ToolReleaseV1[];
  readonly results: readonly ToolResultV1[];
} {
  const requests: ToolGateRequestV1[] = [];
  const decisionIntents: ToolDecisionIntentV1[] = [];
  const releases: ToolReleaseV1[] = [];
  const results: ToolResultV1[] = [];
  for (const event of observations) {
    if (!isRecord(event.payload.data)) continue;
    if (event.payload.kind === 'tool.gate.requested') {
      const request = toolRequest(event.payload.data, event);
      if (request !== undefined) requests.push(request);
    } else if (event.payload.kind === 'tool.gate.decided') {
      const intent = toolDecisionIntent(event.payload.data, event);
      if (intent !== undefined) decisionIntents.push(intent);
    } else if (event.payload.kind === 'tool.gate.released') {
      const release = toolRelease(event.payload.data, event);
      if (release !== undefined) releases.push(release);
    } else if (event.payload.kind === 'tool.gate.result') {
      const result = toolResult(event.payload.data, event);
      if (result !== undefined) results.push(result);
    }
  }
  return {
    requests: deduplicate(requests, (item) => item.gateId),
    decisionIntents: deduplicate(decisionIntents, (item) => item.decisionIntentId),
    releases: deduplicate(releases, (item) => item.releaseId),
    results: deduplicate(results, (item) => item.resultId),
  };
}

function collectAdapterEvidence(
  supplied: readonly BoundAdapterFailureEvidenceV1[],
  branchEvents: readonly StoredEventV1[],
  gaps: MissionFailureEvidenceGapV1[],
): { readonly evidence: readonly AdapterFailureEvidenceV1[]; readonly boundEventIds: Set<string> } {
  const eventsById = new Map(branchEvents.map((event) => [event.eventId, event]));
  const output: AdapterFailureEvidenceV1[] = [];
  const boundEventIds = new Set<string>();
  for (const binding of supplied) {
    const sourceEvents = uniqueSorted(binding.sourceEventIds)
      .map((eventId) => eventsById.get(eventId))
      .filter((event): event is StoredEventV1 => event !== undefined);
    const detection =
      binding.evidence.detection !== undefined &&
      sourceEvents.some((event) => detectionMatchesEvent(binding.evidence.detection!, event))
        ? clone(binding.evidence.detection)
        : undefined;
    const run =
      binding.evidence.run !== undefined &&
      sourceEvents.some((event) => runMatchesEvent(binding.evidence.run!, event))
        ? clone(binding.evidence.run)
        : undefined;
    if (detection === undefined && run === undefined) {
      gaps.push(
        gap(
          'adapter-evidence-unbound',
          'unknown',
          'unknown',
          [binding.evidence.evidenceId, ...binding.sourceEventIds],
          'Adapter evidence was not bound to a matching persisted catalog or process event.',
        ),
      );
      continue;
    }
    const included: AdapterFailureEvidenceV1 = {
      evidenceId: binding.evidence.evidenceId,
      harness: binding.evidence.harness,
      ...(detection === undefined ? {} : { detection }),
      ...(binding.evidence.capabilities === undefined
        ? {}
        : { capabilities: clone(binding.evidence.capabilities) }),
      ...(run === undefined ? {} : { run }),
      evidenceRefs: uniqueSorted([
        ...binding.evidence.evidenceRefs,
        ...sourceEvents.map((event) => `event:${event.eventId}`),
      ]),
    };
    output.push(included);
    sourceEvents.forEach((event) => boundEventIds.add(event.eventId));
  }

  for (const event of branchEvents) {
    if (event.type !== 'runtime.catalog_observed') continue;
    const data = event.payload.observation;
    if (
      (data.availability === 'missing' || data.availability === 'unavailable') &&
      !boundEventIds.has(event.eventId)
    ) {
      gaps.push(
        gap(
          'adapter-detection-unavailable',
          data.availability === 'missing' ? 'environment' : 'harness',
          'observed',
          [`event:${event.eventId}`],
          'Runtime catalog availability is observed, but the exact Adapter detection record was not persisted.',
        ),
      );
    }
  }
  return {
    evidence: deduplicate(output, (item) => item.evidenceId),
    boundEventIds,
  };
}

function collectUnmappedRuntimeFailures(
  observations: BranchScope['observations'],
  boundAdapterEventIds: ReadonlySet<string>,
  gaps: MissionFailureEvidenceGapV1[],
): void {
  for (const event of observations) {
    if (boundAdapterEventIds.has(event.eventId) || !isRecord(event.payload.data)) continue;
    const data = event.payload.data;
    if (event.payload.kind === 'runtime.process_finished') {
      const failed =
        data.aborted === true ||
        (typeof data.exitCode === 'number' && data.exitCode !== 0) ||
        typeof data.signal === 'string';
      if (!failed) continue;
      gaps.push(
        gap(
          'process-failure-without-adapter-record',
          'harness',
          'observed',
          [`event:${event.eventId}`],
          'The Runtime process failure is observed, but no exact sanitized Adapter run record is persisted to attribute its mechanism.',
        ),
      );
    } else if (event.payload.kind === 'failure.observed' && data.code !== 'WORKSPACE_DIVERGED') {
      gaps.push(
        gap(
          'runtime-failure-unattributed',
          data.layer === 'runtime-account' ? 'environment' : 'unknown',
          data.classification === 'observed' ? 'observed' : 'unknown',
          [`event:${event.eventId}`],
          'A Runtime failure symptom is persisted, but the bridge has no direct mechanism evidence beyond that symptom.',
        ),
      );
    }
  }
}

function projectDiagnosticCheckpoint(
  checkpoint: CompositeCheckpointManifestV1,
  missionId: string,
  branchId: string,
  gaps: MissionFailureEvidenceGapV1[],
): DiagnosticCheckpointEvidenceV1 {
  verifyCompositeCheckpoint(checkpoint);
  if (checkpoint.source.missionId !== missionId || checkpoint.source.branchId !== branchId) {
    throw new MissionFailureIntelligenceProjectionError(
      'Composite Checkpoint does not belong to the selected Mission Branch',
    );
  }
  const complete = completeDiagnosticCheckpoint(checkpoint);
  if (!complete) {
    gaps.push(
      gap(
        'diagnostic-checkpoint-incomplete',
        'missionbraid',
        'unknown',
        [`checkpoint:${checkpoint.checkpointId}`],
        'The Checkpoint is valid boundary evidence but lacks the complete recoverable state required for a diagnostic Fork.',
      ),
    );
  }
  return {
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.manifestHash,
    completeness: complete ? 'composite' : 'boundary-only',
    evidenceRefs: uniqueSorted([
      `checkpoint:${checkpoint.checkpointId}`,
      `kernel-head:${checkpoint.eventPrefix.headHash}`,
      ...checkpoint.components.flatMap((component) => component.evidenceRefs),
    ]),
  };
}

function completeDiagnosticCheckpoint(checkpoint: CompositeCheckpointManifestV1): boolean {
  const expected = new Set([
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
  const componentNames = checkpoint.components.map((component) => component.component);
  if (
    new Set(componentNames).size !== componentNames.length ||
    [...expected].some((name) => !componentNames.includes(name as never))
  ) {
    return false;
  }
  const required = new Set([
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
  ]);
  if (
    checkpoint.components.some(
      (component) => required.has(component.component) && component.disposition === 'unavailable',
    )
  ) {
    return false;
  }
  const workspace = checkpoint.components.find((component) => component.component === 'workspace');
  if (
    checkpoint.workspace.state !== 'restorable-artifact' ||
    checkpoint.workspace.workspaceDigest === null ||
    workspace?.disposition !== 'recoverable' ||
    checkpoint.process.status !== 'stopped'
  ) {
    return false;
  }
  return !checkpoint.externalEffectFrontier.some((effect) =>
    ['intended', 'dispatch_started', 'executed', 'ambiguous', 'conflict'].includes(effect.status),
  );
}

function validateForkLineage(
  fork: ExecutionForkRecordV1,
  checkpoint: CompositeCheckpointManifestV1,
): void {
  const lineage = fork.lineage;
  if (
    lineage.mode !== 'execution-fork' ||
    lineage.forkId !== fork.forkId ||
    lineage.missionId !== checkpoint.source.missionId ||
    lineage.contractId !== checkpoint.source.contractId ||
    lineage.parentBranchId !== checkpoint.source.branchId ||
    lineage.parentAttemptId !== checkpoint.source.attemptId ||
    lineage.parentCheckpointId !== checkpoint.checkpointId ||
    lineage.parentEventPrefix.throughSeq !== checkpoint.eventPrefix.throughSeq ||
    lineage.parentEventPrefix.headHash !== checkpoint.eventPrefix.headHash ||
    fork.plan.mode !== 'execution-fork' ||
    fork.plan.parentCheckpointId !== checkpoint.checkpointId ||
    fork.plan.parentBranchId !== checkpoint.source.branchId ||
    fork.plan.childBranchId !== lineage.childBranchId ||
    stableStringify(fork.plan.intervention) !== stableStringify(lineage.intervention)
  ) {
    throw new MissionFailureIntelligenceProjectionError(
      'Execution Fork lineage does not preserve the supplied Composite Checkpoint boundary',
    );
  }
}

function validateVariableForIntervention(
  variable: DiagnosticVariableV1,
  intervention: CheckpointInterventionV1,
): void {
  requireIdentifier(variable.key, 'changedVariable.key');
  const allowed: Readonly<Record<CheckpointInterventionKindV1, readonly FailureLayerV1[]>> = {
    context: ['context'],
    'tool-result': ['tool'],
    'permission-narrowing': ['missionbraid'],
    profile: ['model', 'harness', 'environment'],
    workspace: ['environment'],
    guidance: ['model', 'context'],
  };
  if (!allowed[intervention.kind].includes(variable.dimension)) {
    throw new MissionFailureIntelligenceProjectionError(
      `Diagnostic variable ${variable.dimension} is incompatible with ${intervention.kind} Intervention`,
    );
  }
  if (intervention.kind === 'permission-narrowing' && variable.operation !== 'narrow') {
    throw new MissionFailureIntelligenceProjectionError(
      'Permission-narrowing Intervention must remain a narrowing diagnostic variable',
    );
  }
}

function successfulDiagnosticFork(fork: ExecutionForkRecordV1): boolean {
  const result = fork.runtimeResult;
  const receiptInput = fork.receiptInput;
  return (
    fork.phase === 'finished' &&
    fork.failure === undefined &&
    result?.status === 'completed' &&
    result.toolExecutionEvidenceRefs.length > 0 &&
    result.verificationEvidenceRefs.length > 0 &&
    result.unresolvedItems.length === 0 &&
    receiptInput !== undefined &&
    receiptInput.authority === 'receipt-input-not-kernel-state' &&
    receiptInput.forkId === fork.forkId &&
    receiptInput.parentCheckpointId === fork.lineage.parentCheckpointId &&
    receiptInput.childBranchId === fork.lineage.childBranchId &&
    receiptInput.runtimeRunId === result.runtimeRunId &&
    receiptInput.runtimeStatus === 'completed' &&
    receiptInput.toolExecutionEvidenceRefs.length > 0 &&
    receiptInput.verificationEvidenceRefs.length > 0 &&
    receiptInput.unresolvedItems.length === 0 &&
    stableStringify(receiptInput.intervention) === stableStringify(fork.lineage.intervention)
  );
}

function receiptMatchesFork(
  receipt: ReceiptV1,
  receiptEvent: StoredEventV1,
  events: readonly StoredEventV1[],
  fork: ExecutionForkRecordV1,
): boolean {
  const branchId = receipt.branchId ?? receipt.rootBranchId;
  const verifiedHead = events.find((event) => event.seq === receipt.verifiedThroughSeq);
  return (
    receiptEvent.type === 'receipt.issued' &&
    receiptEvent.payload.receipt.receiptId === receipt.receiptId &&
    receiptEvent.seq > receipt.verifiedThroughSeq &&
    verifiedHead?.hash === receipt.verifiedHeadHash &&
    receipt.missionId === fork.lineage.missionId &&
    receipt.contractId === fork.lineage.contractId &&
    branchId === fork.lineage.childBranchId
  );
}

function hasDeterministicEvaluationBinding(
  fork: ExecutionForkRecordV1,
  receipt: ReceiptV1,
  evidenceRefs: readonly string[],
): boolean {
  if (evidenceRefs.length === 0 || fork.receiptInput === undefined) return false;
  const forkRefs = new Set([
    ...(fork.runtimeResult?.verificationEvidenceRefs ?? []),
    ...fork.receiptInput.verificationEvidenceRefs,
  ]);
  const receiptRefs = new Set(receipt.verifications.flatMap((item) => item.evidenceRefs));
  return evidenceRefs.every((reference) => forkRefs.has(reference) && receiptRefs.has(reference));
}

function hasRequiredInterventionEvidence(fork: ExecutionForkRecordV1): boolean {
  if (fork.lineage.intervention.kind !== 'context') return true;
  const resultRefs = fork.runtimeResult?.contextEvidenceRefs ?? [];
  const receiptRefs = fork.receiptInput?.contextEvidenceRefs ?? [];
  if (resultRefs.length === 0 || receiptRefs.length === 0) return false;
  const evidenceByRef = new Map(
    fork.runtimeEvidence.map((evidence) => [`evidence:${evidence.evidenceId}`, evidence]),
  );
  const allRefs = uniqueSorted([...resultRefs, ...receiptRefs]);
  if (allRefs.some((reference) => !evidenceByRef.has(reference))) return false;
  const contextEvidence = allRefs
    .map((reference) => evidenceByRef.get(reference))
    .filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined);
  if (contextEvidence.length === 0) return false;
  const intervention = fork.lineage.intervention;
  return (
    contextEvidence.every((evidence) => evidence.kind === 'model') &&
    contextEvidence.some((evidence) => {
      const refs = new Set(evidence.evidenceRefs);
      const boundDigestRef = [...refs].find((ref) => ref.startsWith('context-bound-digest:'));
      return (
        refs.has('context-mode:refreshed') &&
        refs.has(`context-current-digest:${intervention.afterDigest}`) &&
        boundDigestRef !== undefined &&
        boundDigestRef !== `context-bound-digest:${intervention.afterDigest}`
      );
    })
  );
}

function detectionMatchesEvent(detection: RuntimeDetection, event: StoredEventV1): boolean {
  if (event.type === 'runtime.catalog_observed') {
    const observation = event.payload.observation;
    const expectedStatus =
      observation.availability === 'ready'
        ? 'ready'
        : observation.availability === 'missing'
          ? 'missing'
          : undefined;
    return (
      observation.harness === detection.runtime &&
      (expectedStatus === undefined || detection.status === expectedStatus)
    );
  }
  return (
    event.type === 'runtime.observation' &&
    event.payload.kind === 'runtime.adapter.detected' &&
    stableStringify(event.payload.data) === stableStringify(detection)
  );
}

function runMatchesEvent(run: RuntimeRunResult, event: StoredEventV1): boolean {
  if (
    event.type !== 'runtime.observation' ||
    event.payload.kind !== 'runtime.process_finished' ||
    !isRecord(event.payload.data)
  ) {
    return false;
  }
  const data = event.payload.data;
  return (
    data.harness === run.runtime &&
    data.exitCode === run.process.exitCode &&
    data.signal === run.process.signal &&
    data.aborted === run.process.aborted
  );
}

function toolRequest(
  data: Record<string, JsonValue>,
  event: Extract<StoredEventV1, { readonly type: 'runtime.observation' }>,
): ToolGateRequestV1 | undefined {
  if (
    data.schemaVersion !== 1 ||
    !nonEmptyString(data.gateId) ||
    !nonEmptyString(data.effectId) ||
    !nonEmptyString(data.toolUseIdSha256) ||
    !nonEmptyString(data.sessionIdSha256) ||
    !nonEmptyString(data.originalInputSha256) ||
    !nonEmptyString(data.requestSha256) ||
    data.missionId !== event.missionId ||
    !nonEmptyString(data.attemptId) ||
    data.attemptId !== event.attemptId ||
    data.hookEventName !== 'PreToolUse' ||
    !nonEmptyString(data.toolName) ||
    !isRecord(data.toolInput) ||
    !nonEmptyString(data.requestedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    gateId: data.gateId,
    effectId: data.effectId,
    toolUseIdSha256: data.toolUseIdSha256,
    sessionIdSha256: data.sessionIdSha256,
    originalInputSha256: data.originalInputSha256,
    requestSha256: data.requestSha256,
    missionId: data.missionId,
    attemptId: data.attemptId,
    hookEventName: 'PreToolUse',
    toolName: data.toolName,
    toolInput: clone(data.toolInput),
    requestedAt: data.requestedAt,
  };
}

function toolDecisionIntent(
  data: Record<string, JsonValue>,
  event: Extract<StoredEventV1, { readonly type: 'runtime.observation' }>,
): ToolDecisionIntentV1 | undefined {
  if (
    data.schemaVersion !== 1 ||
    !nonEmptyString(data.decisionIntentId) ||
    data.missionId !== event.missionId ||
    !nonEmptyString(data.attemptId) ||
    data.attemptId !== event.attemptId ||
    !nonEmptyString(data.gateId) ||
    !nonEmptyString(data.effectId) ||
    !nonEmptyString(data.expectedRequestSha256) ||
    (data.decision !== 'approve' && data.decision !== 'reject' && data.decision !== 'modify') ||
    !nonEmptyString(data.createdAt) ||
    (data.reason !== undefined && typeof data.reason !== 'string') ||
    (data.updatedInput !== undefined && !isRecord(data.updatedInput))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    decisionIntentId: data.decisionIntentId,
    missionId: data.missionId,
    attemptId: data.attemptId,
    gateId: data.gateId,
    effectId: data.effectId,
    expectedRequestSha256: data.expectedRequestSha256,
    decision: data.decision,
    ...(data.reason === undefined ? {} : { reason: data.reason }),
    ...(data.updatedInput === undefined ? {} : { updatedInput: clone(data.updatedInput) }),
    createdAt: data.createdAt,
  };
}

function toolRelease(
  data: Record<string, JsonValue>,
  event: Extract<StoredEventV1, { readonly type: 'runtime.observation' }>,
): ToolReleaseV1 | undefined {
  const kernel = isRecord(data.kernelDecisionEvent) ? data.kernelDecisionEvent : undefined;
  if (
    data.schemaVersion !== 1 ||
    !nonEmptyString(data.releaseId) ||
    data.missionId !== event.missionId ||
    !nonEmptyString(data.attemptId) ||
    data.attemptId !== event.attemptId ||
    !nonEmptyString(data.gateId) ||
    !nonEmptyString(data.effectId) ||
    !nonEmptyString(data.requestSha256) ||
    !nonEmptyString(data.decisionIntentId) ||
    (data.decision !== 'approve' && data.decision !== 'reject' && data.decision !== 'modify') ||
    kernel === undefined ||
    !nonEmptyString(kernel.eventId) ||
    !safePositiveInteger(kernel.seq) ||
    !nonEmptyString(kernel.hash) ||
    !nonEmptyString(kernel.recordedAt) ||
    !nonEmptyString(data.releasedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    releaseId: data.releaseId,
    missionId: data.missionId,
    attemptId: data.attemptId,
    gateId: data.gateId,
    effectId: data.effectId,
    requestSha256: data.requestSha256,
    decisionIntentId: data.decisionIntentId,
    decision: data.decision,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(isRecord(data.updatedInput) ? { updatedInput: clone(data.updatedInput) } : {}),
    kernelDecisionEvent: {
      eventId: kernel.eventId,
      seq: kernel.seq,
      hash: kernel.hash,
      recordedAt: kernel.recordedAt,
    },
    releasedAt: data.releasedAt,
  };
}

function toolResult(
  data: Record<string, JsonValue>,
  event: Extract<StoredEventV1, { readonly type: 'runtime.observation' }>,
): ToolResultV1 | undefined {
  if (
    data.schemaVersion !== 1 ||
    !nonEmptyString(data.resultId) ||
    data.missionId !== event.missionId ||
    !nonEmptyString(data.attemptId) ||
    data.attemptId !== event.attemptId ||
    !nonEmptyString(data.gateId) ||
    !nonEmptyString(data.effectId) ||
    (data.hookEventName !== 'PostToolUse' && data.hookEventName !== 'PostToolUseFailure') ||
    (data.outcome !== 'succeeded' && data.outcome !== 'failed') ||
    !nonEmptyString(data.resultSha256) ||
    !nonEmptyString(data.observedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    resultId: data.resultId,
    missionId: data.missionId,
    attemptId: data.attemptId,
    gateId: data.gateId,
    effectId: data.effectId,
    hookEventName: data.hookEventName,
    outcome: data.outcome,
    resultSha256: data.resultSha256,
    observedAt: data.observedAt,
  };
}

function validatedRuntimeFact(
  value: unknown,
  event: Extract<StoredEventV1, { readonly type: 'runtime.event' }>['payload']['event'],
): RuntimeSemanticFactV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schemaVersion !== 1 ||
    !nonEmptyString(value.factId) ||
    value.sourceRuntimeEventId !== event.runtimeEventId ||
    value.sourceHarness !== event.sourceHarness ||
    value.sourceProtocol !== event.sourceProtocol ||
    value.fidelity !== event.fidelity ||
    (value.evidence !== 'explicit' &&
      value.evidence !== 'derived' &&
      value.evidence !== 'unknown') ||
    stableStringify(value.artifact) !== stableStringify(event.nativeArtifact)
  ) {
    return undefined;
  }
  const evidence: 'explicit' | 'derived' | 'unknown' = value.evidence;
  const base = {
    schemaVersion: 1 as const,
    factId: value.factId,
    sourceRuntimeEventId: event.runtimeEventId,
    sourceHarness: event.sourceHarness,
    sourceProtocol: event.sourceProtocol,
    artifact: { ...event.nativeArtifact },
    fidelity: event.fidelity,
    evidence,
  };
  const phase = runtimePhase(value.phase);
  switch (value.kind) {
    case 'model_call':
      if (phase === undefined) return undefined;
      return {
        ...base,
        kind: 'model_call',
        phase,
        ...(nonEmptyString(value.nativeIdDigest) ? { nativeIdDigest: value.nativeIdDigest } : {}),
      };
    case 'context': {
      if (
        value.contextKind !== 'runtime_environment' &&
        value.contextKind !== 'model_input' &&
        value.contextKind !== 'compaction' &&
        value.contextKind !== 'unknown'
      ) {
        return undefined;
      }
      const counts = optionalCounts(value, [
        'itemCount',
        'toolCount',
        'skillCount',
        'mcpServerCount',
        'messageCount',
      ]);
      if (counts === undefined) return undefined;
      return { ...base, kind: 'context', contextKind: value.contextKind, ...counts };
    }
    case 'message':
      if (
        value.role !== 'system' &&
        value.role !== 'user' &&
        value.role !== 'assistant' &&
        value.role !== 'tool' &&
        value.role !== 'unknown'
      ) {
        return undefined;
      }
      if (
        !optionalNonNegativeInteger(value.partCount) ||
        !optionalBoolean(value.hasText) ||
        !optionalBoolean(value.hasToolRequest) ||
        !optionalBoolean(value.hasToolResult)
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: 'message',
        role: value.role,
        ...(nonEmptyString(value.nativeIdDigest) ? { nativeIdDigest: value.nativeIdDigest } : {}),
        ...(typeof value.partCount === 'number' ? { partCount: value.partCount } : {}),
        ...(typeof value.hasText === 'boolean' ? { hasText: value.hasText } : {}),
        ...(typeof value.hasToolRequest === 'boolean'
          ? { hasToolRequest: value.hasToolRequest }
          : {}),
        ...(typeof value.hasToolResult === 'boolean' ? { hasToolResult: value.hasToolResult } : {}),
      };
    case 'tool_request':
      return {
        ...base,
        kind: 'tool_request',
        ...optionalStringFields(value, ['toolName', 'toolCallIdDigest', 'parentToolCallIdDigest']),
      };
    case 'tool_result':
      if (
        phase === undefined ||
        !optionalBoolean(value.isError) ||
        !optionalInteger(value.exitCode)
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: 'tool_result',
        phase,
        ...optionalStringFields(value, ['toolName', 'toolCallIdDigest', 'parentToolCallIdDigest']),
        ...(typeof value.isError === 'boolean' ? { isError: value.isError } : {}),
        ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
      };
    case 'workspace_change':
      if (
        !nonNegativeInteger(value.changeCount) ||
        !stringArrayOnly(value.pathDigests) ||
        !Array.isArray(value.changeKinds) ||
        !value.changeKinds.every(
          (kind) =>
            kind === 'added' || kind === 'updated' || kind === 'deleted' || kind === 'unknown',
        )
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: 'workspace_change',
        changeCount: value.changeCount,
        pathDigests: [...value.pathDigests],
        changeKinds: [...value.changeKinds],
      };
    case 'test_run':
      if (
        phase === undefined ||
        (value.status !== 'passed' && value.status !== 'failed' && value.status !== 'unknown') ||
        !optionalInteger(value.exitCode)
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: 'test_run',
        phase,
        status: value.status,
        ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
        ...(nonEmptyString(value.toolCallIdDigest)
          ? { toolCallIdDigest: value.toolCallIdDigest }
          : {}),
      };
    case 'subagent_started':
    case 'subagent_finished':
      if (phase === undefined) return undefined;
      return {
        ...base,
        kind: value.kind,
        phase,
        ...optionalStringFields(value, ['actorIdDigest', 'parentActorIdDigest']),
      };
    case 'usage': {
      const counts = optionalCounts(value, [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'totalTokens',
      ]);
      if (
        counts === undefined ||
        (value.costUsd !== undefined &&
          (typeof value.costUsd !== 'number' ||
            !Number.isFinite(value.costUsd) ||
            value.costUsd < 0))
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: 'usage',
        ...counts,
        ...(typeof value.costUsd === 'number' ? { costUsd: value.costUsd } : {}),
      };
    }
    case 'failure':
      if (
        value.isError !== true ||
        (value.failureKind !== 'model' &&
          value.failureKind !== 'tool' &&
          value.failureKind !== 'runtime' &&
          value.failureKind !== 'unknown')
      ) {
        return undefined;
      }
      return {
        ...base,
        kind: 'failure',
        failureKind: value.failureKind,
        isError: true,
        ...(nonEmptyString(value.codeDigest) ? { codeDigest: value.codeDigest } : {}),
      };
    default:
      return undefined;
  }
}

function layerForRuntimeFact(fact: RuntimeSemanticFactV1): FailureLayerV1 | 'unknown' {
  switch (fact.kind) {
    case 'model_call':
    case 'message':
      return 'model';
    case 'context':
      return 'context';
    case 'tool_request':
    case 'tool_result':
    case 'test_run':
      return 'tool';
    case 'workspace_change':
      return 'environment';
    case 'usage':
    case 'subagent_started':
    case 'subagent_finished':
      return 'harness';
    case 'failure':
      return fact.failureKind === 'model'
        ? 'model'
        : fact.failureKind === 'tool'
          ? 'tool'
          : fact.failureKind === 'runtime'
            ? 'harness'
            : 'unknown';
  }
}

function digestEvidenceRefs(data: Record<string, JsonValue>): string[] {
  const references: string[] = [];
  for (const key of [
    'invocationDigest',
    'stdoutSha256',
    'stderrSha256',
    'artifactDigest',
    'resultSha256',
  ]) {
    const value = data[key];
    if (nonEmptyString(value)) references.push(`${key}:${value}`);
  }
  return references;
}

function gap(
  kind: MissionFailureEvidenceGapKindV1,
  layer: FailureLayerV1 | 'unknown',
  status: FailureConclusionStatusV1,
  evidenceRefs: readonly string[],
  detail: string,
): MissionFailureEvidenceGapV1 {
  const refs = uniqueSorted(evidenceRefs);
  return {
    gapId: `failure-gap-${shortHash(stableStringify({ kind, layer, status, refs, detail }))}`,
    kind,
    layer,
    status,
    evidenceRefs: refs,
    detail,
  };
}

function deduplicateGaps(
  gaps: readonly MissionFailureEvidenceGapV1[],
): MissionFailureEvidenceGapV1[] {
  return deduplicate(gaps, (item) => item.gapId);
}

function deduplicate<T>(values: readonly T[], key: (value: T) => string): T[] {
  const selected = new Map<string, T>();
  for (const value of values) if (!selected.has(key(value))) selected.set(key(value), value);
  return [...selected.values()].sort((left, right) => key(left).localeCompare(key(right)));
}

function optionalStringFields<const Key extends string>(
  value: Record<string, JsonValue>,
  keys: readonly Key[],
): Partial<Record<Key, string>> {
  const output: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const member = value[key];
    if (nonEmptyString(member)) output[key] = member;
  }
  return output;
}

function optionalCounts<const Key extends string>(
  value: Record<string, JsonValue>,
  keys: readonly Key[],
): Partial<Record<Key, number>> | undefined {
  const output: Partial<Record<Key, number>> = {};
  for (const key of keys) {
    const member = value[key];
    if (!optionalNonNegativeInteger(member)) return undefined;
    if (typeof member === 'number') output[key] = member;
  }
  return output;
}

function runtimePhase(value: JsonValue | undefined): RuntimeSemanticPhaseV1 | undefined {
  return value === 'started' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'unknown'
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((member): member is string => typeof member === 'string')
    : [];
}

function stringArrayOnly(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((member) => nonEmptyString(member));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value);
}

function optionalInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((member) => stableStringify(member)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`)
    .join(',')}}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

function requireIdentifier(value: string, field: string): void {
  if (!nonEmptyString(value)) {
    throw new MissionFailureIntelligenceProjectionError(`${field} must not be empty`);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
