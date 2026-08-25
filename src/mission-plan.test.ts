import { describe, expect, it } from 'vitest';

import type { ContractV1 } from './domain.js';
import {
  analyzeSelectiveInvalidation,
  createContractRevision,
  createMissionPlanRevision,
  MissionPlanValidationError,
  planConsolidationAttempt,
  recordPlanArtifact,
  recordWorkspaceIntegrationOutcome,
  type ActivePlanAttemptV1,
  type ContractRequirementV1,
  type ContractRevisionV1,
  type DeterministicVerifierEvidenceV1,
  type MissionPlanEdgeInputV1,
  type MissionPlanNodeInputV1,
  type MissionPlanRevisionV1,
  type PlanArtifactV1,
  type PlanConsolidationAttemptInputV1,
} from './mission-plan.js';

describe('Mission Plan DAG and live revisions', () => {
  it('versions every node kind with requirement provenance and deterministic DAG evidence', () => {
    const contractRevision = initialContractRevision();
    const input = planInput(contractRevision);
    const first = createMissionPlanRevision(input);
    const reordered = createMissionPlanRevision({
      ...input,
      nodes: [...input.nodes].reverse(),
      edges: [...input.edges].reverse(),
    });

    expect(reordered).toEqual(first);
    expect(first.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining(['task', 'review', 'diagnostic', 'branch', 'join']),
    );
    expect(first.nodes.every((node) => node.requirementIds.length > 0)).toBe(true);
    expect(first.nodes.every((node) => node.nodeVersion.startsWith('sha256:'))).toBe(true);
    expect(first.structureVerifierEvidence).toMatchObject({
      evaluator: 'deterministic',
      verifierId: 'mission-plan-dag-structure/v1',
      subjectId: first.planRevisionId,
      subjectDigest: first.revisionDigest,
      result: { status: 'passed' },
    });
    expect(first.provenance.source).toBe('accepted-model-proposal');
  });

  it('rejects cycles, in-place writable workspaces, and undeclared shared resources', () => {
    const contractRevision = initialContractRevision();
    const input = planInput(contractRevision);
    expect(() =>
      createMissionPlanRevision({
        ...input,
        edges: [...input.edges, edge('join', 'task-a', 'depends-on')],
      }),
    ).toThrow(new MissionPlanValidationError('Mission Plan contains a cycle'));

    expect(() =>
      createMissionPlanRevision({
        ...input,
        nodes: input.nodes.map((node) =>
          node.nodeId === 'task-b'
            ? { ...node, workspace: { ...node.workspace, workspaceKey: 'workspace-task-a' } }
            : node,
        ),
      }),
    ).toThrow(/share workspace/);

    expect(() =>
      createMissionPlanRevision({
        ...input,
        sharedResources: [],
      }),
    ).toThrow(/undeclared shared resource/);
  });

  it('revises the Contract, invalidates only the affected subgraph, and fences stale Agents', () => {
    const previousContract = initialContractRevision();
    const plan = createMissionPlanRevision(planInput(previousContract));
    const artifactReview = artifact(plan, 'artifact-review-a', 'review-a', 'a');
    const artifactTaskB = artifact(plan, 'artifact-task-b', 'task-b', 'b');
    const nextContract = revisedContractRevision(previousContract);
    const attempts: ActivePlanAttemptV1[] = [
      activeAttempt(plan, 'attempt-a', 'agent-a', 'review-a'),
      activeAttempt(plan, 'attempt-b', 'agent-b', 'task-b'),
      {
        ...activeAttempt(plan, 'attempt-old', 'agent-old', 'task-b'),
        nodeVersion: digest('obsolete-node-version'),
      },
    ];

    const impact = analyzeSelectiveInvalidation({
      plan,
      previousContractRevision: previousContract,
      nextContractRevision: nextContract,
      artifacts: [artifactReview, artifactTaskB],
      activeAttempts: attempts,
    });

    expect(nextContract).toMatchObject({
      revisionNumber: 2,
      parentContractRevisionId: previousContract.contractRevisionId,
      changedRequirementIds: ['req-a'],
    });
    expect(impact.invalidatedNodeIds).toEqual(
      expect.arrayContaining(['task-a', 'review-a', 'diagnostic-a', 'branch-a', 'join']),
    );
    expect(impact.invalidatedNodeIds).not.toContain('task-b');
    expect(impact.reusableNodeIds).toEqual(['task-b']);
    expect(impact.invalidatedArtifactIds).toContain('artifact-review-a');
    expect(impact.reusableArtifactIds).toEqual(['artifact-task-b']);
    expect(impact.staleAttemptFences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptId: 'attempt-a',
          reason: 'requirement-or-authority-changed',
          action: 'interrupt-and-preserve-evidence',
          acceptsFurtherEffects: false,
        }),
        expect.objectContaining({
          attemptId: 'attempt-old',
          reason: 'obsolete-node-version',
        }),
      ]),
    );
    expect(impact.staleAttemptFences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptId: 'attempt-b',
          reason: 'obsolete-contract-revision',
          acceptsFurtherEffects: false,
        }),
      ]),
    );
    expect(impact.rebindableRunningAttemptIds).toEqual(['attempt-b']);
    expect(impact.authorityTransfer).toBe('none');

    const revisedPlan = createMissionPlanRevision({
      ...planInput(nextContract),
      parentRevision: plan,
      createdAt: '2026-08-26T02:00:00.000Z',
    });
    expect(revisedPlan.revisionNumber).toBe(2);
    expect(node(revisedPlan, 'task-a').nodeVersion).not.toBe(node(plan, 'task-a').nodeVersion);
    expect(node(revisedPlan, 'task-b').nodeVersion).toBe(node(plan, 'task-b').nodeVersion);
  });

  it('keeps newly added requirements explicit without discarding unrelated work', () => {
    const previousContract = initialContractRevision();
    const plan = createMissionPlanRevision(planInput(previousContract));
    const nextContract = createContractRevision({
      missionId: 'mission-1',
      contract: { ...baseContract(), objective: 'Build A and B and publish a migration note.' },
      requirements: [
        ...requirements(),
        requirement('req-new', 'Publish a migration note.', 'acceptance-criterion'),
      ],
      previousRevision: previousContract,
      provenance: { reason: 'Add migration note', evidenceRefs: ['change-request-new'] },
      createdAt: '2026-08-26T03:00:00.000Z',
    });
    const impact = analyzeSelectiveInvalidation({
      plan,
      previousContractRevision: previousContract,
      nextContractRevision: nextContract,
    });

    expect(impact.unplannedRequirementIds).toEqual(['req-new']);
    expect(impact.invalidatedNodeIds).toEqual([]);
    expect(impact.reusableNodeIds).toEqual(plan.nodes.map((item) => item.nodeId).sort());
  });

  it('admits an unaffected old artifact into the revised Plan only with its reuse decision', () => {
    const previousContract = initialContractRevision();
    const previousPlan = createMissionPlanRevision(planInput(previousContract));
    const reusableTaskB = artifact(previousPlan, 'artifact-task-b', 'task-b', 'b');
    const nextContract = revisedContractRevision(previousContract);
    const impact = analyzeSelectiveInvalidation({
      plan: previousPlan,
      previousContractRevision: previousContract,
      nextContractRevision: nextContract,
      artifacts: [reusableTaskB],
    });
    const nextPlan = createMissionPlanRevision({
      ...planInput(nextContract),
      parentRevision: previousPlan,
      createdAt: '2026-08-26T03:30:00.000Z',
    });
    const currentReview = artifact(nextPlan, 'artifact-review-next', 'review-a', 'c');
    const currentBranch = artifact(nextPlan, 'artifact-branch-next', 'branch-a', 'd');
    const input = consolidationInput(
      nextPlan,
      nextContract,
      currentReview,
      currentBranch,
      reusableTaskB,
    );

    expect(() =>
      planConsolidationAttempt({
        ...input,
        explicitAuthorityBindings: [explicitGrant()],
      }),
    ).toThrow(/not bound to this Plan node revision/);

    const sources = input.sources.map((source) =>
      source.selectionId === 'selection-task-b' ? { ...source, reuseDecision: impact } : source,
    );
    const accepted = planConsolidationAttempt({
      ...input,
      sources,
      explicitAuthorityBindings: [explicitGrant()],
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('Expected reused artifact consolidation');
    expect(accepted.plan.evidenceRefs).toContain(impact.invalidationId);
    expect(
      accepted.plan.workspaceIntegration.selectedInputs.find(
        (source) => source.selectionId === 'selection-task-b',
      )?.contentId,
    ).toBe('artifact-task-b');
  });
});

describe('join consolidation', () => {
  it('requires explicit authority and never inherits source Agent authority', () => {
    const contractRevision = initialContractRevision();
    const plan = createMissionPlanRevision(planInput(contractRevision));
    const artifactReview = artifact(plan, 'artifact-review-a', 'review-a', 'c');
    const artifactBranch = artifact(plan, 'artifact-branch-a', 'branch-a', 'd');
    const artifactTaskB = artifact(plan, 'artifact-task-b', 'task-b', 'e');
    const baseInput = consolidationInput(
      plan,
      contractRevision,
      artifactReview,
      artifactBranch,
      artifactTaskB,
    );

    const blocked = planConsolidationAttempt(baseInput);
    expect(blocked).toEqual({
      ok: false,
      blocker: expect.objectContaining({
        code: 'EXPLICIT_AUTHORITY_REQUIRED',
        missingAuthorityScopes: ['workspace:integrate'],
      }),
    });

    const planned = planConsolidationAttempt({
      ...baseInput,
      explicitAuthorityBindings: [explicitGrant()],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error('Expected consolidation plan');

    expect(planned.plan).toMatchObject({
      joinNodeId: 'join',
      branch: { branchId: 'branch-consolidation' },
      attempt: {
        attemptId: 'attempt-consolidation',
        branchId: 'branch-consolidation',
        stageId: 'join',
        status: 'running',
      },
      lineage: {
        mode: 'new-consolidation-attempt',
        sourceHistory: 'immutable',
      },
      workspace: {
        access: 'isolated-writable',
        workspaceKey: 'workspace-consolidation',
      },
      authority: {
        inheritance: 'none',
        inheritedAuthorityRefs: [],
        explicitBindings: [expect.objectContaining({ grantId: 'grant-integration' })],
      },
      workspaceIntegration: {
        effect: {
          kind: 'workspace.integration',
          scope: 'branch_local_workspace',
          status: 'intended',
        },
      },
    });
    expect(planned.plan.lineage.sourceBranchIds).toEqual(['branch-a', 'branch-b', 'branch-review']);
    expect(planned.plan.workspaceIntegration.selectedInputs).toHaveLength(3);
    expect(
      planned.plan.workspaceIntegration.sourceVerifierEvidence.every(
        (evidence) => evidence.evaluator === 'deterministic',
      ),
    ).toBe(true);
    expect(JSON.stringify(planned.plan.authority)).not.toContain('source-authority');
  });

  it('blocks unresolved conflicts and unverified inputs before creating an Attempt', () => {
    const contractRevision = initialContractRevision();
    const plan = createMissionPlanRevision(planInput(contractRevision));
    const artifactReview = artifact(plan, 'artifact-review-a', 'review-a', 'f');
    const artifactBranch = artifact(plan, 'artifact-branch-a', 'branch-a', 'a');
    const artifactTaskB = artifact(plan, 'artifact-task-b', 'task-b', 'b');
    const baseInput = {
      ...consolidationInput(plan, contractRevision, artifactReview, artifactBranch, artifactTaskB),
      explicitAuthorityBindings: [explicitGrant()],
    };
    const conflict = planConsolidationAttempt({
      ...baseInput,
      conflicts: [
        {
          conflictId: 'conflict-1',
          resourceKey: 'src/index.ts',
          inputSelectionIds: ['selection-review', 'selection-task-b'],
          status: 'unresolved',
          resolutionEvidenceRefs: [],
        },
      ],
    });
    expect(conflict).toEqual({
      ok: false,
      blocker: expect.objectContaining({
        code: 'UNRESOLVED_INTEGRATION_CONFLICT',
        conflictIds: ['conflict-1'],
      }),
    });

    const failedArtifact = recordPlanArtifact({
      artifactId: 'artifact-failed',
      artifactDigest: digest('failed-artifact'),
      plan,
      producedByNodeId: 'review-a',
      verifierEvidence: [verification('artifact-failed', digest('failed-artifact'), 'failed')],
      evidenceRefs: ['artifact-failed-ref'],
    });
    const unverified = planConsolidationAttempt({
      ...baseInput,
      sources: baseInput.sources.map((source) =>
        source.selectionId === 'selection-review'
          ? { ...source, artifact: failedArtifact }
          : source,
      ),
    });
    expect(unverified).toEqual({
      ok: false,
      blocker: expect.objectContaining({ code: 'SOURCE_VERIFICATION_REQUIRED' }),
    });
  });

  it('confirms workspace integration only with matching deterministic verifier evidence', () => {
    const contractRevision = initialContractRevision();
    const plan = createMissionPlanRevision(planInput(contractRevision));
    const planned = planConsolidationAttempt({
      ...consolidationInput(
        plan,
        contractRevision,
        artifact(plan, 'artifact-review-a', 'review-a', 'c'),
        artifact(plan, 'artifact-branch-a', 'branch-a', 'd'),
        artifact(plan, 'artifact-task-b', 'task-b', 'e'),
      ),
      explicitAuthorityBindings: [explicitGrant()],
    });
    if (!planned.ok) throw new Error('Expected consolidation plan');
    const outputDigest = digest('integrated-workspace');
    const evidence = verification(
      planned.plan.workspaceIntegration.outputVerificationSubjectId,
      outputDigest,
      'passed',
    );

    const confirmed = recordWorkspaceIntegrationOutcome({
      plan: planned.plan,
      outputWorkspaceDigest: outputDigest,
      verifierEvidence: [evidence],
    });
    expect(confirmed).toMatchObject({
      conclusion: 'confirmed',
      effect: { status: 'confirmed', kind: 'workspace.integration' },
    });
    expect(confirmed.verifierEvidence[0]?.subjectDigest).toBe(outputDigest);

    const unmatched = recordWorkspaceIntegrationOutcome({
      plan: planned.plan,
      outputWorkspaceDigest: digest('different-workspace'),
      verifierEvidence: [evidence],
    });
    expect(unmatched).toMatchObject({
      conclusion: 'unknown',
      effect: { status: 'ambiguous' },
      verifierEvidence: [],
    });

    expect(() =>
      recordWorkspaceIntegrationOutcome({
        plan: planned.plan,
        outputWorkspaceDigest: outputDigest,
        verifierEvidence: [
          {
            ...evidence,
            evaluator: 'model-assisted',
          } as unknown as DeterministicVerifierEvidenceV1,
        ],
      }),
    ).toThrow('Only deterministic verifier evidence is accepted');
  });
});

function initialContractRevision(): ContractRevisionV1 {
  return createContractRevision({
    missionId: 'mission-1',
    contract: baseContract(),
    requirements: requirements(),
    provenance: { reason: 'Initial accepted Contract', evidenceRefs: ['contract-accepted'] },
    createdAt: '2026-08-26T00:00:00.000Z',
  });
}

function revisedContractRevision(previous: ContractRevisionV1): ContractRevisionV1 {
  return createContractRevision({
    missionId: 'mission-1',
    contract: { ...baseContract(), objective: 'Build revised A and unchanged B.' },
    requirements: [
      requirement('req-a', 'Build revised A.', 'acceptance-criterion'),
      requirement('req-b', 'Build B.', 'acceptance-criterion'),
    ],
    previousRevision: previous,
    provenance: { reason: 'Revise A only', evidenceRefs: ['change-request-a'] },
    createdAt: '2026-08-26T01:00:00.000Z',
  });
}

function baseContract(): ContractV1 {
  return {
    schemaVersion: 1,
    contractId: 'contract-1',
    objective: 'Build A and B.',
    acceptanceCriteria: [
      {
        criterionId: 'criterion-a',
        description: 'A passes',
        verifier: { kind: 'command', configuration: { command: 'verify-a' } },
      },
      {
        criterionId: 'criterion-b',
        description: 'B passes',
        verifier: { kind: 'command', configuration: { command: 'verify-b' } },
      },
    ],
    createdAt: '2026-08-26T00:00:00.000Z',
  };
}

function requirements(): ContractRequirementV1[] {
  return [
    requirement('req-a', 'Build A.', 'acceptance-criterion'),
    requirement('req-b', 'Build B.', 'acceptance-criterion'),
  ];
}

function requirement(
  requirementId: string,
  statement: string,
  kind: ContractRequirementV1['kind'],
): ContractRequirementV1 {
  return {
    requirementId,
    kind,
    statement,
    acceptanceCriterionIds: requirementId === 'req-a' ? ['criterion-a'] : ['criterion-b'],
    evidenceRefs: [`evidence-${requirementId}`],
  };
}

function planInput(contractRevision: ContractRevisionV1) {
  const nodes: MissionPlanNodeInputV1[] = [
    planNode('task-a', 'task', ['req-a'], 'workspace-task-a', ['shared-cache']),
    planNode('task-b', 'task', ['req-b'], 'workspace-task-b', ['shared-cache']),
    planNode('review-a', 'review', ['req-a'], 'workspace-review-a', [], ['artifact-task-a']),
    planNode('diagnostic-a', 'diagnostic', ['req-a'], 'workspace-diagnostic-a'),
    planNode('branch-a', 'branch', ['req-a'], 'workspace-branch-a'),
    {
      ...planNode(
        'join',
        'join',
        ['req-a', 'req-b'],
        'workspace-join',
        [],
        ['artifact-review-a', 'artifact-branch-a', 'artifact-task-b'],
      ),
      requiredAuthorityScopes: ['workspace:integrate'],
    },
  ];
  const edges: MissionPlanEdgeInputV1[] = [
    edge('task-a', 'review-a', 'review-input'),
    edge('task-a', 'diagnostic-a', 'diagnostic-input'),
    edge('diagnostic-a', 'branch-a', 'branch-input'),
    edge('review-a', 'join', 'join-input'),
    edge('branch-a', 'join', 'join-input'),
    edge('task-b', 'join', 'join-input'),
  ];
  return {
    planId: 'plan-1',
    missionId: 'mission-1',
    contractRevision,
    nodes,
    edges,
    sharedResources: [
      {
        resourceKey: 'shared-cache',
        coordination: 'exclusive-lease' as const,
        evidenceRefs: ['shared-cache-policy'],
      },
    ],
    provenance: {
      source: 'accepted-model-proposal' as const,
      evidenceRefs: ['plan-proposal', 'plan-accepted'],
    },
    createdAt: '2026-08-26T00:10:00.000Z',
  };
}

function planNode(
  nodeId: string,
  kind: MissionPlanNodeInputV1['kind'],
  requirementIds: readonly string[],
  workspaceKey: string,
  sharedResourceKeys: readonly string[] = [],
  inputArtifactIds: readonly string[] = [],
): MissionPlanNodeInputV1 {
  return {
    nodeId,
    kind,
    title: `${kind} ${nodeId}`,
    requirementIds,
    inputArtifactIds,
    declaredOutputKeys: [`output-${nodeId}`],
    requiredAuthorityScopes: [],
    workspace: {
      access: 'isolated-writable',
      workspaceKey,
      sharedResourceKeys,
    },
    provenanceEvidenceRefs: [`plan-node-${nodeId}`],
  };
}

function edge(
  fromNodeId: string,
  toNodeId: string,
  relation: MissionPlanEdgeInputV1['relation'],
): MissionPlanEdgeInputV1 {
  return {
    fromNodeId,
    toNodeId,
    relation,
    evidenceRefs: [`edge-${fromNodeId}-${toNodeId}`],
  };
}

function artifact(
  plan: MissionPlanRevisionV1,
  artifactId: string,
  producedByNodeId: string,
  seed: string,
): PlanArtifactV1 {
  const artifactDigest = digest(`artifact-${seed}`);
  return recordPlanArtifact({
    artifactId,
    artifactDigest,
    plan,
    producedByNodeId,
    verifierEvidence: [verification(artifactId, artifactDigest, 'passed')],
    evidenceRefs: [`artifact-evidence-${seed}`],
  });
}

function verification(
  subjectId: string,
  subjectDigest: string,
  status: 'passed' | 'failed',
): DeterministicVerifierEvidenceV1 {
  return {
    evidenceId: `verification-${subjectId}-${status}`,
    evaluator: 'deterministic',
    verifierId: 'fixture-verifier/v1',
    subjectId,
    subjectDigest,
    result: {
      criterionId: `criterion-${subjectId}`,
      status,
      evidenceRefs: [`verifier-output-${subjectId}-${status}`],
    },
    evidenceRefs: [`verifier-output-${subjectId}-${status}`],
  };
}

function activeAttempt(
  plan: MissionPlanRevisionV1,
  attemptId: string,
  agentId: string,
  nodeId: string,
): ActivePlanAttemptV1 {
  return {
    attemptId,
    agentId,
    nodeId,
    nodeVersion: node(plan, nodeId).nodeVersion,
    planRevisionId: plan.planRevisionId,
    contractRevisionId: plan.contractRevisionId,
    status: 'running',
    authorityRefs: [`source-authority-${attemptId}`],
    evidenceRefs: [`runtime-${attemptId}`],
  };
}

function consolidationInput(
  plan: MissionPlanRevisionV1,
  contractRevision: ContractRevisionV1,
  artifactReview: PlanArtifactV1,
  artifactBranch: PlanArtifactV1,
  artifactTaskB: PlanArtifactV1,
): PlanConsolidationAttemptInputV1 {
  return {
    plan,
    contractRevision,
    joinNodeId: 'join',
    sources: [
      {
        kind: 'artifact',
        selectionId: 'selection-review',
        branchId: 'branch-review',
        attemptId: 'attempt-review',
        nodeId: 'review-a',
        workspaceKey: 'workspace-review-source',
        artifact: artifactReview,
        sourceAuthorityRefs: ['source-authority-review'],
      },
      {
        kind: 'artifact',
        selectionId: 'selection-branch',
        branchId: 'branch-a',
        attemptId: 'attempt-branch',
        nodeId: 'branch-a',
        workspaceKey: 'workspace-branch-source',
        artifact: artifactBranch,
        sourceAuthorityRefs: ['source-authority-branch'],
      },
      {
        kind: 'artifact',
        selectionId: 'selection-task-b',
        branchId: 'branch-b',
        attemptId: 'attempt-task-b',
        nodeId: 'task-b',
        workspaceKey: 'workspace-task-b-source',
        artifact: artifactTaskB,
        sourceAuthorityRefs: ['source-authority-task-b'],
      },
    ],
    newBranchId: 'branch-consolidation',
    newAttemptId: 'attempt-consolidation',
    profileId: 'profile-consolidation',
    targetWorkspaceKey: 'workspace-consolidation',
    startedAt: '2026-08-26T04:00:00.000Z',
  };
}

function explicitGrant() {
  return {
    source: 'authorized-grant' as const,
    grantId: 'grant-integration',
    authorityRef: 'authority-integration',
    scope: 'workspace:integrate',
    evidenceRefs: ['grant-approved'],
  };
}

function node(plan: MissionPlanRevisionV1, nodeId: string) {
  const value = plan.nodes.find((item) => item.nodeId === nodeId);
  if (value === undefined) throw new Error(`Missing node ${nodeId}`);
  return value;
}

function digest(seed: string): string {
  return `sha256:${seed.padEnd(64, '0').slice(0, 64)}`;
}
