/**
 * Rebuildable Mission Plan execution projection.
 *
 * The projection is deliberately read-only.  It turns the immutable Plan DAG,
 * persisted Attempt observations, and selective invalidation records into the
 * view used by the Workbench.  It never starts an Agent, fences a process, or
 * changes Kernel state; those actions remain explicit commands owned by the
 * engine.
 */
import type {
  ActivePlanAttemptV1,
  MissionPlanRevisionV1,
  PlanArtifactV1,
  SelectiveInvalidationV1,
} from './mission-plan.js';

export const MISSION_PLAN_RUNTIME_SCHEMA_VERSION =
  'missionbraid.dev/mission-plan-runtime/v1' as const;

export type MissionPlanNodeExecutionStatusV1 =
  | 'blocked'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'waiting-join'
  | 'unknown';

export interface MissionPlanNodeExecutionV1 {
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly kind: MissionPlanRevisionV1['nodes'][number]['kind'];
  readonly title: string;
  readonly status: MissionPlanNodeExecutionStatusV1;
  readonly requirementIds: readonly string[];
  readonly predecessorNodeIds: readonly string[];
  readonly successorNodeIds: readonly string[];
  readonly activeAttemptIds: readonly string[];
  readonly finishedAttemptIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly invalidationIds: readonly string[];
  readonly reason: string | null;
}

export interface MissionPlanRuntimeProjectionV1 {
  readonly schemaVersion: typeof MISSION_PLAN_RUNTIME_SCHEMA_VERSION;
  readonly missionId: string;
  readonly planId: string;
  readonly planRevisionId: string;
  readonly contractRevisionId: string;
  readonly nodes: readonly MissionPlanNodeExecutionV1[];
  readonly readyNodeIds: readonly string[];
  readonly runningNodeIds: readonly string[];
  readonly staleNodeIds: readonly string[];
  readonly blockedNodeIds: readonly string[];
  readonly completedNodeIds: readonly string[];
  readonly joinNodeIds: readonly string[];
  readonly unknownNodeIds: readonly string[];
  readonly invalidationIds: readonly string[];
  readonly authority: 'derived-plan-evidence-only';
}

export interface ProjectMissionPlanRuntimeInputV1 {
  readonly plan: MissionPlanRevisionV1;
  readonly activeAttempts?: readonly ActivePlanAttemptV1[];
  readonly finishedAttempts?: readonly ActivePlanAttemptV1[];
  readonly artifacts?: readonly PlanArtifactV1[];
  readonly invalidations?: readonly SelectiveInvalidationV1[];
}

/**
 * Projects node state from immutable evidence.  A node is never considered
 * successful merely because a model reported completion: only a provenance
 * bound, verifier-backed PlanArtifact can make it `succeeded`.
 */
export function projectMissionPlanRuntime(
  input: ProjectMissionPlanRuntimeInputV1,
): MissionPlanRuntimeProjectionV1 {
  const nodesById = new Map(input.plan.nodes.map((node) => [node.nodeId, node]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of input.plan.edges) {
    add(incoming, edge.toNodeId, edge.fromNodeId);
    add(outgoing, edge.fromNodeId, edge.toNodeId);
  }

  const activeByNode = group(
    (input.activeAttempts ?? []).filter((attempt) =>
      attemptMatchesCurrentRevision(attempt, input.plan, nodesById),
    ),
  );
  const finishedByNode = group(
    (input.finishedAttempts ?? []).filter((attempt) =>
      attemptMatchesCurrentRevision(attempt, input.plan, nodesById),
    ),
  );
  const artifactsByNode = new Map<string, PlanArtifactV1[]>();
  for (const artifact of input.artifacts ?? []) {
    if (!artifactMatchesCurrentRevision(artifact, input.plan, nodesById)) continue;
    add(artifactsByNode, artifact.producedByNodeId, artifact);
  }

  // An invalidation is relevant to this view only when it produced the
  // current Contract revision and came from either this Plan revision or its
  // direct parent.  Parent invalidations remain visible as history, but they
  // must not make a newly planned node with the same nodeId permanently stale.
  const relevantInvalidations = (input.invalidations ?? []).filter(
    (invalidation) =>
      invalidation.missionId === input.plan.missionId &&
      invalidation.targetContractRevisionId === input.plan.contractRevisionId &&
      (invalidation.sourcePlanRevisionId === input.plan.planRevisionId ||
        invalidation.sourcePlanRevisionId === input.plan.parentPlanRevisionId),
  );

  const invalidationIdsByNode = new Map<string, string[]>();
  for (const invalidation of relevantInvalidations) {
    for (const nodeId of invalidation.invalidatedNodeIds) {
      add(invalidationIdsByNode, nodeId, invalidation.invalidationId);
    }
  }

  const staleNodes = new Set(
    relevantInvalidations
      .filter((invalidation) => invalidation.sourcePlanRevisionId === input.plan.planRevisionId)
      .flatMap((invalidation) => invalidation.invalidatedNodeIds),
  );
  const projections = input.plan.nodes.map((node) => {
    const predecessorIds = [...(incoming.get(node.nodeId) ?? [])].sort();
    const successorIds = [...(outgoing.get(node.nodeId) ?? [])].sort();
    const active = activeByNode.get(node.nodeId) ?? [];
    const finished = finishedByNode.get(node.nodeId) ?? [];
    const artifacts = artifactsByNode.get(node.nodeId) ?? [];
    const invalidationIds = [...(invalidationIdsByNode.get(node.nodeId) ?? [])].sort();
    // Dependency state is resolved in a second topological pass below; this
    // keeps the calculation deterministic even for a large DAG.
    return {
      node,
      predecessorIds,
      successorIds,
      active,
      finished,
      artifacts,
      invalidationIds,
      stale: staleNodes.has(node.nodeId),
    };
  });

  const stateByNode = new Map<string, MissionPlanNodeExecutionStatusV1>();
  // Resolve in topological order.  MissionPlanRevision validation guarantees
  // acyclicity, and the stable node order makes the result reproducible.
  const pending = new Set(projections.map((item) => item.node.nodeId));
  while (pending.size > 0) {
    let progressed = false;
    for (const item of projections) {
      const nodeId = item.node.nodeId;
      if (!pending.has(nodeId)) continue;
      if (item.predecessorIds.some((predecessor) => pending.has(predecessor))) continue;
      const predecessorStatuses = item.predecessorIds.map(
        (predecessor) => stateByNode.get(predecessor) ?? 'unknown',
      );
      stateByNode.set(nodeId, resolveStatus(item, predecessorStatuses));
      pending.delete(nodeId);
      progressed = true;
    }
    if (!progressed) {
      // Defensive fallback for malformed external input.  The Plan creator
      // rejects cycles, but an imported record must remain visibly unknown.
      for (const nodeId of pending) stateByNode.set(nodeId, 'unknown');
      break;
    }
  }

  const nodes = projections
    .map((item) => {
      const status = stateByNode.get(item.node.nodeId) ?? 'unknown';
      const reason = reasonFor(
        status,
        item,
        item.predecessorIds.map((id) => stateByNode.get(id) ?? 'unknown'),
      );
      return {
        nodeId: item.node.nodeId,
        nodeVersion: item.node.nodeVersion,
        kind: item.node.kind,
        title: item.node.title,
        status,
        requirementIds: item.node.requirementIds,
        predecessorNodeIds: item.predecessorIds,
        successorNodeIds: item.successorIds,
        activeAttemptIds: item.active.map((attempt) => attempt.attemptId).sort(),
        finishedAttemptIds: item.finished.map((attempt) => attempt.attemptId).sort(),
        artifactIds: item.artifacts.map((artifact) => artifact.artifactId).sort(),
        invalidationIds: item.invalidationIds,
        reason,
      } satisfies MissionPlanNodeExecutionV1;
    })
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

  const byStatus = (status: MissionPlanNodeExecutionStatusV1) =>
    nodes.filter((node) => node.status === status).map((node) => node.nodeId);
  return {
    schemaVersion: MISSION_PLAN_RUNTIME_SCHEMA_VERSION,
    missionId: input.plan.missionId,
    planId: input.plan.planId,
    planRevisionId: input.plan.planRevisionId,
    contractRevisionId: input.plan.contractRevisionId,
    nodes,
    readyNodeIds: byStatus('ready'),
    runningNodeIds: byStatus('running'),
    staleNodeIds: byStatus('stale'),
    blockedNodeIds: byStatus('blocked'),
    completedNodeIds: byStatus('succeeded'),
    joinNodeIds: nodes.filter((node) => node.kind === 'join').map((node) => node.nodeId),
    unknownNodeIds: byStatus('unknown'),
    invalidationIds: [...new Set(relevantInvalidations.map((item) => item.invalidationId))].sort(),
    authority: 'derived-plan-evidence-only',
  };
}

function resolveStatus(
  item: {
    node: MissionPlanRevisionV1['nodes'][number];
    active: readonly ActivePlanAttemptV1[];
    finished: readonly ActivePlanAttemptV1[];
    artifacts: readonly PlanArtifactV1[];
    stale: boolean;
  },
  predecessorStatuses: readonly MissionPlanNodeExecutionStatusV1[],
): MissionPlanNodeExecutionStatusV1 {
  if (item.stale) return 'stale';
  if (item.active.length > 0) return 'running';
  // A current-revision artifact may have been explicitly adopted from an
  // unaffected parent Plan. Its deterministic reuse evidence is the terminal
  // proof; creating a fake current-revision Agent Attempt would misrepresent
  // what actually ran.
  if (item.artifacts.some((artifact) => hasPassedArtifactVerifier(artifact))) return 'succeeded';
  if (item.finished.some((attempt) => attempt.terminalStatus === 'failed')) return 'failed';
  if (item.finished.some((attempt) => attempt.terminalStatus === 'abandoned')) return 'unknown';
  // A finished Attempt without a PlanArtifact is not proof of failure.  It is
  // intentionally left unknown until a verifier-backed artifact is recorded.
  if (item.finished.length > 0) return 'unknown';
  if (item.node.kind === 'join') {
    if (predecessorStatuses.some((status) => status === 'failed' || status === 'stale'))
      return 'blocked';
    if (predecessorStatuses.every((status) => status === 'succeeded')) return 'ready';
    return 'waiting-join';
  }
  if (predecessorStatuses.some((status) => status === 'failed' || status === 'stale'))
    return 'blocked';
  if (predecessorStatuses.every((status) => status === 'succeeded')) return 'ready';
  if (predecessorStatuses.length === 0) return 'ready';
  return 'blocked';
}

function reasonFor(
  status: MissionPlanNodeExecutionStatusV1,
  item: {
    readonly active: readonly ActivePlanAttemptV1[];
    readonly finished: readonly ActivePlanAttemptV1[];
    readonly artifacts: readonly PlanArtifactV1[];
    readonly invalidationIds: readonly string[];
  },
  predecessorStatuses: readonly MissionPlanNodeExecutionStatusV1[],
): string | null {
  if (status === 'stale') return `invalidated by ${item.invalidationIds.join(', ')}`;
  if (status === 'running')
    return `Attempt ${item.active.map((attempt) => attempt.attemptId).join(', ')} is active`;
  if (status === 'succeeded') return 'verifier-backed PlanArtifact is present';
  if (status === 'failed') return 'an explicit failed Attempt was recorded';
  if (status === 'waiting-join') return 'waiting for every join input to be verified';
  if (status === 'blocked') {
    const failed = predecessorStatuses.filter(
      (candidate) => candidate === 'failed' || candidate === 'stale',
    );
    return failed.length > 0 ? 'a predecessor is failed or stale' : 'a predecessor is not ready';
  }
  if (status === 'ready') return 'all dependencies and evidence gates are satisfied';
  return null;
}

function group<T extends { readonly nodeId: string }>(items: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) add(result, item.nodeId, item);
  return result;
}

function attemptMatchesCurrentRevision(
  attempt: ActivePlanAttemptV1,
  plan: MissionPlanRevisionV1,
  nodesById: ReadonlyMap<string, MissionPlanRevisionV1['nodes'][number]>,
): boolean {
  const node = nodesById.get(attempt.nodeId);
  return (
    node !== undefined &&
    attempt.planRevisionId === plan.planRevisionId &&
    attempt.contractRevisionId === plan.contractRevisionId &&
    attempt.nodeVersion === node.nodeVersion
  );
}

function artifactMatchesCurrentRevision(
  artifact: PlanArtifactV1,
  plan: MissionPlanRevisionV1,
  nodesById: ReadonlyMap<string, MissionPlanRevisionV1['nodes'][number]>,
): boolean {
  const node = nodesById.get(artifact.producedByNodeId);
  return (
    node !== undefined &&
    artifact.missionId === plan.missionId &&
    artifact.planId === plan.planId &&
    artifact.planRevisionId === plan.planRevisionId &&
    artifact.contractRevisionId === plan.contractRevisionId &&
    artifact.producerNodeVersion === node.nodeVersion
  );
}

function hasPassedArtifactVerifier(artifact: PlanArtifactV1): boolean {
  return artifact.verifierEvidence.some(
    (evidence) =>
      evidence.evaluator === 'deterministic' &&
      evidence.subjectId === artifact.artifactId &&
      evidence.subjectDigest === artifact.artifactDigest &&
      ('passed' in evidence.result ? evidence.result.passed : evidence.result.status === 'passed'),
  );
}

function add<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
