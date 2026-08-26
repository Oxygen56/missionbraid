import { describe, expect, it } from 'vitest';

import type { ContractV1 } from './domain.js';
import {
  AGENT_REVISION_DIMENSIONS,
  BRANCH_COMPARISON_DIMENSIONS,
  OutcomeStudioIntegrityError,
  OutcomeStudioPolicyError,
  OutcomeStudioRegistry,
  OutcomeStudioValidationError,
  compareContractBranches,
  createAgentRevision,
  createEvaluationSuite,
  createIncidentScenario,
  createOutcomeCiResult,
  enforceOutcomeCiResult,
  issueStudioOutcomeReceipt,
  rerunIncidentScenario,
  selectVerifiedOutcomeBranch,
  verifyAgentRevision,
  verifyOutcomeBranchSelection,
  verifyOutcomeCiResult,
  verifyStudioOutcomeReceipt,
  type AgentRevisionDimensionInputV1,
  type AgentRevisionV1,
  type BranchEvaluationV1,
  type CreateIncidentScenarioInputV1,
  type EvaluationSuiteV1,
  type OutcomeBranchRecordV1,
} from './outcome-studio.js';

const NOW = '2026-08-26T00:00:00.000Z';

describe('Outcome, Eval, and Incident Studio core', () => {
  it('builds a content-addressed Agent Revision with every behavior dimension explicit', () => {
    const dimensions = revisionDimensions();
    const revision = createAgentRevision({
      profileId: 'profile-1',
      attemptBindingId: 'binding-1',
      dimensions,
      policyEvidence: [{ name: 'planner', version: 'v1', evidenceRefs: ['policy:planner:v1'] }],
    });
    const reordered = createAgentRevision({
      profileId: 'profile-1',
      attemptBindingId: 'binding-1',
      dimensions: [...dimensions].reverse(),
      policyEvidence: [{ name: 'planner', version: 'v1', evidenceRefs: ['policy:planner:v1'] }],
    });
    const changed = createAgentRevision({
      profileId: 'profile-1',
      attemptBindingId: 'binding-1',
      dimensions: dimensions.map((dimension) =>
        dimension.dimension === 'model-provider'
          ? { ...dimension, contentDigest: 'sha256:model-v2' }
          : dimension,
      ),
      policyEvidence: [{ name: 'planner', version: 'v1', evidenceRefs: ['policy:planner:v1'] }],
    });
    const retry = createAgentRevision({
      profileId: 'profile-reobserved',
      attemptBindingId: 'binding-retry',
      dimensions,
      policyEvidence: [{ name: 'planner', version: 'v1', evidenceRefs: ['policy:planner:v1'] }],
    });

    expect(revision.dimensions.map((dimension) => dimension.dimension).sort()).toEqual(
      [...AGENT_REVISION_DIMENSIONS].sort(),
    );
    expect(reordered).toEqual(revision);
    expect(retry.revisionId).toBe(revision.revisionId);
    expect(retry.attemptBindingId).not.toBe(revision.attemptBindingId);
    expect(changed.revisionId).not.toBe(revision.revisionId);
    expect(revision.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      verifyAgentRevision({
        ...revision,
        dimensions: revision.dimensions.map((dimension, index) =>
          index === 0 ? { ...dimension, contentDigest: 'sha256:tampered' } : dimension,
        ),
      }),
    ).toThrow(OutcomeStudioIntegrityError);
  });

  it('keeps Agent-reported, verified, and human-accepted completion independent', async () => {
    const contract = contractWith(['tests-pass']);
    const suite = deterministicSuite(contract);
    const registry = deterministicRegistry('failed');
    const revision = revisionFixture('revision-source');
    const evaluation = await registry.evaluateBranch(
      suite,
      evaluationTarget('branch-false-success', contract.contractId, revision),
    );
    const branch = branchRecord(
      'branch-false-success',
      contract.contractId,
      revision,
      evaluation,
      'reported-success',
    );

    const pendingReceipt = issueStudioOutcomeReceipt({
      branch,
      effects: [resolvedEffect()],
      outcomePolicyVersion: 'outcome-policy-v1',
      issuedAt: NOW,
    });
    const acceptedReceipt = issueStudioOutcomeReceipt({
      branch,
      effects: [resolvedEffect()],
      acceptance: {
        branchId: branch.branchId,
        decision: 'accepted',
        authorityKind: 'human',
        authorityRef: 'developer:local',
        decidedAt: NOW,
      },
      outcomePolicyVersion: 'outcome-policy-v1',
      issuedAt: NOW,
    });

    expect(evaluation.criteria[0]?.status).toBe('failed');
    expect(pendingReceipt.completion).toMatchObject({
      agentReported: { status: 'reported-success' },
      verified: 'rejected',
      accepted: 'pending',
    });
    expect(pendingReceipt.unresolvedItems).toEqual(['criterion:tests-pass:failed']);
    expect(acceptedReceipt.completion).toMatchObject({
      agentReported: { status: 'reported-success' },
      verified: 'rejected',
      accepted: 'accepted',
      acceptanceAuthorityRef: 'developer:local',
    });
  });

  it('runs repeated stochastic trials and applies the predeclared threshold outside model judgement', async () => {
    const contract = contractWith(['behavior-quality']);
    const suite = createEvaluationSuite({
      contract,
      suiteVersion: 'suite-v1',
      outcomePolicyVersion: 'outcome-policy-v1',
      criteria: [
        {
          criterionId: 'behavior-quality',
          required: true,
          mode: 'stochastic-model',
          runner: { kind: 'runtime-trial', version: 'v1' },
          evaluators: [
            { kind: 'threshold-audit', version: 'v1', role: 'authoritative' },
            { kind: 'model-judge', version: 'v3', role: 'advisory' },
          ],
          trialCount: 4,
          threshold: {
            metric: 'pass-rate',
            operator: 'gte',
            value: 0.75,
            minimumKnownTrials: 4,
          },
        },
      ],
    });
    const outcomes = ['passed', 'passed', 'failed', 'failed'] as const;
    let runs = 0;
    const registry = new OutcomeStudioRegistry();
    registry.registerRunner({
      kind: 'runtime-trial',
      version: 'v1',
      mode: 'stochastic-model',
      run: async ({ trialIndex }) => {
        runs += 1;
        return {
          outcome: outcomes[trialIndex]!,
          score: outcomes[trialIndex] === 'passed' ? 1 : 0,
          evidenceRefs: [`trial-evidence:${trialIndex}`],
          retainedArtifactRefs: [`artifact:${trialIndex}`],
        };
      },
    });
    registry.registerEvaluator({
      kind: 'threshold-audit',
      version: 'v1',
      basis: 'deterministic',
      evaluate: async () => ({ status: 'passed', evidenceRefs: ['audit:complete'] }),
    });
    registry.registerEvaluator({
      kind: 'model-judge',
      version: 'v3',
      basis: 'model-judge',
      rubricVersion: 'rubric-v7',
      calibrationBoundaryRef: 'calibration:human-set-2',
      evaluate: async () => ({ status: 'passed', evidenceRefs: ['judge:artifact-1'] }),
    });

    const evaluation = await registry.evaluateBranch(
      suite,
      evaluationTarget('branch-stochastic', contract.contractId, revisionFixture('stochastic')),
    );
    const result = evaluation.criteria[0]!;

    expect(runs).toBe(4);
    expect(result.trials).toHaveLength(4);
    expect(result.thresholdEvaluation).toMatchObject({
      status: 'failed',
      observedValue: 0.5,
      threshold: 0.75,
      knownTrials: 4,
    });
    expect(result.status).toBe('failed');
    expect(result.evaluatorResults.find((entry) => entry.basis === 'model-judge')).toMatchObject({
      role: 'advisory',
      status: 'passed',
      rubricVersion: 'rubric-v7',
      calibrationBoundaryRef: 'calibration:human-set-2',
    });
  });

  it('refuses to make a model judge the authoritative evaluator', async () => {
    const contract = contractWith(['open-ended-quality']);
    const suite = createEvaluationSuite({
      contract,
      suiteVersion: 'suite-v1',
      outcomePolicyVersion: 'outcome-policy-v1',
      criteria: [
        {
          criterionId: 'open-ended-quality',
          required: true,
          mode: 'deterministic-control',
          runner: { kind: 'fixture-runner', version: 'v1' },
          evaluators: [{ kind: 'model-judge', version: 'v1', role: 'authoritative' }],
        },
      ],
    });
    const registry = new OutcomeStudioRegistry();
    registry.registerRunner({
      kind: 'fixture-runner',
      version: 'v1',
      mode: 'deterministic-control',
      run: async () => ({ outcome: 'passed', evidenceRefs: ['runner:evidence'] }),
    });
    registry.registerEvaluator({
      kind: 'model-judge',
      version: 'v1',
      basis: 'model-judge',
      rubricVersion: 'rubric-v1',
      calibrationBoundaryRef: 'calibration:fixture',
      evaluate: async () => ({ status: 'passed', evidenceRefs: ['judge:evidence'] }),
    });

    await expect(
      registry.evaluateBranch(
        suite,
        evaluationTarget('branch-judge-only', contract.contractId, revisionFixture('judge')),
      ),
    ).rejects.toThrow(OutcomeStudioPolicyError);
  });

  it('compares Branches only under the same Contract and evaluation artifacts without choosing a winner', async () => {
    const contract = contractWith(['tests-pass']);
    const suite = deterministicSuite(contract);
    const registry = deterministicRegistry('passed');
    const originalRevision = revisionFixture('original');
    const revisedRevision = revisionFixture('revised', 'sha256:model-revised');
    const originalEvaluation = await registry.evaluateBranch(
      suite,
      evaluationTarget('branch-original', contract.contractId, originalRevision),
    );
    const revisedEvaluation = await registry.evaluateBranch(
      suite,
      evaluationTarget('branch-revised', contract.contractId, revisedRevision),
    );
    const original = branchRecord(
      'branch-original',
      contract.contractId,
      originalRevision,
      originalEvaluation,
      'reported-success',
    );
    const revised = branchRecord(
      'branch-revised',
      contract.contractId,
      revisedRevision,
      revisedEvaluation,
      'reported-success',
      { context: 'sha256:changed-context', latency: null },
    );

    const comparison = compareContractBranches([revised, original]);

    expect(comparison.selection).toBe('not-selected');
    expect(comparison).not.toHaveProperty('winner');
    expect(comparison.dimensions.find((entry) => entry.dimension === 'tools')?.status).toBe(
      'equal',
    );
    expect(comparison.dimensions.find((entry) => entry.dimension === 'context')?.status).toBe(
      'different',
    );
    expect(comparison.dimensions.find((entry) => entry.dimension === 'latency')?.status).toBe(
      'unknown',
    );
    expect(() =>
      compareContractBranches([{ ...revised, contractId: 'contract-other' }, original]),
    ).toThrow(OutcomeStudioPolicyError);
  });

  it('creates a deterministic redacted content-addressed incident scenario', () => {
    const input = incidentInput();
    const scenario = createIncidentScenario(input);
    const reordered = createIncidentScenario({
      ...input,
      artifacts: [...input.artifacts].reverse(),
    });
    const serialized = scenario.artifacts.map((artifact) => artifact.content).join('\n');

    expect(reordered).toEqual(scenario);
    expect(serialized).not.toContain('sk-proj-super-secret');
    expect(serialized).not.toContain('Bearer private-token');
    expect(serialized).toContain('[REDACTED]');
    expect(scenario.artifacts.some((artifact) => artifact.redactionCount > 0)).toBe(true);
    expect(scenario.artifacts.every((artifact) => artifact.sanitized)).toBe(true);
    expect(scenario.scenarioHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createIncidentScenario({ ...input, artifacts: input.artifacts.slice(1) })).toThrow(
      OutcomeStudioValidationError,
    );
  });

  it('exports a versioned CI result that reports regression without granting release authority', async () => {
    const contract = contractWith(['tests-pass']);
    const suite = deterministicSuite(contract);
    const registry = deterministicRegistry('passed');
    const revision = revisionFixture('ci');
    const evaluation = await registry.evaluateBranch(
      suite,
      evaluationTarget('branch-ci', contract.contractId, revision),
    );
    const branch = branchRecord(
      'branch-ci',
      contract.contractId,
      revision,
      evaluation,
      'reported-success',
    );
    const receipt = issueStudioOutcomeReceipt({
      branch,
      effects: [resolvedEffect()],
      runtimeProfileBinding: runtimeProfileBinding(),
      outcomePolicyVersion: 'outcome-policy-v1',
      issuedAt: NOW,
    });
    const scenario = createIncidentScenario(
      incidentInput({
        contractId: contract.contractId,
        evaluationSuiteId: suite.suiteId,
        sourceAgentRevisionId: revision.revisionId,
      }),
    );
    const passed = createOutcomeCiResult({ scenario, receipt, generatedAt: NOW });
    const expectedFailure = createIncidentScenario({
      ...incidentInput({
        contractId: contract.contractId,
        evaluationSuiteId: suite.suiteId,
        sourceAgentRevisionId: revision.revisionId,
      }),
      expectedEvidence: [
        {
          criterionId: 'tests-pass',
          expectedStatus: 'failed',
          evidenceRefs: ['expected:known-failure'],
        },
      ],
    });
    const returned = createOutcomeCiResult({
      scenario: expectedFailure,
      receipt,
      generatedAt: NOW,
    });

    expect(passed).toMatchObject({
      status: 'passed',
      regression: 'retained',
      authority: 'evidence-export-only',
      deploymentAuthorized: false,
      organizationalApprovalGranted: false,
      publicationAuthorized: false,
      runtimeProfileBinding: runtimeProfileBinding(),
    });
    expect(returned).toMatchObject({ status: 'failed', regression: 'returned' });
    expect(passed.resultHash).toMatch(/^[a-f0-9]{64}$/);
    expect(enforceOutcomeCiResult(passed)).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(enforceOutcomeCiResult(returned)).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(() => verifyOutcomeCiResult({ ...passed, regression: 'returned' })).toThrow(
      OutcomeStudioIntegrityError,
    );
    expect(() =>
      verifyStudioOutcomeReceipt({
        ...receipt,
        runtimeProfileBinding: {
          ...receipt.runtimeProfileBinding!,
          targetProfileId: 'profile-target-tampered',
        },
      }),
    ).toThrow(OutcomeStudioIntegrityError);
    expect(() =>
      verifyOutcomeCiResult({
        ...passed,
        runtimeProfileBinding: {
          ...passed.runtimeProfileBinding!,
          targetProfileId: 'profile-target-tampered',
        },
      }),
    ).toThrow(OutcomeStudioIntegrityError);
  });

  it('reruns an executable incident with predeclared repeated trials on a distinct Agent Revision', async () => {
    const contract = contractWith(['tests-pass']);
    const suite = createEvaluationSuite({
      contract,
      suiteVersion: 'incident-regression-v2',
      outcomePolicyVersion: 'outcome-policy-v1',
      criteria: [
        {
          criterionId: 'tests-pass',
          required: true,
          mode: 'stochastic-model',
          runner: { kind: 'real-runtime-trial', version: 'v1' },
          evaluators: [{ kind: 'deterministic-trial-audit', version: 'v1', role: 'authoritative' }],
          trialCount: 3,
          threshold: {
            metric: 'pass-rate',
            operator: 'gte',
            value: 2 / 3,
            minimumKnownTrials: 3,
          },
        },
      ],
    });
    const sourceRevision = revisionFixture('incident-source');
    const upgradedRevision = revisionFixture('incident-upgraded', 'sha256:model-v2');
    const scenario = createIncidentScenario({
      ...incidentInput({
        contractId: contract.contractId,
        evaluationSuiteId: suite.suiteId,
        sourceAgentRevisionId: sourceRevision.revisionId,
      }),
      executionPlan: {
        runner: { kind: 'mission-runtime-regression', version: 'v1' },
        evaluationSuite: suite,
        sourceProfileId: sourceRevision.profileId,
        sourceProfileDigest: 'sha256:profile-source',
        requiresDistinctAgentRevision: true,
        evidenceRefs: ['checkpoint:source', `suite:${suite.suiteId}`],
      },
    });
    const registry = new OutcomeStudioRegistry();
    let trials = 0;
    registry.registerRunner({
      kind: 'real-runtime-trial',
      version: 'v1',
      mode: 'stochastic-model',
      run: async ({ trialIndex }) => {
        trials += 1;
        return {
          outcome: trialIndex === 1 ? 'failed' : 'passed',
          score: trialIndex === 1 ? 0 : 1,
          evidenceRefs: [`runtime-attempt:${trialIndex}`, `verifier:${trialIndex}`],
          retainedArtifactRefs: [`artifact:trial:${trialIndex}`],
        };
      },
    });
    registry.registerEvaluator({
      kind: 'deterministic-trial-audit',
      version: 'v1',
      basis: 'deterministic',
      evaluate: async ({ trials: observations }) => ({
        status: observations.every((trial) => trial.evidenceRefs.length > 0) ? 'passed' : 'unknown',
        evidenceRefs: ['audit:all-trials-retained'],
      }),
    });
    const target = {
      ...evaluationTarget('branch-upgraded', contract.contractId, upgradedRevision),
      scenarioId: scenario.scenarioId,
    };
    const rerun = await rerunIncidentScenario({
      scenario,
      registry,
      target,
      lineageBranchIds: ['branch-source', target.branchId],
      dimensions: BRANCH_COMPARISON_DIMENSIONS.map((dimension) => ({
        dimension,
        fidelity: 'known' as const,
        digest: `sha256:upgraded-${dimension}`,
        evidenceRefs: [`runtime:${dimension}`],
      })),
      agentReported: { status: 'reported-success', evidenceRefs: ['runtime:process-exit-0'] },
      effects: [resolvedEffect()],
      outcomePolicyVersion: 'outcome-policy-v1',
      issuedAt: NOW,
    });

    expect(trials).toBe(3);
    expect(rerun.evaluation.criteria[0]?.thresholdEvaluation).toMatchObject({
      status: 'passed',
      knownTrials: 3,
      totalTrials: 3,
      observedValue: 2 / 3,
    });
    expect(rerun.receipt.completion.verified).toBe('verified');
    expect(enforceOutcomeCiResult(rerun.ciResult)).toMatchObject({ exitCode: 0 });
    await expect(
      rerunIncidentScenario({
        scenario,
        registry,
        target: { ...target, agentRevision: sourceRevision },
        lineageBranchIds: ['branch-source', target.branchId],
        dimensions: BRANCH_COMPARISON_DIMENSIONS.map((dimension) => ({
          dimension,
          fidelity: 'known' as const,
          digest: `sha256:source-${dimension}`,
          evidenceRefs: [`runtime:${dimension}`],
        })),
        agentReported: { status: 'not-reported', evidenceRefs: [] },
        effects: [],
        outcomePolicyVersion: 'outcome-policy-v1',
        issuedAt: NOW,
      }),
    ).rejects.toThrow(OutcomeStudioPolicyError);
  });

  it('records human Branch selection separately and rejects selection of an unverified Branch', async () => {
    const contract = contractWith(['tests-pass']);
    const suite = deterministicSuite(contract);
    const revisionA = revisionFixture('selection-a');
    const revisionB = revisionFixture('selection-b', 'sha256:model-v2');
    const passedRegistry = deterministicRegistry('passed');
    const failedRegistry = deterministicRegistry('failed');
    const evaluationA = await failedRegistry.evaluateBranch(
      suite,
      evaluationTarget('branch-selection-a', contract.contractId, revisionA),
    );
    const evaluationB = await passedRegistry.evaluateBranch(
      suite,
      evaluationTarget('branch-selection-b', contract.contractId, revisionB),
    );
    const branchA = branchRecord(
      'branch-selection-a',
      contract.contractId,
      revisionA,
      evaluationA,
      'reported-success',
    );
    const branchB = branchRecord(
      'branch-selection-b',
      contract.contractId,
      revisionB,
      evaluationB,
      'reported-success',
    );
    const comparison = compareContractBranches([branchA, branchB]);
    const rejected = issueStudioOutcomeReceipt({
      branch: branchA,
      effects: [],
      outcomePolicyVersion: 'outcome-policy-v1',
      issuedAt: NOW,
    });
    const verified = issueStudioOutcomeReceipt({
      branch: branchB,
      effects: [],
      outcomePolicyVersion: 'outcome-policy-v1',
      issuedAt: NOW,
    });
    expect(() =>
      selectVerifiedOutcomeBranch({
        comparison,
        receipt: rejected,
        authorityKind: 'human',
        authorityRef: 'developer:local',
        decidedAt: NOW,
      }),
    ).toThrow(OutcomeStudioPolicyError);
    const selection = selectVerifiedOutcomeBranch({
      comparison,
      receipt: verified,
      authorityKind: 'human',
      authorityRef: 'developer:local',
      decidedAt: NOW,
    });
    expect(selection).toMatchObject({
      branchId: branchB.branchId,
      comparisonId: comparison.comparisonId,
      receiptId: verified.receiptId,
      authorityKind: 'human',
    });
    expect(() =>
      verifyOutcomeBranchSelection({ ...selection, branchId: branchA.branchId }),
    ).toThrow(OutcomeStudioIntegrityError);
  });
});

function runtimeProfileBinding() {
  return {
    sourceProfileId: 'profile-source',
    targetProfileId: 'profile-target',
    targetStageId: 'stage-target',
    targetProfileDefinitionId: 'profile-definition-target',
    profileSelectionId: 'profile-selection-target',
    plannerDecisionHash: 'a'.repeat(64),
    authorityChange: 'unchanged' as const,
    evidenceRefs: ['event:planner-decision', 'event:profile-selected'],
  };
}

function contractWith(criterionIds: readonly string[]): ContractV1 {
  return {
    schemaVersion: 1,
    contractId: 'contract-1',
    objective: 'Improve the Agent behavior without changing the user goal.',
    acceptanceCriteria: criterionIds.map((criterionId) => ({
      criterionId,
      description: `Verify ${criterionId}`,
      verifier: { kind: 'fixture', configuration: {} },
    })),
    createdAt: NOW,
  };
}

function revisionDimensions(modelDigest = 'sha256:model-v1'): AgentRevisionDimensionInputV1[] {
  return AGENT_REVISION_DIMENSIONS.map((dimension) =>
    dimension === 'environment'
      ? {
          dimension,
          fidelity: 'partial',
          contentDigest: 'sha256:environment-partial',
          evidenceRefs: ['evidence:environment'],
          reason: 'Provider internals are unavailable',
        }
      : {
          dimension,
          fidelity: 'known',
          contentDigest: dimension === 'model-provider' ? modelDigest : `sha256:${dimension}`,
          evidenceRefs: [`evidence:${dimension}`],
        },
  );
}

function revisionFixture(label: string, modelDigest?: string): AgentRevisionV1 {
  return createAgentRevision({
    profileId: `profile-${label}`,
    attemptBindingId: `binding-${label}`,
    dimensions: revisionDimensions(modelDigest),
    policyEvidence: [
      { name: 'planner', version: 'v1', evidenceRefs: ['policy:planner:v1'] },
      { name: 'effect-policy', version: 'v2', evidenceRefs: ['policy:effects:v2'] },
    ],
  });
}

function deterministicSuite(contract: ContractV1): EvaluationSuiteV1 {
  return createEvaluationSuite({
    contract,
    suiteVersion: 'suite-v1',
    outcomePolicyVersion: 'outcome-policy-v1',
    criteria: contract.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      required: true,
      mode: 'deterministic-control',
      runner: { kind: 'fixture-runner', version: 'v1' },
      evaluators: [{ kind: 'fixture-evaluator', version: 'v1', role: 'authoritative' }],
    })),
  });
}

function deterministicRegistry(outcome: 'passed' | 'failed' | 'unknown'): OutcomeStudioRegistry {
  const registry = new OutcomeStudioRegistry();
  registry.registerRunner({
    kind: 'fixture-runner',
    version: 'v1',
    mode: 'deterministic-control',
    run: async ({ criterion }) => ({
      outcome,
      evidenceRefs: [`runner:${criterion.criterionId}:${outcome}`],
      retainedArtifactRefs: [`artifact:${criterion.criterionId}`],
    }),
  });
  registry.registerEvaluator({
    kind: 'fixture-evaluator',
    version: 'v1',
    basis: 'deterministic',
    evaluate: async ({ trials }) => ({
      status: trials[0]?.outcome ?? 'unknown',
      evidenceRefs: ['evaluator:fixture'],
    }),
  });
  return registry;
}

function evaluationTarget(branchId: string, contractId: string, agentRevision: AgentRevisionV1) {
  return {
    branchId,
    contractId,
    agentRevision,
    checkpointId: `checkpoint-${branchId}`,
    eventHeadHash: `event-head-${branchId}`,
    eventThroughSeq: 42,
  } as const;
}

function branchRecord(
  branchId: string,
  contractId: string,
  agentRevision: AgentRevisionV1,
  evaluation: BranchEvaluationV1,
  reportStatus: 'reported-success' | 'reported-failure' | 'not-reported',
  dimensionOverrides: Partial<
    Record<(typeof BRANCH_COMPARISON_DIMENSIONS)[number], string | null>
  > = {},
): OutcomeBranchRecordV1 {
  return {
    branchId,
    contractId,
    lineageBranchIds: ['branch-root', branchId],
    checkpointId: evaluation.checkpointId,
    eventHeadHash: evaluation.eventHeadHash,
    eventThroughSeq: evaluation.eventThroughSeq,
    agentRevision,
    evaluation,
    dimensions: BRANCH_COMPARISON_DIMENSIONS.map((dimension) => {
      const override = dimensionOverrides[dimension];
      return override === null
        ? { dimension, fidelity: 'unknown' as const, evidenceRefs: [] }
        : {
            dimension,
            fidelity: 'known' as const,
            digest: override ?? `sha256:shared-${dimension}`,
            evidenceRefs: [`evidence:${branchId}:${dimension}`],
          };
    }),
    agentReported: {
      status: reportStatus,
      evidenceRefs: reportStatus === 'not-reported' ? [] : [`agent-report:${branchId}`],
    },
  };
}

function resolvedEffect() {
  return {
    effectId: 'effect-workspace',
    required: true,
    status: 'confirmed' as const,
    resolution: 'resolved' as const,
    evidenceRefs: ['effect-receipt:workspace'],
  };
}

function incidentInput(
  overrides: Partial<CreateIncidentScenarioInputV1> = {},
): CreateIncidentScenarioInputV1 {
  return {
    scenarioRevision: 'scenario-v1',
    contractId: 'contract-1',
    evaluationSuiteId: 'suite-fixture',
    sourceAgentRevisionId: 'revision-fixture',
    sourceCheckpointId: 'checkpoint-fixture',
    interventionId: 'intervention-fixture',
    artifacts: [
      {
        kind: 'checkpoint',
        content: JSON.stringify({ checkpointId: 'checkpoint-fixture', api_key: 'secret-value' }),
      },
      {
        kind: 'intervention',
        content: 'Authorization: Bearer private-token',
      },
      { kind: 'contract', content: JSON.stringify({ contractId: 'contract-1' }) },
      { kind: 'profile', content: JSON.stringify({ model: 'fixture-model' }) },
      {
        kind: 'expected-evidence',
        content: JSON.stringify({ token: 'sk-proj-super-secret', criterionId: 'tests-pass' }),
      },
    ],
    expectedEvidence: [
      {
        criterionId: 'tests-pass',
        expectedStatus: 'passed',
        evidenceRefs: ['expected:tests-pass'],
      },
    ],
    createdAt: NOW,
    ...overrides,
  };
}
