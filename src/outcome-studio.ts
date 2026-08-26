import { createHash } from 'node:crypto';

import { sanitizeNativeArtifact } from './artifact-store.js';
import type { ContractV1, EffectStatusV1 } from './domain.js';

export const AGENT_REVISION_SCHEMA_VERSION = 'missionbraid.dev/agent-revision/v1' as const;
export const EVALUATION_SUITE_SCHEMA_VERSION = 'missionbraid.dev/evaluation-suite/v1' as const;
export const BRANCH_EVALUATION_SCHEMA_VERSION = 'missionbraid.dev/branch-evaluation/v1' as const;
export const BRANCH_COMPARISON_SCHEMA_VERSION = 'missionbraid.dev/branch-comparison/v1' as const;
export const INCIDENT_SCENARIO_SCHEMA_VERSION = 'missionbraid.dev/incident-scenario/v1' as const;
export const STUDIO_OUTCOME_RECEIPT_SCHEMA_VERSION = 'missionbraid.dev/outcome-receipt/v1' as const;
export const OUTCOME_CI_RESULT_SCHEMA_VERSION = 'missionbraid.dev/outcome-ci-result/v1' as const;

export const AGENT_REVISION_DIMENSIONS = [
  'model-provider',
  'prompt-instructions',
  'skills',
  'mcp-tools',
  'context-memory',
  'orchestration',
  'permissions-effects',
  'harness',
  'adapter-provider',
  'environment',
] as const;

export const BRANCH_COMPARISON_DIMENSIONS = [
  'trajectory',
  'context',
  'tools',
  'files',
  'tests',
  'usage',
  'cost',
  'latency',
  'effects',
  'failures',
  'criteria',
] as const;

const INCIDENT_ARTIFACT_KINDS = [
  'checkpoint',
  'intervention',
  'contract',
  'profile',
  'expected-evidence',
] as const;

export type AgentRevisionDimensionV1 = (typeof AGENT_REVISION_DIMENSIONS)[number];
export type BranchComparisonDimensionV1 = (typeof BRANCH_COMPARISON_DIMENSIONS)[number];
export type IncidentArtifactKindV1 = (typeof INCIDENT_ARTIFACT_KINDS)[number];
export type CriterionExecutionModeV1 = 'deterministic-control' | 'stochastic-model';
export type CriterionStatusV1 = 'passed' | 'failed' | 'unknown';
export type EvaluatorBasisV1 = 'deterministic' | 'external-authority' | 'model-judge';

export interface AgentRevisionDimensionInputV1 {
  readonly dimension: AgentRevisionDimensionV1;
  readonly fidelity: 'known' | 'partial' | 'unknown';
  readonly contentDigest?: string;
  readonly evidenceRefs: readonly string[];
  readonly reason?: string;
}

export interface AgentRevisionPolicyEvidenceV1 {
  readonly name: string;
  readonly version: string;
  readonly evidenceRefs: readonly string[];
}

export interface CreateAgentRevisionInputV1 {
  readonly profileId: string;
  readonly attemptBindingId: string;
  readonly dimensions: readonly AgentRevisionDimensionInputV1[];
  readonly policyEvidence: readonly AgentRevisionPolicyEvidenceV1[];
}

export interface AgentRevisionDimensionEvidenceV1 {
  readonly dimension: AgentRevisionDimensionV1;
  readonly fidelity: 'known' | 'partial' | 'unknown';
  readonly contentDigest: string | null;
  readonly evidenceRefs: readonly string[];
  readonly reason: string | null;
}

interface AgentRevisionCoreV1 {
  readonly schemaVersion: typeof AGENT_REVISION_SCHEMA_VERSION;
  readonly profileId: string;
  readonly attemptBindingId: string;
  readonly dimensions: readonly AgentRevisionDimensionEvidenceV1[];
  readonly policyEvidence: readonly AgentRevisionPolicyEvidenceV1[];
}

interface AgentRevisionIdentityCoreV1 {
  readonly schemaVersion: typeof AGENT_REVISION_SCHEMA_VERSION;
  readonly dimensions: readonly AgentRevisionDimensionEvidenceV1[];
  readonly policyEvidence: readonly AgentRevisionPolicyEvidenceV1[];
}

export interface AgentRevisionV1 extends AgentRevisionCoreV1 {
  readonly revisionId: string;
  readonly revisionHash: string;
}

export interface CriterionRunnerRefV1 {
  readonly kind: string;
  readonly version: string;
}

export interface CriterionEvaluatorBindingV1 {
  readonly kind: string;
  readonly version: string;
  readonly role: 'authoritative' | 'advisory';
}

export interface StochasticThresholdV1 {
  readonly metric: 'pass-rate' | 'mean-score';
  readonly operator: 'gte';
  readonly value: number;
  readonly minimumKnownTrials: number;
}

export interface EvaluationCriterionInputV1 {
  readonly criterionId: string;
  readonly required: boolean;
  readonly mode: CriterionExecutionModeV1;
  readonly runner: CriterionRunnerRefV1;
  readonly evaluators: readonly CriterionEvaluatorBindingV1[];
  readonly trialCount?: number;
  readonly threshold?: StochasticThresholdV1;
}

export interface CreateEvaluationSuiteInputV1 {
  readonly contract: ContractV1;
  readonly suiteVersion: string;
  readonly outcomePolicyVersion: string;
  readonly criteria: readonly EvaluationCriterionInputV1[];
}

export interface EvaluationCriterionV1 {
  readonly criterionId: string;
  readonly required: boolean;
  readonly mode: CriterionExecutionModeV1;
  readonly runner: CriterionRunnerRefV1;
  readonly evaluators: readonly CriterionEvaluatorBindingV1[];
  readonly trialCount: number;
  readonly threshold: StochasticThresholdV1 | null;
}

interface EvaluationSuiteCoreV1 {
  readonly schemaVersion: typeof EVALUATION_SUITE_SCHEMA_VERSION;
  readonly contractId: string;
  readonly contractHash: string;
  readonly suiteVersion: string;
  readonly outcomePolicyVersion: string;
  readonly criteria: readonly EvaluationCriterionV1[];
}

export interface EvaluationSuiteV1 extends EvaluationSuiteCoreV1 {
  readonly suiteId: string;
  readonly suiteHash: string;
}

export interface BranchEvaluationTargetV1 {
  readonly branchId: string;
  readonly contractId: string;
  readonly agentRevision: AgentRevisionV1;
  readonly checkpointId: string;
  readonly eventHeadHash: string;
  readonly eventThroughSeq: number;
  readonly scenarioId?: string;
}

export interface CriterionRunnerContextV1 {
  readonly suiteId: string;
  readonly criterion: EvaluationCriterionV1;
  readonly target: BranchEvaluationTargetV1;
  readonly trialIndex: number;
}

export interface CriterionTrialObservationInputV1 {
  readonly outcome: CriterionStatusV1;
  readonly score?: number;
  readonly evidenceRefs: readonly string[];
  readonly retainedArtifactRefs?: readonly string[];
}

export interface CriterionTrialObservationV1 {
  readonly trialId: string;
  readonly trialIndex: number;
  readonly outcome: CriterionStatusV1;
  readonly score: number | null;
  readonly evidenceRefs: readonly string[];
  readonly retainedArtifactRefs: readonly string[];
}

export interface CriterionRunnerRegistrationV1 {
  readonly kind: string;
  readonly version: string;
  readonly mode: CriterionExecutionModeV1;
  run(context: CriterionRunnerContextV1): Promise<CriterionTrialObservationInputV1>;
}

export interface CriterionEvaluatorContextV1 {
  readonly suiteId: string;
  readonly criterion: EvaluationCriterionV1;
  readonly target: BranchEvaluationTargetV1;
  readonly trials: readonly CriterionTrialObservationV1[];
}

export interface CriterionEvaluatorOutputV1 {
  readonly status: CriterionStatusV1;
  readonly evidenceRefs: readonly string[];
}

export interface CriterionEvaluatorRegistrationV1 {
  readonly kind: string;
  readonly version: string;
  readonly basis: EvaluatorBasisV1;
  readonly rubricVersion?: string;
  readonly calibrationBoundaryRef?: string;
  evaluate(context: CriterionEvaluatorContextV1): Promise<CriterionEvaluatorOutputV1>;
}

export interface CriterionEvaluatorResultV1 {
  readonly evaluationId: string;
  readonly kind: string;
  readonly version: string;
  readonly role: 'authoritative' | 'advisory';
  readonly basis: EvaluatorBasisV1;
  readonly status: CriterionStatusV1;
  readonly evidenceRefs: readonly string[];
  readonly rubricVersion: string | null;
  readonly calibrationBoundaryRef: string | null;
}

export interface ThresholdEvaluationV1 {
  readonly status: CriterionStatusV1 | 'not-applicable';
  readonly metric: StochasticThresholdV1['metric'] | null;
  readonly threshold: number | null;
  readonly observedValue: number | null;
  readonly knownTrials: number;
  readonly totalTrials: number;
}

export interface EvaluatedCriterionV1 {
  readonly criterionId: string;
  readonly required: boolean;
  readonly mode: CriterionExecutionModeV1;
  readonly status: CriterionStatusV1;
  readonly trials: readonly CriterionTrialObservationV1[];
  readonly thresholdEvaluation: ThresholdEvaluationV1;
  readonly evaluatorResults: readonly CriterionEvaluatorResultV1[];
  readonly evidenceRefs: readonly string[];
}

interface BranchEvaluationCoreV1 {
  readonly schemaVersion: typeof BRANCH_EVALUATION_SCHEMA_VERSION;
  readonly suiteId: string;
  readonly suiteHash: string;
  readonly contractId: string;
  readonly branchId: string;
  readonly agentRevisionId: string;
  readonly checkpointId: string;
  readonly eventHeadHash: string;
  readonly eventThroughSeq: number;
  readonly scenarioId: string | null;
  readonly criteria: readonly EvaluatedCriterionV1[];
}

export interface BranchEvaluationV1 extends BranchEvaluationCoreV1 {
  readonly evaluationId: string;
  readonly evaluationHash: string;
}

export interface BranchDimensionEvidenceInputV1 {
  readonly dimension: BranchComparisonDimensionV1;
  readonly fidelity: 'known' | 'unknown';
  readonly digest?: string;
  readonly evidenceRefs: readonly string[];
}

export interface AgentReportedCompletionV1 {
  readonly status: 'reported-success' | 'reported-failure' | 'not-reported';
  readonly evidenceRefs: readonly string[];
}

export interface OutcomeBranchRecordV1 {
  readonly branchId: string;
  readonly contractId: string;
  readonly lineageBranchIds: readonly string[];
  readonly checkpointId: string;
  readonly eventHeadHash: string;
  readonly eventThroughSeq: number;
  readonly agentRevision: AgentRevisionV1;
  readonly evaluation: BranchEvaluationV1;
  readonly dimensions: readonly BranchDimensionEvidenceInputV1[];
  readonly agentReported: AgentReportedCompletionV1;
}

export interface BranchDimensionComparisonV1 {
  readonly dimension: BranchComparisonDimensionV1;
  readonly status: 'equal' | 'different' | 'unknown';
  readonly branches: readonly {
    readonly branchId: string;
    readonly digest: string | null;
    readonly evidenceRefs: readonly string[];
  }[];
}

interface BranchComparisonCoreV1 {
  readonly schemaVersion: typeof BRANCH_COMPARISON_SCHEMA_VERSION;
  readonly contractId: string;
  readonly suiteId: string;
  readonly branchIds: readonly string[];
  readonly revisionIds: readonly string[];
  readonly dimensions: readonly BranchDimensionComparisonV1[];
  readonly agentReported: readonly {
    readonly branchId: string;
    readonly status: AgentReportedCompletionV1['status'];
    readonly evidenceRefs: readonly string[];
  }[];
  readonly selection: 'not-selected';
}

export interface BranchComparisonV1 extends BranchComparisonCoreV1 {
  readonly comparisonId: string;
  readonly comparisonHash: string;
}

export interface IncidentArtifactInputV1 {
  readonly kind: IncidentArtifactKindV1;
  readonly content: string;
}

export interface IncidentExpectedEvidenceV1 {
  readonly criterionId: string;
  readonly expectedStatus: CriterionStatusV1;
  readonly evidenceRefs: readonly string[];
}

export interface CreateIncidentScenarioInputV1 {
  readonly scenarioRevision: string;
  readonly contractId: string;
  readonly evaluationSuiteId: string;
  readonly sourceAgentRevisionId: string;
  readonly sourceCheckpointId: string;
  readonly interventionId: string;
  readonly artifacts: readonly IncidentArtifactInputV1[];
  readonly expectedEvidence: readonly IncidentExpectedEvidenceV1[];
  readonly executionPlan?: IncidentScenarioExecutionPlanInputV1;
  readonly createdAt: string;
}

export interface IncidentScenarioExecutionPlanInputV1 {
  readonly runner: CriterionRunnerRefV1;
  readonly evaluationSuite: EvaluationSuiteV1;
  readonly sourceProfileId: string;
  readonly sourceProfileDigest: string;
  readonly requiresDistinctAgentRevision: boolean;
  readonly evidenceRefs: readonly string[];
}

export interface IncidentScenarioExecutionPlanV1 {
  readonly runner: CriterionRunnerRefV1;
  readonly evaluationSuite: EvaluationSuiteV1;
  readonly sourceProfileId: string;
  readonly sourceProfileDigest: string;
  readonly requiresDistinctAgentRevision: boolean;
  readonly evidenceRefs: readonly string[];
}

export interface RedactedIncidentArtifactV1 {
  readonly kind: IncidentArtifactKindV1;
  readonly artifactId: string;
  readonly sha256: string;
  readonly mediaType: 'application/json' | 'text/plain';
  readonly content: string;
  readonly byteLength: number;
  readonly sanitized: true;
  readonly redactionCount: number;
}

interface IncidentScenarioCoreV1 {
  readonly schemaVersion: typeof INCIDENT_SCENARIO_SCHEMA_VERSION;
  readonly scenarioRevision: string;
  readonly contractId: string;
  readonly evaluationSuiteId: string;
  readonly sourceAgentRevisionId: string;
  readonly sourceCheckpointId: string;
  readonly interventionId: string;
  readonly artifacts: readonly RedactedIncidentArtifactV1[];
  readonly expectedEvidence: readonly IncidentExpectedEvidenceV1[];
  readonly executionPlan: IncidentScenarioExecutionPlanV1 | null;
  readonly createdAt: string;
}

export interface IncidentScenarioV1 extends IncidentScenarioCoreV1 {
  readonly scenarioId: string;
  readonly scenarioHash: string;
}

export interface OutcomeEffectEvidenceV1 {
  readonly effectId: string;
  readonly required: boolean;
  readonly status: EffectStatusV1;
  readonly resolution: 'resolved' | 'blocking' | 'ambiguous';
  readonly evidenceRefs: readonly string[];
}

export interface OutcomeRuntimeProfileBindingV1 {
  readonly sourceProfileId: string;
  readonly targetProfileId: string;
  readonly targetStageId: string;
  readonly targetProfileDefinitionId: string;
  readonly profileSelectionId: string;
  readonly plannerDecisionHash: string;
  readonly authorityChange: 'unchanged' | 'narrowed';
  readonly evidenceRefs: readonly string[];
}

export interface BranchAcceptanceV1 {
  readonly branchId: string;
  readonly decision: 'accepted' | 'rejected';
  readonly authorityKind: 'human' | 'external-authority';
  readonly authorityRef: string;
  readonly decidedAt: string;
}

export interface IssueStudioOutcomeReceiptInputV1 {
  readonly branch: OutcomeBranchRecordV1;
  readonly effects: readonly OutcomeEffectEvidenceV1[];
  readonly acceptance?: BranchAcceptanceV1;
  readonly runtimeProfileBinding?: OutcomeRuntimeProfileBindingV1;
  readonly outcomePolicyVersion: string;
  readonly issuedAt: string;
}

interface StudioOutcomeReceiptCoreV1 {
  readonly schemaVersion: typeof STUDIO_OUTCOME_RECEIPT_SCHEMA_VERSION;
  readonly outcomePolicyVersion: string;
  readonly contractId: string;
  readonly branchId: string;
  readonly branchLineage: readonly string[];
  readonly agentRevisionId: string;
  readonly evaluationSuiteId: string;
  readonly evaluationId: string;
  readonly checkpointId: string;
  readonly eventHeadHash: string;
  readonly eventThroughSeq: number;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly required: boolean;
    readonly status: CriterionStatusV1;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly effects: readonly OutcomeEffectEvidenceV1[];
  readonly runtimeProfileBinding?: OutcomeRuntimeProfileBindingV1;
  readonly unresolvedItems: readonly string[];
  readonly completion: {
    readonly agentReported: AgentReportedCompletionV1;
    readonly verified: 'verified' | 'rejected';
    readonly accepted: 'accepted' | 'rejected' | 'pending';
    readonly acceptanceAuthorityKind: BranchAcceptanceV1['authorityKind'] | null;
    readonly acceptanceAuthorityRef: string | null;
    readonly acceptanceDecidedAt: string | null;
  };
  readonly issuedAt: string;
}

export interface StudioOutcomeReceiptV1 extends StudioOutcomeReceiptCoreV1 {
  readonly receiptId: string;
  readonly receiptHash: string;
}

export interface CreateOutcomeCiResultInputV1 {
  readonly scenario: IncidentScenarioV1;
  readonly receipt: StudioOutcomeReceiptV1;
  readonly generatedAt: string;
}

interface OutcomeCiResultCoreV1 {
  readonly schemaVersion: typeof OUTCOME_CI_RESULT_SCHEMA_VERSION;
  readonly scenarioId: string;
  readonly scenarioRevision: string;
  readonly receiptId: string;
  readonly contractId: string;
  readonly branchId: string;
  readonly agentRevisionId: string;
  readonly evaluationSuiteId: string;
  readonly runtimeProfileBinding?: OutcomeRuntimeProfileBindingV1;
  readonly expectationResults: readonly {
    readonly criterionId: string;
    readonly expectedStatus: CriterionStatusV1;
    readonly actualStatus: CriterionStatusV1 | 'missing';
    readonly matched: boolean;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly regression: 'retained' | 'returned' | 'inconclusive';
  readonly status: 'passed' | 'failed';
  readonly authority: 'evidence-export-only';
  readonly deploymentAuthorized: false;
  readonly organizationalApprovalGranted: false;
  readonly publicationAuthorized: false;
  readonly generatedAt: string;
}

export interface OutcomeCiResultV1 extends OutcomeCiResultCoreV1 {
  readonly resultId: string;
  readonly resultHash: string;
}

export interface OutcomeCiEnforcementV1 {
  readonly resultId: string;
  readonly status: 'passed' | 'failed';
  readonly exitCode: 0 | 1;
  readonly reasons: readonly string[];
}

export interface OutcomeBranchSelectionV1 {
  readonly schemaVersion: 'missionbraid.dev/outcome-branch-selection/v1';
  readonly selectionId: string;
  readonly comparisonId: string;
  readonly contractId: string;
  readonly branchId: string;
  readonly receiptId: string;
  readonly authorityKind: 'human' | 'external-authority';
  readonly authorityRef: string;
  readonly decidedAt: string;
  readonly selectionHash: string;
}

export interface RerunIncidentScenarioInputV1 {
  readonly scenario: IncidentScenarioV1;
  readonly registry: OutcomeStudioRegistry;
  readonly target: BranchEvaluationTargetV1;
  readonly lineageBranchIds: readonly string[];
  readonly dimensions: readonly BranchDimensionEvidenceInputV1[];
  readonly agentReported: AgentReportedCompletionV1;
  readonly effects: readonly OutcomeEffectEvidenceV1[];
  readonly runtimeProfileBinding?: OutcomeRuntimeProfileBindingV1;
  readonly outcomePolicyVersion: string;
  readonly issuedAt: string;
}

export interface IncidentScenarioRerunV1 {
  readonly scenarioId: string;
  readonly sourceAgentRevisionId: string;
  readonly targetAgentRevisionId: string;
  readonly targetProfileId: string;
  readonly runtimeProfileBinding?: OutcomeRuntimeProfileBindingV1;
  readonly evaluation: BranchEvaluationV1;
  readonly receipt: StudioOutcomeReceiptV1;
  readonly ciResult: OutcomeCiResultV1;
}

export class OutcomeStudioValidationError extends TypeError {}
export class OutcomeStudioIntegrityError extends Error {}
export class OutcomeStudioRegistryError extends Error {}
export class OutcomeStudioPolicyError extends Error {}

export function createAgentRevision(input: CreateAgentRevisionInputV1): AgentRevisionV1 {
  const dimensions = input.dimensions.map(normalizeRevisionDimension).sort(compareDimension);
  requireExactMembers(
    dimensions.map((dimension) => dimension.dimension),
    AGENT_REVISION_DIMENSIONS,
    'Agent Revision dimensions',
  );
  const policyEvidence = input.policyEvidence
    .map((policy, index) => ({
      name: requireNonEmpty(policy.name, `policyEvidence[${index}].name`),
      version: requireNonEmpty(policy.version, `policyEvidence[${index}].version`),
      evidenceRefs: normalizeRefs(policy.evidenceRefs, `policyEvidence[${index}].evidenceRefs`),
    }))
    .sort(
      (left, right) =>
        compareText(left.name, right.name) || compareText(left.version, right.version),
    );
  requireUnique(
    policyEvidence.map((policy) => `${policy.name}@${policy.version}`),
    'Agent Revision policyEvidence',
  );
  const core: AgentRevisionCoreV1 = {
    schemaVersion: AGENT_REVISION_SCHEMA_VERSION,
    profileId: requireNonEmpty(input.profileId, 'profileId'),
    attemptBindingId: requireNonEmpty(input.attemptBindingId, 'attemptBindingId'),
    dimensions,
    policyEvidence,
  };
  // Attempt and Profile identities are provenance bindings, not behavioral
  // content.  A retried Attempt with identical effective inputs must retain the
  // same Agent Revision, while a Prompt, Context, tool, model, permission, or
  // environment digest change must create a new Revision.
  const revisionHash = digest(agentRevisionIdentityCore(core));
  return {
    ...core,
    revisionId: `revision-${revisionHash}`,
    revisionHash,
  };
}

export function verifyAgentRevision(revision: AgentRevisionV1): void {
  const { revisionId: _revisionId, revisionHash: _revisionHash, ...core } = revision;
  requireNonEmpty(revision.profileId, 'profileId');
  requireNonEmpty(revision.attemptBindingId, 'attemptBindingId');
  const expected = digest(agentRevisionIdentityCore(core));
  if (revision.revisionHash !== expected || revision.revisionId !== `revision-${expected}`) {
    throw new OutcomeStudioIntegrityError('Agent Revision identity does not match its content');
  }
}

export function createEvaluationSuite(input: CreateEvaluationSuiteInputV1): EvaluationSuiteV1 {
  const contractId = requireNonEmpty(input.contract.contractId, 'contract.contractId');
  const contractCriterionIds = input.contract.acceptanceCriteria
    .map((criterion, index) =>
      requireNonEmpty(criterion.criterionId, `contract.acceptanceCriteria[${index}].criterionId`),
    )
    .sort(compareText);
  requireUnique(contractCriterionIds, 'contract acceptance criterion IDs');
  const criteria = input.criteria.map(normalizeEvaluationCriterion).sort(compareCriterion);
  requireExactMembers(
    criteria.map((criterion) => criterion.criterionId),
    contractCriterionIds,
    'Evaluation Suite criteria',
  );
  const core: EvaluationSuiteCoreV1 = {
    schemaVersion: EVALUATION_SUITE_SCHEMA_VERSION,
    contractId,
    contractHash: digest(input.contract),
    suiteVersion: requireNonEmpty(input.suiteVersion, 'suiteVersion'),
    outcomePolicyVersion: requireNonEmpty(input.outcomePolicyVersion, 'outcomePolicyVersion'),
    criteria,
  };
  const suiteHash = digest(core);
  return { ...core, suiteId: `suite-${suiteHash}`, suiteHash };
}

export function verifyEvaluationSuite(suite: EvaluationSuiteV1): void {
  const { suiteId: _suiteId, suiteHash: _suiteHash, ...core } = suite;
  const expected = digest(core);
  if (suite.suiteHash !== expected || suite.suiteId !== `suite-${expected}`) {
    throw new OutcomeStudioIntegrityError('Evaluation Suite identity does not match its content');
  }
}

export class OutcomeStudioRegistry {
  readonly #runners = new Map<string, CriterionRunnerRegistrationV1>();
  readonly #evaluators = new Map<string, CriterionEvaluatorRegistrationV1>();

  registerRunner(runner: CriterionRunnerRegistrationV1): void {
    const normalized = normalizeRunnerRegistration(runner);
    const key = registryKey(normalized.kind, normalized.version);
    if (this.#runners.has(key)) {
      throw new OutcomeStudioRegistryError(`Criterion runner ${key} is already registered`);
    }
    this.#runners.set(key, normalized);
  }

  registerEvaluator(evaluator: CriterionEvaluatorRegistrationV1): void {
    const normalized = normalizeEvaluatorRegistration(evaluator);
    const key = registryKey(normalized.kind, normalized.version);
    if (this.#evaluators.has(key)) {
      throw new OutcomeStudioRegistryError(`Criterion evaluator ${key} is already registered`);
    }
    this.#evaluators.set(key, normalized);
  }

  async evaluateBranch(
    suite: EvaluationSuiteV1,
    target: BranchEvaluationTargetV1,
  ): Promise<BranchEvaluationV1> {
    verifyEvaluationSuite(suite);
    verifyAgentRevision(target.agentRevision);
    validateEvaluationTarget(suite, target);

    const criteria: EvaluatedCriterionV1[] = [];
    for (const criterion of suite.criteria) {
      criteria.push(await this.#evaluateCriterion(suite, criterion, target));
    }
    const core: BranchEvaluationCoreV1 = {
      schemaVersion: BRANCH_EVALUATION_SCHEMA_VERSION,
      suiteId: suite.suiteId,
      suiteHash: suite.suiteHash,
      contractId: suite.contractId,
      branchId: requireNonEmpty(target.branchId, 'target.branchId'),
      agentRevisionId: target.agentRevision.revisionId,
      checkpointId: requireNonEmpty(target.checkpointId, 'target.checkpointId'),
      eventHeadHash: requireNonEmpty(target.eventHeadHash, 'target.eventHeadHash'),
      eventThroughSeq: nonNegativeSafeInteger(target.eventThroughSeq, 'target.eventThroughSeq'),
      scenarioId:
        target.scenarioId === undefined
          ? null
          : requireNonEmpty(target.scenarioId, 'target.scenarioId'),
      criteria,
    };
    const evaluationHash = digest(core);
    return {
      ...core,
      evaluationId: `evaluation-${evaluationHash}`,
      evaluationHash,
    };
  }

  async #evaluateCriterion(
    suite: EvaluationSuiteV1,
    criterion: EvaluationCriterionV1,
    target: BranchEvaluationTargetV1,
  ): Promise<EvaluatedCriterionV1> {
    const runner = this.#runners.get(registryKey(criterion.runner.kind, criterion.runner.version));
    if (runner === undefined) {
      throw new OutcomeStudioRegistryError(
        `Criterion runner ${registryKey(criterion.runner.kind, criterion.runner.version)} is not registered`,
      );
    }
    if (runner.mode !== criterion.mode) {
      throw new OutcomeStudioPolicyError(
        `Criterion ${criterion.criterionId} requires ${criterion.mode}, but its runner declares ${runner.mode}`,
      );
    }

    const trials: CriterionTrialObservationV1[] = [];
    for (let trialIndex = 0; trialIndex < criterion.trialCount; trialIndex += 1) {
      const raw = await runner.run({ suiteId: suite.suiteId, criterion, target, trialIndex });
      const normalized = normalizeTrial(raw, trialIndex);
      const trialCore = {
        suiteId: suite.suiteId,
        branchId: target.branchId,
        criterionId: criterion.criterionId,
        runner: criterion.runner,
        ...normalized,
      };
      trials.push({
        trialId: `trial-${digest(trialCore)}`,
        ...normalized,
      });
    }

    const evaluatorResults: CriterionEvaluatorResultV1[] = [];
    for (const binding of criterion.evaluators) {
      const evaluator = this.#evaluators.get(registryKey(binding.kind, binding.version));
      if (evaluator === undefined) {
        throw new OutcomeStudioRegistryError(
          `Criterion evaluator ${registryKey(binding.kind, binding.version)} is not registered`,
        );
      }
      if (binding.role === 'authoritative' && evaluator.basis === 'model-judge') {
        throw new OutcomeStudioPolicyError(
          `Model judge ${binding.kind}@${binding.version} cannot be an authoritative evaluator`,
        );
      }
      const raw = await evaluator.evaluate({
        suiteId: suite.suiteId,
        criterion,
        target,
        trials,
      });
      const status = validateCriterionStatus(raw.status, 'evaluator.status');
      const evidenceRefs = normalizeRefs(raw.evidenceRefs, 'evaluator.evidenceRefs');
      const resultCore = {
        suiteId: suite.suiteId,
        branchId: target.branchId,
        criterionId: criterion.criterionId,
        kind: evaluator.kind,
        version: evaluator.version,
        role: binding.role,
        basis: evaluator.basis,
        status,
        evidenceRefs,
        rubricVersion: evaluator.rubricVersion ?? null,
        calibrationBoundaryRef: evaluator.calibrationBoundaryRef ?? null,
      } as const;
      evaluatorResults.push({
        evaluationId: `criterion-evaluation-${digest(resultCore)}`,
        kind: evaluator.kind,
        version: evaluator.version,
        role: binding.role,
        basis: evaluator.basis,
        status,
        evidenceRefs,
        rubricVersion: evaluator.rubricVersion ?? null,
        calibrationBoundaryRef: evaluator.calibrationBoundaryRef ?? null,
      });
    }

    const thresholdEvaluation = evaluateThreshold(criterion, trials);
    const authoritativeStatuses = evaluatorResults
      .filter((result) => result.role === 'authoritative')
      .map((result) => result.status);
    if (criterion.mode === 'stochastic-model') {
      authoritativeStatuses.push(
        thresholdEvaluation.status === 'not-applicable' ? 'unknown' : thresholdEvaluation.status,
      );
    }
    const status = aggregateStatuses(authoritativeStatuses);
    return {
      criterionId: criterion.criterionId,
      required: criterion.required,
      mode: criterion.mode,
      status,
      trials,
      thresholdEvaluation,
      evaluatorResults,
      evidenceRefs: uniqueSorted([
        ...trials.flatMap((trial) => [trial.trialId, ...trial.evidenceRefs]),
        ...evaluatorResults.flatMap((result) => [result.evaluationId, ...result.evidenceRefs]),
      ]),
    };
  }
}

export function compareContractBranches(
  branches: readonly OutcomeBranchRecordV1[],
): BranchComparisonV1 {
  if (branches.length < 2) {
    throw new OutcomeStudioValidationError('Branch comparison requires at least two Branches');
  }
  const normalized = branches.map(normalizeBranchRecord).sort(compareBranch);
  requireUnique(
    normalized.map((branch) => branch.branchId),
    'Branch comparison branchIds',
  );
  const contractIds = uniqueSorted(normalized.map((branch) => branch.contractId));
  if (contractIds.length !== 1) {
    throw new OutcomeStudioPolicyError('Branches must use the same immutable Contract');
  }
  const suiteIds = uniqueSorted(normalized.map((branch) => branch.evaluation.suiteId));
  if (suiteIds.length !== 1) {
    throw new OutcomeStudioPolicyError('Branches must use the same controlling Evaluation Suite');
  }

  const dimensions = BRANCH_COMPARISON_DIMENSIONS.map((dimension) => {
    const values = normalized.map((branch) => {
      const evidence = branch.dimensions.find((candidate) => candidate.dimension === dimension)!;
      return {
        branchId: branch.branchId,
        digest: evidence.digest ?? null,
        evidenceRefs: evidence.evidenceRefs,
      };
    });
    const knownDigests = values.flatMap((value) => (value.digest === null ? [] : [value.digest]));
    return {
      dimension,
      status:
        knownDigests.length !== values.length
          ? 'unknown'
          : new Set(knownDigests).size === 1
            ? 'equal'
            : 'different',
      branches: values,
    } as const;
  });
  const core: BranchComparisonCoreV1 = {
    schemaVersion: BRANCH_COMPARISON_SCHEMA_VERSION,
    contractId: contractIds[0]!,
    suiteId: suiteIds[0]!,
    branchIds: normalized.map((branch) => branch.branchId),
    revisionIds: normalized.map((branch) => branch.agentRevision.revisionId),
    dimensions,
    agentReported: normalized.map((branch) => ({
      branchId: branch.branchId,
      status: branch.agentReported.status,
      evidenceRefs: branch.agentReported.evidenceRefs,
    })),
    selection: 'not-selected',
  };
  const comparisonHash = digest(core);
  return {
    ...core,
    comparisonId: `comparison-${comparisonHash}`,
    comparisonHash,
  };
}

export function createIncidentScenario(input: CreateIncidentScenarioInputV1): IncidentScenarioV1 {
  const artifacts = input.artifacts.map(redactIncidentArtifact).sort(compareArtifact);
  requireExactMembers(
    artifacts.map((artifact) => artifact.kind),
    INCIDENT_ARTIFACT_KINDS,
    'Incident scenario artifacts',
  );
  const expectedEvidence = input.expectedEvidence
    .map((expectation, index) => ({
      criterionId: requireNonEmpty(
        expectation.criterionId,
        `expectedEvidence[${index}].criterionId`,
      ),
      expectedStatus: validateCriterionStatus(
        expectation.expectedStatus,
        `expectedEvidence[${index}].expectedStatus`,
      ),
      evidenceRefs: normalizeRefs(
        expectation.evidenceRefs,
        `expectedEvidence[${index}].evidenceRefs`,
      ),
    }))
    .sort((left, right) => compareText(left.criterionId, right.criterionId));
  requireUnique(
    expectedEvidence.map((expectation) => expectation.criterionId),
    'Incident expected criterion IDs',
  );
  if (expectedEvidence.length === 0) {
    throw new OutcomeStudioValidationError('Incident expectedEvidence must not be empty');
  }
  const executionPlan = normalizeIncidentExecutionPlan(
    input.executionPlan,
    input.contractId,
    input.evaluationSuiteId,
  );
  const core: IncidentScenarioCoreV1 = {
    schemaVersion: INCIDENT_SCENARIO_SCHEMA_VERSION,
    scenarioRevision: requireNonEmpty(input.scenarioRevision, 'scenarioRevision'),
    contractId: requireNonEmpty(input.contractId, 'contractId'),
    evaluationSuiteId: requireNonEmpty(input.evaluationSuiteId, 'evaluationSuiteId'),
    sourceAgentRevisionId: requireNonEmpty(input.sourceAgentRevisionId, 'sourceAgentRevisionId'),
    sourceCheckpointId: requireNonEmpty(input.sourceCheckpointId, 'sourceCheckpointId'),
    interventionId: requireNonEmpty(input.interventionId, 'interventionId'),
    artifacts,
    expectedEvidence,
    executionPlan,
    createdAt: requireIsoTimestamp(input.createdAt, 'createdAt'),
  };
  const scenarioHash = digest(core);
  return { ...core, scenarioId: `scenario-${scenarioHash}`, scenarioHash };
}

export function verifyIncidentScenario(scenario: IncidentScenarioV1): void {
  for (const artifact of scenario.artifacts) {
    const actual = sha256(artifact.content);
    if (actual !== artifact.sha256 || artifact.artifactId !== `incident-artifact-${actual}`) {
      throw new OutcomeStudioIntegrityError(
        `Incident artifact ${artifact.kind} identity does not match its content`,
      );
    }
  }
  if (scenario.executionPlan !== undefined && scenario.executionPlan !== null) {
    verifyEvaluationSuite(scenario.executionPlan.evaluationSuite);
    if (
      scenario.executionPlan.evaluationSuite.contractId !== scenario.contractId ||
      scenario.executionPlan.evaluationSuite.suiteId !== scenario.evaluationSuiteId
    ) {
      throw new OutcomeStudioIntegrityError(
        'Incident execution plan does not match its Contract and Evaluation Suite',
      );
    }
  }
  const { scenarioId: _scenarioId, scenarioHash: _scenarioHash, ...core } = scenario;
  const expected = digest(core);
  if (scenario.scenarioHash !== expected || scenario.scenarioId !== `scenario-${expected}`) {
    throw new OutcomeStudioIntegrityError('Incident Scenario identity does not match its content');
  }
}

export function issueStudioOutcomeReceipt(
  input: IssueStudioOutcomeReceiptInputV1,
): StudioOutcomeReceiptV1 {
  const branch = normalizeBranchRecord(input.branch);
  const effects = input.effects.map(normalizeOutcomeEffect).sort(compareEffect);
  requireUnique(
    effects.map((effect) => effect.effectId),
    'Outcome Receipt effect IDs',
  );
  const acceptance = normalizeAcceptance(input.acceptance, branch.branchId);
  const criteria = branch.evaluation.criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    required: criterion.required,
    status: criterion.status,
    evidenceRefs: criterion.evidenceRefs,
  }));
  const unresolvedItems = uniqueSorted([
    ...criteria
      .filter((criterion) => criterion.required && criterion.status !== 'passed')
      .map((criterion) => `criterion:${criterion.criterionId}:${criterion.status}`),
    ...effects
      .filter((effect) => effect.required && effect.resolution !== 'resolved')
      .map((effect) => `effect:${effect.effectId}:${effect.resolution}`),
  ]);
  const verified = unresolvedItems.length === 0 ? 'verified' : 'rejected';
  const core: StudioOutcomeReceiptCoreV1 = {
    schemaVersion: STUDIO_OUTCOME_RECEIPT_SCHEMA_VERSION,
    outcomePolicyVersion: requireNonEmpty(input.outcomePolicyVersion, 'outcomePolicyVersion'),
    contractId: branch.contractId,
    branchId: branch.branchId,
    branchLineage: branch.lineageBranchIds,
    agentRevisionId: branch.agentRevision.revisionId,
    evaluationSuiteId: branch.evaluation.suiteId,
    evaluationId: branch.evaluation.evaluationId,
    checkpointId: branch.checkpointId,
    eventHeadHash: branch.eventHeadHash,
    eventThroughSeq: branch.eventThroughSeq,
    criteria,
    effects,
    ...(input.runtimeProfileBinding === undefined
      ? {}
      : { runtimeProfileBinding: normalizeRuntimeProfileBinding(input.runtimeProfileBinding) }),
    unresolvedItems,
    completion: {
      agentReported: branch.agentReported,
      verified,
      accepted: acceptance?.decision ?? 'pending',
      acceptanceAuthorityKind: acceptance?.authorityKind ?? null,
      acceptanceAuthorityRef: acceptance?.authorityRef ?? null,
      acceptanceDecidedAt: acceptance?.decidedAt ?? null,
    },
    issuedAt: requireIsoTimestamp(input.issuedAt, 'issuedAt'),
  };
  const receiptHash = digest(core);
  return { ...core, receiptId: `outcome-receipt-${receiptHash}`, receiptHash };
}

export function verifyStudioOutcomeReceipt(receipt: StudioOutcomeReceiptV1): void {
  const { receiptId: _receiptId, receiptHash: _receiptHash, ...core } = receipt;
  const expected = digest(core);
  if (receipt.receiptHash !== expected || receipt.receiptId !== `outcome-receipt-${expected}`) {
    throw new OutcomeStudioIntegrityError('Outcome Receipt identity does not match its content');
  }
  if (
    receipt.runtimeProfileBinding !== undefined &&
    stableCanonicalJson(normalizeRuntimeProfileBinding(receipt.runtimeProfileBinding)) !==
      stableCanonicalJson(receipt.runtimeProfileBinding)
  ) {
    throw new OutcomeStudioIntegrityError('Outcome Receipt Runtime Profile binding is invalid');
  }
}

export function createOutcomeCiResult(input: CreateOutcomeCiResultInputV1): OutcomeCiResultV1 {
  verifyIncidentScenario(input.scenario);
  verifyStudioOutcomeReceipt(input.receipt);
  if (input.scenario.contractId !== input.receipt.contractId) {
    throw new OutcomeStudioPolicyError('CI scenario and Receipt must use the same Contract');
  }
  if (input.scenario.evaluationSuiteId !== input.receipt.evaluationSuiteId) {
    throw new OutcomeStudioPolicyError(
      'CI scenario and Receipt must use the same Evaluation Suite',
    );
  }
  const criteria = new Map(
    input.receipt.criteria.map((criterion) => [criterion.criterionId, criterion]),
  );
  const expectationResults = input.scenario.expectedEvidence.map((expectation) => {
    const actual = criteria.get(expectation.criterionId);
    const actualStatus: CriterionStatusV1 | 'missing' = actual?.status ?? 'missing';
    return {
      criterionId: expectation.criterionId,
      expectedStatus: expectation.expectedStatus,
      actualStatus,
      matched: actualStatus === expectation.expectedStatus,
      evidenceRefs: uniqueSorted([...expectation.evidenceRefs, ...(actual?.evidenceRefs ?? [])]),
    };
  });
  const anyUnknown = expectationResults.some(
    (result) => result.actualStatus === 'unknown' || result.actualStatus === 'missing',
  );
  const allMatched = expectationResults.every((result) => result.matched);
  const regression = anyUnknown ? 'inconclusive' : allMatched ? 'retained' : 'returned';
  const core: OutcomeCiResultCoreV1 = {
    schemaVersion: OUTCOME_CI_RESULT_SCHEMA_VERSION,
    scenarioId: input.scenario.scenarioId,
    scenarioRevision: input.scenario.scenarioRevision,
    receiptId: input.receipt.receiptId,
    contractId: input.receipt.contractId,
    branchId: input.receipt.branchId,
    agentRevisionId: input.receipt.agentRevisionId,
    evaluationSuiteId: input.receipt.evaluationSuiteId,
    ...(input.receipt.runtimeProfileBinding === undefined
      ? {}
      : { runtimeProfileBinding: input.receipt.runtimeProfileBinding }),
    expectationResults,
    regression,
    status: allMatched && input.receipt.completion.verified === 'verified' ? 'passed' : 'failed',
    authority: 'evidence-export-only',
    deploymentAuthorized: false,
    organizationalApprovalGranted: false,
    publicationAuthorized: false,
    generatedAt: requireIsoTimestamp(input.generatedAt, 'generatedAt'),
  };
  const resultHash = digest(core);
  return { ...core, resultId: `ci-result-${resultHash}`, resultHash };
}

export function verifyOutcomeCiResult(result: OutcomeCiResultV1): void {
  const { resultId: _resultId, resultHash: _resultHash, ...core } = result;
  const expectedHash = digest(core);
  if (result.resultHash !== expectedHash || result.resultId !== `ci-result-${expectedHash}`) {
    throw new OutcomeStudioIntegrityError('Outcome CI result identity does not match its content');
  }
  if (
    result.authority !== 'evidence-export-only' ||
    result.deploymentAuthorized !== false ||
    result.organizationalApprovalGranted !== false ||
    result.publicationAuthorized !== false
  ) {
    throw new OutcomeStudioPolicyError('Outcome CI result cannot grant release authority');
  }
  if (result.expectationResults.length === 0) {
    throw new OutcomeStudioIntegrityError('Outcome CI result has no criterion expectations');
  }
  if (
    result.runtimeProfileBinding !== undefined &&
    stableCanonicalJson(normalizeRuntimeProfileBinding(result.runtimeProfileBinding)) !==
      stableCanonicalJson(result.runtimeProfileBinding)
  ) {
    throw new OutcomeStudioIntegrityError('Outcome CI Runtime Profile binding is invalid');
  }
  requireUnique(
    result.expectationResults.map((expectation) => expectation.criterionId),
    'Outcome CI result criterion IDs',
  );
  const anyUnknown = result.expectationResults.some(
    (expectation) =>
      expectation.actualStatus === 'unknown' || expectation.actualStatus === 'missing',
  );
  const allMatched = result.expectationResults.every(
    (expectation) => expectation.matched && expectation.actualStatus === expectation.expectedStatus,
  );
  const expectedRegression = anyUnknown ? 'inconclusive' : allMatched ? 'retained' : 'returned';
  if (result.regression !== expectedRegression) {
    throw new OutcomeStudioIntegrityError('Outcome CI regression conclusion is inconsistent');
  }
  if (result.status === 'passed' && (!allMatched || result.regression !== 'retained')) {
    throw new OutcomeStudioPolicyError(
      'Outcome CI cannot pass with failed, missing, unknown, or mismatched expectations',
    );
  }
}

export function enforceOutcomeCiResult(result: OutcomeCiResultV1): OutcomeCiEnforcementV1 {
  verifyOutcomeCiResult(result);
  const reasons = uniqueSorted([
    ...(result.status === 'passed' ? [] : [`status:${result.status}`]),
    ...(result.regression === 'retained' ? [] : [`regression:${result.regression}`]),
    ...result.expectationResults
      .filter(
        (expectation) =>
          !expectation.matched ||
          expectation.actualStatus === 'unknown' ||
          expectation.actualStatus === 'missing',
      )
      .map((expectation) => `criterion:${expectation.criterionId}:${expectation.actualStatus}`),
  ]);
  return {
    resultId: result.resultId,
    status: reasons.length === 0 ? 'passed' : 'failed',
    exitCode: reasons.length === 0 ? 0 : 1,
    reasons,
  };
}

export function selectVerifiedOutcomeBranch(input: {
  readonly comparison: BranchComparisonV1;
  readonly receipt: StudioOutcomeReceiptV1;
  readonly authorityKind: 'human' | 'external-authority';
  readonly authorityRef: string;
  readonly decidedAt: string;
}): OutcomeBranchSelectionV1 {
  verifyStudioOutcomeReceipt(input.receipt);
  if (!input.comparison.branchIds.includes(input.receipt.branchId)) {
    throw new OutcomeStudioPolicyError('Selected Branch is absent from the comparison');
  }
  if (
    input.comparison.contractId !== input.receipt.contractId ||
    input.comparison.suiteId !== input.receipt.evaluationSuiteId
  ) {
    throw new OutcomeStudioPolicyError('Selection does not match the comparison evidence');
  }
  if (input.receipt.completion.verified !== 'verified') {
    throw new OutcomeStudioPolicyError('An unverified Branch cannot be selected');
  }
  if (!['human', 'external-authority'].includes(input.authorityKind)) {
    throw new OutcomeStudioPolicyError('A model cannot select an Outcome Branch');
  }
  const core = {
    schemaVersion: 'missionbraid.dev/outcome-branch-selection/v1' as const,
    comparisonId: input.comparison.comparisonId,
    contractId: input.comparison.contractId,
    branchId: input.receipt.branchId,
    receiptId: input.receipt.receiptId,
    authorityKind: input.authorityKind,
    authorityRef: requireNonEmpty(input.authorityRef, 'authorityRef'),
    decidedAt: requireIsoTimestamp(input.decidedAt, 'decidedAt'),
  };
  const selectionHash = digest(core);
  return {
    ...core,
    selectionId: `outcome-selection-${selectionHash}`,
    selectionHash,
  };
}

export function verifyOutcomeBranchSelection(selection: OutcomeBranchSelectionV1): void {
  const { selectionId: _selectionId, selectionHash: _selectionHash, ...core } = selection;
  const expectedHash = digest(core);
  if (
    selection.selectionHash !== expectedHash ||
    selection.selectionId !== `outcome-selection-${expectedHash}`
  ) {
    throw new OutcomeStudioIntegrityError(
      'Outcome Branch selection identity does not match its content',
    );
  }
  if (!['human', 'external-authority'].includes(selection.authorityKind)) {
    throw new OutcomeStudioPolicyError('A model cannot select an Outcome Branch');
  }
}

export async function rerunIncidentScenario(
  input: RerunIncidentScenarioInputV1,
): Promise<IncidentScenarioRerunV1> {
  verifyIncidentScenario(input.scenario);
  const executionPlan = input.scenario.executionPlan;
  if (executionPlan === null) {
    throw new OutcomeStudioPolicyError('Incident Scenario has no executable rerun plan');
  }
  verifyAgentRevision(input.target.agentRevision);
  if (input.target.contractId !== input.scenario.contractId) {
    throw new OutcomeStudioPolicyError('Incident rerun target uses a different Contract');
  }
  if (input.target.scenarioId !== input.scenario.scenarioId) {
    throw new OutcomeStudioPolicyError('Incident rerun target is not bound to the Scenario');
  }
  if (
    executionPlan.requiresDistinctAgentRevision &&
    input.target.agentRevision.revisionId === input.scenario.sourceAgentRevisionId
  ) {
    throw new OutcomeStudioPolicyError(
      'Incident rerun requires an upgraded Agent Revision distinct from its source',
    );
  }
  const evaluation = await input.registry.evaluateBranch(
    executionPlan.evaluationSuite,
    input.target,
  );
  const branch: OutcomeBranchRecordV1 = {
    branchId: input.target.branchId,
    contractId: input.target.contractId,
    lineageBranchIds: input.lineageBranchIds,
    checkpointId: input.target.checkpointId,
    eventHeadHash: input.target.eventHeadHash,
    eventThroughSeq: input.target.eventThroughSeq,
    agentRevision: input.target.agentRevision,
    evaluation,
    dimensions: input.dimensions,
    agentReported: input.agentReported,
  };
  // Normalize before issuing the Receipt so malformed branch evidence cannot
  // be hidden behind a successful evaluator result.
  normalizeBranchRecord(branch);
  const receipt = issueStudioOutcomeReceipt({
    branch,
    effects: input.effects,
    ...(input.runtimeProfileBinding === undefined
      ? {}
      : { runtimeProfileBinding: input.runtimeProfileBinding }),
    outcomePolicyVersion: input.outcomePolicyVersion,
    issuedAt: input.issuedAt,
  });
  const ciResult = createOutcomeCiResult({
    scenario: input.scenario,
    receipt,
    generatedAt: input.issuedAt,
  });
  verifyOutcomeCiResult(ciResult);
  return {
    scenarioId: input.scenario.scenarioId,
    sourceAgentRevisionId: input.scenario.sourceAgentRevisionId,
    targetAgentRevisionId: input.target.agentRevision.revisionId,
    targetProfileId: input.target.agentRevision.profileId,
    ...(input.runtimeProfileBinding === undefined
      ? {}
      : { runtimeProfileBinding: normalizeRuntimeProfileBinding(input.runtimeProfileBinding) }),
    evaluation,
    receipt,
    ciResult,
  };
}

function normalizeRevisionDimension(
  input: AgentRevisionDimensionInputV1,
  index: number,
): AgentRevisionDimensionEvidenceV1 {
  if (!AGENT_REVISION_DIMENSIONS.includes(input.dimension)) {
    throw new OutcomeStudioValidationError(`dimensions[${index}].dimension is invalid`);
  }
  if (!['known', 'partial', 'unknown'].includes(input.fidelity)) {
    throw new OutcomeStudioValidationError(`dimensions[${index}].fidelity is invalid`);
  }
  const evidenceRefs = normalizeRefs(input.evidenceRefs, `dimensions[${index}].evidenceRefs`, true);
  if (input.fidelity === 'known') {
    if (input.contentDigest === undefined || evidenceRefs.length === 0) {
      throw new OutcomeStudioValidationError(
        `Known Agent Revision dimension ${input.dimension} requires a digest and evidence`,
      );
    }
    return {
      dimension: input.dimension,
      fidelity: input.fidelity,
      contentDigest: requireNonEmpty(input.contentDigest, `dimensions[${index}].contentDigest`),
      evidenceRefs,
      reason: null,
    };
  }
  const reason = requireNonEmpty(input.reason ?? '', `dimensions[${index}].reason`);
  if (input.fidelity === 'unknown' && input.contentDigest !== undefined) {
    throw new OutcomeStudioValidationError(
      `Unknown Agent Revision dimension ${input.dimension} cannot claim a content digest`,
    );
  }
  return {
    dimension: input.dimension,
    fidelity: input.fidelity,
    contentDigest:
      input.contentDigest === undefined
        ? null
        : requireNonEmpty(input.contentDigest, `dimensions[${index}].contentDigest`),
    evidenceRefs,
    reason,
  };
}

function agentRevisionIdentityCore(core: AgentRevisionCoreV1): AgentRevisionIdentityCoreV1 {
  return {
    schemaVersion: core.schemaVersion,
    dimensions: core.dimensions,
    policyEvidence: core.policyEvidence,
  };
}

function normalizeIncidentExecutionPlan(
  input: IncidentScenarioExecutionPlanInputV1 | undefined,
  contractId: string,
  evaluationSuiteId: string,
): IncidentScenarioExecutionPlanV1 | null {
  if (input === undefined) return null;
  verifyEvaluationSuite(input.evaluationSuite);
  if (
    input.evaluationSuite.contractId !== contractId ||
    input.evaluationSuite.suiteId !== evaluationSuiteId
  ) {
    throw new OutcomeStudioPolicyError(
      'Incident execution plan must embed the controlling Contract-bound Evaluation Suite',
    );
  }
  if (typeof input.requiresDistinctAgentRevision !== 'boolean') {
    throw new OutcomeStudioValidationError(
      'executionPlan.requiresDistinctAgentRevision must be boolean',
    );
  }
  return {
    runner: {
      kind: requireNonEmpty(input.runner.kind, 'executionPlan.runner.kind'),
      version: requireNonEmpty(input.runner.version, 'executionPlan.runner.version'),
    },
    evaluationSuite: input.evaluationSuite,
    sourceProfileId: requireNonEmpty(input.sourceProfileId, 'executionPlan.sourceProfileId'),
    sourceProfileDigest: requireNonEmpty(
      input.sourceProfileDigest,
      'executionPlan.sourceProfileDigest',
    ),
    requiresDistinctAgentRevision: input.requiresDistinctAgentRevision,
    evidenceRefs: normalizeRefs(input.evidenceRefs, 'executionPlan.evidenceRefs'),
  };
}

function normalizeEvaluationCriterion(
  input: EvaluationCriterionInputV1,
  index: number,
): EvaluationCriterionV1 {
  const path = `criteria[${index}]`;
  if (!['deterministic-control', 'stochastic-model'].includes(input.mode)) {
    throw new OutcomeStudioValidationError(`${path}.mode is invalid`);
  }
  const evaluators = input.evaluators
    .map((evaluator, evaluatorIndex) => ({
      kind: requireNonEmpty(evaluator.kind, `${path}.evaluators[${evaluatorIndex}].kind`),
      version: requireNonEmpty(evaluator.version, `${path}.evaluators[${evaluatorIndex}].version`),
      role: normalizeEvaluatorRole(evaluator.role, `${path}.evaluators[${evaluatorIndex}].role`),
    }))
    .sort(compareEvaluatorBinding);
  requireUnique(
    evaluators.map((evaluator) => registryKey(evaluator.kind, evaluator.version)),
    `${path}.evaluators`,
  );
  if (!evaluators.some((evaluator) => evaluator.role === 'authoritative')) {
    throw new OutcomeStudioPolicyError(
      `Criterion ${input.criterionId} requires a non-advisory evaluator`,
    );
  }
  const trialCount = input.trialCount ?? 1;
  if (!Number.isSafeInteger(trialCount) || trialCount <= 0) {
    throw new OutcomeStudioValidationError(`${path}.trialCount must be a positive safe integer`);
  }
  if (input.mode === 'deterministic-control') {
    if (trialCount !== 1 || input.threshold !== undefined) {
      throw new OutcomeStudioPolicyError(
        `Deterministic criterion ${input.criterionId} must use one trial and no stochastic threshold`,
      );
    }
  } else {
    if (trialCount < 2 || input.threshold === undefined) {
      throw new OutcomeStudioPolicyError(
        `Stochastic criterion ${input.criterionId} requires repeated trials and a predeclared threshold`,
      );
    }
  }
  return {
    criterionId: requireNonEmpty(input.criterionId, `${path}.criterionId`),
    required: requireBoolean(input.required, `${path}.required`),
    mode: input.mode,
    runner: {
      kind: requireNonEmpty(input.runner.kind, `${path}.runner.kind`),
      version: requireNonEmpty(input.runner.version, `${path}.runner.version`),
    },
    evaluators,
    trialCount,
    threshold:
      input.threshold === undefined
        ? null
        : normalizeThreshold(input.threshold, trialCount, `${path}.threshold`),
  };
}

function normalizeThreshold(
  input: StochasticThresholdV1,
  trialCount: number,
  path: string,
): StochasticThresholdV1 {
  if (!['pass-rate', 'mean-score'].includes(input.metric)) {
    throw new OutcomeStudioValidationError(`${path}.metric is invalid`);
  }
  if (input.operator !== 'gte') {
    throw new OutcomeStudioValidationError(`${path}.operator must be gte`);
  }
  if (!Number.isFinite(input.value) || input.value < 0 || input.value > 1) {
    throw new OutcomeStudioValidationError(`${path}.value must be between 0 and 1`);
  }
  if (
    !Number.isSafeInteger(input.minimumKnownTrials) ||
    input.minimumKnownTrials <= 0 ||
    input.minimumKnownTrials > trialCount
  ) {
    throw new OutcomeStudioValidationError(
      `${path}.minimumKnownTrials must be within the declared trial count`,
    );
  }
  return {
    metric: input.metric,
    operator: input.operator,
    value: input.value,
    minimumKnownTrials: input.minimumKnownTrials,
  };
}

function normalizeRunnerRegistration(
  input: CriterionRunnerRegistrationV1,
): CriterionRunnerRegistrationV1 {
  if (!['deterministic-control', 'stochastic-model'].includes(input.mode)) {
    throw new OutcomeStudioValidationError('runner.mode is invalid');
  }
  if (typeof input.run !== 'function') {
    throw new OutcomeStudioValidationError('runner.run must be a function');
  }
  return {
    kind: requireNonEmpty(input.kind, 'runner.kind'),
    version: requireNonEmpty(input.version, 'runner.version'),
    mode: input.mode,
    run: input.run,
  };
}

function normalizeEvaluatorRegistration(
  input: CriterionEvaluatorRegistrationV1,
): CriterionEvaluatorRegistrationV1 {
  if (!['deterministic', 'external-authority', 'model-judge'].includes(input.basis)) {
    throw new OutcomeStudioValidationError('evaluator.basis is invalid');
  }
  if (typeof input.evaluate !== 'function') {
    throw new OutcomeStudioValidationError('evaluator.evaluate must be a function');
  }
  if (input.basis === 'model-judge') {
    requireNonEmpty(input.rubricVersion ?? '', 'evaluator.rubricVersion');
    requireNonEmpty(input.calibrationBoundaryRef ?? '', 'evaluator.calibrationBoundaryRef');
  }
  return {
    kind: requireNonEmpty(input.kind, 'evaluator.kind'),
    version: requireNonEmpty(input.version, 'evaluator.version'),
    basis: input.basis,
    ...(input.rubricVersion === undefined ? {} : { rubricVersion: input.rubricVersion }),
    ...(input.calibrationBoundaryRef === undefined
      ? {}
      : { calibrationBoundaryRef: input.calibrationBoundaryRef }),
    evaluate: input.evaluate,
  };
}

function validateEvaluationTarget(
  suite: EvaluationSuiteV1,
  target: BranchEvaluationTargetV1,
): void {
  if (target.contractId !== suite.contractId) {
    throw new OutcomeStudioPolicyError('Evaluation target and Suite must use the same Contract');
  }
  requireNonEmpty(target.branchId, 'target.branchId');
  requireNonEmpty(target.checkpointId, 'target.checkpointId');
  requireNonEmpty(target.eventHeadHash, 'target.eventHeadHash');
  nonNegativeSafeInteger(target.eventThroughSeq, 'target.eventThroughSeq');
}

function normalizeTrial(
  input: CriterionTrialObservationInputV1,
  trialIndex: number,
): Omit<CriterionTrialObservationV1, 'trialId'> {
  return {
    trialIndex,
    outcome: validateCriterionStatus(input.outcome, `trial[${trialIndex}].outcome`),
    score: input.score === undefined ? null : ratio(input.score, `trial[${trialIndex}].score`),
    evidenceRefs: normalizeRefs(input.evidenceRefs, `trial[${trialIndex}].evidenceRefs`),
    retainedArtifactRefs: normalizeRefs(
      input.retainedArtifactRefs ?? [],
      `trial[${trialIndex}].retainedArtifactRefs`,
      true,
    ),
  };
}

function evaluateThreshold(
  criterion: EvaluationCriterionV1,
  trials: readonly CriterionTrialObservationV1[],
): ThresholdEvaluationV1 {
  if (criterion.threshold === null) {
    return {
      status: 'not-applicable',
      metric: null,
      threshold: null,
      observedValue: null,
      knownTrials: trials.filter((trial) => trial.outcome !== 'unknown').length,
      totalTrials: trials.length,
    };
  }
  const knownTrials = trials.filter((trial) => trial.outcome !== 'unknown');
  let observedValue: number | null;
  if (criterion.threshold.metric === 'pass-rate') {
    observedValue = trials.filter((trial) => trial.outcome === 'passed').length / trials.length;
  } else {
    const scores = trials.flatMap((trial) => (trial.score === null ? [] : [trial.score]));
    observedValue =
      scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }
  const enoughKnown = knownTrials.length >= criterion.threshold.minimumKnownTrials;
  return {
    status:
      !enoughKnown || observedValue === null
        ? 'unknown'
        : observedValue >= criterion.threshold.value
          ? 'passed'
          : 'failed',
    metric: criterion.threshold.metric,
    threshold: criterion.threshold.value,
    observedValue,
    knownTrials: knownTrials.length,
    totalTrials: trials.length,
  };
}

function aggregateStatuses(statuses: readonly CriterionStatusV1[]): CriterionStatusV1 {
  if (statuses.length === 0) return 'unknown';
  if (statuses.includes('failed')) return 'failed';
  return statuses.every((status) => status === 'passed') ? 'passed' : 'unknown';
}

function normalizeBranchRecord(input: OutcomeBranchRecordV1): OutcomeBranchRecordV1 {
  verifyAgentRevision(input.agentRevision);
  verifyBranchEvaluation(input.evaluation);
  const branchId = requireNonEmpty(input.branchId, 'branch.branchId');
  const contractId = requireNonEmpty(input.contractId, 'branch.contractId');
  if (input.evaluation.branchId !== branchId || input.evaluation.contractId !== contractId) {
    throw new OutcomeStudioPolicyError('Branch and evaluation identities do not match');
  }
  if (input.evaluation.agentRevisionId !== input.agentRevision.revisionId) {
    throw new OutcomeStudioPolicyError('Branch and evaluation Agent Revisions do not match');
  }
  const dimensions = input.dimensions.map(normalizeBranchDimension).sort(compareBranchDimension);
  requireExactMembers(
    dimensions.map((dimension) => dimension.dimension),
    BRANCH_COMPARISON_DIMENSIONS,
    'Branch comparison dimensions',
  );
  const lineageBranchIds = input.lineageBranchIds.map((id, index) =>
    requireNonEmpty(id, `branch.lineageBranchIds[${index}]`),
  );
  requireUnique(lineageBranchIds, 'branch.lineageBranchIds');
  if (lineageBranchIds.at(-1) !== branchId) {
    throw new OutcomeStudioValidationError('Branch lineage must end at the current branchId');
  }
  return {
    branchId,
    contractId,
    lineageBranchIds,
    checkpointId: requireNonEmpty(input.checkpointId, 'branch.checkpointId'),
    eventHeadHash: requireNonEmpty(input.eventHeadHash, 'branch.eventHeadHash'),
    eventThroughSeq: nonNegativeSafeInteger(input.eventThroughSeq, 'branch.eventThroughSeq'),
    agentRevision: input.agentRevision,
    evaluation: input.evaluation,
    dimensions,
    agentReported: normalizeAgentReport(input.agentReported),
  };
}

function normalizeBranchDimension(
  input: BranchDimensionEvidenceInputV1,
  index: number,
): BranchDimensionEvidenceInputV1 {
  if (!BRANCH_COMPARISON_DIMENSIONS.includes(input.dimension)) {
    throw new OutcomeStudioValidationError(`branch.dimensions[${index}].dimension is invalid`);
  }
  if (!['known', 'unknown'].includes(input.fidelity)) {
    throw new OutcomeStudioValidationError(`branch.dimensions[${index}].fidelity is invalid`);
  }
  if (input.fidelity === 'known' && input.digest === undefined) {
    throw new OutcomeStudioValidationError(
      `Known comparison dimension ${input.dimension} requires a digest`,
    );
  }
  if (input.fidelity === 'unknown' && input.digest !== undefined) {
    throw new OutcomeStudioValidationError(
      `Unknown comparison dimension ${input.dimension} cannot claim a digest`,
    );
  }
  const evidenceRefs = normalizeRefs(
    input.evidenceRefs,
    `branch.dimensions[${index}].evidenceRefs`,
    true,
  );
  return input.fidelity === 'known'
    ? {
        dimension: input.dimension,
        fidelity: 'known',
        digest: requireNonEmpty(input.digest!, `branch.dimensions[${index}].digest`),
        evidenceRefs,
      }
    : {
        dimension: input.dimension,
        fidelity: 'unknown',
        evidenceRefs,
      };
}

function normalizeAgentReport(input: AgentReportedCompletionV1): AgentReportedCompletionV1 {
  if (!['reported-success', 'reported-failure', 'not-reported'].includes(input.status)) {
    throw new OutcomeStudioValidationError('agentReported.status is invalid');
  }
  const evidenceRefs = normalizeRefs(input.evidenceRefs, 'agentReported.evidenceRefs', true);
  if (input.status !== 'not-reported' && evidenceRefs.length === 0) {
    throw new OutcomeStudioValidationError('An Agent completion report requires evidence');
  }
  return { status: input.status, evidenceRefs };
}

function verifyBranchEvaluation(evaluation: BranchEvaluationV1): void {
  const { evaluationId: _evaluationId, evaluationHash: _evaluationHash, ...core } = evaluation;
  const expected = digest(core);
  if (
    evaluation.evaluationHash !== expected ||
    evaluation.evaluationId !== `evaluation-${expected}`
  ) {
    throw new OutcomeStudioIntegrityError('Branch Evaluation identity does not match its content');
  }
}

function redactIncidentArtifact(
  input: IncidentArtifactInputV1,
  index: number,
): RedactedIncidentArtifactV1 {
  if (!INCIDENT_ARTIFACT_KINDS.includes(input.kind)) {
    throw new OutcomeStudioValidationError(`artifacts[${index}].kind is invalid`);
  }
  const raw = requireNonEmpty(input.content, `artifacts[${index}].content`);
  const sanitized = sanitizeNativeArtifact(raw);
  const content = canonicalizeSanitizedArtifact(sanitized.content, sanitized.mediaType);
  const sha = sha256(content);
  return {
    kind: input.kind,
    artifactId: `incident-artifact-${sha}`,
    sha256: sha,
    mediaType: sanitized.mediaType,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    sanitized: true,
    redactionCount: sanitized.redactionCount,
  };
}

function canonicalizeSanitizedArtifact(
  content: string,
  mediaType: 'application/json' | 'text/plain',
): string {
  if (mediaType === 'text/plain') return content;
  return `${stableCanonicalJson(JSON.parse(content) as unknown)}\n`;
}

function normalizeOutcomeEffect(
  input: OutcomeEffectEvidenceV1,
  index: number,
): OutcomeEffectEvidenceV1 {
  if (!['resolved', 'blocking', 'ambiguous'].includes(input.resolution)) {
    throw new OutcomeStudioValidationError(`effects[${index}].resolution is invalid`);
  }
  validateEffectStatus(input.status, `effects[${index}].status`);
  if (input.resolution === 'resolved' && input.status === 'ambiguous') {
    throw new OutcomeStudioPolicyError(`Ambiguous Effect ${input.effectId} cannot be resolved`);
  }
  return {
    effectId: requireNonEmpty(input.effectId, `effects[${index}].effectId`),
    required: requireBoolean(input.required, `effects[${index}].required`),
    status: input.status,
    resolution: input.resolution,
    evidenceRefs: normalizeRefs(input.evidenceRefs, `effects[${index}].evidenceRefs`, true),
  };
}

function normalizeRuntimeProfileBinding(
  input: OutcomeRuntimeProfileBindingV1,
): OutcomeRuntimeProfileBindingV1 {
  const sourceProfileId = requireNonEmpty(
    input.sourceProfileId,
    'runtimeProfileBinding.sourceProfileId',
  );
  const targetProfileId = requireNonEmpty(
    input.targetProfileId,
    'runtimeProfileBinding.targetProfileId',
  );
  if (sourceProfileId === targetProfileId) {
    throw new OutcomeStudioPolicyError(
      'Outcome Runtime Profile binding must identify a distinct target Profile',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.plannerDecisionHash)) {
    throw new OutcomeStudioValidationError(
      'runtimeProfileBinding.plannerDecisionHash must be a complete Planner hash',
    );
  }
  if (input.authorityChange !== 'unchanged' && input.authorityChange !== 'narrowed') {
    throw new OutcomeStudioPolicyError(
      'Outcome Runtime Profile binding cannot expand Runtime authority',
    );
  }
  return {
    sourceProfileId,
    targetProfileId,
    targetStageId: requireNonEmpty(input.targetStageId, 'runtimeProfileBinding.targetStageId'),
    targetProfileDefinitionId: requireNonEmpty(
      input.targetProfileDefinitionId,
      'runtimeProfileBinding.targetProfileDefinitionId',
    ),
    profileSelectionId: requireNonEmpty(
      input.profileSelectionId,
      'runtimeProfileBinding.profileSelectionId',
    ),
    plannerDecisionHash: input.plannerDecisionHash,
    authorityChange: input.authorityChange,
    evidenceRefs: normalizeRefs(input.evidenceRefs, 'runtimeProfileBinding.evidenceRefs'),
  };
}

function normalizeAcceptance(
  input: BranchAcceptanceV1 | undefined,
  branchId: string,
): BranchAcceptanceV1 | null {
  if (input === undefined) return null;
  if (input.branchId !== branchId) {
    throw new OutcomeStudioPolicyError('Acceptance targets a different Branch');
  }
  if (!['accepted', 'rejected'].includes(input.decision)) {
    throw new OutcomeStudioValidationError('acceptance.decision is invalid');
  }
  if (!['human', 'external-authority'].includes(input.authorityKind)) {
    throw new OutcomeStudioPolicyError('A model cannot accept or select a Branch');
  }
  return {
    branchId,
    decision: input.decision,
    authorityKind: input.authorityKind,
    authorityRef: requireNonEmpty(input.authorityRef, 'acceptance.authorityRef'),
    decidedAt: requireIsoTimestamp(input.decidedAt, 'acceptance.decidedAt'),
  };
}

function normalizeEvaluatorRole(
  value: CriterionEvaluatorBindingV1['role'],
  path: string,
): CriterionEvaluatorBindingV1['role'] {
  if (!['authoritative', 'advisory'].includes(value)) {
    throw new OutcomeStudioValidationError(`${path} is invalid`);
  }
  return value;
}

function validateCriterionStatus(value: unknown, path: string): CriterionStatusV1 {
  if (!['passed', 'failed', 'unknown'].includes(value as CriterionStatusV1)) {
    throw new OutcomeStudioValidationError(`${path} is invalid`);
  }
  return value as CriterionStatusV1;
}

function validateEffectStatus(value: unknown, path: string): EffectStatusV1 {
  if (
    ![
      'intended',
      'dispatch_started',
      'executed',
      'confirmed',
      'skipped',
      'ambiguous',
      'conflict',
      'failed',
    ].includes(value as EffectStatusV1)
  ) {
    throw new OutcomeStudioValidationError(`${path} is invalid`);
  }
  return value as EffectStatusV1;
}

function normalizeRefs(values: readonly string[], path: string, allowEmpty = false): string[] {
  const normalized = values.map((value, index) => requireNonEmpty(value, `${path}[${index}]`));
  if (!allowEmpty && normalized.length === 0) {
    throw new OutcomeStudioValidationError(`${path} must not be empty`);
  }
  return uniqueSorted(normalized);
}

function requireExactMembers(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
): void {
  requireUnique(actual, path);
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (stableCanonicalJson(actualSorted) !== stableCanonicalJson(expectedSorted)) {
    throw new OutcomeStudioValidationError(
      `${path} must contain every required member exactly once`,
    );
  }
}

function requireUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new OutcomeStudioValidationError(`${path} must not contain duplicates`);
  }
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new OutcomeStudioValidationError(`${path} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function requireBoolean(value: boolean, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OutcomeStudioValidationError(`${path} must be boolean`);
  }
  return value;
}

function requireIsoTimestamp(value: string, path: string): string {
  requireNonEmpty(value, path);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new OutcomeStudioValidationError(`${path} must be a canonical ISO timestamp`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OutcomeStudioValidationError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function ratio(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new OutcomeStudioValidationError(`${path} must be between 0 and 1`);
  }
  return value;
}

function registryKey(kind: string, version: string): string {
  return `${kind}@${version}`;
}

function compareDimension(
  left: AgentRevisionDimensionEvidenceV1,
  right: AgentRevisionDimensionEvidenceV1,
): number {
  return compareText(left.dimension, right.dimension);
}

function compareCriterion(left: EvaluationCriterionV1, right: EvaluationCriterionV1): number {
  return compareText(left.criterionId, right.criterionId);
}

function compareEvaluatorBinding(
  left: CriterionEvaluatorBindingV1,
  right: CriterionEvaluatorBindingV1,
): number {
  return (
    compareText(left.role, right.role) ||
    compareText(left.kind, right.kind) ||
    compareText(left.version, right.version)
  );
}

function compareBranch(left: OutcomeBranchRecordV1, right: OutcomeBranchRecordV1): number {
  return compareText(left.branchId, right.branchId);
}

function compareBranchDimension(
  left: { readonly dimension: BranchComparisonDimensionV1 },
  right: { readonly dimension: BranchComparisonDimensionV1 },
): number {
  return compareText(left.dimension, right.dimension);
}

function compareArtifact(
  left: RedactedIncidentArtifactV1,
  right: RedactedIncidentArtifactV1,
): number {
  return compareText(left.kind, right.kind);
}

function compareEffect(left: OutcomeEffectEvidenceV1, right: OutcomeEffectEvidenceV1): number {
  return compareText(left.effectId, right.effectId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function digest(value: unknown): string {
  return sha256(stableCanonicalJson(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OutcomeStudioValidationError('Canonical JSON forbids non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => {
        const member = record[key];
        if (member === undefined) {
          throw new OutcomeStudioValidationError(`Canonical JSON forbids undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${stableCanonicalJson(member)}`;
      })
      .join(',')}}`;
  }
  throw new OutcomeStudioValidationError(`Canonical JSON forbids ${typeof value}`);
}
