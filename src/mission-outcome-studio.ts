import { createHash } from 'node:crypto';

import type {
  AttemptBindingV1,
  BranchV1,
  ContractV1,
  EffectV1,
  EventV1,
  MissionV1,
  ProfileV1,
  ReceiptV1,
  StoredEventV1,
} from './domain.js';
import type {
  CompositeCheckpointManifestV1,
  CheckpointInterventionV1,
} from './composite-checkpoint.js';
import {
  AGENT_REVISION_DIMENSIONS,
  compareContractBranches,
  createAgentRevision,
  createEvaluationSuite,
  createIncidentScenario,
  createOutcomeCiResult,
  issueStudioOutcomeReceipt,
  type AgentRevisionV1,
  type AgentRevisionDimensionInputV1,
  type EvaluationSuiteV1,
  type IncidentScenarioV1,
  type OutcomeBranchRecordV1,
  type OutcomeCiResultV1,
  type BranchEvaluationV1,
  type BranchDimensionEvidenceInputV1,
  type BranchComparisonV1,
} from './outcome-studio.js';

/** Inputs are persisted Mission facts only; this adapter never infers runtime facts. */
export interface MissionOutcomeStudioInputV1 {
  readonly mission: MissionV1;
  readonly contract: ContractV1;
  readonly profile: ProfileV1;
  readonly branch: BranchV1;
  readonly attemptBinding?: AttemptBindingV1;
  readonly checkpoint?: CompositeCheckpointManifestV1;
  readonly intervention?: CheckpointInterventionV1;
  readonly events?: readonly (EventV1 | StoredEventV1)[];
  readonly effects?: readonly EffectV1[];
  readonly receipt?: ReceiptV1;
  readonly evaluation?: BranchEvaluationV1;
  readonly siblingBranches?: readonly OutcomeBranchRecordV1[];
  readonly suiteVersion?: string;
  readonly outcomePolicyVersion?: string;
  readonly createdAt?: string;
}

export interface MissionOutcomeStudioViewV1 {
  readonly agentRevision: AgentRevisionV1 | null;
  readonly evaluationSuite: EvaluationSuiteV1 | null;
  readonly branch: OutcomeBranchRecordV1 | null;
  readonly comparison: BranchComparisonV1 | null;
  readonly incidentScenario: IncidentScenarioV1 | null;
  readonly ciResult: OutcomeCiResultV1 | null;
  readonly studioReceipt: ReturnType<typeof issueStudioOutcomeReceipt> | null;
  readonly unknown: readonly string[];
}

export function createMissionOutcomeStudioView(
  input: MissionOutcomeStudioInputV1,
): MissionOutcomeStudioViewV1 {
  const events = [...(input.events ?? [])].sort(
    (a, b) => ('seq' in a ? a.seq : 0) - ('seq' in b ? b.seq : 0),
  );
  const eventRef = events.length ? `kernel-event:${events.at(-1)!.eventId}` : undefined;
  const evidence = eventRef ? [eventRef] : [];
  const unknown: string[] = [];
  const binding = input.attemptBinding;
  let agentRevision: AgentRevisionV1 | null = null;
  if (binding) {
    const profileRef = `profile:${input.profile.profileId}`;
    const dims = AGENT_REVISION_DIMENSIONS.map((dimension) =>
      profileDimensionEvidence(dimension, input.profile, profileRef, input.events ?? []),
    );
    agentRevision = createAgentRevision({
      profileId: input.profile.profileId,
      attemptBindingId: binding.bindingId,
      dimensions: dims,
      policyEvidence: [],
    });
    dims
      .filter((dimension) => dimension.fidelity === 'unknown')
      .forEach((dimension) => unknown.push(`agentRevision.dimensions.${dimension.dimension}`));
  } else unknown.push('agentRevision.attemptBindingId');

  const evaluationSuite = createEvaluationSuite({
    contract: input.contract,
    suiteVersion: input.suiteVersion ?? 'mission-contract-v1',
    outcomePolicyVersion: input.outcomePolicyVersion ?? 'mission-outcome-policy-v1',
    criteria: input.contract.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      required: true,
      mode: 'deterministic-control',
      runner: { kind: criterion.verifier.kind, version: 'mission-contract-v1' },
      evaluators: [{ kind: 'mission-receipt', version: 'v1', role: 'authoritative' }],
    })),
  });

  let evaluation = input.evaluation;
  if (!evaluation && input.receipt && agentRevision && input.checkpoint) {
    evaluation = evaluationFromReceipt(
      input.receipt,
      evaluationSuite,
      input.branch.branchId,
      agentRevision,
      input.checkpoint,
    );
  }
  let branch: OutcomeBranchRecordV1 | null = null;
  if (agentRevision && evaluation && input.checkpoint) {
    const eventThroughSeq = input.checkpoint.eventPrefix.throughSeq;
    const dimensions: BranchDimensionEvidenceInputV1[] = [
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
    ].map((dimension) => ({
      dimension: dimension as BranchDimensionEvidenceInputV1['dimension'],
      fidelity: 'unknown',
      evidenceRefs: [],
    }));
    branch = {
      branchId: input.branch.branchId,
      contractId: input.contract.contractId,
      lineageBranchIds: lineage(input.branch),
      checkpointId: input.checkpoint.checkpointId,
      eventHeadHash: input.checkpoint.eventPrefix.headHash,
      eventThroughSeq,
      agentRevision,
      evaluation,
      dimensions,
      agentReported: { status: 'not-reported', evidenceRefs: [] },
    };
  } else {
    if (!input.checkpoint) unknown.push('branch.checkpoint');
    if (!input.evaluation) unknown.push('branch.evaluation');
  }

  const comparison =
    branch && input.siblingBranches?.length
      ? compareContractBranches([branch, ...input.siblingBranches])
      : null;
  const incidentScenario =
    branch && input.intervention && input.checkpoint && input.createdAt
      ? createIncidentScenario({
          scenarioRevision: 'mission-outcome-studio-v1',
          contractId: input.contract.contractId,
          evaluationSuiteId: evaluationSuite.suiteId,
          sourceAgentRevisionId: agentRevision!.revisionId,
          sourceCheckpointId: input.checkpoint.checkpointId,
          interventionId: input.intervention.interventionId,
          artifacts: [
            { kind: 'checkpoint', content: JSON.stringify(input.checkpoint) },
            { kind: 'intervention', content: JSON.stringify(input.intervention) },
            { kind: 'contract', content: JSON.stringify(input.contract) },
            { kind: 'profile', content: JSON.stringify(input.profile) },
            {
              kind: 'expected-evidence',
              content: JSON.stringify(input.contract.acceptanceCriteria),
            },
          ],
          expectedEvidence: input.contract.acceptanceCriteria.map((c) => ({
            criterionId: c.criterionId,
            expectedStatus: 'unknown',
            evidenceRefs: [],
          })),
          createdAt: input.createdAt,
        })
      : null;
  // The kernel Receipt is evidence, not an Outcome Studio Receipt.  Re-issue a
  // content-addressed Studio Receipt from the reconstructed Branch so CI never
  // treats a shape-compatible object as authoritative by accident.
  const studioReceipt =
    branch && input.createdAt
      ? issueStudioOutcomeReceipt({
          branch,
          effects: (input.effects ?? []).map((effect) => ({
            effectId: effect.effectId,
            required: true,
            status: effect.status,
            resolution:
              effect.status === 'confirmed'
                ? 'resolved'
                : effect.status === 'ambiguous'
                  ? 'ambiguous'
                  : 'blocking',
            evidenceRefs: effect.evidenceRefs,
          })),
          outcomePolicyVersion: input.outcomePolicyVersion ?? 'mission-outcome-policy-v1',
          issuedAt: input.createdAt,
        })
      : null;
  const ciResult =
    incidentScenario && studioReceipt && input.createdAt
      ? createOutcomeCiResult({
          scenario: incidentScenario,
          receipt: studioReceipt,
          generatedAt: input.createdAt,
        })
      : null;
  return {
    agentRevision,
    evaluationSuite,
    branch,
    comparison,
    incidentScenario,
    ciResult,
    studioReceipt,
    unknown: [...new Set(unknown)].sort(),
  };
}

export const buildMissionOutcomeStudioView = createMissionOutcomeStudioView;

function lineage(branch: BranchV1): readonly string[] {
  return branch.parentBranchId ? [branch.parentBranchId, branch.branchId] : [branch.branchId];
}

function profileDimensionEvidence(
  dimension: (typeof AGENT_REVISION_DIMENSIONS)[number],
  profile: ProfileV1,
  profileRef: string,
  events: readonly (EventV1 | StoredEventV1)[],
): AgentRevisionDimensionInputV1 {
  const effective = profile.effective;
  const field = (name: keyof NonNullable<ProfileV1['effective']>) => effective?.[name];
  const eventRefs = events
    .filter((event) => event.type === 'runtime.observation')
    .filter((event) => {
      const kind = event.payload.kind;
      return kind.includes('planner') || kind.includes('profile') || kind.includes('context');
    })
    .map((event) => `event:${event.eventId}`);
  const refs = [...new Set([profileRef, ...eventRefs])].sort();
  const known = (value: unknown): AgentRevisionDimensionInputV1 => ({
    dimension,
    fidelity: 'known',
    contentDigest: sha256(JSON.stringify(value)),
    evidenceRefs: refs,
  });
  const partial = (value: unknown, reason: string): AgentRevisionDimensionInputV1 => ({
    dimension,
    fidelity: 'partial',
    contentDigest: sha256(JSON.stringify(value)),
    evidenceRefs: refs,
    reason,
  });
  const unknownDimension = (reason: string): AgentRevisionDimensionInputV1 => ({
    dimension,
    fidelity: 'unknown',
    evidenceRefs: [],
    reason,
  });

  switch (dimension) {
    case 'model-provider':
      return known({
        harness: profile.harness,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort ?? null,
        effectiveModel: field('model') ?? null,
      });
    case 'harness':
      return known({
        harness: profile.harness,
        runtimeVersion: profile.runtimeVersion ?? null,
        capabilities: profile.capabilities,
      });
    case 'prompt-instructions':
      return fieldEvidence(
        field('instructions'),
        partial,
        unknownDimension,
        'Instructions are only partially exposed',
      );
    case 'skills':
      return fieldEvidence(
        field('skills'),
        partial,
        unknownDimension,
        'Skills are only partially exposed',
      );
    case 'mcp-tools':
      return fieldEvidence(
        { mcpServers: field('mcpServers') ?? null, tools: field('tools') ?? null },
        partial,
        unknownDimension,
        'MCP or tool details are only partially exposed',
      );
    case 'context-memory':
      return field('contextWindowTokens') === undefined
        ? unknownDimension(
            'Only context-window evidence is exposed; hidden memory remains unavailable',
          )
        : fieldEvidence(
            field('contextWindowTokens'),
            partial,
            unknownDimension,
            'Only context-window evidence is exposed; hidden memory remains unavailable',
          );
    case 'permissions-effects':
      return fieldEvidence(
        field('permissions'),
        partial,
        unknownDimension,
        'Effective permissions are only partially exposed',
      );
    case 'adapter-provider':
      return profile.adapterCapabilities === undefined
        ? unknownDimension('Adapter capability evidence is unavailable')
        : known({ adapterCapabilities: profile.adapterCapabilities });
    case 'environment':
      return profile.runtimeVersion === undefined && profile.catalogObservation === undefined
        ? unknownDimension('Runtime environment evidence is unavailable')
        : partial(
            {
              runtimeVersion: profile.runtimeVersion ?? null,
              catalogObservation: profile.catalogObservation ?? null,
            },
            'Environment observations may be incomplete or stale',
          );
    case 'orchestration':
      return eventRefs.length === 0
        ? unknownDimension('Mission evidence does not expose orchestration decisions')
        : partial(
            { orchestrationEvidence: eventRefs },
            'Only persisted orchestration observations are visible',
          );
  }
}

function fieldEvidence(
  value: unknown,
  partial: (value: unknown, reason: string) => AgentRevisionDimensionInputV1,
  unknownDimension: (reason: string) => AgentRevisionDimensionInputV1,
  reason: string,
): AgentRevisionDimensionInputV1 {
  if (value === undefined) return unknownDimension(reason);
  if (isRuntimeField(value) && value.status === 'unknown')
    return unknownDimension(value.reason ?? reason);
  if (isRuntimeField(value) && value.status === 'unsupported')
    return unknownDimension(value.reason ?? reason);
  return partial(value, reason);
}

function isRuntimeField(value: unknown): value is { status: string; reason?: string } {
  return value !== null && typeof value === 'object' && 'status' in value;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function evaluationFromReceipt(
  receipt: ReceiptV1,
  suite: EvaluationSuiteV1,
  branchId: string,
  revision: AgentRevisionV1,
  checkpoint: CompositeCheckpointManifestV1,
): BranchEvaluationV1 {
  const status = new Map(receipt.verifications.map((v) => [v.criterionId, v]));
  const criteria = suite.criteria.map((criterion) => {
    const v = status.get(criterion.criterionId);
    const result =
      v?.status === 'passed' ? 'passed' : v?.status === 'failed' ? 'failed' : 'unknown';
    return {
      criterionId: criterion.criterionId,
      required: criterion.required,
      mode: criterion.mode,
      status: result as 'passed' | 'failed' | 'unknown',
      trials: [],
      thresholdEvaluation: {
        status: 'not-applicable' as const,
        metric: null,
        threshold: null,
        observedValue: null,
        knownTrials: 0,
        totalTrials: 0,
      },
      evaluatorResults: [],
      evidenceRefs: [...(v?.evidenceRefs ?? [])],
    };
  });
  const core = {
    schemaVersion: 'missionbraid.dev/branch-evaluation/v1' as const,
    suiteId: suite.suiteId,
    suiteHash: suite.suiteHash,
    contractId: suite.contractId,
    branchId,
    agentRevisionId: revision.revisionId,
    checkpointId: checkpoint.checkpointId,
    eventHeadHash: checkpoint.eventPrefix.headHash,
    eventThroughSeq: checkpoint.eventPrefix.throughSeq,
    scenarioId: null,
    criteria,
  };
  const hash = createHash('sha256').update(canonical(core), 'utf8').digest('hex');
  return { ...core, evaluationId: `evaluation-${hash}`, evaluationHash: hash };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}
