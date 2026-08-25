import { describe, expect, it } from 'vitest';

import type { AdapterCapabilitiesV1, ProfileV1, RuntimeProfileEffectiveV1 } from './domain.js';
import {
  EXECUTION_PLANNER_POLICY_VERSION,
  ExecutionPlannerInputError,
  planExecution,
  type ExecutionPlannerInputV1,
  type FrozenMissionCapabilityRequirementsV1,
  type PlannerProfileCandidateV1,
} from './execution-planner.js';

const OBSERVED_AT = '2026-08-26T00:00:00.000Z';

describe('deterministic Execution Planner', () => {
  it('keeps the eligible current Profile even when another Runtime has better rank signals', () => {
    const current = candidate('profile-codex-current', 'codex', {
      source: 'derived',
      freshness: 'stale',
      quotaRemainingRatio: 0.05,
      estimatedCostMicros: 900,
      latencyMs: 900,
      historicalSuccessRate: 0.1,
    });
    const alternative = candidate('profile-qoder-fast', 'qoder', {
      source: 'official-api',
      freshness: 'fresh',
      quotaRemainingRatio: 1,
      estimatedCostMicros: 1,
      latencyMs: 1,
      historicalSuccessRate: 1,
      handoffStates: [handoff('visible-context', 'summarized')],
    });
    const input = plannerInput([alternative, current], {
      currentProfileId: current.profile.profileId,
    });

    const decision = planExecution(input);
    const reordered = planExecution({ ...input, candidates: [current, alternative] });

    expect(decision.binding).toMatchObject({
      selectedProfileId: current.profile.profileId,
      action: 'continue',
      reason: 'keep_current',
    });
    expect(decision.rank[0]?.profileId).toBe(current.profile.profileId);
    expect(decision.rank[0]?.rankVector.continuityPenalty).toBe(0);
    expect(decision.manualOverride.status).toBe('none');
    expect(reordered).toEqual(decision);
    expect(decision.decisionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('switches only after the current Profile is unavailable and prefers an eligible Profile on the same Runtime', () => {
    const unavailableCurrent = candidate('profile-codex-current', 'codex', {
      availability: 'unavailable',
    });
    const sameRuntime = candidate('profile-codex-fallback', 'codex', {
      source: 'local-cli',
      freshness: 'fresh',
      quotaRemainingRatio: 0.4,
      handoffStates: [handoff('visible-context', 'exact')],
    });
    const otherRuntime = candidate('profile-qoder-best-metrics', 'qoder', {
      source: 'official-api',
      freshness: 'fresh',
      quotaRemainingRatio: 1,
      estimatedCostMicros: 0,
      latencyMs: 0,
      historicalSuccessRate: 1,
      handoffStates: [handoff('visible-context', 'exact')],
    });

    const decision = planExecution(
      plannerInput([unavailableCurrent, otherRuntime, sameRuntime], {
        currentProfileId: unavailableCurrent.profile.profileId,
      }),
    );

    expect(decision.filter.candidates).toContainEqual(
      expect.objectContaining({
        profileId: unavailableCurrent.profile.profileId,
        eligible: false,
        rejectionReasons: [
          expect.objectContaining({ code: 'PROFILE_NOT_READY', actual: 'unavailable' }),
        ],
      }),
    );
    expect(decision.binding).toMatchObject({
      selectedProfileId: sameRuntime.profile.profileId,
      selectedHarness: 'codex',
      action: 'handoff',
      reason: 'current_ineligible_ranked_replacement',
    });
    expect(decision.rank.map((entry) => entry.profileId)).toEqual([
      sameRuntime.profile.profileId,
      otherRuntime.profile.profileId,
    ]);
  });

  it('records and applies an eligible manual override but blocks an ineligible override', () => {
    const current = candidate('profile-codex-current', 'codex');
    const target = candidate('profile-qoder-target', 'qoder', {
      handoffStates: [handoff('visible-context', 'summarized')],
    });
    const base = plannerInput([current, target], {
      currentProfileId: current.profile.profileId,
    });

    const applied = planExecution({
      ...base,
      manualOverride: {
        profileId: target.profile.profileId,
        reason: 'Developer selected the review Runtime',
      },
    });
    const rejected = planExecution({
      ...base,
      manualOverride: {
        profileId: 'profile-not-present',
        reason: 'Developer requested an unavailable Profile',
      },
    });

    expect(applied.manualOverride).toEqual({
      status: 'applied',
      requestedProfileId: target.profile.profileId,
      reason: 'Developer selected the review Runtime',
    });
    expect(applied.binding).toMatchObject({
      selectedProfileId: target.profile.profileId,
      action: 'handoff',
      reason: 'manual_override',
    });
    expect(rejected.manualOverride.status).toBe('rejected');
    expect(rejected.binding).toEqual({
      status: 'blocked',
      selectedProfileId: null,
      selectedHarness: null,
      action: 'blocked',
      reason: 'manual_override_rejected',
    });
  });

  it('returns every hard-filter rejection and blocks blind replay of confirmed or ambiguous Effects', () => {
    const broken = candidate('profile-broken', 'qoder', {
      availability: 'missing',
      profileCapabilities: [],
      adapterCapabilities: adapterCapabilities({ preToolGate: 'unsupported' }),
      contextWindowTokens: null,
      injectionBudgetTokens: null,
      wouldRepeatEffectIds: ['effect-confirmed', 'effect-ambiguous', 'effect-failed'],
    });
    const requirements: FrozenMissionCapabilityRequirementsV1 = {
      ...baseRequirements(),
      requiredProfileCapabilities: ['workspace-write'],
      minimumAdapterCapabilities: { preToolGate: 'native' },
      allowedHarnesses: ['codex'],
      minimumContextWindowTokens: 128_000,
      minimumInjectionBudgetTokens: 4_096,
      handoffStates: [
        { stateId: 'visible-context', required: true },
        { stateId: 'native-session', required: true },
      ],
    };

    const decision = planExecution({
      policyVersion: EXECUTION_PLANNER_POLICY_VERSION,
      requirements,
      candidates: [broken],
      currentProfileId: 'profile-source-not-in-set',
      effectFrontier: [
        { effectId: 'effect-failed', status: 'failed' },
        { effectId: 'effect-confirmed', status: 'confirmed' },
        { effectId: 'effect-ambiguous', status: 'ambiguous' },
      ],
    });
    const filtered = decision.filter.candidates[0]!;
    const compatibility = decision.handoffCompatibility[0]!;

    expect(filtered.eligible).toBe(false);
    expect(filtered.rejectionReasons.map((reason) => reason.code)).toEqual([
      'PROFILE_NOT_READY',
      'HARNESS_NOT_ALLOWED',
      'PROFILE_CAPABILITY_MISSING',
      'ADAPTER_CAPABILITY_INSUFFICIENT',
      'CONTEXT_WINDOW_UNKNOWN',
      'INJECTION_BUDGET_UNKNOWN',
      'HANDOFF_STATE_BLOCKING',
      'HANDOFF_STATE_BLOCKING',
      'EFFECT_REPLAY_BLOCKED',
      'EFFECT_REPLAY_BLOCKED',
    ]);
    expect(compatibility.overall).toBe('blocking');
    expect(compatibility.effectFrontier).toEqual({
      classification: 'blocking',
      doNotRepeatEffectIds: ['effect-ambiguous', 'effect-confirmed'],
      conflictingEffectIds: ['effect-ambiguous', 'effect-confirmed'],
    });
    expect(filtered.rejectionReasons.some((reason) => reason.subject === 'effect-failed')).toBe(
      false,
    );
    expect(decision.binding.reason).toBe('no_eligible_profile');
  });

  it('preserves all Handoff compatibility classifications without treating optional loss as eligibility', () => {
    const source = candidate('profile-source', 'codex');
    const target = candidate('profile-target', 'qoder', {
      handoffStates: [
        handoff('a-exact', 'exact'),
        handoff('b-emulated', 'emulated'),
        handoff('c-summarized', 'summarized'),
        handoff('d-rebound', 'rebound'),
        handoff('e-unavailable', 'unavailable'),
        handoff('f-blocking', 'blocking'),
      ],
    });
    const requirements: FrozenMissionCapabilityRequirementsV1 = {
      ...baseRequirements(),
      handoffStates: [
        { stateId: 'a-exact', required: true },
        { stateId: 'b-emulated', required: true },
        { stateId: 'c-summarized', required: true },
        { stateId: 'd-rebound', required: true },
        { stateId: 'e-unavailable', required: false },
        { stateId: 'f-blocking', required: false },
      ],
    };

    const decision = planExecution({
      policyVersion: EXECUTION_PLANNER_POLICY_VERSION,
      requirements,
      candidates: [source, target],
      currentProfileId: source.profile.profileId,
    });
    const report = decision.handoffCompatibility.find(
      (value) => value.profileId === target.profile.profileId,
    )!;

    expect(report.states.map((state) => state.classification)).toEqual([
      'exact',
      'emulated',
      'summarized',
      'rebound',
      'unavailable',
      'blocking',
    ]);
    expect(report.overall).toBe('summarized');
    expect(
      decision.filter.candidates.find((value) => value.profileId === target.profile.profileId)
        ?.eligible,
    ).toBe(true);
  });

  it('rejects an unknown policy version instead of letting policy prose alter the rank', () => {
    const input = plannerInput([candidate('profile-codex', 'codex')]);

    expect(() =>
      planExecution({
        ...input,
        policyVersion: 'model-selected-policy',
      } as unknown as ExecutionPlannerInputV1),
    ).toThrow(ExecutionPlannerInputError);
  });
});

function plannerInput(
  candidates: readonly PlannerProfileCandidateV1[],
  overrides: Partial<ExecutionPlannerInputV1> = {},
): ExecutionPlannerInputV1 {
  return {
    policyVersion: EXECUTION_PLANNER_POLICY_VERSION,
    requirements: baseRequirements(),
    candidates,
    ...overrides,
  };
}

function baseRequirements(): FrozenMissionCapabilityRequirementsV1 {
  return {
    requirementsId: 'requirements-1',
    missionId: 'mission-1',
    contractId: 'contract-1',
    planNodeId: 'plan-node-1',
    source: 'contract',
    requiredProfileCapabilities: ['workspace-read'],
    minimumAdapterCapabilities: { observe: 'native' },
    handoffStates: [{ stateId: 'visible-context', required: true }],
  };
}

function candidate(
  profileId: string,
  harness: string,
  options: {
    readonly availability?: 'ready' | 'unavailable' | 'missing' | 'unknown';
    readonly source?: 'official-api' | 'local-cli' | 'manual' | 'derived' | 'unknown';
    readonly freshness?: 'fresh' | 'stale' | 'unknown';
    readonly quotaRemainingRatio?: number;
    readonly estimatedCostMicros?: number;
    readonly latencyMs?: number;
    readonly historicalSuccessRate?: number;
    readonly profileCapabilities?: readonly string[];
    readonly adapterCapabilities?: AdapterCapabilitiesV1;
    readonly contextWindowTokens?: number | null;
    readonly injectionBudgetTokens?: number | null;
    readonly handoffStates?: PlannerProfileCandidateV1['handoffStates'];
    readonly wouldRepeatEffectIds?: readonly string[];
  } = {},
): PlannerProfileCandidateV1 {
  const profile: ProfileV1 = {
    schemaVersion: 1,
    profileId,
    harness,
    model: `${harness}-model`,
    ...(options.injectionBudgetTokens === null
      ? {}
      : { injectionBudgetTokens: options.injectionBudgetTokens ?? 8_192 }),
    permissionMode: 'workspace-write',
    capabilities: options.profileCapabilities ?? ['workspace-read', 'workspace-write'],
    configurationDigest: `digest-${profileId}`,
    adapterCapabilities: options.adapterCapabilities ?? adapterCapabilities(),
    ...(options.contextWindowTokens === null
      ? {}
      : { effective: effectiveProfile(options.contextWindowTokens ?? 200_000) }),
  };
  return {
    profile,
    observation: {
      observationId: `observation-${profileId}`,
      observedAt: OBSERVED_AT,
      source: options.source ?? 'local-cli',
      freshness: options.freshness ?? 'fresh',
      availability: options.availability ?? 'ready',
      quotaRemainingRatio: options.quotaRemainingRatio ?? 0.5,
      estimatedCostMicros: options.estimatedCostMicros ?? 100,
      latencyMs: options.latencyMs ?? 100,
      historicalSuccessRate: options.historicalSuccessRate ?? 0.5,
    },
    ...(options.handoffStates === undefined ? {} : { handoffStates: options.handoffStates }),
    ...(options.wouldRepeatEffectIds === undefined
      ? {}
      : { wouldRepeatEffectIds: options.wouldRepeatEffectIds }),
  };
}

function adapterCapabilities(
  overrides: Partial<AdapterCapabilitiesV1> = {},
): AdapterCapabilitiesV1 {
  return {
    observe: 'native',
    contextCapture: 'native',
    steer: 'cooperative',
    interrupt: 'process-only',
    preToolGate: 'native',
    resume: 'cooperative',
    nativeFork: 'unsupported',
    workspaceRestore: 'cooperative',
    externalEffectControl: 'cooperative',
    ...overrides,
  };
}

function effectiveProfile(contextWindowTokens: number): RuntimeProfileEffectiveV1 {
  return {
    model: { status: 'known', value: 'fixture-model', source: 'fixture' },
    reasoningEffort: { status: 'known', value: 'high', source: 'fixture' },
    instructions: { status: 'unknown', reason: 'fixture' },
    skills: { status: 'unknown', reason: 'fixture' },
    mcpServers: { status: 'unknown', reason: 'fixture' },
    tools: { status: 'unknown', reason: 'fixture' },
    permissions: { status: 'known', value: 'workspace-write', source: 'fixture' },
    contextWindowTokens: { status: 'known', value: contextWindowTokens, source: 'fixture' },
    session: { status: 'unknown', reason: 'fixture' },
    availability: { status: 'known', value: 'ready', source: 'fixture' },
    quota: { status: 'unknown', reason: 'fixture' },
    cost: { status: 'unknown', reason: 'fixture' },
  };
}

function handoff(
  stateId: string,
  classification: 'exact' | 'emulated' | 'summarized' | 'rebound' | 'unavailable' | 'blocking',
): NonNullable<PlannerProfileCandidateV1['handoffStates']>[number] {
  return {
    stateId,
    classification,
    source: 'local-cli',
    freshness: 'fresh',
  };
}
