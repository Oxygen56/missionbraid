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
      verifierEvidence: [],
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
          targetContractRevisionId: 'contract-revision-next',
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
