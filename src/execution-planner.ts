import { createHash } from 'node:crypto';

import type {
  AdapterCapabilitiesV1,
  EffectStatusV1,
  ProfileV1,
  RuntimeCapabilityFidelityV1,
} from './domain.js';

export const EXECUTION_PLANNER_SCHEMA_VERSION = 'missionbraid.dev/execution-plan/v1' as const;
export const EXECUTION_PLANNER_POLICY_VERSION =
  'missionbraid.dev/execution-policy/deterministic-v1' as const;

const UNKNOWN_RANK_PENALTY = Number.MAX_SAFE_INTEGER;
const RATIO_SCALE = 1_000_000;

const ADAPTER_CAPABILITY_NAMES = [
  'observe',
  'contextCapture',
  'steer',
  'interrupt',
  'preToolGate',
  'resume',
  'nativeFork',
  'workspaceRestore',
  'externalEffectControl',
] as const satisfies readonly (keyof AdapterCapabilitiesV1)[];

const OBSERVATION_SOURCES = ['official-api', 'local-cli', 'manual', 'derived', 'unknown'] as const;
const OBSERVATION_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
const OBSERVED_AVAILABILITY = ['ready', 'unavailable', 'missing', 'unknown'] as const;
const HANDOFF_CLASSIFICATIONS = [
  'exact',
  'emulated',
  'summarized',
  'rebound',
  'unavailable',
  'blocking',
] as const;

export type PlannerAdapterCapabilityNameV1 = (typeof ADAPTER_CAPABILITY_NAMES)[number];
export type PlannerMinimumFidelityV1 = Exclude<
  RuntimeCapabilityFidelityV1,
  'unsupported' | 'unknown'
>;
export type PlannerObservationSourceV1 = (typeof OBSERVATION_SOURCES)[number];
export type PlannerObservationFreshnessV1 = (typeof OBSERVATION_FRESHNESS)[number];
export type PlannerAvailabilityV1 = (typeof OBSERVED_AVAILABILITY)[number];
export type HandoffCompatibilityClassificationV1 = (typeof HANDOFF_CLASSIFICATIONS)[number];

export interface MissionHandoffStateRequirementV1 {
  readonly stateId: string;
  readonly required: boolean;
}

/**
 * These requirements are already accepted and frozen before the deterministic
 * planner runs. A model may propose them elsewhere, but cannot select a Profile.
 */
export interface FrozenMissionCapabilityRequirementsV1 {
  readonly requirementsId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly planNodeId: string;
  readonly source: 'contract' | 'manual' | 'accepted-model-proposal';
  readonly requiredProfileCapabilities: readonly string[];
  readonly minimumAdapterCapabilities?: Readonly<
    Partial<Record<PlannerAdapterCapabilityNameV1, PlannerMinimumFidelityV1>>
  >;
  readonly allowedHarnesses?: readonly string[];
  readonly minimumContextWindowTokens?: number;
  readonly minimumInjectionBudgetTokens?: number;
  readonly handoffStates?: readonly MissionHandoffStateRequirementV1[];
}

export interface PlannerObservationV1 {
  readonly observationId: string;
  readonly observedAt: string;
  readonly source: PlannerObservationSourceV1;
  readonly freshness: PlannerObservationFreshnessV1;
  readonly availability: PlannerAvailabilityV1;
  readonly quotaRemainingRatio?: number;
  readonly estimatedCostMicros?: number;
  readonly latencyMs?: number;
  readonly historicalSuccessRate?: number;
}

/** Adapter-observed transfer support for one target Profile. */
export interface CandidateHandoffStateV1 {
  readonly stateId: string;
  readonly classification: HandoffCompatibilityClassificationV1;
  readonly source: PlannerObservationSourceV1;
  readonly freshness: PlannerObservationFreshnessV1;
}

export interface PlannerProfileCandidateV1 {
  readonly profile: ProfileV1;
  readonly observation: PlannerObservationV1;
  readonly handoffStates?: readonly CandidateHandoffStateV1[];
  /** Effects this target would dispatch again without a reconciliation step. */
  readonly wouldRepeatEffectIds?: readonly string[];
}

export interface PlannerEffectFrontierEntryV1 {
  readonly effectId: string;
  readonly status: EffectStatusV1;
}

export interface PlannerManualOverrideV1 {
  readonly profileId: string;
  readonly reason: string;
}

export interface ExecutionPlannerInputV1 {
  readonly policyVersion: typeof EXECUTION_PLANNER_POLICY_VERSION;
  readonly requirements: FrozenMissionCapabilityRequirementsV1;
  readonly candidates: readonly PlannerProfileCandidateV1[];
  readonly currentProfileId?: string;
  readonly effectFrontier?: readonly PlannerEffectFrontierEntryV1[];
  readonly manualOverride?: PlannerManualOverrideV1;
}

export interface ExtractedAdapterRequirementV1 {
  readonly name: PlannerAdapterCapabilityNameV1;
  readonly minimum: PlannerMinimumFidelityV1;
}

export interface ExtractedPlannerRequirementsV1 {
  readonly requirementsId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly planNodeId: string;
  readonly source: FrozenMissionCapabilityRequirementsV1['source'];
  readonly requiredProfileCapabilities: readonly string[];
  readonly minimumAdapterCapabilities: readonly ExtractedAdapterRequirementV1[];
  readonly allowedHarnesses: readonly string[] | null;
  readonly minimumContextWindowTokens: number | null;
  readonly minimumInjectionBudgetTokens: number | null;
  readonly handoffStates: readonly MissionHandoffStateRequirementV1[];
}

export interface ExtractedPlannerCandidateV1 {
  readonly profileId: string;
  readonly harness: string;
  readonly model: string;
  readonly configurationDigest: string;
  readonly permissionMode: string | null;
  readonly profileCapabilities: readonly string[];
  readonly adapterCapabilities: AdapterCapabilitiesV1 | null;
  readonly contextWindowTokens: number | null;
  readonly injectionBudgetTokens: number | null;
  readonly observation: {
    readonly observationId: string;
    readonly observedAt: string;
    readonly source: PlannerObservationSourceV1;
    readonly freshness: PlannerObservationFreshnessV1;
    readonly availability: PlannerAvailabilityV1;
    readonly quotaRemainingRatio: number | null;
    readonly estimatedCostMicros: number | null;
    readonly latencyMs: number | null;
    readonly historicalSuccessRate: number | null;
  };
  readonly handoffStates: readonly CandidateHandoffStateV1[];
  readonly wouldRepeatEffectIds: readonly string[];
}

export interface ExtractedPlannerInputV1 {
  readonly policyVersion: typeof EXECUTION_PLANNER_POLICY_VERSION;
  readonly requirements: ExtractedPlannerRequirementsV1;
  readonly candidates: readonly ExtractedPlannerCandidateV1[];
  readonly currentProfileId: string | null;
  readonly effectFrontier: readonly PlannerEffectFrontierEntryV1[];
  readonly manualOverride: PlannerManualOverrideV1 | null;
}

export type PlannerRejectionCodeV1 =
  | 'PROFILE_NOT_READY'
  | 'HARNESS_NOT_ALLOWED'
  | 'PROFILE_CAPABILITY_MISSING'
  | 'ADAPTER_CAPABILITY_INSUFFICIENT'
  | 'CONTEXT_WINDOW_UNKNOWN'
  | 'CONTEXT_WINDOW_INSUFFICIENT'
  | 'INJECTION_BUDGET_UNKNOWN'
  | 'INJECTION_BUDGET_INSUFFICIENT'
  | 'HANDOFF_STATE_BLOCKING'
  | 'EFFECT_REPLAY_BLOCKED';

export interface PlannerRejectionReasonV1 {
  readonly code: PlannerRejectionCodeV1;
  readonly subject: string;
  readonly required: string;
  readonly actual: string;
}

export interface CandidateFilterResultV1 {
  readonly profileId: string;
  readonly eligible: boolean;
  readonly rejectionReasons: readonly PlannerRejectionReasonV1[];
}

export interface PlannerRankVectorV1 {
  readonly continuityPenalty: number;
  readonly freshnessPenalty: number;
  readonly sourcePenalty: number;
  readonly quotaPenalty: number;
  readonly costPenalty: number;
  readonly latencyPenalty: number;
  readonly outcomePenalty: number;
  readonly profileIdTieBreaker: string;
}

export interface RankedPlannerCandidateV1 {
  readonly rank: number;
  readonly profileId: string;
  readonly harness: string;
  readonly rankVector: PlannerRankVectorV1;
  readonly observationId: string;
  readonly observationSource: PlannerObservationSourceV1;
  readonly observationFreshness: PlannerObservationFreshnessV1;
}

export interface HandoffStateCompatibilityV1 {
  readonly stateId: string;
  readonly required: boolean;
  readonly classification: HandoffCompatibilityClassificationV1;
  readonly source: string;
  readonly freshness: PlannerObservationFreshnessV1;
}

export interface HandoffCompatibilityReportV1 {
  readonly profileId: string;
  readonly overall: HandoffCompatibilityClassificationV1;
  readonly states: readonly HandoffStateCompatibilityV1[];
  readonly effectFrontier: {
    readonly classification: 'exact' | 'blocking';
    readonly doNotRepeatEffectIds: readonly string[];
    readonly conflictingEffectIds: readonly string[];
  };
  readonly blockingSubjects: readonly string[];
}

export interface PlannerManualOverrideResultV1 {
  readonly status: 'none' | 'applied' | 'rejected';
  readonly requestedProfileId: string | null;
  readonly reason: string | null;
}

export interface PlannerBindingV1 {
  readonly status: 'bound' | 'blocked';
  readonly selectedProfileId: string | null;
  readonly selectedHarness: string | null;
  readonly action: 'start' | 'continue' | 'handoff' | 'blocked';
  readonly reason:
    | 'manual_override'
    | 'manual_override_rejected'
    | 'keep_current'
    | 'current_ineligible_ranked_replacement'
    | 'current_missing_ranked_replacement'
    | 'highest_ranked_eligible'
    | 'no_eligible_profile';
}

export interface ExecutionPlannerDecisionV1 {
  readonly schemaVersion: typeof EXECUTION_PLANNER_SCHEMA_VERSION;
  readonly extracted: ExtractedPlannerInputV1;
  readonly filter: {
    readonly candidates: readonly CandidateFilterResultV1[];
    readonly eligibleProfileIds: readonly string[];
  };
  readonly rank: readonly RankedPlannerCandidateV1[];
  readonly handoffCompatibility: readonly HandoffCompatibilityReportV1[];
  readonly manualOverride: PlannerManualOverrideResultV1;
  readonly binding: PlannerBindingV1;
  readonly decisionHash: string;
}

export class ExecutionPlannerInputError extends TypeError {}

export function planExecution(input: ExecutionPlannerInputV1): ExecutionPlannerDecisionV1 {
  const extracted = extractInput(input);
  const handoffCompatibility = extracted.candidates.map((candidate) =>
    classifyHandoff(candidate, extracted),
  );
  const compatibilityByProfile = new Map(
    handoffCompatibility.map((compatibility) => [compatibility.profileId, compatibility]),
  );
  const filterCandidates = extracted.candidates.map((candidate) =>
    filterCandidate(
      candidate,
      extracted,
      requireMapValue(compatibilityByProfile, candidate.profileId),
    ),
  );
  const eligibleProfileIds = filterCandidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.profileId)
    .sort(compareText);
  const eligibleIds = new Set(eligibleProfileIds);
  const rank = rankCandidates(
    extracted.candidates.filter((candidate) => eligibleIds.has(candidate.profileId)),
    extracted,
  );
  const { manualOverride, binding } = bindCandidate(extracted, eligibleIds, rank);
  const decisionCore = {
    schemaVersion: EXECUTION_PLANNER_SCHEMA_VERSION,
    extracted,
    filter: {
      candidates: filterCandidates,
      eligibleProfileIds,
    },
    rank,
    handoffCompatibility,
    manualOverride,
    binding,
  } as const;

  return {
    ...decisionCore,
    decisionHash: sha256(stableCanonicalJson(decisionCore)),
  };
}

function extractInput(input: ExecutionPlannerInputV1): ExtractedPlannerInputV1 {
  if (input.policyVersion !== EXECUTION_PLANNER_POLICY_VERSION) {
    throw new ExecutionPlannerInputError(
      `Unsupported execution planner policy ${input.policyVersion}`,
    );
  }

  const requirements = extractRequirements(input.requirements);
  const candidates = input.candidates.map(extractCandidate).sort(compareCandidate);
  requireUnique(
    candidates.map((candidate) => candidate.profileId),
    'candidates.profileId',
  );
  const effectFrontier = (input.effectFrontier ?? [])
    .map((effect, index) => ({
      effectId: requireNonEmpty(effect.effectId, `effectFrontier[${index}].effectId`),
      status: validateEffectStatus(effect.status, `effectFrontier[${index}].status`),
    }))
    .sort((left, right) => compareText(left.effectId, right.effectId));
  requireUnique(
    effectFrontier.map((effect) => effect.effectId),
    'effectFrontier.effectId',
  );
  const currentProfileId =
    input.currentProfileId === undefined
      ? null
      : requireNonEmpty(input.currentProfileId, 'currentProfileId');
  const manualOverride =
    input.manualOverride === undefined
      ? null
      : {
          profileId: requireNonEmpty(input.manualOverride.profileId, 'manualOverride.profileId'),
          reason: requireNonEmpty(input.manualOverride.reason, 'manualOverride.reason'),
        };

  return {
    policyVersion: input.policyVersion,
    requirements,
    candidates,
    currentProfileId,
    effectFrontier,
    manualOverride,
  };
}

function extractRequirements(
  input: FrozenMissionCapabilityRequirementsV1,
): ExtractedPlannerRequirementsV1 {
  const requiredProfileCapabilities = input.requiredProfileCapabilities
    .map((capability, index) =>
      requireNonEmpty(capability, `requirements.requiredProfileCapabilities[${index}]`),
    )
    .sort(compareText);
  requireUnique(requiredProfileCapabilities, 'requirements.requiredProfileCapabilities');

  const rawAdapterRequirements = input.minimumAdapterCapabilities ?? {};
  for (const name of Object.keys(rawAdapterRequirements)) {
    if (!ADAPTER_CAPABILITY_NAMES.includes(name as PlannerAdapterCapabilityNameV1)) {
      throw new ExecutionPlannerInputError(`Unknown adapter capability requirement ${name}`);
    }
  }
  const minimumAdapterCapabilities = ADAPTER_CAPABILITY_NAMES.flatMap((name) => {
    const minimum = rawAdapterRequirements[name];
    if (minimum === undefined) return [];
    if (!['native', 'cooperative', 'process-only'].includes(minimum)) {
      throw new ExecutionPlannerInputError(
        `requirements.minimumAdapterCapabilities.${name} has unsupported minimum ${minimum}`,
      );
    }
    return [{ name, minimum }];
  });

  const allowedHarnesses =
    input.allowedHarnesses === undefined
      ? null
      : input.allowedHarnesses
          .map((harness, index) =>
            requireNonEmpty(harness, `requirements.allowedHarnesses[${index}]`),
          )
          .sort(compareText);
  if (allowedHarnesses !== null) {
    if (allowedHarnesses.length === 0) {
      throw new ExecutionPlannerInputError('requirements.allowedHarnesses must not be empty');
    }
    requireUnique(allowedHarnesses, 'requirements.allowedHarnesses');
  }

  const handoffStates = (input.handoffStates ?? [])
    .map((state, index) => ({
      stateId: requireNonEmpty(state.stateId, `requirements.handoffStates[${index}].stateId`),
      required: requireBoolean(state.required, `requirements.handoffStates[${index}].required`),
    }))
    .sort((left, right) => compareText(left.stateId, right.stateId));
  requireUnique(
    handoffStates.map((state) => state.stateId),
    'requirements.handoffStates.stateId',
  );

  return {
    requirementsId: requireNonEmpty(input.requirementsId, 'requirements.requirementsId'),
    missionId: requireNonEmpty(input.missionId, 'requirements.missionId'),
    contractId: requireNonEmpty(input.contractId, 'requirements.contractId'),
    planNodeId: requireNonEmpty(input.planNodeId, 'requirements.planNodeId'),
    source: validateRequirementSource(input.source),
    requiredProfileCapabilities,
    minimumAdapterCapabilities,
    allowedHarnesses,
    minimumContextWindowTokens: optionalPositiveSafeInteger(
      input.minimumContextWindowTokens,
      'requirements.minimumContextWindowTokens',
    ),
    minimumInjectionBudgetTokens: optionalPositiveSafeInteger(
      input.minimumInjectionBudgetTokens,
      'requirements.minimumInjectionBudgetTokens',
    ),
    handoffStates,
  };
}

function extractCandidate(
  input: PlannerProfileCandidateV1,
  index: number,
): ExtractedPlannerCandidateV1 {
  const path = `candidates[${index}]`;
  const profile = input.profile;
  const profileCapabilities = profile.capabilities
    .map((capability, capabilityIndex) =>
      requireNonEmpty(capability, `${path}.profile.capabilities[${capabilityIndex}]`),
    )
    .sort(compareText);
  requireUnique(profileCapabilities, `${path}.profile.capabilities`);
  const handoffStates = (input.handoffStates ?? [])
    .map((state, stateIndex) => ({
      stateId: requireNonEmpty(state.stateId, `${path}.handoffStates[${stateIndex}].stateId`),
      classification: validateHandoffClassification(
        state.classification,
        `${path}.handoffStates[${stateIndex}].classification`,
      ),
      source: validateObservationSource(
        state.source,
        `${path}.handoffStates[${stateIndex}].source`,
      ),
      freshness: validateObservationFreshness(
        state.freshness,
        `${path}.handoffStates[${stateIndex}].freshness`,
      ),
    }))
    .sort((left, right) => compareText(left.stateId, right.stateId));
  requireUnique(
    handoffStates.map((state) => state.stateId),
    `${path}.handoffStates.stateId`,
  );
  const wouldRepeatEffectIds = (input.wouldRepeatEffectIds ?? [])
    .map((effectId, effectIndex) =>
      requireNonEmpty(effectId, `${path}.wouldRepeatEffectIds[${effectIndex}]`),
    )
    .sort(compareText);
  requireUnique(wouldRepeatEffectIds, `${path}.wouldRepeatEffectIds`);

  return {
    profileId: requireNonEmpty(profile.profileId, `${path}.profile.profileId`),
    harness: requireNonEmpty(profile.harness, `${path}.profile.harness`),
    model: requireNonEmpty(profile.model, `${path}.profile.model`),
    configurationDigest: requireNonEmpty(
      profile.configurationDigest,
      `${path}.profile.configurationDigest`,
    ),
    permissionMode:
      profile.permissionMode === undefined
        ? null
        : requireNonEmpty(profile.permissionMode, `${path}.profile.permissionMode`),
    profileCapabilities,
    adapterCapabilities:
      profile.adapterCapabilities === undefined
        ? null
        : normalizeAdapterCapabilities(profile.adapterCapabilities, path),
    contextWindowTokens: extractContextWindow(profile, path),
    injectionBudgetTokens: optionalPositiveSafeInteger(
      profile.injectionBudgetTokens,
      `${path}.profile.injectionBudgetTokens`,
    ),
    observation: extractObservation(input.observation, path),
    handoffStates,
    wouldRepeatEffectIds,
  };
}

function extractObservation(
  observation: PlannerObservationV1,
  candidatePath: string,
): ExtractedPlannerCandidateV1['observation'] {
  const path = `${candidatePath}.observation`;
  return {
    observationId: requireNonEmpty(observation.observationId, `${path}.observationId`),
    observedAt: requireNonEmpty(observation.observedAt, `${path}.observedAt`),
    source: validateObservationSource(observation.source, `${path}.source`),
    freshness: validateObservationFreshness(observation.freshness, `${path}.freshness`),
    availability: validateAvailability(observation.availability, `${path}.availability`),
    quotaRemainingRatio: optionalRatio(
      observation.quotaRemainingRatio,
      `${path}.quotaRemainingRatio`,
    ),
    estimatedCostMicros: optionalNonNegativeSafeInteger(
      observation.estimatedCostMicros,
      `${path}.estimatedCostMicros`,
    ),
    latencyMs: optionalNonNegativeSafeInteger(observation.latencyMs, `${path}.latencyMs`),
    historicalSuccessRate: optionalRatio(
      observation.historicalSuccessRate,
      `${path}.historicalSuccessRate`,
    ),
  };
}

function classifyHandoff(
  candidate: ExtractedPlannerCandidateV1,
  input: ExtractedPlannerInputV1,
): HandoffCompatibilityReportV1 {
  const continuingCurrent = input.currentProfileId === candidate.profileId;
  const observedStates = new Map(candidate.handoffStates.map((state) => [state.stateId, state]));
  const states = input.requirements.handoffStates.map((requirement) => {
    if (continuingCurrent || input.currentProfileId === null) {
      return {
        stateId: requirement.stateId,
        required: requirement.required,
        classification: 'exact',
        source: 'planner-continuity',
        freshness: 'fresh',
      } as const;
    }
    const observed = observedStates.get(requirement.stateId);
    if (observed === undefined) {
      return {
        stateId: requirement.stateId,
        required: requirement.required,
        classification: 'unavailable',
        source: 'unknown',
        freshness: 'unknown',
      } as const;
    }
    return {
      stateId: requirement.stateId,
      required: requirement.required,
      classification: observed.classification,
      source: observed.source,
      freshness: observed.freshness,
    };
  });
  const doNotRepeatEffectIds = input.effectFrontier
    .filter((effect) => effect.status === 'confirmed' || effect.status === 'ambiguous')
    .map((effect) => effect.effectId);
  const doNotRepeatSet = new Set(doNotRepeatEffectIds);
  const conflictingEffectIds = candidate.wouldRepeatEffectIds.filter((effectId) =>
    doNotRepeatSet.has(effectId),
  );
  const blockingSubjects = [
    ...states
      .filter(
        (state) =>
          state.required &&
          (state.classification === 'blocking' || state.classification === 'unavailable'),
      )
      .map((state) => `handoff:${state.stateId}`),
    ...conflictingEffectIds.map((effectId) => `effect:${effectId}`),
  ].sort(compareText);

  return {
    profileId: candidate.profileId,
    overall:
      blockingSubjects.length > 0
        ? 'blocking'
        : weakestRequiredClassification(states.filter((state) => state.required)),
    states,
    effectFrontier: {
      classification: conflictingEffectIds.length === 0 ? 'exact' : 'blocking',
      doNotRepeatEffectIds,
      conflictingEffectIds,
    },
    blockingSubjects,
  };
}

function filterCandidate(
  candidate: ExtractedPlannerCandidateV1,
  input: ExtractedPlannerInputV1,
  compatibility: HandoffCompatibilityReportV1,
): CandidateFilterResultV1 {
  const reasons: PlannerRejectionReasonV1[] = [];
  const requirements = input.requirements;

  if (candidate.observation.availability !== 'ready') {
    reasons.push({
      code: 'PROFILE_NOT_READY',
      subject: 'availability',
      required: 'ready',
      actual: candidate.observation.availability,
    });
  }
  if (
    requirements.allowedHarnesses !== null &&
    !requirements.allowedHarnesses.includes(candidate.harness)
  ) {
    reasons.push({
      code: 'HARNESS_NOT_ALLOWED',
      subject: 'harness',
      required: requirements.allowedHarnesses.join(','),
      actual: candidate.harness,
    });
  }
  for (const requiredCapability of requirements.requiredProfileCapabilities) {
    if (!candidate.profileCapabilities.includes(requiredCapability)) {
      reasons.push({
        code: 'PROFILE_CAPABILITY_MISSING',
        subject: requiredCapability,
        required: 'present',
        actual: 'missing',
      });
    }
  }
  for (const requirement of requirements.minimumAdapterCapabilities) {
    const actual = candidate.adapterCapabilities?.[requirement.name] ?? 'unknown';
    if (!meetsMinimumFidelity(actual, requirement.minimum)) {
      reasons.push({
        code: 'ADAPTER_CAPABILITY_INSUFFICIENT',
        subject: requirement.name,
        required: requirement.minimum,
        actual,
      });
    }
  }
  if (requirements.minimumContextWindowTokens !== null) {
    if (candidate.contextWindowTokens === null) {
      reasons.push({
        code: 'CONTEXT_WINDOW_UNKNOWN',
        subject: 'contextWindowTokens',
        required: String(requirements.minimumContextWindowTokens),
        actual: 'unknown',
      });
    } else if (candidate.contextWindowTokens < requirements.minimumContextWindowTokens) {
      reasons.push({
        code: 'CONTEXT_WINDOW_INSUFFICIENT',
        subject: 'contextWindowTokens',
        required: String(requirements.minimumContextWindowTokens),
        actual: String(candidate.contextWindowTokens),
      });
    }
  }
  if (requirements.minimumInjectionBudgetTokens !== null) {
    if (candidate.injectionBudgetTokens === null) {
      reasons.push({
        code: 'INJECTION_BUDGET_UNKNOWN',
        subject: 'injectionBudgetTokens',
        required: String(requirements.minimumInjectionBudgetTokens),
        actual: 'unknown',
      });
    } else if (candidate.injectionBudgetTokens < requirements.minimumInjectionBudgetTokens) {
      reasons.push({
        code: 'INJECTION_BUDGET_INSUFFICIENT',
        subject: 'injectionBudgetTokens',
        required: String(requirements.minimumInjectionBudgetTokens),
        actual: String(candidate.injectionBudgetTokens),
      });
    }
  }
  for (const state of compatibility.states) {
    if (
      state.required &&
      (state.classification === 'blocking' || state.classification === 'unavailable')
    ) {
      reasons.push({
        code: 'HANDOFF_STATE_BLOCKING',
        subject: state.stateId,
        required: 'exact|emulated|summarized|rebound',
        actual: state.classification,
      });
    }
  }
  for (const effectId of compatibility.effectFrontier.conflictingEffectIds) {
    reasons.push({
      code: 'EFFECT_REPLAY_BLOCKED',
      subject: effectId,
      required: 'reconcile-or-skip',
      actual: 'would-repeat',
    });
  }

  return {
    profileId: candidate.profileId,
    eligible: reasons.length === 0,
    rejectionReasons: reasons,
  };
}

function rankCandidates(
  candidates: readonly ExtractedPlannerCandidateV1[],
  input: ExtractedPlannerInputV1,
): RankedPlannerCandidateV1[] {
  const current =
    input.currentProfileId === null
      ? undefined
      : input.candidates.find((candidate) => candidate.profileId === input.currentProfileId);
  return candidates
    .map((candidate) => ({
      profileId: candidate.profileId,
      harness: candidate.harness,
      rankVector: rankVector(candidate, current),
      observationId: candidate.observation.observationId,
      observationSource: candidate.observation.source,
      observationFreshness: candidate.observation.freshness,
    }))
    .sort(compareRankedCandidates)
    .map((candidate, index) => ({ rank: index + 1, ...candidate }));
}

function rankVector(
  candidate: ExtractedPlannerCandidateV1,
  current: ExtractedPlannerCandidateV1 | undefined,
): PlannerRankVectorV1 {
  return {
    continuityPenalty:
      current === undefined
        ? 0
        : candidate.profileId === current.profileId
          ? 0
          : candidate.harness === current.harness
            ? 1
            : 2,
    freshnessPenalty: freshnessPenalty(candidate.observation.freshness),
    sourcePenalty: sourcePenalty(candidate.observation.source),
    quotaPenalty:
      candidate.observation.quotaRemainingRatio === null
        ? UNKNOWN_RANK_PENALTY
        : Math.round((1 - candidate.observation.quotaRemainingRatio) * RATIO_SCALE),
    costPenalty: candidate.observation.estimatedCostMicros ?? UNKNOWN_RANK_PENALTY,
    latencyPenalty: candidate.observation.latencyMs ?? UNKNOWN_RANK_PENALTY,
    outcomePenalty:
      candidate.observation.historicalSuccessRate === null
        ? UNKNOWN_RANK_PENALTY
        : Math.round((1 - candidate.observation.historicalSuccessRate) * RATIO_SCALE),
    profileIdTieBreaker: candidate.profileId,
  };
}

function bindCandidate(
  input: ExtractedPlannerInputV1,
  eligibleIds: ReadonlySet<string>,
  rank: readonly RankedPlannerCandidateV1[],
): {
  readonly manualOverride: PlannerManualOverrideResultV1;
  readonly binding: PlannerBindingV1;
} {
  if (input.manualOverride !== null) {
    const requested = input.candidates.find(
      (candidate) => candidate.profileId === input.manualOverride?.profileId,
    );
    if (requested === undefined || !eligibleIds.has(requested.profileId)) {
      return {
        manualOverride: {
          status: 'rejected',
          requestedProfileId: input.manualOverride.profileId,
          reason: input.manualOverride.reason,
        },
        binding: {
          status: 'blocked',
          selectedProfileId: null,
          selectedHarness: null,
          action: 'blocked',
          reason: 'manual_override_rejected',
        },
      };
    }
    return {
      manualOverride: {
        status: 'applied',
        requestedProfileId: requested.profileId,
        reason: input.manualOverride.reason,
      },
      binding: boundProfile(requested, input.currentProfileId, 'manual_override'),
    };
  }

  const current =
    input.currentProfileId === null
      ? undefined
      : input.candidates.find((candidate) => candidate.profileId === input.currentProfileId);
  if (current !== undefined && eligibleIds.has(current.profileId)) {
    return {
      manualOverride: { status: 'none', requestedProfileId: null, reason: null },
      binding: boundProfile(current, input.currentProfileId, 'keep_current'),
    };
  }

  const selectedRank = rank[0];
  if (selectedRank === undefined) {
    return {
      manualOverride: { status: 'none', requestedProfileId: null, reason: null },
      binding: {
        status: 'blocked',
        selectedProfileId: null,
        selectedHarness: null,
        action: 'blocked',
        reason: 'no_eligible_profile',
      },
    };
  }
  const selected = requireCandidate(input.candidates, selectedRank.profileId);
  const reason =
    input.currentProfileId === null
      ? 'highest_ranked_eligible'
      : current === undefined
        ? 'current_missing_ranked_replacement'
        : 'current_ineligible_ranked_replacement';
  return {
    manualOverride: { status: 'none', requestedProfileId: null, reason: null },
    binding: boundProfile(selected, input.currentProfileId, reason),
  };
}

function boundProfile(
  selected: ExtractedPlannerCandidateV1,
  currentProfileId: string | null,
  reason: Extract<
    PlannerBindingV1['reason'],
    | 'manual_override'
    | 'keep_current'
    | 'current_ineligible_ranked_replacement'
    | 'current_missing_ranked_replacement'
    | 'highest_ranked_eligible'
  >,
): PlannerBindingV1 {
  return {
    status: 'bound',
    selectedProfileId: selected.profileId,
    selectedHarness: selected.harness,
    action:
      currentProfileId === null
        ? 'start'
        : currentProfileId === selected.profileId
          ? 'continue'
          : 'handoff',
    reason,
  };
}

function normalizeAdapterCapabilities(
  capabilities: AdapterCapabilitiesV1,
  path: string,
): AdapterCapabilitiesV1 {
  const normalized = {} as Record<PlannerAdapterCapabilityNameV1, RuntimeCapabilityFidelityV1>;
  for (const name of ADAPTER_CAPABILITY_NAMES) {
    const value = capabilities[name];
    if (!['native', 'cooperative', 'process-only', 'unsupported', 'unknown'].includes(value)) {
      throw new ExecutionPlannerInputError(
        `${path}.profile.adapterCapabilities.${name} is invalid`,
      );
    }
    normalized[name] = value;
  }
  return normalized;
}

function extractContextWindow(profile: ProfileV1, path: string): number | null {
  const field = profile.effective?.contextWindowTokens;
  if (field?.status !== 'known') return null;
  if (typeof field.value !== 'number') {
    throw new ExecutionPlannerInputError(
      `${path}.profile.effective.contextWindowTokens must be numeric when known`,
    );
  }
  return positiveSafeInteger(field.value, `${path}.profile.effective.contextWindowTokens`);
}

function meetsMinimumFidelity(
  actual: RuntimeCapabilityFidelityV1,
  minimum: PlannerMinimumFidelityV1,
): boolean {
  const levels: Record<RuntimeCapabilityFidelityV1, number> = {
    unsupported: 0,
    unknown: 0,
    'process-only': 1,
    'observe-only': 1,
    controller: 2,
    cooperative: 2,
    native: 3,
  };
  return levels[actual] >= levels[minimum];
}

function weakestRequiredClassification(
  states: readonly HandoffStateCompatibilityV1[],
): HandoffCompatibilityClassificationV1 {
  if (states.length === 0) return 'exact';
  const severity: Record<HandoffCompatibilityClassificationV1, number> = {
    exact: 0,
    rebound: 1,
    emulated: 2,
    summarized: 3,
    unavailable: 4,
    blocking: 5,
  };
  return [...states].sort(
    (left, right) =>
      severity[right.classification] - severity[left.classification] ||
      compareText(left.stateId, right.stateId),
  )[0]!.classification;
}

function compareRankedCandidates(
  left: Omit<RankedPlannerCandidateV1, 'rank'>,
  right: Omit<RankedPlannerCandidateV1, 'rank'>,
): number {
  const numericKeys = [
    'continuityPenalty',
    'freshnessPenalty',
    'sourcePenalty',
    'quotaPenalty',
    'costPenalty',
    'latencyPenalty',
    'outcomePenalty',
  ] as const satisfies readonly (keyof PlannerRankVectorV1)[];
  for (const key of numericKeys) {
    const difference = (left.rankVector[key] as number) - (right.rankVector[key] as number);
    if (difference !== 0) return difference;
  }
  return compareText(left.rankVector.profileIdTieBreaker, right.rankVector.profileIdTieBreaker);
}

function freshnessPenalty(value: PlannerObservationFreshnessV1): number {
  return { fresh: 0, stale: 1, unknown: 2 }[value];
}

function sourcePenalty(value: PlannerObservationSourceV1): number {
  return { 'official-api': 0, 'local-cli': 1, manual: 2, derived: 3, unknown: 4 }[value];
}

function validateRequirementSource(
  value: FrozenMissionCapabilityRequirementsV1['source'],
): FrozenMissionCapabilityRequirementsV1['source'] {
  if (!['contract', 'manual', 'accepted-model-proposal'].includes(value)) {
    throw new ExecutionPlannerInputError(`requirements.source is invalid`);
  }
  return value;
}

function validateObservationSource(value: unknown, path: string): PlannerObservationSourceV1 {
  if (!OBSERVATION_SOURCES.includes(value as PlannerObservationSourceV1)) {
    throw new ExecutionPlannerInputError(`${path} is invalid`);
  }
  return value as PlannerObservationSourceV1;
}

function validateObservationFreshness(value: unknown, path: string): PlannerObservationFreshnessV1 {
  if (!OBSERVATION_FRESHNESS.includes(value as PlannerObservationFreshnessV1)) {
    throw new ExecutionPlannerInputError(`${path} is invalid`);
  }
  return value as PlannerObservationFreshnessV1;
}

function validateAvailability(value: unknown, path: string): PlannerAvailabilityV1 {
  if (!OBSERVED_AVAILABILITY.includes(value as PlannerAvailabilityV1)) {
    throw new ExecutionPlannerInputError(`${path} is invalid`);
  }
  return value as PlannerAvailabilityV1;
}

function validateHandoffClassification(
  value: unknown,
  path: string,
): HandoffCompatibilityClassificationV1 {
  if (!HANDOFF_CLASSIFICATIONS.includes(value as HandoffCompatibilityClassificationV1)) {
    throw new ExecutionPlannerInputError(`${path} is invalid`);
  }
  return value as HandoffCompatibilityClassificationV1;
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
    throw new ExecutionPlannerInputError(`${path} is invalid`);
  }
  return value as EffectStatusV1;
}

function optionalRatio(value: number | undefined, path: string): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ExecutionPlannerInputError(`${path} must be between 0 and 1`);
  }
  return value;
}

function optionalPositiveSafeInteger(value: number | undefined, path: string): number | null {
  return value === undefined ? null : positiveSafeInteger(value, path);
}

function positiveSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExecutionPlannerInputError(`${path} must be a positive safe integer`);
  }
  return value;
}

function optionalNonNegativeSafeInteger(value: number | undefined, path: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExecutionPlannerInputError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new ExecutionPlannerInputError(`${path} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function requireBoolean(value: boolean, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ExecutionPlannerInputError(`${path} must be boolean`);
  }
  return value;
}

function requireUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new ExecutionPlannerInputError(`${path} must not contain duplicates`);
  }
}

function requireCandidate(
  candidates: readonly ExtractedPlannerCandidateV1[],
  profileId: string,
): ExtractedPlannerCandidateV1 {
  const candidate = candidates.find((value) => value.profileId === profileId);
  if (candidate === undefined) {
    throw new ExecutionPlannerInputError(`Planner lost candidate ${profileId}`);
  }
  return candidate;
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new ExecutionPlannerInputError(`Planner lost compatibility for ${String(key)}`);
  }
  return value;
}

function compareCandidate(
  left: ExtractedPlannerCandidateV1,
  right: ExtractedPlannerCandidateV1,
): number {
  return compareText(left.profileId, right.profileId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ExecutionPlannerInputError('Planner decision contains a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new ExecutionPlannerInputError(`Planner decision contains non-JSON value ${typeof value}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
