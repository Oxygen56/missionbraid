/**
 * Pure Mission Plan DAG, revision-impact, and consolidation planning primitives.
 *
 * This module owns no Mission state. It produces immutable, content-addressed
 * records that a Kernel may validate and persist before any Agent or Effect is
 * dispatched. Source Branches, Attempts, workspaces, and authority are never
 * mutated or inherited by these projections.
 */
import { createHash } from 'node:crypto';

import type { AttemptV1, BranchV1, ContractV1, EffectV1, VerificationResultV1 } from './domain.js';
import type { CommandVerificationResultV1 } from './verifier.js';

export const CONTRACT_REVISION_SCHEMA_VERSION = 'missionbraid.dev/contract-revision/v1' as const;
export const MISSION_PLAN_SCHEMA_VERSION = 'missionbraid.dev/mission-plan/v1' as const;
export const PLAN_ARTIFACT_SCHEMA_VERSION = 'missionbraid.dev/plan-artifact/v1' as const;
export const SELECTIVE_INVALIDATION_SCHEMA_VERSION =
  'missionbraid.dev/selective-invalidation/v1' as const;
export const CONSOLIDATION_SCHEMA_VERSION = 'missionbraid.dev/consolidation/v1' as const;

export type MissionPlanNodeKindV1 = 'task' | 'review' | 'diagnostic' | 'branch' | 'join';

export type ContractRequirementKindV1 =
  | 'objective'
  | 'constraint'
  | 'acceptance-criterion'
  | 'capability'
  | 'permission';

export interface ContractRequirementV1 {
  readonly requirementId: string;
  readonly kind: ContractRequirementKindV1;
  readonly statement: string;
  readonly acceptanceCriterionIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ContractAuthorityChangeV1 {
  readonly changeId: string;
  readonly action: 'grant' | 'narrow' | 'revoke';
  readonly authorityRef: string;
  readonly scope: string;
  readonly authorizationEvidenceRefs: readonly string[];
}

export interface ContractRevisionProvenanceV1 {
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

export interface ContractRevisionV1 {
  readonly schemaVersion: typeof CONTRACT_REVISION_SCHEMA_VERSION;
  readonly contractRevisionId: string;
  readonly revisionDigest: string;
  readonly missionId: string;
  readonly revisionNumber: number;
  readonly parentContractRevisionId?: string;
  readonly contract: ContractV1;
  readonly requirements: readonly ContractRequirementV1[];
  readonly changedRequirementIds: readonly string[];
  readonly authorityChanges: readonly ContractAuthorityChangeV1[];
  readonly changedAuthorityScopes: readonly string[];
  readonly provenance: ContractRevisionProvenanceV1;
  readonly createdAt: string;
}

export interface CreateContractRevisionInputV1 {
  readonly missionId: string;
  readonly contract: ContractV1;
  readonly requirements: readonly ContractRequirementV1[];
  readonly authorityChanges?: readonly ContractAuthorityChangeV1[];
  readonly previousRevision?: ContractRevisionV1;
  readonly provenance: ContractRevisionProvenanceV1;
  readonly createdAt: string;
}

export type PlanWorkspaceAccessV1 = 'read-only' | 'isolated-writable';

export interface PlanNodeWorkspaceV1 {
  readonly access: PlanWorkspaceAccessV1;
  readonly workspaceKey: string;
  readonly sharedResourceKeys: readonly string[];
}

export interface MissionPlanNodeInputV1 {
  readonly nodeId: string;
  readonly kind: MissionPlanNodeKindV1;
  readonly title: string;
  readonly requirementIds: readonly string[];
  readonly inputArtifactIds: readonly string[];
  readonly declaredOutputKeys: readonly string[];
  readonly requiredAuthorityScopes: readonly string[];
  readonly workspace: PlanNodeWorkspaceV1;
  readonly provenanceEvidenceRefs: readonly string[];
}

export interface MissionPlanNodeV1 extends MissionPlanNodeInputV1 {
  /** Stable while the node's observable semantics remain unchanged. */
  readonly nodeVersion: string;
}

export type MissionPlanEdgeRelationV1 =
  | 'depends-on'
  | 'review-input'
  | 'diagnostic-input'
  | 'branch-input'
  | 'join-input';

export interface MissionPlanEdgeInputV1 {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly relation: MissionPlanEdgeRelationV1;
  readonly evidenceRefs: readonly string[];
}

export interface MissionPlanEdgeV1 extends MissionPlanEdgeInputV1 {
  readonly edgeId: string;
}

export interface SharedResourceCoordinationV1 {
  readonly resourceKey: string;
  readonly coordination: 'exclusive-lease' | 'serialized-effect' | 'read-only';
  readonly evidenceRefs: readonly string[];
}

export type DeterministicVerificationResultV1 = VerificationResultV1 | CommandVerificationResultV1;

export interface DeterministicVerifierEvidenceV1 {
  readonly evidenceId: string;
  readonly evaluator: 'deterministic';
  readonly verifierId: string;
  readonly subjectId: string;
  readonly subjectDigest: string;
  readonly result: DeterministicVerificationResultV1;
  readonly evidenceRefs: readonly string[];
}

export interface MissionPlanRevisionProvenanceV1 {
  readonly source: 'human' | 'deterministic-planner' | 'accepted-model-proposal';
  readonly evidenceRefs: readonly string[];
}

export interface MissionPlanRevisionV1 {
  readonly schemaVersion: typeof MISSION_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly planRevisionId: string;
  readonly revisionDigest: string;
  readonly missionId: string;
  readonly revisionNumber: number;
  readonly parentPlanRevisionId?: string;
  readonly contractRevisionId: string;
  readonly nodes: readonly MissionPlanNodeV1[];
  readonly edges: readonly MissionPlanEdgeV1[];
  readonly sharedResources: readonly SharedResourceCoordinationV1[];
  readonly provenance: MissionPlanRevisionProvenanceV1;
  /** Evidence from this module's deterministic structural DAG verifier. */
  readonly structureVerifierEvidence: DeterministicVerifierEvidenceV1;
  readonly createdAt: string;
}

export interface CreateMissionPlanRevisionInputV1 {
  readonly planId: string;
  readonly missionId: string;
  readonly contractRevision: ContractRevisionV1;
  readonly parentRevision?: MissionPlanRevisionV1;
  readonly nodes: readonly MissionPlanNodeInputV1[];
  readonly edges: readonly MissionPlanEdgeInputV1[];
  readonly sharedResources?: readonly SharedResourceCoordinationV1[];
  readonly provenance: MissionPlanRevisionProvenanceV1;
  readonly createdAt: string;
}

export interface PlanArtifactV1 {
  readonly schemaVersion: typeof PLAN_ARTIFACT_SCHEMA_VERSION;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly missionId: string;
  readonly planId: string;
  readonly planRevisionId: string;
  readonly contractRevisionId: string;
  readonly producedByNodeId: string;
  readonly producerNodeVersion: string;
  readonly requirementIds: readonly string[];
  readonly sourceArtifactIds: readonly string[];
  readonly verifierEvidence: readonly DeterministicVerifierEvidenceV1[];
  readonly evidenceRefs: readonly string[];
}

export interface RecordPlanArtifactInputV1 {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly plan: MissionPlanRevisionV1;
  readonly producedByNodeId: string;
  readonly requirementIds?: readonly string[];
  readonly sourceArtifactIds?: readonly string[];
  readonly verifierEvidence: readonly DeterministicVerifierEvidenceV1[];
  readonly evidenceRefs: readonly string[];
}

export interface ActivePlanAttemptV1 {
  readonly attemptId: string;
  readonly agentId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly planRevisionId: string;
  readonly contractRevisionId: string;
  readonly status: 'running' | 'finished';
  /** Observable source authority; it is never transferred by impact analysis. */
  readonly authorityRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export type AttemptFenceReasonV1 =
  | 'requirement-or-authority-changed'
  | 'invalidated-dependency'
  | 'obsolete-node-version'
  | 'obsolete-contract-revision';

export interface StaleAttemptFenceV1 {
  readonly fenceId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly nodeId: string;
  readonly reason: AttemptFenceReasonV1;
  readonly action: 'interrupt-and-preserve-evidence';
  readonly acceptsFurtherEffects: false;
  readonly observedPlanRevisionId: string;
  readonly observedContractRevisionId: string;
  readonly targetContractRevisionId: string;
  readonly evidenceRefs: readonly string[];
}

export interface SelectiveInvalidationV1 {
  readonly schemaVersion: typeof SELECTIVE_INVALIDATION_SCHEMA_VERSION;
  readonly invalidationId: string;
  readonly missionId: string;
  readonly sourcePlanRevisionId: string;
  readonly sourceContractRevisionId: string;
  readonly targetContractRevisionId: string;
  readonly changedRequirementIds: readonly string[];
  readonly changedAuthorityScopes: readonly string[];
  readonly directlyImpactedNodeIds: readonly string[];
  readonly invalidatedNodeIds: readonly string[];
  readonly replanFrontierNodeIds: readonly string[];
  readonly reusableNodeIds: readonly string[];
  readonly invalidatedArtifactIds: readonly string[];
  readonly reusableArtifactIds: readonly string[];
  readonly unplannedRequirementIds: readonly string[];
  readonly staleAttemptFences: readonly StaleAttemptFenceV1[];
  /** Unaffected work that may continue only after a new revision binding. */
  readonly rebindableRunningAttemptIds: readonly string[];
  readonly authorityTransfer: 'none';
  readonly evidenceRefs: readonly string[];
}

export interface AnalyzeSelectiveInvalidationInputV1 {
  readonly plan: MissionPlanRevisionV1;
  readonly previousContractRevision: ContractRevisionV1;
  readonly nextContractRevision: ContractRevisionV1;
  readonly artifacts?: readonly PlanArtifactV1[];
  readonly activeAttempts?: readonly ActivePlanAttemptV1[];
}

export interface ConsolidationArtifactSourceV1 {
  readonly kind: 'artifact';
  readonly selectionId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly workspaceKey: string;
  readonly artifact: PlanArtifactV1;
  /** Required when reusing an unaffected artifact from the parent Plan revision. */
  readonly reuseDecision?: SelectiveInvalidationV1;
  /** Recorded only to prove it is deliberately not inherited. */
  readonly sourceAuthorityRefs: readonly string[];
}

export interface ConsolidationCheckpointSourceV1 {
  readonly kind: 'checkpoint';
  readonly selectionId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly workspaceKey: string;
  readonly checkpointId: string;
  readonly checkpointDigest: string;
  readonly workspaceArtifactRef: string;
  readonly workspaceDisposition: 'restorable-artifact';
  readonly planRevisionId: string;
  readonly contractRevisionId: string;
  readonly nodeVersion: string;
  readonly requirementIds: readonly string[];
  readonly verifierEvidence: readonly DeterministicVerifierEvidenceV1[];
  readonly evidenceRefs: readonly string[];
  /** Required when reusing an unaffected Checkpoint from the parent Plan revision. */
  readonly reuseDecision?: SelectiveInvalidationV1;
  /** Recorded only to prove it is deliberately not inherited. */
  readonly sourceAuthorityRefs: readonly string[];
}

export type ConsolidationSourceV1 = ConsolidationArtifactSourceV1 | ConsolidationCheckpointSourceV1;

export type ExplicitAuthorityBindingV1 =
  | {
      readonly source: 'authorized-grant';
      readonly grantId: string;
      readonly authorityRef: string;
      readonly scope: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly source: 'contract-revision';
      readonly contractRevisionId: string;
      readonly authorityChangeId: string;
      readonly authorityRef: string;
      readonly scope: string;
      readonly evidenceRefs: readonly string[];
    };

export interface WorkspaceIntegrationConflictV1 {
  readonly conflictId: string;
  readonly resourceKey: string;
  readonly inputSelectionIds: readonly string[];
  readonly status: 'resolved' | 'unresolved';
  readonly resolutionEvidenceRefs: readonly string[];
}

export interface ConsolidationSourceSelectionV1 {
  readonly selectionId: string;
  readonly kind: 'artifact' | 'checkpoint';
  readonly branchId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly workspaceKey: string;
  readonly contentId: string;
  readonly contentDigest: string;
  readonly evidenceRefs: readonly string[];
}

export interface WorkspaceIntegrationEffectV1 {
  readonly effect: EffectV1;
  readonly selectedInputs: readonly ConsolidationSourceSelectionV1[];
  readonly conflicts: readonly WorkspaceIntegrationConflictV1[];
  readonly sourceVerifierEvidence: readonly DeterministicVerifierEvidenceV1[];
  readonly outputVerificationSubjectId: string;
}

export interface ConsolidationAuthorityBindingV1 {
  readonly inheritance: 'none';
  readonly inheritedAuthorityRefs: readonly [];
  readonly explicitBindings: readonly ExplicitAuthorityBindingV1[];
}

export interface ConsolidationAttemptPlanV1 {
  readonly schemaVersion: typeof CONSOLIDATION_SCHEMA_VERSION;
  readonly consolidationId: string;
  readonly planRevisionId: string;
  readonly contractRevisionId: string;
  readonly joinNodeId: string;
  readonly branch: BranchV1;
  readonly attempt: AttemptV1;
  readonly lineage: {
    readonly mode: 'new-consolidation-attempt';
    readonly sourceBranchIds: readonly string[];
    readonly sourceAttemptIds: readonly string[];
    readonly sourceNodeIds: readonly string[];
    readonly sourceHistory: 'immutable';
  };
  readonly workspace: {
    readonly access: 'isolated-writable';
    readonly workspaceKey: string;
  };
  readonly authority: ConsolidationAuthorityBindingV1;
  readonly workspaceIntegration: WorkspaceIntegrationEffectV1;
  readonly evidenceRefs: readonly string[];
}

export type ConsolidationBlockerCodeV1 =
  | 'JOIN_INPUT_MISSING'
  | 'SOURCE_VERIFICATION_REQUIRED'
  | 'UNRESOLVED_INTEGRATION_CONFLICT'
  | 'EXPLICIT_AUTHORITY_REQUIRED';

export interface ConsolidationBlockerV1 {
  readonly code: ConsolidationBlockerCodeV1;
  readonly joinNodeId: string;
  readonly sourceSelectionIds: readonly string[];
  readonly missingAuthorityScopes: readonly string[];
  readonly conflictIds: readonly string[];
  readonly detail: string;
}

export type ConsolidationPlanResultV1 =
  | { readonly ok: true; readonly plan: ConsolidationAttemptPlanV1 }
  | { readonly ok: false; readonly blocker: ConsolidationBlockerV1 };

export interface PlanConsolidationAttemptInputV1 {
  readonly plan: MissionPlanRevisionV1;
  readonly contractRevision: ContractRevisionV1;
  readonly joinNodeId: string;
  readonly sources: readonly ConsolidationSourceV1[];
  readonly newBranchId: string;
  readonly newAttemptId: string;
  readonly profileId: string;
  readonly targetWorkspaceKey: string;
  readonly explicitAuthorityBindings?: readonly ExplicitAuthorityBindingV1[];
  readonly conflicts?: readonly WorkspaceIntegrationConflictV1[];
  readonly startedAt: string;
}

export interface WorkspaceIntegrationOutcomeV1 {
  readonly schemaVersion: typeof CONSOLIDATION_SCHEMA_VERSION;
  readonly consolidationId: string;
  readonly outputWorkspaceDigest: string;
  readonly effect: EffectV1;
  readonly verifierEvidence: readonly DeterministicVerifierEvidenceV1[];
  readonly conflicts: readonly WorkspaceIntegrationConflictV1[];
  readonly conclusion: 'confirmed' | 'failed' | 'conflict' | 'unknown';
  readonly evidenceRefs: readonly string[];
}

export interface RecordWorkspaceIntegrationOutcomeInputV1 {
  readonly plan: ConsolidationAttemptPlanV1;
  readonly outputWorkspaceDigest: string;
  readonly verifierEvidence: readonly DeterministicVerifierEvidenceV1[];
  readonly conflicts?: readonly WorkspaceIntegrationConflictV1[];
}

export class MissionPlanValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'MissionPlanValidationError';
  }
}

/** Creates a content-addressed immutable Contract revision and its semantic delta. */
export function createContractRevision(input: CreateContractRevisionInputV1): ContractRevisionV1 {
  requireIdentifier(input.missionId, 'missionId');
  requireIdentifier(input.contract.contractId, 'contract.contractId');
  requireText(input.provenance.reason, 'provenance.reason');
  requireTimestamp(input.createdAt, 'createdAt');

  const previous = input.previousRevision;
  if (previous !== undefined && previous.missionId !== input.missionId) {
    throw new MissionPlanValidationError('Previous Contract revision belongs to another Mission');
  }
  const requirements = normalizeRequirements(input.requirements);
  const authorityChanges = normalizeAuthorityChanges(input.authorityChanges ?? []);
  const changedRequirementIds = changedIds(
    previous?.requirements ?? [],
    requirements,
    (requirement) => requirement.requirementId,
    requirementSemanticDigest,
  );
  const changedAuthorityScopes = uniqueSorted(authorityChanges.map((change) => change.scope));
  const previousContractDigest = previous === undefined ? undefined : digest(previous.contract);
  const contractDigest = digest(input.contract);
  if (
    previous !== undefined &&
    previousContractDigest !== contractDigest &&
    changedRequirementIds.length === 0 &&
    authorityChanges.length === 0
  ) {
    throw new MissionPlanValidationError(
      'Contract content changed without an explicit requirement or authority revision',
    );
  }

  const revisionNumber = (previous?.revisionNumber ?? 0) + 1;
  const provenance = {
    reason: input.provenance.reason.trim(),
    evidenceRefs: normalizeRefs(input.provenance.evidenceRefs, 'provenance.evidenceRefs'),
  };
  const revisionCore = {
    missionId: input.missionId,
    revisionNumber,
    parentContractRevisionId: previous?.contractRevisionId ?? null,
    contractDigest,
    requirements,
    changedRequirementIds,
    authorityChanges,
    changedAuthorityScopes,
    provenance,
  };
  const revisionDigest = digest(revisionCore);
  return {
    schemaVersion: CONTRACT_REVISION_SCHEMA_VERSION,
    contractRevisionId: `contract-revision-${shortHash(revisionDigest)}`,
    revisionDigest,
    missionId: input.missionId,
    revisionNumber,
    ...(previous === undefined ? {} : { parentContractRevisionId: previous.contractRevisionId }),
    contract: cloneContract(input.contract),
    requirements,
    changedRequirementIds,
    authorityChanges,
    changedAuthorityScopes,
    provenance,
    createdAt: input.createdAt,
  };
}

/** Validates and versions a Mission Plan DAG without dispatching it. */
export function createMissionPlanRevision(
  input: CreateMissionPlanRevisionInputV1,
): MissionPlanRevisionV1 {
  requireIdentifier(input.planId, 'planId');
  requireIdentifier(input.missionId, 'missionId');
  requireTimestamp(input.createdAt, 'createdAt');
  if (input.contractRevision.missionId !== input.missionId) {
    throw new MissionPlanValidationError('Contract revision belongs to another Mission');
  }
  const parent = input.parentRevision;
  if (
    parent !== undefined &&
    (parent.planId !== input.planId || parent.missionId !== input.missionId)
  ) {
    throw new MissionPlanValidationError('Parent Plan revision has a different Plan or Mission');
  }

  const contractRequirements = new Map(
    input.contractRevision.requirements.map((requirement) => [
      requirement.requirementId,
      requirementSemanticDigest(requirement),
    ]),
  );
  const nodes = normalizePlanNodes(input.nodes, contractRequirements);
  const sharedResources = normalizeSharedResources(input.sharedResources ?? []);
  validateWorkspaceIsolation(nodes);
  validateSharedResources(nodes, sharedResources);
  const edges = normalizePlanEdges(input.edges, nodes);
  validateDag(nodes, edges);
  validateNodeShapes(nodes, edges);

  const provenance = {
    source: input.provenance.source,
    evidenceRefs: normalizeRefs(input.provenance.evidenceRefs, 'provenance.evidenceRefs'),
  };
  const revisionNumber = (parent?.revisionNumber ?? 0) + 1;
  const revisionCore = {
    planId: input.planId,
    missionId: input.missionId,
    revisionNumber,
    parentPlanRevisionId: parent?.planRevisionId ?? null,
    contractRevisionId: input.contractRevision.contractRevisionId,
    nodes,
    edges,
    sharedResources,
    provenance,
  };
  const revisionDigest = digest(revisionCore);
  const planRevisionId = `plan-revision-${shortHash(revisionDigest)}`;
  const structureVerifierEvidence: DeterministicVerifierEvidenceV1 = {
    evidenceId: `plan-structure-verification-${shortHash(revisionDigest)}`,
    evaluator: 'deterministic',
    verifierId: 'mission-plan-dag-structure/v1',
    subjectId: planRevisionId,
    subjectDigest: revisionDigest,
    result: {
      criterionId: 'mission-plan-dag-structure',
      status: 'passed',
      evidenceRefs: uniqueSorted([
        ...provenance.evidenceRefs,
        ...nodes.flatMap((node) => node.provenanceEvidenceRefs),
        ...edges.flatMap((edge) => edge.evidenceRefs),
      ]),
    },
    evidenceRefs: uniqueSorted([
      ...provenance.evidenceRefs,
      ...nodes.flatMap((node) => node.provenanceEvidenceRefs),
      ...edges.flatMap((edge) => edge.evidenceRefs),
    ]),
  };
  return {
    schemaVersion: MISSION_PLAN_SCHEMA_VERSION,
    planId: input.planId,
    planRevisionId,
    revisionDigest,
    missionId: input.missionId,
    revisionNumber,
    ...(parent === undefined ? {} : { parentPlanRevisionId: parent.planRevisionId }),
    contractRevisionId: input.contractRevision.contractRevisionId,
    nodes,
    edges,
    sharedResources,
    provenance,
    structureVerifierEvidence,
    createdAt: input.createdAt,
  };
}

/** Records requirement-to-node-to-artifact provenance for later reuse analysis. */
export function recordPlanArtifact(input: RecordPlanArtifactInputV1): PlanArtifactV1 {
  requireIdentifier(input.artifactId, 'artifactId');
  requireDigest(input.artifactDigest, 'artifactDigest');
  const node = requirePlanNode(input.plan, input.producedByNodeId);
  const requirementIds = normalizeIdentifiers(
    input.requirementIds ?? node.requirementIds,
    'requirementIds',
  );
  for (const requirementId of requirementIds) {
    if (!node.requirementIds.includes(requirementId)) {
      throw new MissionPlanValidationError(
        `Artifact requirement ${requirementId} is not in producer node provenance`,
      );
    }
  }
  const verifierEvidence = normalizeVerifierEvidence(input.verifierEvidence);
  for (const evidence of verifierEvidence) {
    if (
      evidence.subjectId !== input.artifactId ||
      evidence.subjectDigest !== input.artifactDigest
    ) {
      throw new MissionPlanValidationError(
        `Artifact verifier ${evidence.evidenceId} is bound to a different subject`,
      );
    }
  }
  return {
    schemaVersion: PLAN_ARTIFACT_SCHEMA_VERSION,
    artifactId: input.artifactId,
    artifactDigest: input.artifactDigest,
    missionId: input.plan.missionId,
    planId: input.plan.planId,
    planRevisionId: input.plan.planRevisionId,
    contractRevisionId: input.plan.contractRevisionId,
    producedByNodeId: node.nodeId,
    producerNodeVersion: node.nodeVersion,
    requirementIds,
    sourceArtifactIds: normalizeIdentifiers(input.sourceArtifactIds ?? [], 'sourceArtifactIds'),
    verifierEvidence,
    evidenceRefs: normalizeRefs(input.evidenceRefs, 'evidenceRefs'),
  };
}

/**
 * Finds the minimum invalidated subgraph and fences only running Attempts whose
 * node semantics or upstream provenance became stale.
 */
export function analyzeSelectiveInvalidation(
  input: AnalyzeSelectiveInvalidationInputV1,
): SelectiveInvalidationV1 {
  const { plan, previousContractRevision, nextContractRevision } = input;
  if (
    plan.missionId !== previousContractRevision.missionId ||
    plan.contractRevisionId !== previousContractRevision.contractRevisionId
  ) {
    throw new MissionPlanValidationError('Plan is not bound to the previous Contract revision');
  }
  if (
    nextContractRevision.missionId !== plan.missionId ||
    nextContractRevision.parentContractRevisionId !== previousContractRevision.contractRevisionId
  ) {
    throw new MissionPlanValidationError(
      'Next Contract revision must directly descend from the Plan-bound revision',
    );
  }

  const changedRequirements = new Set(nextContractRevision.changedRequirementIds);
  const changedAuthorityScopes = new Set(nextContractRevision.changedAuthorityScopes);
  const nodesById = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const artifacts = normalizeArtifacts(input.artifacts ?? [], plan);
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const direct = new Set<string>();
  for (const node of plan.nodes) {
    if (
      intersects(node.requirementIds, changedRequirements) ||
      intersects(node.requiredAuthorityScopes, changedAuthorityScopes)
    ) {
      direct.add(node.nodeId);
    }
  }

  const invalidArtifacts = new Set<string>();
  for (const artifact of artifacts) {
    const producer = nodesById.get(artifact.producedByNodeId);
    if (
      producer === undefined ||
      artifact.producerNodeVersion !== producer.nodeVersion ||
      artifact.contractRevisionId !== previousContractRevision.contractRevisionId ||
      intersects(artifact.requirementIds, changedRequirements) ||
      !hasPassedVerifier(artifact.verifierEvidence, artifact.artifactId, artifact.artifactDigest)
    ) {
      invalidArtifacts.add(artifact.artifactId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of plan.nodes) {
      if (
        !direct.has(node.nodeId) &&
        node.inputArtifactIds.some((artifactId) => invalidArtifacts.has(artifactId))
      ) {
        direct.add(node.nodeId);
        changed = true;
      }
    }
    for (const artifact of artifacts) {
      if (!invalidArtifacts.has(artifact.artifactId) && direct.has(artifact.producedByNodeId)) {
        invalidArtifacts.add(artifact.artifactId);
        changed = true;
      }
      if (
        !invalidArtifacts.has(artifact.artifactId) &&
        artifact.sourceArtifactIds.some((artifactId) => invalidArtifacts.has(artifactId))
      ) {
        invalidArtifacts.add(artifact.artifactId);
        changed = true;
      }
    }
  }

  const invalidated = downstreamClosure(direct, plan.edges);
  for (const artifact of artifacts) {
    if (invalidated.has(artifact.producedByNodeId)) invalidArtifacts.add(artifact.artifactId);
  }
  const incoming = groupIncoming(plan.edges);
  const replanFrontier = [...invalidated].filter((nodeId) =>
    (incoming.get(nodeId) ?? []).every((parentId) => !invalidated.has(parentId)),
  );
  const reusableNodes = plan.nodes
    .map((node) => node.nodeId)
    .filter((nodeId) => !invalidated.has(nodeId));
  const reusableArtifacts = artifacts
    .map((artifact) => artifact.artifactId)
    .filter((artifactId) => {
      const artifact = artifactsById.get(artifactId);
      return (
        artifact !== undefined &&
        !invalidArtifacts.has(artifactId) &&
        !invalidated.has(artifact.producedByNodeId)
      );
    });
  const plannedRequirementIds = new Set(plan.nodes.flatMap((node) => node.requirementIds));
  const unplannedRequirementIds = [...changedRequirements].filter(
    (requirementId) => !plannedRequirementIds.has(requirementId),
  );

  const staleAttemptFences: StaleAttemptFenceV1[] = [];
  const rebindableRunningAttemptIds: string[] = [];
  for (const attempt of deduplicateBy(input.activeAttempts ?? [], (item) => item.attemptId)) {
    const node = nodesById.get(attempt.nodeId);
    if (node === undefined) {
      throw new MissionPlanValidationError(
        `Active Attempt references unknown node ${attempt.nodeId}`,
      );
    }
    if (attempt.status !== 'running') continue;
    const reason: AttemptFenceReasonV1 | undefined =
      attempt.nodeVersion !== node.nodeVersion
        ? 'obsolete-node-version'
        : direct.has(node.nodeId)
          ? 'requirement-or-authority-changed'
          : invalidated.has(node.nodeId)
            ? 'invalidated-dependency'
            : attempt.contractRevisionId !== nextContractRevision.contractRevisionId ||
                attempt.planRevisionId !== plan.planRevisionId
              ? 'obsolete-contract-revision'
              : undefined;
    if (reason === undefined) {
      continue;
    }
    if (reason === 'obsolete-contract-revision' && !invalidated.has(node.nodeId)) {
      rebindableRunningAttemptIds.push(attempt.attemptId);
    }
    staleAttemptFences.push({
      fenceId: `attempt-fence-${shortHash(
        `${attempt.attemptId}\0${nextContractRevision.contractRevisionId}\0${reason}`,
      )}`,
      attemptId: attempt.attemptId,
      agentId: attempt.agentId,
      nodeId: attempt.nodeId,
      reason,
      action: 'interrupt-and-preserve-evidence',
      acceptsFurtherEffects: false,
      observedPlanRevisionId: attempt.planRevisionId,
      observedContractRevisionId: attempt.contractRevisionId,
      targetContractRevisionId: nextContractRevision.contractRevisionId,
      evidenceRefs: normalizeRefs(
        attempt.evidenceRefs,
        `Attempt ${attempt.attemptId} evidenceRefs`,
      ),
    });
  }

  const evidenceRefs = uniqueSorted([
    ...previousContractRevision.provenance.evidenceRefs,
    ...nextContractRevision.provenance.evidenceRefs,
    ...plan.structureVerifierEvidence.evidenceRefs,
    ...artifacts.flatMap((artifact) => artifact.evidenceRefs),
    ...staleAttemptFences.flatMap((fence) => fence.evidenceRefs),
  ]);
  const identity = {
    planRevisionId: plan.planRevisionId,
    targetContractRevisionId: nextContractRevision.contractRevisionId,
    direct: sorted(direct),
    invalidated: sorted(invalidated),
    invalidArtifacts: sorted(invalidArtifacts),
  };
  return {
    schemaVersion: SELECTIVE_INVALIDATION_SCHEMA_VERSION,
    invalidationId: `selective-invalidation-${shortHash(digest(identity))}`,
    missionId: plan.missionId,
    sourcePlanRevisionId: plan.planRevisionId,
    sourceContractRevisionId: previousContractRevision.contractRevisionId,
    targetContractRevisionId: nextContractRevision.contractRevisionId,
    changedRequirementIds: [...changedRequirements].sort(),
    changedAuthorityScopes: [...changedAuthorityScopes].sort(),
    directlyImpactedNodeIds: sorted(direct),
    invalidatedNodeIds: sorted(invalidated),
    replanFrontierNodeIds: replanFrontier.sort(),
    reusableNodeIds: reusableNodes.sort(),
    invalidatedArtifactIds: sorted(invalidArtifacts),
    reusableArtifactIds: reusableArtifacts.sort(),
    unplannedRequirementIds: unplannedRequirementIds.sort(),
    staleAttemptFences: staleAttemptFences.sort((left, right) =>
      left.attemptId.localeCompare(right.attemptId),
    ),
    rebindableRunningAttemptIds: rebindableRunningAttemptIds.sort(),
    authorityTransfer: 'none',
    evidenceRefs,
  };
}

/**
 * Creates a new consolidation Branch and Attempt. It never merges either
 * source Branch in place and never copies source authority.
 */
export function planConsolidationAttempt(
  input: PlanConsolidationAttemptInputV1,
): ConsolidationPlanResultV1 {
  const joinNode = requirePlanNode(input.plan, input.joinNodeId);
  if (joinNode.kind !== 'join') {
    throw new MissionPlanValidationError('Consolidation can only target a join node');
  }
  if (
    input.contractRevision.contractRevisionId !== input.plan.contractRevisionId ||
    input.contractRevision.missionId !== input.plan.missionId
  ) {
    throw new MissionPlanValidationError('Consolidation Contract revision does not match the Plan');
  }
  requireIdentifier(input.newBranchId, 'newBranchId');
  requireIdentifier(input.newAttemptId, 'newAttemptId');
  requireIdentifier(input.profileId, 'profileId');
  requireIdentifier(input.targetWorkspaceKey, 'targetWorkspaceKey');
  requireTimestamp(input.startedAt, 'startedAt');

  const sources = normalizeConsolidationSources(input.sources, input.plan);
  if (sources.length < 2) {
    return consolidationBlocker(
      'JOIN_INPUT_MISSING',
      joinNode.nodeId,
      sources,
      [],
      [],
      'A join requires at least two provenance-bound source selections',
    );
  }
  const expectedInputNodes = new Set(
    input.plan.edges
      .filter((edge) => edge.toNodeId === joinNode.nodeId)
      .map((edge) => edge.fromNodeId),
  );
  const selectedNodeIds = new Set(sources.map((source) => source.nodeId));
  const missingInputNodeIds = [...expectedInputNodes].filter(
    (nodeId) => !selectedNodeIds.has(nodeId),
  );
  if (missingInputNodeIds.length > 0) {
    return consolidationBlocker(
      'JOIN_INPUT_MISSING',
      joinNode.nodeId,
      sources,
      [],
      [],
      `Join sources are missing predecessor nodes: ${missingInputNodeIds.sort().join(', ')}`,
    );
  }
  if (
    sources.some(
      (source) =>
        source.branchId === input.newBranchId ||
        source.attemptId === input.newAttemptId ||
        source.workspaceKey === input.targetWorkspaceKey,
    )
  ) {
    throw new MissionPlanValidationError(
      'Consolidation requires a new Branch, Attempt, and isolated writable workspace',
    );
  }

  const unverifiedSources = sources.filter(
    (source) => !hasPassedVerifier(source.verifierEvidence, source.contentId, source.contentDigest),
  );
  if (unverifiedSources.length > 0) {
    return consolidationBlocker(
      'SOURCE_VERIFICATION_REQUIRED',
      joinNode.nodeId,
      unverifiedSources,
      [],
      [],
      'Every selected source must have passed deterministic verifier evidence bound to its digest',
    );
  }

  const conflicts = normalizeConflicts(input.conflicts ?? [], sources);
  const unresolvedConflicts = conflicts.filter((conflict) => conflict.status === 'unresolved');
  if (unresolvedConflicts.length > 0) {
    return consolidationBlocker(
      'UNRESOLVED_INTEGRATION_CONFLICT',
      joinNode.nodeId,
      sources,
      [],
      unresolvedConflicts.map((conflict) => conflict.conflictId),
      'Workspace integration conflicts must be resolved before creating the consolidation Attempt',
    );
  }

  const explicitAuthorityBindings = normalizeAuthorityBindings(
    input.explicitAuthorityBindings ?? [],
    input.contractRevision,
  );
  const explicitScopes = new Set(explicitAuthorityBindings.map((binding) => binding.scope));
  const missingAuthorityScopes = joinNode.requiredAuthorityScopes.filter(
    (scope) => !explicitScopes.has(scope),
  );
  if (missingAuthorityScopes.length > 0) {
    return consolidationBlocker(
      'EXPLICIT_AUTHORITY_REQUIRED',
      joinNode.nodeId,
      sources,
      missingAuthorityScopes,
      [],
      'Source Agent authority is not inherited; the join requires an explicit Grant or Contract revision',
    );
  }

  const selectedInputs: ConsolidationSourceSelectionV1[] = sources.map((source) => ({
    selectionId: source.selectionId,
    kind: source.kind,
    branchId: source.branchId,
    attemptId: source.attemptId,
    nodeId: source.nodeId,
    workspaceKey: source.workspaceKey,
    contentId: source.contentId,
    contentDigest: source.contentDigest,
    evidenceRefs: source.evidenceRefs,
  }));
  const sourceVerifierEvidence = sources.flatMap((source) => source.verifierEvidence);
  const sourceEvidenceRefs = uniqueSorted([
    ...selectedInputs.flatMap((source) => source.evidenceRefs),
    ...sourceVerifierEvidence.flatMap((evidence) => [
      evidence.evidenceId,
      ...evidence.evidenceRefs,
    ]),
  ]);
  const consolidationId = `consolidation-${shortHash(
    digest({
      planRevisionId: input.plan.planRevisionId,
      joinNodeId: joinNode.nodeId,
      newBranchId: input.newBranchId,
      newAttemptId: input.newAttemptId,
      targetWorkspaceKey: input.targetWorkspaceKey,
      selectedInputs,
    }),
  )}`;
  const effectId = `effect-workspace-integration-${shortHash(consolidationId)}`;
  const branch: BranchV1 = {
    schemaVersion: 1,
    branchId: input.newBranchId,
    missionId: input.plan.missionId,
    status: 'active',
    createdAt: input.startedAt,
  };
  const attempt: AttemptV1 = {
    schemaVersion: 1,
    attemptId: input.newAttemptId,
    missionId: input.plan.missionId,
    branchId: input.newBranchId,
    profileId: input.profileId,
    stageId: joinNode.nodeId,
    status: 'running',
    startedAt: input.startedAt,
  };
  const effect: EffectV1 = {
    schemaVersion: 1,
    effectId,
    missionId: input.plan.missionId,
    attemptId: input.newAttemptId,
    kind: 'workspace.integration',
    resourceKey: input.targetWorkspaceKey,
    controlLevel: 'enforced',
    scope: 'branch_local_workspace',
    status: 'intended',
    idempotencyKey: consolidationId,
    evidenceRefs: sourceEvidenceRefs,
    createdAt: input.startedAt,
  };
  const evidenceRefs = uniqueSorted([
    ...sourceEvidenceRefs,
    ...conflicts.flatMap((conflict) => conflict.resolutionEvidenceRefs),
    ...explicitAuthorityBindings.flatMap((binding) => binding.evidenceRefs),
    input.plan.structureVerifierEvidence.evidenceId,
  ]);
  return {
    ok: true,
    plan: {
      schemaVersion: CONSOLIDATION_SCHEMA_VERSION,
      consolidationId,
      planRevisionId: input.plan.planRevisionId,
      contractRevisionId: input.contractRevision.contractRevisionId,
      joinNodeId: joinNode.nodeId,
      branch,
      attempt,
      lineage: {
        mode: 'new-consolidation-attempt',
        sourceBranchIds: uniqueSorted(sources.map((source) => source.branchId)),
        sourceAttemptIds: uniqueSorted(sources.map((source) => source.attemptId)),
        sourceNodeIds: uniqueSorted(sources.map((source) => source.nodeId)),
        sourceHistory: 'immutable',
      },
      workspace: {
        access: 'isolated-writable',
        workspaceKey: input.targetWorkspaceKey,
      },
      authority: {
        inheritance: 'none',
        inheritedAuthorityRefs: [],
        explicitBindings: explicitAuthorityBindings,
      },
      workspaceIntegration: {
        effect,
        selectedInputs,
        conflicts,
        sourceVerifierEvidence,
        outputVerificationSubjectId: effectId,
      },
      evidenceRefs,
    },
  };
}

/** Derives the immutable Effect outcome; it does not execute workspace integration. */
export function recordWorkspaceIntegrationOutcome(
  input: RecordWorkspaceIntegrationOutcomeInputV1,
): WorkspaceIntegrationOutcomeV1 {
  requireDigest(input.outputWorkspaceDigest, 'outputWorkspaceDigest');
  const verifierEvidence = normalizeVerifierEvidence(input.verifierEvidence);
  const conflicts = normalizeConflicts(
    input.conflicts ?? input.plan.workspaceIntegration.conflicts,
    input.plan.workspaceIntegration.selectedInputs.map((source) => ({
      ...source,
      verifierEvidence: [],
    })),
  );
  const unresolved = conflicts.filter((conflict) => conflict.status === 'unresolved');
  const matching = verifierEvidence.filter(
    (evidence) =>
      evidence.subjectId === input.plan.workspaceIntegration.outputVerificationSubjectId &&
      evidence.subjectDigest === input.outputWorkspaceDigest,
  );
  const passed = matching.some((evidence) => verifierPassed(evidence.result));
  const failed = matching.some((evidence) => verifierFailed(evidence.result));
  const conclusion =
    unresolved.length > 0 ? 'conflict' : failed ? 'failed' : passed ? 'confirmed' : 'unknown';
  const status: EffectV1['status'] =
    conclusion === 'conflict'
      ? 'conflict'
      : conclusion === 'failed'
        ? 'failed'
        : conclusion === 'confirmed'
          ? 'confirmed'
          : 'ambiguous';
  const evidenceRefs = uniqueSorted([
    ...input.plan.evidenceRefs,
    ...matching.flatMap((evidence) => [evidence.evidenceId, ...evidence.evidenceRefs]),
    ...conflicts.flatMap((conflict) => conflict.resolutionEvidenceRefs),
  ]);
  return {
    schemaVersion: CONSOLIDATION_SCHEMA_VERSION,
    consolidationId: input.plan.consolidationId,
    outputWorkspaceDigest: input.outputWorkspaceDigest,
    effect: {
      ...input.plan.workspaceIntegration.effect,
      status,
      evidenceRefs,
    },
    verifierEvidence: matching,
    conflicts,
    conclusion,
    evidenceRefs,
  };
}

interface NormalizedConsolidationSource {
  readonly kind: 'artifact' | 'checkpoint';
  readonly selectionId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly workspaceKey: string;
  readonly contentId: string;
  readonly contentDigest: string;
  readonly verifierEvidence: readonly DeterministicVerifierEvidenceV1[];
  readonly evidenceRefs: readonly string[];
}

function normalizeRequirements(
  requirements: readonly ContractRequirementV1[],
): readonly ContractRequirementV1[] {
  requireUnique(
    requirements.map((requirement) => requirement.requirementId),
    'requirementId',
  );
  return requirements
    .map((requirement) => {
      requireIdentifier(requirement.requirementId, 'requirement.requirementId');
      requireText(requirement.statement, `Requirement ${requirement.requirementId} statement`);
      return {
        requirementId: requirement.requirementId,
        kind: requirement.kind,
        statement: requirement.statement.trim(),
        acceptanceCriterionIds: normalizeIdentifiers(
          requirement.acceptanceCriterionIds,
          `Requirement ${requirement.requirementId} acceptanceCriterionIds`,
        ),
        evidenceRefs: normalizeRefs(
          requirement.evidenceRefs,
          `Requirement ${requirement.requirementId} evidenceRefs`,
        ),
      };
    })
    .sort((left, right) => left.requirementId.localeCompare(right.requirementId));
}

function normalizeAuthorityChanges(
  changes: readonly ContractAuthorityChangeV1[],
): readonly ContractAuthorityChangeV1[] {
  requireUnique(
    changes.map((change) => change.changeId),
    'authority changeId',
  );
  return changes
    .map((change) => {
      requireIdentifier(change.changeId, 'authority changeId');
      requireIdentifier(change.authorityRef, `Authority ${change.changeId} authorityRef`);
      requireIdentifier(change.scope, `Authority ${change.changeId} scope`);
      const authorizationEvidenceRefs = normalizeRefs(
        change.authorizationEvidenceRefs,
        `Authority ${change.changeId} authorizationEvidenceRefs`,
      );
      if (authorizationEvidenceRefs.length === 0) {
        throw new MissionPlanValidationError(
          `Authority change ${change.changeId} requires explicit authorization evidence`,
        );
      }
      return { ...change, authorizationEvidenceRefs };
    })
    .sort((left, right) => left.changeId.localeCompare(right.changeId));
}

function normalizePlanNodes(
  inputs: readonly MissionPlanNodeInputV1[],
  contractRequirements: ReadonlyMap<string, string>,
): readonly MissionPlanNodeV1[] {
  if (inputs.length === 0) throw new MissionPlanValidationError('Mission Plan requires a node');
  requireUnique(
    inputs.map((node) => node.nodeId),
    'nodeId',
  );
  return inputs
    .map((node) => {
      requireIdentifier(node.nodeId, 'node.nodeId');
      requireText(node.title, `Node ${node.nodeId} title`);
      requireIdentifier(node.workspace.workspaceKey, `Node ${node.nodeId} workspaceKey`);
      const requirementIds = normalizeIdentifiers(
        node.requirementIds,
        `Node ${node.nodeId} requirementIds`,
      );
      if (requirementIds.length === 0) {
        throw new MissionPlanValidationError(
          `Node ${node.nodeId} requires explicit requirement provenance`,
        );
      }
      for (const requirementId of requirementIds) {
        if (!contractRequirements.has(requirementId)) {
          throw new MissionPlanValidationError(
            `Node ${node.nodeId} references unknown requirement ${requirementId}`,
          );
        }
      }
      const normalized = {
        nodeId: node.nodeId,
        kind: node.kind,
        title: node.title.trim(),
        requirementIds,
        inputArtifactIds: normalizeIdentifiers(
          node.inputArtifactIds,
          `Node ${node.nodeId} inputArtifactIds`,
        ),
        declaredOutputKeys: normalizeIdentifiers(
          node.declaredOutputKeys,
          `Node ${node.nodeId} declaredOutputKeys`,
        ),
        requiredAuthorityScopes: normalizeIdentifiers(
          node.requiredAuthorityScopes,
          `Node ${node.nodeId} requiredAuthorityScopes`,
        ),
        workspace: {
          access: node.workspace.access,
          workspaceKey: node.workspace.workspaceKey,
          sharedResourceKeys: normalizeIdentifiers(
            node.workspace.sharedResourceKeys,
            `Node ${node.nodeId} sharedResourceKeys`,
          ),
        },
        provenanceEvidenceRefs: normalizeRefs(
          node.provenanceEvidenceRefs,
          `Node ${node.nodeId} provenanceEvidenceRefs`,
        ),
      };
      const requirementDigests = requirementIds.map((requirementId) =>
        contractRequirements.get(requirementId),
      );
      return { ...normalized, nodeVersion: digest({ ...normalized, requirementDigests }) };
    })
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function normalizePlanEdges(
  inputs: readonly MissionPlanEdgeInputV1[],
  nodes: readonly MissionPlanNodeV1[],
): readonly MissionPlanEdgeV1[] {
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const identities = inputs.map((edge) => `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.relation}`);
  requireUnique(identities, 'Plan edge');
  return inputs
    .map((edge) => {
      requireIdentifier(edge.fromNodeId, 'edge.fromNodeId');
      requireIdentifier(edge.toNodeId, 'edge.toNodeId');
      if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
        throw new MissionPlanValidationError('Plan edge references an unknown node');
      }
      if (edge.fromNodeId === edge.toNodeId) {
        throw new MissionPlanValidationError('Plan edge cannot point to the same node');
      }
      const evidenceRefs = normalizeRefs(edge.evidenceRefs, 'edge.evidenceRefs');
      return {
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        relation: edge.relation,
        evidenceRefs,
        edgeId: `plan-edge-${shortHash(`${edge.fromNodeId}\0${edge.toNodeId}\0${edge.relation}`)}`,
      };
    })
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function normalizeSharedResources(
  resources: readonly SharedResourceCoordinationV1[],
): readonly SharedResourceCoordinationV1[] {
  requireUnique(
    resources.map((resource) => resource.resourceKey),
    'shared resourceKey',
  );
  return resources
    .map((resource) => {
      requireIdentifier(resource.resourceKey, 'shared resourceKey');
      return {
        ...resource,
        evidenceRefs: normalizeRefs(
          resource.evidenceRefs,
          `Shared resource ${resource.resourceKey} evidenceRefs`,
        ),
      };
    })
    .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
}

function validateWorkspaceIsolation(nodes: readonly MissionPlanNodeV1[]): void {
  const owners = new Map<string, string>();
  for (const node of nodes.filter(
    (candidate) => candidate.workspace.access === 'isolated-writable',
  )) {
    const previous = owners.get(node.workspace.workspaceKey);
    if (previous !== undefined) {
      throw new MissionPlanValidationError(
        `Writable nodes ${previous} and ${node.nodeId} share workspace ${node.workspace.workspaceKey}`,
      );
    }
    owners.set(node.workspace.workspaceKey, node.nodeId);
  }
}

function validateSharedResources(
  nodes: readonly MissionPlanNodeV1[],
  resources: readonly SharedResourceCoordinationV1[],
): void {
  const declared = new Set(resources.map((resource) => resource.resourceKey));
  for (const node of nodes) {
    for (const resourceKey of node.workspace.sharedResourceKeys) {
      if (!declared.has(resourceKey)) {
        throw new MissionPlanValidationError(
          `Node ${node.nodeId} uses undeclared shared resource ${resourceKey}`,
        );
      }
    }
  }
}

function validateDag(
  nodes: readonly MissionPlanNodeV1[],
  edges: readonly MissionPlanEdgeV1[],
): void {
  const incomingCount = new Map(nodes.map((node) => [node.nodeId, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    incomingCount.set(edge.toNodeId, (incomingCount.get(edge.toNodeId) ?? 0) + 1);
    addGrouped(outgoing, edge.fromNodeId, edge.toNodeId);
  }
  const ready = [...incomingCount]
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId)
    .sort();
  let visited = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    visited += 1;
    for (const childId of outgoing.get(nodeId) ?? []) {
      const count = (incomingCount.get(childId) ?? 0) - 1;
      incomingCount.set(childId, count);
      if (count === 0) {
        ready.push(childId);
        ready.sort();
      }
    }
  }
  if (visited !== nodes.length)
    throw new MissionPlanValidationError('Mission Plan contains a cycle');
}

function validateNodeShapes(
  nodes: readonly MissionPlanNodeV1[],
  edges: readonly MissionPlanEdgeV1[],
): void {
  const incoming = groupIncoming(edges);
  for (const node of nodes) {
    const parents = incoming.get(node.nodeId) ?? [];
    if (node.kind === 'join' && parents.length < 2) {
      throw new MissionPlanValidationError(`Join node ${node.nodeId} requires at least two inputs`);
    }
    if (
      (node.kind === 'review' || node.kind === 'diagnostic' || node.kind === 'branch') &&
      parents.length === 0
    ) {
      throw new MissionPlanValidationError(`${node.kind} node ${node.nodeId} requires an input`);
    }
  }
}

function normalizeVerifierEvidence(
  evidence: readonly DeterministicVerifierEvidenceV1[],
): readonly DeterministicVerifierEvidenceV1[] {
  requireUnique(
    evidence.map((item) => item.evidenceId),
    'verifier evidenceId',
  );
  return evidence
    .map((item) => {
      requireIdentifier(item.evidenceId, 'verifier evidenceId');
      requireIdentifier(item.verifierId, `Verifier ${item.evidenceId} verifierId`);
      requireIdentifier(item.subjectId, `Verifier ${item.evidenceId} subjectId`);
      requireDigest(item.subjectDigest, `Verifier ${item.evidenceId} subjectDigest`);
      if (item.evaluator !== 'deterministic') {
        throw new MissionPlanValidationError('Only deterministic verifier evidence is accepted');
      }
      return {
        ...item,
        evidenceRefs: normalizeRefs(item.evidenceRefs, `Verifier ${item.evidenceId} evidenceRefs`),
      };
    })
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function normalizeArtifacts(
  artifacts: readonly PlanArtifactV1[],
  plan: MissionPlanRevisionV1,
): readonly PlanArtifactV1[] {
  requireUnique(
    artifacts.map((artifact) => artifact.artifactId),
    'artifactId',
  );
  return artifacts.map((artifact) => {
    if (artifact.missionId !== plan.missionId || artifact.planId !== plan.planId) {
      throw new MissionPlanValidationError(
        `Artifact ${artifact.artifactId} belongs to another Plan`,
      );
    }
    return artifact;
  });
}

function normalizeConsolidationSources(
  sources: readonly ConsolidationSourceV1[],
  plan: MissionPlanRevisionV1,
): readonly NormalizedConsolidationSource[] {
  requireUnique(
    sources.map((source) => source.selectionId),
    'source selectionId',
  );
  return sources
    .map((source): NormalizedConsolidationSource => {
      requireIdentifier(source.selectionId, 'source selectionId');
      requireIdentifier(source.branchId, `Source ${source.selectionId} branchId`);
      requireIdentifier(source.attemptId, `Source ${source.selectionId} attemptId`);
      requireIdentifier(source.workspaceKey, `Source ${source.selectionId} workspaceKey`);
      const node = requirePlanNode(plan, source.nodeId);
      if (source.kind === 'artifact') {
        const artifact = source.artifact;
        const sameRevision =
          artifact.planRevisionId === plan.planRevisionId &&
          artifact.contractRevisionId === plan.contractRevisionId;
        const reusableFromParent =
          source.reuseDecision !== undefined &&
          source.reuseDecision.missionId === plan.missionId &&
          source.reuseDecision.sourcePlanRevisionId === artifact.planRevisionId &&
          source.reuseDecision.sourceContractRevisionId === artifact.contractRevisionId &&
          source.reuseDecision.targetContractRevisionId === plan.contractRevisionId &&
          plan.parentPlanRevisionId === artifact.planRevisionId &&
          source.reuseDecision.reusableArtifactIds.includes(artifact.artifactId);
        if (
          artifact.missionId !== plan.missionId ||
          artifact.planId !== plan.planId ||
          (!sameRevision && !reusableFromParent) ||
          artifact.producedByNodeId !== source.nodeId ||
          artifact.producerNodeVersion !== node.nodeVersion
        ) {
          throw new MissionPlanValidationError(
            `Artifact source ${source.selectionId} is not bound to this Plan node revision`,
          );
        }
        const verifierEvidence = normalizeVerifierEvidence(artifact.verifierEvidence);
        return {
          kind: 'artifact',
          selectionId: source.selectionId,
          branchId: source.branchId,
          attemptId: source.attemptId,
          nodeId: source.nodeId,
          workspaceKey: source.workspaceKey,
          contentId: artifact.artifactId,
          contentDigest: artifact.artifactDigest,
          verifierEvidence,
          evidenceRefs: uniqueSorted([
            artifact.artifactId,
            ...artifact.evidenceRefs,
            ...(source.reuseDecision === undefined
              ? []
              : [source.reuseDecision.invalidationId, ...source.reuseDecision.evidenceRefs]),
            ...verifierEvidence.flatMap((evidence) => evidence.evidenceRefs),
          ]),
        };
      }
      const sameRevision =
        source.planRevisionId === plan.planRevisionId &&
        source.contractRevisionId === plan.contractRevisionId;
      const reusableFromParent =
        source.reuseDecision !== undefined &&
        source.reuseDecision.missionId === plan.missionId &&
        source.reuseDecision.sourcePlanRevisionId === source.planRevisionId &&
        source.reuseDecision.sourceContractRevisionId === source.contractRevisionId &&
        source.reuseDecision.targetContractRevisionId === plan.contractRevisionId &&
        plan.parentPlanRevisionId === source.planRevisionId &&
        source.reuseDecision.reusableNodeIds.includes(source.nodeId);
      if ((!sameRevision && !reusableFromParent) || source.nodeVersion !== node.nodeVersion) {
        throw new MissionPlanValidationError(
          `Checkpoint source ${source.selectionId} is not bound to this Plan node revision`,
        );
      }
      if (source.workspaceDisposition !== 'restorable-artifact') {
        throw new MissionPlanValidationError(
          `Checkpoint source ${source.selectionId} is not a restorable workspace artifact`,
        );
      }
      requireIdentifier(source.checkpointId, `Source ${source.selectionId} checkpointId`);
      requireDigest(source.checkpointDigest, `Source ${source.selectionId} checkpointDigest`);
      requireIdentifier(
        source.workspaceArtifactRef,
        `Source ${source.selectionId} workspaceArtifactRef`,
      );
      const verifierEvidence = normalizeVerifierEvidence(source.verifierEvidence);
      return {
        kind: 'checkpoint',
        selectionId: source.selectionId,
        branchId: source.branchId,
        attemptId: source.attemptId,
        nodeId: source.nodeId,
        workspaceKey: source.workspaceKey,
        contentId: source.checkpointId,
        contentDigest: source.checkpointDigest,
        verifierEvidence,
        evidenceRefs: uniqueSorted([
          source.checkpointId,
          source.workspaceArtifactRef,
          ...source.evidenceRefs,
          ...(source.reuseDecision === undefined
            ? []
            : [source.reuseDecision.invalidationId, ...source.reuseDecision.evidenceRefs]),
          ...verifierEvidence.flatMap((evidence) => evidence.evidenceRefs),
        ]),
      };
    })
    .sort((left, right) => left.selectionId.localeCompare(right.selectionId));
}

function normalizeConflicts(
  conflicts: readonly WorkspaceIntegrationConflictV1[],
  sources: readonly Pick<NormalizedConsolidationSource, 'selectionId'>[],
): readonly WorkspaceIntegrationConflictV1[] {
  requireUnique(
    conflicts.map((conflict) => conflict.conflictId),
    'conflictId',
  );
  const sourceIds = new Set(sources.map((source) => source.selectionId));
  return conflicts
    .map((conflict) => {
      requireIdentifier(conflict.conflictId, 'conflictId');
      requireIdentifier(conflict.resourceKey, `Conflict ${conflict.conflictId} resourceKey`);
      const inputSelectionIds = normalizeIdentifiers(
        conflict.inputSelectionIds,
        `Conflict ${conflict.conflictId} inputSelectionIds`,
      );
      for (const selectionId of inputSelectionIds) {
        if (!sourceIds.has(selectionId)) {
          throw new MissionPlanValidationError(
            `Conflict ${conflict.conflictId} references unknown selection ${selectionId}`,
          );
        }
      }
      const resolutionEvidenceRefs = normalizeRefs(
        conflict.resolutionEvidenceRefs,
        `Conflict ${conflict.conflictId} resolutionEvidenceRefs`,
      );
      if (conflict.status === 'resolved' && resolutionEvidenceRefs.length === 0) {
        throw new MissionPlanValidationError(
          `Resolved conflict ${conflict.conflictId} requires resolution evidence`,
        );
      }
      return { ...conflict, inputSelectionIds, resolutionEvidenceRefs };
    })
    .sort((left, right) => left.conflictId.localeCompare(right.conflictId));
}

function normalizeAuthorityBindings(
  bindings: readonly ExplicitAuthorityBindingV1[],
  contractRevision: ContractRevisionV1,
): readonly ExplicitAuthorityBindingV1[] {
  const identities = bindings.map((binding) =>
    binding.source === 'authorized-grant'
      ? `grant:${binding.grantId}`
      : `contract:${binding.contractRevisionId}:${binding.authorityChangeId}`,
  );
  requireUnique(identities, 'authority binding');
  return bindings
    .map((binding) => {
      requireIdentifier(binding.authorityRef, 'authority binding authorityRef');
      requireIdentifier(binding.scope, 'authority binding scope');
      const evidenceRefs = normalizeRefs(binding.evidenceRefs, 'authority binding evidenceRefs');
      if (evidenceRefs.length === 0) {
        throw new MissionPlanValidationError('Explicit authority binding requires evidence');
      }
      if (binding.source === 'authorized-grant') {
        requireIdentifier(binding.grantId, 'authority binding grantId');
        return { ...binding, evidenceRefs };
      }
      if (binding.contractRevisionId !== contractRevision.contractRevisionId) {
        throw new MissionPlanValidationError(
          'Contract authority binding references another Contract revision',
        );
      }
      const change = contractRevision.authorityChanges.find(
        (candidate) => candidate.changeId === binding.authorityChangeId,
      );
      if (
        change === undefined ||
        change.action !== 'grant' ||
        change.authorityRef !== binding.authorityRef ||
        change.scope !== binding.scope
      ) {
        throw new MissionPlanValidationError(
          'Contract authority binding is not backed by an explicit grant change',
        );
      }
      return { ...binding, evidenceRefs };
    })
    .sort((left, right) =>
      authorityBindingIdentity(left).localeCompare(authorityBindingIdentity(right)),
    );
}

function consolidationBlocker(
  code: ConsolidationBlockerCodeV1,
  joinNodeId: string,
  sources: readonly Pick<NormalizedConsolidationSource, 'selectionId'>[],
  missingAuthorityScopes: readonly string[],
  conflictIds: readonly string[],
  detail: string,
): ConsolidationPlanResultV1 {
  return {
    ok: false,
    blocker: {
      code,
      joinNodeId,
      sourceSelectionIds: uniqueSorted(sources.map((source) => source.selectionId)),
      missingAuthorityScopes: uniqueSorted(missingAuthorityScopes),
      conflictIds: uniqueSorted(conflictIds),
      detail,
    },
  };
}

function downstreamClosure(
  roots: ReadonlySet<string>,
  edges: readonly MissionPlanEdgeV1[],
): Set<string> {
  const result = new Set(roots);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) addGrouped(outgoing, edge.fromNodeId, edge.toNodeId);
  const queue = [...roots];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    for (const childId of outgoing.get(nodeId) ?? []) {
      if (result.has(childId)) continue;
      result.add(childId);
      queue.push(childId);
    }
  }
  return result;
}

function groupIncoming(edges: readonly MissionPlanEdgeV1[]): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) addGrouped(incoming, edge.toNodeId, edge.fromNodeId);
  return incoming;
}

function requirePlanNode(plan: MissionPlanRevisionV1, nodeId: string): MissionPlanNodeV1 {
  const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) throw new MissionPlanValidationError(`Unknown Plan node ${nodeId}`);
  return node;
}

function hasPassedVerifier(
  evidence: readonly DeterministicVerifierEvidenceV1[],
  subjectId: string,
  subjectDigest: string,
): boolean {
  return evidence.some(
    (item) =>
      item.evaluator === 'deterministic' &&
      item.subjectId === subjectId &&
      item.subjectDigest === subjectDigest &&
      verifierPassed(item.result),
  );
}

function verifierPassed(result: DeterministicVerificationResultV1): boolean {
  return 'passed' in result ? result.passed : result.status === 'passed';
}

function verifierFailed(result: DeterministicVerificationResultV1): boolean {
  return 'passed' in result ? !result.passed : result.status === 'failed';
}

function changedIds<T>(
  previous: readonly T[],
  next: readonly T[],
  key: (item: T) => string,
  semanticDigest: (item: T) => string,
): string[] {
  const previousById = new Map(previous.map((item) => [key(item), semanticDigest(item)]));
  const nextById = new Map(next.map((item) => [key(item), semanticDigest(item)]));
  const ids = new Set([...previousById.keys(), ...nextById.keys()]);
  return [...ids].filter((id) => previousById.get(id) !== nextById.get(id)).sort();
}

function requirementSemanticDigest(requirement: ContractRequirementV1): string {
  return digest({
    requirementId: requirement.requirementId,
    kind: requirement.kind,
    statement: requirement.statement,
    acceptanceCriterionIds: requirement.acceptanceCriterionIds,
  });
}

function cloneContract(contract: ContractV1): ContractV1 {
  return {
    ...contract,
    ...(contract.constraints === undefined ? {} : { constraints: [...contract.constraints] }),
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      verifier: {
        ...criterion.verifier,
        configuration: { ...criterion.verifier.configuration },
      },
    })),
  };
}

function authorityBindingIdentity(binding: ExplicitAuthorityBindingV1): string {
  return binding.source === 'authorized-grant'
    ? `grant:${binding.grantId}`
    : `contract:${binding.contractRevisionId}:${binding.authorityChangeId}`;
}

function intersects(values: readonly string[], targets: ReadonlySet<string>): boolean {
  return values.some((value) => targets.has(value));
}

function addGrouped(map: Map<string, string[]>, key: string, value: string): void {
  const group = map.get(key);
  if (group === undefined) map.set(key, [value]);
  else group.push(value);
}

function deduplicateBy<T>(values: readonly T[], identity: (value: T) => string): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    const id = identity(value);
    const previous = byId.get(id);
    if (previous !== undefined && stableStringify(previous) !== stableStringify(value)) {
      throw new MissionPlanValidationError(`Conflicting duplicate identity ${id}`);
    }
    byId.set(id, value);
  }
  return [...byId.values()].sort((left, right) => identity(left).localeCompare(identity(right)));
}

function normalizeIdentifiers(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => requireIdentifier(value, label));
  requireUnique(normalized, label);
  return normalized.sort();
}

function normalizeRefs(values: readonly string[], label: string): string[] {
  return normalizeIdentifiers(values, label);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new MissionPlanValidationError(`${label} values must be unique`);
  }
}

function requireIdentifier(value: string, label: string): string {
  if (value.trim().length === 0) throw new MissionPlanValidationError(`${label} must not be empty`);
  return value;
}

function requireText(value: string, label: string): string {
  if (value.trim().length === 0) throw new MissionPlanValidationError(`${label} must not be empty`);
  return value;
}

function requireDigest(value: string, label: string): string {
  if (value.trim().length === 0) throw new MissionPlanValidationError(`${label} must not be empty`);
  return value;
}

function requireTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new MissionPlanValidationError(`${label} must be an ISO timestamp`);
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}
