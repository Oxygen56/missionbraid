import { describe, expect, it } from 'vitest';

import { projectMissionPlanRuntime } from './mission-plan-runtime.js';
import type { MissionPlanRevisionV1, PlanArtifactV1 } from './mission-plan.js';

describe('Mission Plan runtime projection', () => {
  it('exposes ready, running, verified, and join-waiting nodes without mutating the DAG', () => {
    const plan = planFixture();
    const artifact: PlanArtifactV1 = {
      schemaVersion: 'missionbraid.dev/plan-artifact/v1',
      artifactId: 'artifact-a',
      artifactDigest: 'sha256:artifact-a',
      missionId: plan.missionId,
      planId: plan.planId,
      planRevisionId: plan.planRevisionId,
      contractRevisionId: plan.contractRevisionId,
      producedByNodeId: 'task-a',
      producerNodeVersion: 'node-version-task-a',
      requirementIds: ['req-a'],
      sourceArtifactIds: [],
      verifierEvidence: [passedVerifier('artifact-a', 'sha256:artifact-a')],
      evidenceRefs: ['verifier:task-a'],
    };
    const projection = projectMissionPlanRuntime({
      plan,
      artifacts: [artifact],
      finishedAttempts: [attempt('attempt-a', 'task-a')],
      activeAttempts: [attempt('attempt-b', 'task-b')],
    });

    expect(projection.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'task-a', status: 'succeeded' }),
        expect.objectContaining({ nodeId: 'task-b', status: 'running' }),
        expect.objectContaining({ nodeId: 'join', status: 'waiting-join' }),
      ]),
    );
    expect(projection.readyNodeIds).toContain('task-c');
    expect(projection.joinNodeIds).toEqual(['join']);
    expect(plan.nodes.map((node) => node.nodeId)).toEqual(['task-a', 'task-b', 'task-c', 'join']);
  });

  it('marks only the invalidated frontier stale and keeps missing verifier evidence unknown', () => {
    const plan = planFixture();
    const projection = projectMissionPlanRuntime({
      plan,
      finishedAttempts: [attempt('attempt-a', 'task-a')],
      invalidations: [
        {
          schemaVersion: 'missionbraid.dev/selective-invalidation/v1',
          invalidationId: 'invalidation-1',
          missionId: plan.missionId,
          sourcePlanRevisionId: plan.planRevisionId,
          sourceContractRevisionId: plan.contractRevisionId,
          targetContractRevisionId: plan.contractRevisionId,
          changedRequirementIds: ['req-a'],
          changedAuthorityScopes: [],
          directlyImpactedNodeIds: ['task-a'],
          invalidatedNodeIds: ['task-a', 'join'],
          replanFrontierNodeIds: ['task-a'],
          reusableNodeIds: ['task-b', 'task-c'],
          invalidatedArtifactIds: [],
          reusableArtifactIds: [],
          unplannedRequirementIds: [],
          staleAttemptFences: [],
          rebindableRunningAttemptIds: [],
          authorityTransfer: 'none',
          evidenceRefs: ['event:revision'],
        },
      ],
    });

    expect(projection.staleNodeIds).toEqual(['join', 'task-a']);
    expect(projection.nodes.find((node) => node.nodeId === 'task-a')?.status).toBe('stale');
    expect(projection.nodes.find((node) => node.nodeId === 'task-b')?.status).toBe('ready');
    expect(projection.nodes.find((node) => node.nodeId === 'task-c')?.status).toBe('blocked');
    expect(projection.invalidationIds).toEqual(['invalidation-1']);
  });

  it('does not promote failed or abandoned Attempts to succeeded artifacts', () => {
    const plan = planFixture();
    const projection = projectMissionPlanRuntime({
      plan,
      finishedAttempts: [
        { ...attempt('attempt-failed', 'task-a'), terminalStatus: 'failed' },
        { ...attempt('attempt-abandoned', 'task-b'), terminalStatus: 'abandoned' },
      ],
      artifacts: [
        {
          schemaVersion: 'missionbraid.dev/plan-artifact/v1',
          artifactId: 'artifact-failed',
          artifactDigest: 'sha256:artifact-failed',
          missionId: plan.missionId,
          planId: plan.planId,
          planRevisionId: plan.planRevisionId,
          contractRevisionId: plan.contractRevisionId,
          producedByNodeId: 'task-a',
          producerNodeVersion: 'node-version-task-a',
          requirementIds: ['req-a'],
          sourceArtifactIds: [],
          verifierEvidence: [],
          evidenceRefs: [],
        },
      ],
    });
    expect(projection.nodes.find((node) => node.nodeId === 'task-a')?.status).toBe('failed');
    expect(projection.nodes.find((node) => node.nodeId === 'task-b')?.status).toBe('unknown');
  });

  it('ignores Attempts and Artifacts that are not bound to the current revisions and node version', () => {
    const plan = planFixture();
    const projection = projectMissionPlanRuntime({
      plan,
      activeAttempts: [
        {
          ...attempt('attempt-old-plan', 'task-a'),
          planRevisionId: 'plan-revision-old',
          status: 'running',
        },
        {
          ...attempt('attempt-old-contract', 'task-a'),
          contractRevisionId: 'contract-revision-old',
          status: 'running',
        },
        {
          ...attempt('attempt-old-node', 'task-a'),
          nodeVersion: 'node-version-task-a-old',
          status: 'running',
        },
      ],
      finishedAttempts: [
        {
          ...attempt('attempt-finished-old', 'task-a'),
          planRevisionId: 'plan-revision-old',
          terminalStatus: 'succeeded',
        },
      ],
      artifacts: [
        {
          ...artifact('artifact-old-plan', 'task-a', plan),
          planRevisionId: 'plan-revision-old',
        },
        {
          ...artifact('artifact-old-contract', 'task-a', plan),
          contractRevisionId: 'contract-revision-old',
        },
        {
          ...artifact('artifact-old-node', 'task-a', plan),
          producerNodeVersion: 'node-version-task-a-old',
        },
      ],
    });

    expect(projection.nodes.find((node) => node.nodeId === 'task-a')).toEqual(
      expect.objectContaining({
        status: 'ready',
        activeAttemptIds: [],
        finishedAttemptIds: [],
        artifactIds: [],
      }),
    );
  });

  it('keeps a finished node unknown until an artifact has matching passed verifier evidence', () => {
    const plan = planFixture();
    const emptyVerifier = artifact('artifact-empty', 'task-a', plan, []);
    const wrongSubject = artifact('artifact-wrong-subject', 'task-b', plan, [
      passedVerifier('another-artifact', 'sha256:artifact-wrong-subject'),
    ]);

    const projection = projectMissionPlanRuntime({
      plan,
      finishedAttempts: [
        { ...attempt('attempt-a', 'task-a'), terminalStatus: 'succeeded' },
        { ...attempt('attempt-b', 'task-b'), terminalStatus: 'succeeded' },
      ],
      artifacts: [emptyVerifier, wrongSubject],
    });

    expect(projection.nodes.find((node) => node.nodeId === 'task-a')?.status).toBe('unknown');
    expect(projection.nodes.find((node) => node.nodeId === 'task-b')?.status).toBe('unknown');
    expect(projection.completedNodeIds).toEqual([]);
  });

  it('keeps a parent invalidation as history without making revised same-name nodes stale', () => {
    const previousPlan = planFixture();
    const plan: MissionPlanRevisionV1 = {
      ...previousPlan,
      planRevisionId: 'plan-revision-runtime-next',
      revisionDigest: 'sha256:plan-runtime-next',
      revisionNumber: 2,
      parentPlanRevisionId: previousPlan.planRevisionId,
      contractRevisionId: 'contract-revision-runtime-next',
      nodes: previousPlan.nodes.map((node) =>
        node.nodeId === 'task-a' ? { ...node, nodeVersion: 'node-version-task-a-next' } : node,
      ),
    };
    const projection = projectMissionPlanRuntime({
      plan,
      activeAttempts: [attempt('attempt-parent', 'task-a')],
      artifacts: [artifact('artifact-parent', 'task-a', previousPlan)],
      invalidations: [
        {
          schemaVersion: 'missionbraid.dev/selective-invalidation/v1',
          invalidationId: 'invalidation-parent-to-current',
          missionId: plan.missionId,
          sourcePlanRevisionId: previousPlan.planRevisionId,
          sourceContractRevisionId: previousPlan.contractRevisionId,
          targetContractRevisionId: plan.contractRevisionId,
          changedRequirementIds: ['req-a'],
          changedAuthorityScopes: [],
          directlyImpactedNodeIds: ['task-a'],
          invalidatedNodeIds: ['task-a', 'join'],
          replanFrontierNodeIds: ['task-a'],
          reusableNodeIds: ['task-b', 'task-c'],
          invalidatedArtifactIds: ['artifact-parent'],
          reusableArtifactIds: [],
          unplannedRequirementIds: [],
          staleAttemptFences: [],
          rebindableRunningAttemptIds: [],
          authorityTransfer: 'none',
          evidenceRefs: ['event:revision'],
        },
      ],
    });

    expect(projection.invalidationIds).toEqual(['invalidation-parent-to-current']);
    expect(projection.staleNodeIds).toEqual([]);
    expect(projection.nodes.find((node) => node.nodeId === 'task-a')).toEqual(
      expect.objectContaining({
        status: 'ready',
        activeAttemptIds: [],
        artifactIds: [],
        invalidationIds: ['invalidation-parent-to-current'],
      }),
    );
  });

  it('ignores invalidations targeting another Contract or unrelated Plan history', () => {
    const plan = planFixture();
    const baseInvalidation = {
      schemaVersion: 'missionbraid.dev/selective-invalidation/v1' as const,
      missionId: plan.missionId,
      sourceContractRevisionId: plan.contractRevisionId,
      changedRequirementIds: ['req-a'],
      changedAuthorityScopes: [],
      directlyImpactedNodeIds: ['task-a'],
      invalidatedNodeIds: ['task-a'],
      replanFrontierNodeIds: ['task-a'],
      reusableNodeIds: ['task-b', 'task-c', 'join'],
      invalidatedArtifactIds: [],
      reusableArtifactIds: [],
      unplannedRequirementIds: [],
      staleAttemptFences: [],
      rebindableRunningAttemptIds: [],
      authorityTransfer: 'none' as const,
      evidenceRefs: ['event:revision'],
    };
    const projection = projectMissionPlanRuntime({
      plan,
      invalidations: [
        {
          ...baseInvalidation,
          invalidationId: 'invalidation-other-contract',
          sourcePlanRevisionId: plan.planRevisionId,
          targetContractRevisionId: 'contract-revision-other',
        },
        {
          ...baseInvalidation,
          invalidationId: 'invalidation-unrelated-plan',
          sourcePlanRevisionId: 'plan-revision-unrelated',
          targetContractRevisionId: plan.contractRevisionId,
        },
      ],
    });

    expect(projection.invalidationIds).toEqual([]);
    expect(projection.staleNodeIds).toEqual([]);
    expect(projection.nodes.find((node) => node.nodeId === 'task-a')?.status).toBe('ready');
  });
});

function planFixture(): MissionPlanRevisionV1 {
  const node = (nodeId: string, kind: MissionPlanRevisionV1['nodes'][number]['kind']) => ({
    nodeId,
    nodeVersion: `node-version-${nodeId}`,
    kind,
    title: nodeId,
    requirementIds: ['req-a'],
    inputArtifactIds: [],
    declaredOutputKeys: [`output:${nodeId}`],
    requiredAuthorityScopes: [],
    workspace: {
      access: 'isolated-writable' as const,
      workspaceKey: `workspace-${nodeId}`,
      sharedResourceKeys: [],
    },
    provenanceEvidenceRefs: [`plan:${nodeId}`],
  });
  return {
    schemaVersion: 'missionbraid.dev/mission-plan/v1',
    planId: 'plan-runtime-fixture',
    planRevisionId: 'plan-revision-runtime-fixture',
    revisionDigest: 'sha256:plan-runtime-fixture',
    missionId: 'mission-runtime-fixture',
    revisionNumber: 1,
    contractRevisionId: 'contract-revision-runtime-fixture',
    nodes: [
      node('task-a', 'task'),
      node('task-b', 'task'),
      node('task-c', 'task'),
      node('join', 'join'),
    ],
    edges: [
      edge('task-a', 'join', 'join-input'),
      edge('task-b', 'join', 'join-input'),
      edge('task-a', 'task-c', 'depends-on'),
    ],
    sharedResources: [],
    provenance: { source: 'deterministic-planner', evidenceRefs: ['plan:fixture'] },
    structureVerifierEvidence: {
      evidenceId: 'plan-structure-fixture',
      evaluator: 'deterministic',
      verifierId: 'mission-plan-dag-structure/v1',
      subjectId: 'plan-revision-runtime-fixture',
      subjectDigest: 'sha256:plan-runtime-fixture',
      result: { criterionId: 'mission-plan-dag-structure', status: 'passed', evidenceRefs: [] },
      evidenceRefs: [],
    },
    createdAt: '2026-08-26T00:00:00.000Z',
  };
}

function edge(
  fromNodeId: string,
  toNodeId: string,
  relation: MissionPlanRevisionV1['edges'][number]['relation'],
) {
  return {
    fromNodeId,
    toNodeId,
    relation,
    edgeId: `edge-${fromNodeId}-${toNodeId}`,
    evidenceRefs: [],
  };
}

function attempt(attemptId: string, nodeId: string) {
  return {
    attemptId,
    agentId: `agent-${nodeId}`,
    nodeId,
    nodeVersion: `node-version-${nodeId}`,
    planRevisionId: 'plan-revision-runtime-fixture',
    contractRevisionId: 'contract-revision-runtime-fixture',
    status: 'finished' as const,
    authorityRefs: [],
    evidenceRefs: [`attempt:${attemptId}`],
  };
}

function artifact(
  artifactId: string,
  nodeId: string,
  plan: MissionPlanRevisionV1,
  verifierEvidence = [passedVerifier(artifactId, `sha256:${artifactId}`)],
): PlanArtifactV1 {
  return {
    schemaVersion: 'missionbraid.dev/plan-artifact/v1',
    artifactId,
    artifactDigest: `sha256:${artifactId}`,
    missionId: plan.missionId,
    planId: plan.planId,
    planRevisionId: plan.planRevisionId,
    contractRevisionId: plan.contractRevisionId,
    producedByNodeId: nodeId,
    producerNodeVersion: `node-version-${nodeId}`,
    requirementIds: ['req-a'],
    sourceArtifactIds: [],
    verifierEvidence,
    evidenceRefs: [`verifier:${artifactId}`],
  };
}

function passedVerifier(subjectId: string, subjectDigest: string) {
  return {
    evidenceId: `evidence-${subjectId}`,
    evaluator: 'deterministic' as const,
    verifierId: 'fixture-verifier/v1',
    subjectId,
    subjectDigest,
    result: {
      criterionId: 'fixture-verification',
      status: 'passed' as const,
      evidenceRefs: [`verifier:${subjectId}`],
    },
    evidenceRefs: [`verifier:${subjectId}`],
  };
}
