/**
 * Rebuildable Failure Evidence Graph derived from persisted evidence.
 *
 * The projection never changes Mission state, never executes a diagnostic
 * Branch, and never treats array position or event arrival order as causality.
 */
import { createHash } from 'node:crypto';

import type { ContextGraphV1 } from './context-graph.js';
import type { VerificationResultV1 } from './domain.js';
import type { RuntimeSemanticFactV1 } from './runtime-semantics.js';
import type {
  ToolDecisionIntentV1,
  ToolGateRequestV1,
  ToolReleaseV1,
  ToolResultV1,
} from './tool-gateway.js';
import type {
  RuntimeAdapterCapabilities,
  RuntimeDetection,
  RuntimeRunResult,
} from './adapters/types.js';
import type { CommandVerificationResultV1 } from './verifier.js';

export const FAILURE_INTELLIGENCE_SCHEMA_VERSION = 1 as const;

export type FailureLayerV1 =
  | 'model'
  | 'context'
  | 'tool'
  | 'harness'
  | 'environment'
  | 'missionbraid';

export type FailureConclusionStatusV1 = 'observed' | 'inferred' | 'confirmed' | 'unknown';

export type FailureDetectorKindV1 =
  | 'loop'
  | 'repeated-failure'
  | 'stale-context'
  | 'permission-conflict'
  | 'tool-error'
  | 'workspace-divergence'
  | 'verification-failure'
  | 'adapter-failure'
  | 'unattributed';

export interface WorkspaceComparisonEvidenceV1 {
  readonly evidenceId: string;
  readonly boundaryId: string;
  readonly expectedWorkspaceDigest: string;
  readonly observedWorkspaceDigest: string;
  readonly evidenceRefs: readonly string[];
}

export interface ContextFreshnessEvidenceV1 {
  readonly evidenceId: string;
  readonly contextFactId: string;
  readonly boundWorkspaceDigest: string;
  readonly currentWorkspaceDigest: string;
  /** Optional content-level binding evidence. Older Runtime records may omit it. */
  readonly boundContextDigest?: string;
  readonly currentContextDigest?: string;
  readonly evidenceRefs: readonly string[];
}

export interface FailureVerificationEvidenceV1 {
  readonly evidenceId: string;
  readonly criterionId?: string;
  readonly result: VerificationResultV1 | CommandVerificationResultV1;
  readonly evidenceRefs: readonly string[];
}

export interface AdapterFailureEvidenceV1 {
  readonly evidenceId: string;
  readonly harness: string;
  readonly detection?: RuntimeDetection;
  readonly capabilities?: RuntimeAdapterCapabilities;
  readonly run?: RuntimeRunResult;
  readonly evidenceRefs: readonly string[];
}

export interface DiagnosticCheckpointEvidenceV1 {
  readonly checkpointId: string;
  readonly checkpointDigest: string;
  readonly completeness: 'composite' | 'boundary-only';
  readonly evidenceRefs: readonly string[];
}

export interface DiagnosticVariableV1 {
  readonly dimension: FailureLayerV1;
  readonly key: string;
  readonly operation: 'replace' | 'narrow' | 'expand' | 'refresh' | 'retry-with-alternative';
}

export interface DiagnosticBranchOutcomeV1 {
  readonly outcomeId: string;
  readonly candidateId: string;
  /** Exactly one declared variable; no implicit bundle of changes is accepted. */
  readonly changedVariable: DiagnosticVariableV1;
  readonly preservedCheckpointDigest: string;
  readonly evaluation: 'deterministic' | 'model-assisted';
  readonly result: 'mechanism-confirmed' | 'mechanism-refuted' | 'inconclusive';
  readonly evidenceRefs: readonly string[];
}

export interface ToolGatewayFailureEvidenceV1 {
  readonly requests?: readonly ToolGateRequestV1[];
  readonly decisionIntents?: readonly ToolDecisionIntentV1[];
  readonly releases?: readonly ToolReleaseV1[];
  readonly results?: readonly ToolResultV1[];
}

export interface FailureIntelligenceInputV1 {
  readonly persistedRuntimeFacts: readonly RuntimeSemanticFactV1[];
  readonly contextGraph?: ContextGraphV1;
  readonly contextFreshness?: readonly ContextFreshnessEvidenceV1[];
  readonly workspaceComparisons?: readonly WorkspaceComparisonEvidenceV1[];
  readonly verifications?: readonly FailureVerificationEvidenceV1[];
  readonly toolGateway?: ToolGatewayFailureEvidenceV1;
  readonly adapters?: readonly AdapterFailureEvidenceV1[];
  readonly checkpoint?: DiagnosticCheckpointEvidenceV1;
  readonly diagnosticOutcomes?: readonly DiagnosticBranchOutcomeV1[];
}

export type FailureGraphNodeKindV1 =
  | 'layer'
  | 'evidence'
  | 'candidate'
  | 'missing-evidence'
  | 'diagnostic-proposal';

export interface FailureGraphNodeV1 {
  readonly nodeId: string;
  readonly kind: FailureGraphNodeKindV1;
  readonly label: string;
  readonly layer?: FailureLayerV1 | 'unknown';
  readonly status?: FailureConclusionStatusV1;
  readonly evidenceRefs: readonly string[];
}

export type FailureGraphEdgeKindV1 =
  | 'located-in'
  | 'supports'
  | 'contradicts'
  | 'missing-for'
  | 'proposes';

export interface FailureGraphEdgeV1 {
  readonly edgeId: string;
  readonly kind: FailureGraphEdgeKindV1;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly evidenceRefs: readonly string[];
}

export interface FailureCandidateV1 {
  readonly candidateId: string;
  readonly detector: FailureDetectorKindV1;
  readonly layer: FailureLayerV1 | 'unknown';
  readonly title: string;
  readonly status: FailureConclusionStatusV1;
  /** Evidence-priority score, not a probability. */
  readonly rankScore: number;
  readonly rank: number;
  readonly supportingEvidenceRefs: readonly string[];
  readonly counterEvidenceRefs: readonly string[];
  readonly decisiveEvidenceRefs: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly recommendedAction: string;
}

export interface DiagnosticBranchProposalV1 {
  readonly proposalId: string;
  readonly candidateId: string;
  readonly execution: 'proposal-only';
  readonly ready: boolean;
  readonly baseCheckpointId?: string;
  readonly baseCheckpointDigest?: string;
  readonly changedVariable: DiagnosticVariableV1;
  readonly preserve: readonly ['outcome-contract', 'checkpointed-comparison-boundary'];
  readonly expectedDiscriminator: string;
  readonly requiresExplicitAuthorization: boolean;
  readonly missingPreconditions: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface FailureEvidenceGraphV1 {
  readonly schemaVersion: typeof FAILURE_INTELLIGENCE_SCHEMA_VERSION;
  readonly authority: 'derived-evidence-only';
  readonly nodes: readonly FailureGraphNodeV1[];
  readonly edges: readonly FailureGraphEdgeV1[];
  readonly candidates: readonly FailureCandidateV1[];
  readonly diagnosticBranchProposals: readonly DiagnosticBranchProposalV1[];
}

interface EvidenceRecord {
  readonly evidenceId: string;
  readonly layer: FailureLayerV1 | 'unknown';
  readonly label: string;
  readonly evidenceRefs: readonly string[];
}

interface FailureSignal {
  readonly signature: string;
  readonly counterSignature: string;
  readonly layer: FailureLayerV1;
  readonly evidenceId: string;
}

interface FindingDraft {
  readonly detector: FailureDetectorKindV1;
  readonly layer: FailureLayerV1 | 'unknown';
  readonly mechanismKey: string;
  readonly title: string;
  readonly baseStatus: FailureConclusionStatusV1;
  readonly supportingEvidenceIds: readonly string[];
  readonly counterEvidenceIds: readonly string[];
  readonly decisiveEvidenceIds: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly recommendedAction: string;
}

interface MutableFinding {
  readonly detector: FailureDetectorKindV1;
  readonly layer: FailureLayerV1 | 'unknown';
  readonly mechanismKey: string;
  title: string;
  baseStatus: FailureConclusionStatusV1;
  status: FailureConclusionStatusV1;
  readonly supportingEvidenceIds: Set<string>;
  readonly counterEvidenceIds: Set<string>;
  readonly decisiveEvidenceIds: Set<string>;
  readonly missingEvidence: Set<string>;
  recommendedAction: string;
}

const LAYERS: readonly FailureLayerV1[] = [
  'model',
  'context',
  'tool',
  'harness',
  'environment',
  'missionbraid',
];

/** Derives a deterministic, non-authoritative Failure Evidence Graph. */
export function deriveFailureIntelligence(
  input: FailureIntelligenceInputV1,
): FailureEvidenceGraphV1 {
  const evidence = new Map<string, EvidenceRecord>();
  const findings = new Map<string, MutableFinding>();
  const failures: FailureSignal[] = [];
  const successes: FailureSignal[] = [];

  const registerEvidence = (record: EvidenceRecord): void => {
    const previous = evidence.get(record.evidenceId);
    if (previous === undefined) {
      evidence.set(record.evidenceId, {
        ...record,
        evidenceRefs: uniqueSorted([record.evidenceId, ...record.evidenceRefs]),
      });
      return;
    }
    evidence.set(record.evidenceId, {
      ...previous,
      evidenceRefs: uniqueSorted([...previous.evidenceRefs, ...record.evidenceRefs]),
    });
  };

  const addFinding = (draft: FindingDraft): string => {
    const candidateId = candidateIdentity(draft.detector, draft.layer, draft.mechanismKey);
    const current = findings.get(candidateId);
    if (current === undefined) {
      findings.set(candidateId, {
        detector: draft.detector,
        layer: draft.layer,
        mechanismKey: draft.mechanismKey,
        title: draft.title,
        baseStatus: draft.baseStatus,
        status: draft.baseStatus,
        supportingEvidenceIds: new Set(draft.supportingEvidenceIds),
        counterEvidenceIds: new Set(draft.counterEvidenceIds),
        decisiveEvidenceIds: new Set(draft.decisiveEvidenceIds),
        missingEvidence: new Set(draft.missingEvidence),
        recommendedAction: draft.recommendedAction,
      });
      return candidateId;
    }
    current.title = draft.title;
    if (statusRank(draft.baseStatus) > statusRank(current.baseStatus)) {
      current.baseStatus = draft.baseStatus;
      current.status = draft.baseStatus;
    }
    draft.supportingEvidenceIds.forEach((id) => current.supportingEvidenceIds.add(id));
    draft.counterEvidenceIds.forEach((id) => current.counterEvidenceIds.add(id));
    draft.decisiveEvidenceIds.forEach((id) => current.decisiveEvidenceIds.add(id));
    draft.missingEvidence.forEach((item) => current.missingEvidence.add(item));
    current.recommendedAction = draft.recommendedAction;
    return candidateId;
  };

  const facts = deduplicateBy(input.persistedRuntimeFacts, (fact) => fact.factId);
  for (const fact of facts) {
    const layer = runtimeFactLayer(fact);
    registerEvidence({
      evidenceId: fact.factId,
      layer,
      label: runtimeFactLabel(fact),
      evidenceRefs: [fact.sourceRuntimeEventId, fact.artifact.artifactId],
    });
    collectRuntimeFailureSignal(fact, failures, successes);
  }

  collectContextEvidence(input, registerEvidence, addFinding);
  collectWorkspaceEvidence(input, registerEvidence, addFinding);
  collectVerificationEvidence(input, registerEvidence, addFinding, failures, successes);
  collectToolGatewayEvidence(input, registerEvidence, addFinding, failures, successes);
  collectAdapterEvidence(input, registerEvidence, addFinding, failures, successes);
  detectToolErrors(facts, input.toolGateway, successes, addFinding);
  detectRepeatedFailures(failures, successes, addFinding);
  detectExactRequestLoops(
    input.toolGateway?.requests ?? [],
    input.toolGateway?.results ?? [],
    addFinding,
  );

  const hasMechanismBeforeVerification = [...findings.values()].some(
    (finding) => finding.detector !== 'verification-failure',
  );
  if (findings.size === 0 || (failures.length > 0 && !hasMechanismBeforeVerification)) {
    const unknownEvidence = uniqueSorted([
      ...failures.map((failure) => failure.evidenceId),
      ...[...evidence.values()]
        .filter((record) => record.label.includes('unavailable'))
        .map((record) => record.evidenceId),
    ]);
    addFinding({
      detector: 'unattributed',
      layer: 'unknown',
      mechanismKey: 'no-deterministic-mechanism',
      title: 'No deterministic upstream failure mechanism is established',
      baseStatus: 'unknown',
      supportingEvidenceIds: unknownEvidence,
      counterEvidenceIds: [],
      decisiveEvidenceIds: [],
      missingEvidence:
        failures.length === 0
          ? [
              'A persisted failure symptom with a stable identity',
              'Evidence connecting the symptom to model, context, tool, Harness, environment, or MissionBraid',
            ]
          : [
              'Evidence connecting the terminal failure symptom to model, context, tool, Harness, environment, or MissionBraid',
            ],
      recommendedAction:
        'Collect the missing layer-specific evidence before changing execution inputs.',
    });
  }

  applyDiagnosticOutcomes(
    input.diagnosticOutcomes ?? [],
    findings,
    registerEvidence,
    input.checkpoint,
  );

  const provisional = [...findings.entries()].map(([candidateId, finding]) =>
    materializeCandidate(candidateId, finding, evidence),
  );
  provisional.sort(compareCandidates);
  const candidates: FailureCandidateV1[] = provisional.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
  const proposals = candidates
    .filter((candidate) => candidate.status !== 'unknown')
    .map((candidate) => diagnosticProposal(candidate, input.checkpoint));
  const { nodes, edges } = buildGraph(evidence, candidates, proposals);

  return {
    schemaVersion: FAILURE_INTELLIGENCE_SCHEMA_VERSION,
    authority: 'derived-evidence-only',
    nodes,
    edges,
    candidates,
    diagnosticBranchProposals: proposals,
  };
}

function collectContextEvidence(
  input: FailureIntelligenceInputV1,
  registerEvidence: (record: EvidenceRecord) => void,
  addFinding: (draft: FindingDraft) => string,
): void {
  for (const boundary of input.contextGraph?.unavailable ?? []) {
    const layer: FailureLayerV1 = boundary.kind === 'hidden-model-state' ? 'model' : 'context';
    registerEvidence({
      evidenceId: boundary.boundaryId,
      layer,
      label: `context unavailable: ${boundary.kind}`,
      evidenceRefs: boundary.evidenceRefs,
    });
  }
  for (const diff of input.contextGraph?.contextDiffs ?? []) {
    registerEvidence({
      evidenceId: diff.diffId,
      layer: 'context',
      label: 'observable adjacent model context diff',
      evidenceRefs: [diff.fromRuntimeEventId, diff.toRuntimeEventId],
    });
  }

  const freshness = deduplicateBy(input.contextFreshness ?? [], (item) => item.evidenceId);
  for (const item of freshness) {
    const contentStale = contextContentDiffers(item);
    const workspaceStale = item.boundWorkspaceDigest !== item.currentWorkspaceDigest;
    registerEvidence({
      evidenceId: item.evidenceId,
      layer: 'context',
      label: contentStale
        ? 'context content differs from the bound snapshot'
        : workspaceStale
          ? 'context binding differs from current workspace'
          : 'context binding matches current workspace',
      evidenceRefs: [item.contextFactId, ...item.evidenceRefs],
    });
  }
  for (const stale of freshness.filter(
    (item) =>
      contextContentDiffers(item) ||
      (noContentDigestEvidence(item) && item.boundWorkspaceDigest !== item.currentWorkspaceDigest),
  )) {
    const counter = freshness
      .filter(
        (item) =>
          item.contextFactId === stale.contextFactId &&
          !contextContentDiffers(item) &&
          (item.boundWorkspaceDigest === item.currentWorkspaceDigest ||
            noContentDigestEvidence(item)),
      )
      .map((item) => item.evidenceId);
    addFinding({
      detector: 'stale-context',
      layer: 'context',
      mechanismKey: stale.contextFactId,
      title: 'Model context is bound to an older Context or workspace frontier',
      baseStatus: 'inferred',
      supportingEvidenceIds: [stale.evidenceId],
      counterEvidenceIds: counter,
      decisiveEvidenceIds: [stale.evidenceId],
      missingEvidence: [
        'A single-variable context refresh outcome on the same composite Checkpoint',
      ],
      recommendedAction: 'Refresh only the bound context snapshot on a diagnostic Branch.',
    });
  }
}

function contextContentDiffers(item: ContextFreshnessEvidenceV1): boolean {
  return (
    item.boundContextDigest !== undefined &&
    item.currentContextDigest !== undefined &&
    item.boundContextDigest !== item.currentContextDigest
  );
}

function noContentDigestEvidence(item: ContextFreshnessEvidenceV1): boolean {
  return item.boundContextDigest === undefined || item.currentContextDigest === undefined;
}

function collectWorkspaceEvidence(
  input: FailureIntelligenceInputV1,
  registerEvidence: (record: EvidenceRecord) => void,
  addFinding: (draft: FindingDraft) => string,
): void {
  const comparisons = deduplicateBy(input.workspaceComparisons ?? [], (item) => item.evidenceId);
  for (const item of comparisons) {
    const diverged = item.expectedWorkspaceDigest !== item.observedWorkspaceDigest;
    registerEvidence({
      evidenceId: item.evidenceId,
      layer: 'environment',
      label: diverged
        ? 'workspace digest diverged at boundary'
        : 'workspace digest matched boundary',
      evidenceRefs: [item.boundaryId, ...item.evidenceRefs],
    });
    if (!diverged) continue;
    const counter = comparisons
      .filter(
        (candidate) =>
          candidate.boundaryId === item.boundaryId &&
          candidate.expectedWorkspaceDigest === candidate.observedWorkspaceDigest,
      )
      .map((candidate) => candidate.evidenceId);
    addFinding({
      detector: 'workspace-divergence',
      layer: 'environment',
      mechanismKey: item.boundaryId,
      title: 'Observed workspace differs from the recorded boundary',
      baseStatus: 'observed',
      supportingEvidenceIds: [item.evidenceId],
      counterEvidenceIds: counter,
      decisiveEvidenceIds: [item.evidenceId],
      missingEvidence: ['A complete composite Checkpoint capable of restoring this exact boundary'],
      recommendedAction: 'Compare or restore only the workspace component on a diagnostic Branch.',
    });
  }
}

function collectVerificationEvidence(
  input: FailureIntelligenceInputV1,
  registerEvidence: (record: EvidenceRecord) => void,
  addFinding: (draft: FindingDraft) => string,
  failures: FailureSignal[],
  successes: FailureSignal[],
): void {
  const records = deduplicateBy(input.verifications ?? [], (item) => item.evidenceId);
  for (const item of records) {
    const status = verificationStatus(item.result);
    const key = verificationKey(item);
    registerEvidence({
      evidenceId: item.evidenceId,
      layer: 'missionbraid',
      label: `verification ${status}`,
      evidenceRefs: item.evidenceRefs,
    });
    const signal: FailureSignal = {
      signature: `verification:${key}`,
      counterSignature: `verification:${key}`,
      layer: 'missionbraid',
      evidenceId: item.evidenceId,
    };
    if (status === 'failed') failures.push(signal);
    if (status === 'passed') successes.push(signal);
  }

  for (const failed of records.filter((item) => verificationStatus(item.result) === 'failed')) {
    const key = verificationKey(failed);
    const counter = records
      .filter(
        (candidate) =>
          verificationKey(candidate) === key && verificationStatus(candidate.result) === 'passed',
      )
      .map((candidate) => candidate.evidenceId);
    addFinding({
      detector: 'verification-failure',
      layer: 'missionbraid',
      mechanismKey: key,
      title: 'Bound verification evidence failed',
      baseStatus: 'observed',
      supportingEvidenceIds: [failed.evidenceId],
      counterEvidenceIds: counter,
      decisiveEvidenceIds: [failed.evidenceId],
      missingEvidence: ['Evidence locating the failing mechanism before the verifier boundary'],
      recommendedAction:
        'Preserve the criterion and isolate one upstream input on a diagnostic Branch.',
    });
  }
}

function collectToolGatewayEvidence(
  input: FailureIntelligenceInputV1,
  registerEvidence: (record: EvidenceRecord) => void,
  addFinding: (draft: FindingDraft) => string,
  failures: FailureSignal[],
  successes: FailureSignal[],
): void {
  const gateway = input.toolGateway;
  const requests = deduplicateBy(gateway?.requests ?? [], (item) => item.gateId);
  const requestByGate = new Map(requests.map((request) => [request.gateId, request]));
  for (const request of requests) {
    registerEvidence({
      evidenceId: request.gateId,
      layer: 'tool',
      label: `pre-tool request: ${request.toolName}`,
      evidenceRefs: [request.effectId, request.requestSha256],
    });
  }
  const intents = deduplicateBy(gateway?.decisionIntents ?? [], (item) => item.decisionIntentId);
  for (const intent of intents) {
    registerEvidence({
      evidenceId: intent.decisionIntentId,
      layer: 'missionbraid',
      label: `tool decision intent: ${intent.decision}`,
      evidenceRefs: [intent.gateId, intent.effectId],
    });
  }
  const releases = deduplicateBy(gateway?.releases ?? [], (item) => item.releaseId);
  for (const release of releases) {
    registerEvidence({
      evidenceId: release.releaseId,
      layer: 'missionbraid',
      label: `persisted tool release: ${release.decision}`,
      evidenceRefs: [
        release.gateId,
        release.effectId,
        release.decisionIntentId,
        release.kernelDecisionEvent.eventId,
      ],
    });
    if (release.decision !== 'reject') continue;
    addFinding({
      detector: 'permission-conflict',
      layer: 'missionbraid',
      mechanismKey: release.gateId,
      title: 'A requested tool was explicitly denied before dispatch',
      baseStatus: 'observed',
      supportingEvidenceIds: [release.releaseId, release.gateId],
      counterEvidenceIds: releases
        .filter(
          (candidate) => candidate.gateId === release.gateId && candidate.decision !== 'reject',
        )
        .map((candidate) => candidate.releaseId),
      decisiveEvidenceIds: [release.releaseId],
      missingEvidence: ['Evidence that this denied operation was required by the failed criterion'],
      recommendedAction:
        'Review the denied capability; any authority expansion requires an explicit Grant.',
    });
  }
  const releasedIntentIds = new Set(releases.map((release) => release.decisionIntentId));
  for (const intent of intents.filter(
    (candidate) =>
      candidate.decision === 'reject' && !releasedIntentIds.has(candidate.decisionIntentId),
  )) {
    addFinding({
      detector: 'permission-conflict',
      layer: 'missionbraid',
      mechanismKey: intent.gateId,
      title: 'A rejection intent exists without a persisted release',
      baseStatus: 'unknown',
      supportingEvidenceIds: [intent.decisionIntentId],
      counterEvidenceIds: [],
      decisiveEvidenceIds: [],
      missingEvidence: ['A Kernel-persisted decision event and matching Tool Gateway release'],
      recommendedAction:
        'Wait for or reconcile the authoritative decision before attributing the failure.',
    });
  }

  for (const result of deduplicateBy(gateway?.results ?? [], (item) => item.resultId)) {
    const request = requestByGate.get(result.gateId);
    const toolName = request?.toolName ?? 'unknown-tool';
    registerEvidence({
      evidenceId: result.resultId,
      layer: 'tool',
      label: `tool result ${result.outcome}: ${toolName}`,
      evidenceRefs: [result.gateId, result.effectId, result.resultSha256],
    });
    const signal: FailureSignal = {
      signature: `tool:${toolName}:${result.resultSha256}`,
      counterSignature: `tool:${toolName}`,
      layer: 'tool',
      evidenceId: result.resultId,
    };
    if (result.outcome === 'failed') failures.push(signal);
    else successes.push(signal);
  }
}

function collectAdapterEvidence(
  input: FailureIntelligenceInputV1,
  registerEvidence: (record: EvidenceRecord) => void,
  addFinding: (draft: FindingDraft) => string,
  failures: FailureSignal[],
  successes: FailureSignal[],
): void {
  for (const item of deduplicateBy(input.adapters ?? [], (candidate) => candidate.evidenceId)) {
    const detectionFailure = adapterDetectionFailure(item.detection);
    const processFailure = adapterProcessFailure(item.run);
    const layer = detectionFailure?.layer ?? processFailure?.layer ?? 'harness';
    const status = detectionFailure ?? processFailure;
    registerEvidence({
      evidenceId: item.evidenceId,
      layer,
      label: status === undefined ? `adapter ready: ${item.harness}` : status.label,
      evidenceRefs: item.evidenceRefs,
    });
    const signal: FailureSignal = {
      signature: `adapter:${item.harness}:${status?.mechanism ?? 'ready'}`,
      counterSignature: `adapter:${item.harness}`,
      layer,
      evidenceId: item.evidenceId,
    };
    if (status === undefined) successes.push(signal);
    else failures.push(signal);
    if (status === undefined) continue;
    addFinding({
      detector: 'adapter-failure',
      layer: status.layer,
      mechanismKey: `${item.harness}:${status.mechanism}`,
      title: status.label,
      baseStatus: 'observed',
      supportingEvidenceIds: [item.evidenceId],
      counterEvidenceIds: [],
      decisiveEvidenceIds: [item.evidenceId],
      missingEvidence: [
        'A same-Profile diagnostic run after changing only the implicated adapter input',
      ],
      recommendedAction:
        status.layer === 'environment'
          ? 'Change only the unavailable executable or process environment on a diagnostic Branch.'
          : 'Retry with one alternate Harness Profile while preserving all other inputs.',
    });
  }
}

function detectToolErrors(
  facts: readonly RuntimeSemanticFactV1[],
  gateway: ToolGatewayFailureEvidenceV1 | undefined,
  successes: readonly FailureSignal[],
  addFinding: (draft: FindingDraft) => string,
): void {
  const failedToolFacts = facts.filter(
    (fact) =>
      (fact.kind === 'tool_result' &&
        (fact.isError === true ||
          fact.phase === 'failed' ||
          (fact.exitCode !== undefined && fact.exitCode !== 0))) ||
      (fact.kind === 'failure' && fact.failureKind === 'tool'),
  );
  const requestByGate = new Map(
    (gateway?.requests ?? []).map((request) => [request.gateId, request]),
  );
  const grouped = new Map<string, string[]>();
  for (const fact of failedToolFacts) {
    const toolName =
      fact.kind === 'tool_result' ? (fact.toolName ?? 'unknown-tool') : 'unknown-tool';
    addGrouped(grouped, toolName, fact.factId);
  }
  for (const result of gateway?.results ?? []) {
    if (result.outcome !== 'failed') continue;
    addGrouped(
      grouped,
      requestByGate.get(result.gateId)?.toolName ?? 'unknown-tool',
      result.resultId,
    );
  }
  for (const [toolName, support] of grouped) {
    const counter = successes
      .filter((signal) => signal.layer === 'tool' && signal.counterSignature === `tool:${toolName}`)
      .map((signal) => signal.evidenceId);
    addFinding({
      detector: 'tool-error',
      layer: 'tool',
      mechanismKey: toolName,
      title: `Tool execution failed: ${toolName}`,
      baseStatus: 'observed',
      supportingEvidenceIds: support,
      counterEvidenceIds: counter,
      decisiveEvidenceIds: support,
      missingEvidence: [
        'A single-variable retry showing whether correcting this tool changes verification',
      ],
      recommendedAction: 'Change only this tool input or implementation on a diagnostic Branch.',
    });
  }
}

function detectRepeatedFailures(
  failures: readonly FailureSignal[],
  successes: readonly FailureSignal[],
  addFinding: (draft: FindingDraft) => string,
): void {
  const bySignature = groupBy(failures, (signal) => signal.signature);
  for (const [signature, group] of bySignature) {
    const support = uniqueSorted(group.map((signal) => signal.evidenceId));
    if (support.length < 2) continue;
    const layer = group[0]?.layer ?? 'harness';
    const counterKeys = new Set(group.map((signal) => signal.counterSignature));
    const counter = successes
      .filter((signal) => counterKeys.has(signal.counterSignature))
      .map((signal) => signal.evidenceId);
    addFinding({
      detector: 'repeated-failure',
      layer,
      mechanismKey: signature,
      title: `The same failure fingerprint was observed ${String(support.length)} times`,
      baseStatus: 'inferred',
      supportingEvidenceIds: support,
      counterEvidenceIds: counter,
      decisiveEvidenceIds: support,
      missingEvidence: [
        'A discriminating run that changes one input while preserving the failure boundary',
      ],
      recommendedAction: `Probe one ${layer} input while preserving the same composite Checkpoint.`,
    });
  }
}

function detectExactRequestLoops(
  requests: readonly ToolGateRequestV1[],
  results: readonly ToolResultV1[],
  addFinding: (draft: FindingDraft) => string,
): void {
  const groups = groupBy(
    deduplicateBy(requests, (request) => request.gateId),
    (request) => `${request.attemptId}:${request.toolName}:${request.originalInputSha256}`,
  );
  const successfulResultsByGate = new Map(
    results
      .filter((result) => result.outcome === 'succeeded')
      .map((result) => [result.gateId, result.resultId]),
  );
  for (const [signature, group] of groups) {
    if (group.length < 3) continue;
    addFinding({
      detector: 'loop',
      layer: 'model',
      mechanismKey: signature,
      title: `The exact ${group[0]?.toolName ?? 'tool'} input was requested ${String(group.length)} times`,
      baseStatus: 'inferred',
      supportingEvidenceIds: group.map((request) => request.gateId),
      counterEvidenceIds: group.flatMap((request) => {
        const resultId = successfulResultsByGate.get(request.gateId);
        return resultId === undefined ? [] : [resultId];
      }),
      decisiveEvidenceIds: group.map((request) => request.gateId),
      missingEvidence: [
        'Evidence that the repeated requests pursued the same unresolved objective',
      ],
      recommendedAction:
        'Change only the repeated-action policy or model guidance on a diagnostic Branch.',
    });
  }
}

function collectRuntimeFailureSignal(
  fact: RuntimeSemanticFactV1,
  failures: FailureSignal[],
  successes: FailureSignal[],
): void {
  if (fact.kind === 'failure') {
    const layer = runtimeFactLayer(fact);
    failures.push({
      signature: `runtime:${fact.sourceHarness}:${fact.failureKind}:${fact.codeDigest ?? 'unknown'}`,
      counterSignature: `runtime:${fact.sourceHarness}:${fact.failureKind}`,
      layer: layer === 'unknown' ? 'harness' : layer,
      evidenceId: fact.factId,
    });
    return;
  }
  if (fact.kind === 'model_call') {
    const signal = {
      signature: `model:${fact.sourceHarness}:${fact.phase}`,
      counterSignature: `model:${fact.sourceHarness}`,
      layer: 'model' as const,
      evidenceId: fact.factId,
    };
    if (fact.phase === 'failed') failures.push(signal);
    if (fact.phase === 'completed') successes.push(signal);
    return;
  }
  if (fact.kind === 'tool_result') {
    const failed =
      fact.isError === true ||
      fact.phase === 'failed' ||
      (fact.exitCode !== undefined && fact.exitCode !== 0);
    const succeeded =
      fact.isError === false || fact.exitCode === 0 || (fact.phase === 'completed' && !failed);
    const toolName = fact.toolName ?? 'unknown-tool';
    const signal = {
      signature: `tool:${toolName}:${fact.exitCode ?? (fact.isError === true ? 'error' : fact.phase)}`,
      counterSignature: `tool:${toolName}`,
      layer: 'tool' as const,
      evidenceId: fact.factId,
    };
    if (failed) failures.push(signal);
    if (succeeded) successes.push(signal);
    return;
  }
  if (fact.kind === 'test_run') {
    const signal = {
      signature: `test:${fact.sourceHarness}:${fact.exitCode ?? fact.status}`,
      counterSignature: `test:${fact.sourceHarness}`,
      layer: 'tool' as const,
      evidenceId: fact.factId,
    };
    if (fact.status === 'failed') failures.push(signal);
    if (fact.status === 'passed') successes.push(signal);
  }
}

function applyDiagnosticOutcomes(
  outcomes: readonly DiagnosticBranchOutcomeV1[],
  findings: Map<string, MutableFinding>,
  registerEvidence: (record: EvidenceRecord) => void,
  checkpoint: DiagnosticCheckpointEvidenceV1 | undefined,
): void {
  for (const outcome of deduplicateBy(outcomes, (item) => item.outcomeId)) {
    validateDiagnosticOutcome(outcome);
    const finding = findings.get(outcome.candidateId);
    registerEvidence({
      evidenceId: outcome.outcomeId,
      layer: outcome.changedVariable.dimension,
      label: `diagnostic outcome: ${outcome.result}`,
      evidenceRefs: outcome.evidenceRefs,
    });
    if (finding === undefined) continue;
    const expectedVariable = diagnosticVariable(finding);
    const matchesProposal =
      stableStringify(outcome.changedVariable) === stableStringify(expectedVariable);
    const matchesCheckpoint =
      checkpoint?.completeness === 'composite' &&
      checkpoint.checkpointDigest === outcome.preservedCheckpointDigest;
    if (!matchesProposal) {
      finding.missingEvidence.add(
        'A diagnostic outcome that changes exactly the variable proposed for this candidate',
      );
      continue;
    }
    if (!matchesCheckpoint) {
      finding.missingEvidence.add(
        'A diagnostic outcome bound to the same complete composite Checkpoint',
      );
      continue;
    }
    if (outcome.result === 'mechanism-refuted') {
      finding.counterEvidenceIds.add(outcome.outcomeId);
      continue;
    }
    if (outcome.result !== 'mechanism-confirmed') continue;
    finding.supportingEvidenceIds.add(outcome.outcomeId);
    if (outcome.evaluation === 'deterministic') {
      finding.status = 'confirmed';
      finding.decisiveEvidenceIds.clear();
      finding.decisiveEvidenceIds.add(outcome.outcomeId);
      finding.missingEvidence.delete(
        'A single-variable retry showing whether correcting this tool changes verification',
      );
    } else {
      finding.missingEvidence.add('A deterministic evaluator for the diagnostic Branch outcome');
    }
  }
}

function materializeCandidate(
  candidateId: string,
  finding: MutableFinding,
  evidence: ReadonlyMap<string, EvidenceRecord>,
): Omit<FailureCandidateV1, 'rank'> {
  const supportingEvidenceRefs = expandEvidenceRefs(finding.supportingEvidenceIds, evidence);
  const counterEvidenceRefs = expandEvidenceRefs(finding.counterEvidenceIds, evidence);
  const decisiveEvidenceRefs = expandEvidenceRefs(finding.decisiveEvidenceIds, evidence);
  const status = finding.status;
  return {
    candidateId,
    detector: finding.detector,
    layer: finding.layer,
    title: finding.title,
    status,
    rankScore: scoreCandidate(status, supportingEvidenceRefs.length, counterEvidenceRefs.length),
    supportingEvidenceRefs,
    counterEvidenceRefs,
    decisiveEvidenceRefs,
    missingEvidence: [...finding.missingEvidence].sort(),
    recommendedAction: finding.recommendedAction,
  };
}

function diagnosticProposal(
  candidate: FailureCandidateV1,
  checkpoint: DiagnosticCheckpointEvidenceV1 | undefined,
): DiagnosticBranchProposalV1 {
  const changedVariable = diagnosticVariable(candidate);
  const missingPreconditions: string[] = [];
  if (checkpoint === undefined)
    missingPreconditions.push('A complete composite Checkpoint is required');
  else if (checkpoint.completeness !== 'composite') {
    missingPreconditions.push(
      'The supplied boundary evidence is not a restorable composite Checkpoint',
    );
  }
  const requiresExplicitAuthorization = candidate.detector === 'permission-conflict';
  if (requiresExplicitAuthorization) {
    missingPreconditions.push('Any permission expansion requires an explicit authorized Grant');
  }
  const proposalId = `diagnostic-proposal-${shortHash(
    stableStringify({
      candidateId: candidate.candidateId,
      checkpointDigest: checkpoint?.checkpointDigest ?? null,
      changedVariable,
    }),
  )}`;
  return {
    proposalId,
    candidateId: candidate.candidateId,
    execution: 'proposal-only',
    ready: missingPreconditions.length === 0,
    ...(checkpoint === undefined
      ? {}
      : {
          baseCheckpointId: checkpoint.checkpointId,
          baseCheckpointDigest: checkpoint.checkpointDigest,
        }),
    changedVariable,
    preserve: ['outcome-contract', 'checkpointed-comparison-boundary'],
    expectedDiscriminator: diagnosticDiscriminator(candidate),
    requiresExplicitAuthorization,
    missingPreconditions,
    evidenceRefs: uniqueSorted([
      ...candidate.supportingEvidenceRefs,
      ...(checkpoint?.evidenceRefs ?? []),
    ]),
  };
}

function diagnosticVariable(
  candidate: Pick<FailureCandidateV1, 'detector' | 'layer'>,
): DiagnosticVariableV1 {
  switch (candidate.detector) {
    case 'loop':
      return { dimension: 'model', key: 'repeated-action-guidance', operation: 'replace' };
    case 'repeated-failure':
      return {
        dimension: candidate.layer === 'unknown' ? 'harness' : candidate.layer,
        key: 'repeated-failure-input',
        operation: 'retry-with-alternative',
      };
    case 'stale-context':
      return { dimension: 'context', key: 'context-snapshot', operation: 'refresh' };
    case 'permission-conflict':
      return { dimension: 'missionbraid', key: 'permission-grant', operation: 'expand' };
    case 'tool-error':
      return { dimension: 'tool', key: 'tool-input-or-implementation', operation: 'replace' };
    case 'workspace-divergence':
      return { dimension: 'environment', key: 'workspace-component', operation: 'replace' };
    case 'verification-failure':
      return {
        dimension: 'missionbraid',
        key: 'upstream-verification-input',
        operation: 'retry-with-alternative',
      };
    case 'adapter-failure':
      return {
        dimension: candidate.layer === 'environment' ? 'environment' : 'harness',
        key: candidate.layer === 'environment' ? 'runtime-executable' : 'runtime-profile',
        operation: 'retry-with-alternative',
      };
    case 'unattributed':
      return { dimension: 'missionbraid', key: 'evidence-capture', operation: 'replace' };
  }
}

function diagnosticDiscriminator(candidate: FailureCandidateV1): string {
  return `A declared ${candidate.layer} Intervention changes the ${candidate.detector} evidence; Contract, Profile, authority, workspace, and run-state differences are evaluated from recorded evidence rather than assumed equal.`;
}

function buildGraph(
  evidence: ReadonlyMap<string, EvidenceRecord>,
  candidates: readonly FailureCandidateV1[],
  proposals: readonly DiagnosticBranchProposalV1[],
): {
  readonly nodes: readonly FailureGraphNodeV1[];
  readonly edges: readonly FailureGraphEdgeV1[];
} {
  const nodes = new Map<string, FailureGraphNodeV1>();
  const edges = new Map<string, FailureGraphEdgeV1>();
  const addNode = (node: FailureGraphNodeV1): void => {
    nodes.set(node.nodeId, node);
  };
  const addEdge = (
    kind: FailureGraphEdgeKindV1,
    fromNodeId: string,
    toNodeId: string,
    evidenceRefs: readonly string[],
  ): void => {
    const edgeId = `failure-edge-${shortHash(`${kind}\0${fromNodeId}\0${toNodeId}`)}`;
    edges.set(edgeId, {
      edgeId,
      kind,
      fromNodeId,
      toNodeId,
      evidenceRefs: uniqueSorted(evidenceRefs),
    });
  };

  for (const layer of LAYERS) {
    addNode({
      nodeId: `failure-layer:${layer}`,
      kind: 'layer',
      label: layer,
      layer,
      evidenceRefs: [],
    });
  }
  for (const record of evidence.values()) {
    const nodeId = evidenceNodeId(record.evidenceId);
    addNode({
      nodeId,
      kind: 'evidence',
      label: record.label,
      layer: record.layer,
      evidenceRefs: record.evidenceRefs,
    });
    if (record.layer !== 'unknown') {
      addEdge('located-in', nodeId, `failure-layer:${record.layer}`, record.evidenceRefs);
    }
  }
  for (const candidate of candidates) {
    addNode({
      nodeId: candidate.candidateId,
      kind: 'candidate',
      label: candidate.title,
      layer: candidate.layer,
      status: candidate.status,
      evidenceRefs: candidate.supportingEvidenceRefs,
    });
    if (candidate.layer !== 'unknown') {
      addEdge('located-in', candidate.candidateId, `failure-layer:${candidate.layer}`, []);
    }
    for (const record of evidence.values()) {
      if (candidate.supportingEvidenceRefs.some((ref) => record.evidenceRefs.includes(ref))) {
        addEdge(
          'supports',
          evidenceNodeId(record.evidenceId),
          candidate.candidateId,
          record.evidenceRefs,
        );
      }
      if (candidate.counterEvidenceRefs.some((ref) => record.evidenceRefs.includes(ref))) {
        addEdge(
          'contradicts',
          evidenceNodeId(record.evidenceId),
          candidate.candidateId,
          record.evidenceRefs,
        );
      }
    }
    for (const missing of candidate.missingEvidence) {
      const nodeId = `missing-evidence-${shortHash(`${candidate.candidateId}\0${missing}`)}`;
      addNode({
        nodeId,
        kind: 'missing-evidence',
        label: missing,
        layer: candidate.layer,
        status: 'unknown',
        evidenceRefs: [],
      });
      addEdge('missing-for', nodeId, candidate.candidateId, []);
    }
  }
  for (const proposal of proposals) {
    addNode({
      nodeId: proposal.proposalId,
      kind: 'diagnostic-proposal',
      label: `${proposal.changedVariable.dimension}.${proposal.changedVariable.key}`,
      layer: proposal.changedVariable.dimension,
      evidenceRefs: proposal.evidenceRefs,
    });
    addEdge('proposes', proposal.candidateId, proposal.proposalId, proposal.evidenceRefs);
  }

  return {
    nodes: [...nodes.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: [...edges.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
  };
}

function runtimeFactLayer(fact: RuntimeSemanticFactV1): FailureLayerV1 | 'unknown' {
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

function runtimeFactLabel(fact: RuntimeSemanticFactV1): string {
  switch (fact.kind) {
    case 'model_call':
      return `model call ${fact.phase}`;
    case 'context':
      return `context ${fact.contextKind}`;
    case 'message':
      return `message ${fact.role}`;
    case 'tool_request':
      return `tool request ${fact.toolName ?? 'unknown-tool'}`;
    case 'tool_result':
      return `tool result ${fact.phase}`;
    case 'workspace_change':
      return `workspace change (${String(fact.changeCount)})`;
    case 'test_run':
      return `test run ${fact.status}`;
    case 'subagent_started':
    case 'subagent_finished':
      return fact.kind.replaceAll('_', ' ');
    case 'usage':
      return 'runtime usage';
    case 'failure':
      return `${fact.failureKind} failure`;
  }
}

function verificationStatus(
  result: VerificationResultV1 | CommandVerificationResultV1,
): 'passed' | 'failed' | 'unknown' {
  if ('passed' in result) return result.passed ? 'passed' : 'failed';
  return result.status === 'inconclusive' ? 'unknown' : result.status;
}

function verificationKey(item: FailureVerificationEvidenceV1): string {
  if (item.criterionId !== undefined) return `criterion:${item.criterionId}`;
  if ('invocationDigest' in item.result) return `command:${item.result.invocationDigest}`;
  return `criterion:${item.result.criterionId}`;
}

function adapterDetectionFailure(
  detection: RuntimeDetection | undefined,
):
  | { readonly layer: FailureLayerV1; readonly mechanism: string; readonly label: string }
  | undefined {
  if (detection === undefined || detection.status === 'ready') return undefined;
  if (detection.status === 'missing') {
    return {
      layer: 'environment',
      mechanism: 'runtime-missing',
      label: `Runtime executable missing: ${detection.runtime}`,
    };
  }
  return {
    layer: 'harness',
    mechanism: detection.status,
    label: `Runtime ${detection.status}: ${detection.runtime}`,
  };
}

function adapterProcessFailure(
  run: RuntimeRunResult | undefined,
):
  | { readonly layer: FailureLayerV1; readonly mechanism: string; readonly label: string }
  | undefined {
  if (run === undefined) return undefined;
  if (run.process.startError !== undefined || run.process.spawnError !== undefined) {
    return {
      layer: 'environment',
      mechanism: 'process-start',
      label: `Runtime process could not start: ${run.runtime}`,
    };
  }
  if (run.process.observerError !== undefined) {
    return {
      layer: 'missionbraid',
      mechanism: 'observer',
      label: `MissionBraid runtime observer failed: ${run.runtime}`,
    };
  }
  if (run.process.aborted || run.process.exitCode !== 0) {
    return {
      layer: 'harness',
      mechanism: run.process.aborted ? 'aborted' : `exit-${String(run.process.exitCode)}`,
      label: `Runtime process did not complete successfully: ${run.runtime}`,
    };
  }
  return undefined;
}

function validateDiagnosticOutcome(outcome: DiagnosticBranchOutcomeV1): void {
  if (
    outcome.outcomeId.length === 0 ||
    outcome.candidateId.length === 0 ||
    outcome.preservedCheckpointDigest.length === 0 ||
    outcome.changedVariable.key.length === 0
  ) {
    throw new TypeError('Diagnostic outcome identities and changed variable must be non-empty');
  }
  if (!LAYERS.includes(outcome.changedVariable.dimension)) {
    throw new TypeError('Diagnostic outcome changedVariable dimension is unsupported');
  }
}

function candidateIdentity(
  detector: FailureDetectorKindV1,
  layer: FailureLayerV1 | 'unknown',
  mechanismKey: string,
): string {
  return `failure-candidate-${shortHash(`${detector}\0${layer}\0${mechanismKey}`)}`;
}

function evidenceNodeId(evidenceId: string): string {
  return `failure-evidence-${shortHash(evidenceId)}`;
}

function expandEvidenceRefs(
  evidenceIds: ReadonlySet<string>,
  evidence: ReadonlyMap<string, EvidenceRecord>,
): string[] {
  return uniqueSorted([...evidenceIds].flatMap((id) => evidence.get(id)?.evidenceRefs ?? [id]));
}

function scoreCandidate(
  status: FailureConclusionStatusV1,
  supportingCount: number,
  counterCount: number,
): number {
  const base =
    status === 'confirmed' ? 100 : status === 'observed' ? 70 : status === 'inferred' ? 50 : 0;
  return Math.max(0, base + Math.min(supportingCount, 9) - Math.min(counterCount * 3, 18));
}

function compareCandidates(
  left: Omit<FailureCandidateV1, 'rank'>,
  right: Omit<FailureCandidateV1, 'rank'>,
): number {
  return (
    right.rankScore - left.rankScore ||
    statusRank(right.status) - statusRank(left.status) ||
    left.candidateId.localeCompare(right.candidateId)
  );
}

function statusRank(status: FailureConclusionStatusV1): number {
  return status === 'confirmed' ? 4 : status === 'observed' ? 3 : status === 'inferred' ? 2 : 1;
}

function addGrouped(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const identity = key(value);
    const members = grouped.get(identity) ?? [];
    members.push(value);
    grouped.set(identity, members);
  }
  return grouped;
}

function deduplicateBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const selected = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (!selected.has(identity)) selected.set(identity, value);
  }
  return [...selected.values()].sort((left, right) => key(left).localeCompare(key(right)));
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
