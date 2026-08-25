import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type {
  AttemptV1,
  BranchV1,
  ContractV1,
  EffectStatusV1,
  EffectV1,
  MissionV1,
  ProfileV1,
} from './domain.js';
import type { GitWorkspaceSnapshotV1 } from './workspace.js';

export const COMPOSITE_CHECKPOINT_SCHEMA_VERSION =
  'missionbraid.dev/composite-checkpoint/v1' as const;
export const CHECKPOINT_OPERATION_SCHEMA_VERSION =
  'missionbraid.dev/checkpoint-operation/v1' as const;

export type CheckpointComponentDispositionV1 =
  | 'portable'
  | 'recoverable'
  | 'inspect-only'
  | 'unavailable';

export type CheckpointComponentNameV1 =
  | 'mission'
  | 'branch'
  | 'attempt'
  | 'contract'
  | 'profile'
  | 'event-prefix'
  | 'visible-context'
  | 'workspace'
  | 'permissions'
  | 'effect-frontier'
  | 'process'
  | 'native-session';

export interface CheckpointComponentV1 {
  readonly component: CheckpointComponentNameV1;
  readonly disposition: CheckpointComponentDispositionV1;
  readonly contentDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly reason?: string;
}

export interface CheckpointEventPrefixEvidenceV1 {
  readonly throughSeq: number;
  readonly headHash: string;
  readonly evidenceRefs: readonly string[];
}

export type CheckpointVisibleContextEvidenceV1 =
  | {
      readonly status: 'captured';
      readonly contextDigest: string;
      readonly artifactRefs: readonly string[];
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
    };

/**
 * A Git digest proves what was observed, but it does not contain bytes needed
 * for restoration. Only a content-addressed restoration artifact is recoverable.
 */
export type CheckpointWorkspaceEvidenceV1 =
  | {
      readonly kind: 'git-digest';
      readonly workspaceKey: string;
      readonly snapshot: GitWorkspaceSnapshotV1;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: 'restorable-artifact';
      readonly workspaceKey: string;
      readonly workspaceDigest: string;
      readonly artifactRef: string;
      readonly artifactDigest: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly kind: 'unavailable';
      readonly workspaceKey: string;
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
    };

export interface CheckpointPermissionEvidenceV1 {
  readonly permissionMode: string;
  /** A reference to authority, never authority or credentials themselves. */
  readonly authorityRef?: string;
  readonly evidenceRefs: readonly string[];
}

export interface CheckpointStoppedProcessEvidenceV1 {
  /** A Checkpoint is only valid after the owned Runtime process has stopped. */
  readonly status: 'stopped';
  readonly stoppedAt: string;
  readonly processRef?: string;
  readonly exitCode?: number | null;
  readonly evidenceRefs: readonly string[];
}

export type CheckpointNativeSessionEvidenceV1 =
  | {
      readonly status: 'available';
      readonly harness: string;
      readonly sessionRef: string;
      readonly resumeSupported: boolean;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: 'unavailable';
      readonly harness: string;
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
    };

export interface CompositeCheckpointInputV1 {
  readonly mission: MissionV1;
  readonly branch: BranchV1;
  readonly attempt: AttemptV1;
  readonly contract: ContractV1;
  readonly profile: ProfileV1;
  readonly eventPrefix: CheckpointEventPrefixEvidenceV1;
  readonly visibleContext: CheckpointVisibleContextEvidenceV1;
  readonly workspace: CheckpointWorkspaceEvidenceV1;
  readonly permissions: CheckpointPermissionEvidenceV1;
  readonly effects: readonly EffectV1[];
  readonly process: CheckpointStoppedProcessEvidenceV1;
  readonly nativeSession: CheckpointNativeSessionEvidenceV1;
  readonly capturedAt: string;
}

export interface CheckpointSourceV1 {
  readonly missionId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly contractId: string;
  readonly profileId: string;
  readonly workspaceKey: string;
}

export interface CheckpointWorkspaceV1 {
  readonly workspaceKey: string;
  readonly state: 'digest-only' | 'restorable-artifact' | 'unavailable';
  readonly workspaceDigest: string | null;
  readonly statusDigest?: string;
  readonly head?: string | null;
  readonly artifactRef?: string;
  readonly artifactDigest?: string;
  readonly reason?: string;
}

export interface CheckpointProcessV1 {
  readonly status: 'stopped';
  readonly stoppedAt: string;
  readonly processRef?: string;
  readonly exitCode?: number | null;
}

export type CheckpointNativeSessionV1 =
  | {
      readonly status: 'available';
      readonly harness: string;
      readonly sessionRef: string;
      readonly resumeSupported: boolean;
    }
  | { readonly status: 'unavailable'; readonly harness: string; readonly reason: string };

export interface CheckpointEffectFrontierEntryV1 {
  readonly effectId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly resourceKey: string;
  readonly scope: 'shared_resource' | 'mission_global_external' | 'unknown';
  readonly status: EffectStatusV1;
  readonly controlLevel: 'enforced' | 'guarded' | 'advisory' | 'unknown';
  readonly authorityRef?: string;
  readonly idempotencyKey?: string;
  readonly evidenceRefs: readonly string[];
}

interface CompositeCheckpointCoreV1 {
  readonly schemaVersion: typeof COMPOSITE_CHECKPOINT_SCHEMA_VERSION;
  readonly source: CheckpointSourceV1;
  readonly eventPrefix: {
    readonly throughSeq: number;
    readonly headHash: string;
  };
  readonly workspace: CheckpointWorkspaceV1;
  readonly process: CheckpointProcessV1;
  readonly nativeSession: CheckpointNativeSessionV1;
  readonly externalEffectFrontier: readonly CheckpointEffectFrontierEntryV1[];
  readonly components: readonly CheckpointComponentV1[];
  readonly capturedAt: string;
}

export interface CompositeCheckpointManifestV1 extends CompositeCheckpointCoreV1 {
  readonly checkpointId: string;
  readonly manifestHash: string;
}

export class CompositeCheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositeCheckpointValidationError';
  }
}

export class CompositeCheckpointIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositeCheckpointIntegrityError';
  }
}

export function createCompositeCheckpoint(
  input: CompositeCheckpointInputV1,
): CompositeCheckpointManifestV1 {
  validateRelationships(input);

  const normalizedEffects = normalizeEffects(input.effects);
  const workspace = normalizeWorkspace(input.workspace);
  const process = normalizeProcess(input.process);
  const nativeSession = normalizeNativeSession(input.nativeSession);
  const externalEffectFrontier = normalizedEffects
    .filter((effect) => effect.scope !== 'branch_local_workspace')
    .map(
      (effect): CheckpointEffectFrontierEntryV1 => ({
        effectId: effect.effectId,
        attemptId: effect.attemptId,
        kind: effect.kind,
        resourceKey: effect.resourceKey,
        scope:
          effect.scope === 'shared_resource' || effect.scope === 'mission_global_external'
            ? effect.scope
            : 'unknown',
        status: effect.status,
        controlLevel: effect.controlLevel ?? 'unknown',
        ...(effect.authorityRef === undefined ? {} : { authorityRef: effect.authorityRef }),
        ...(effect.idempotencyKey === undefined ? {} : { idempotencyKey: effect.idempotencyKey }),
        evidenceRefs: normalizeRefs(effect.evidenceRefs, `Effect ${effect.effectId} evidenceRefs`),
      }),
    );

  const missionDigest = digest(input.mission);
  const branchDigest = digest(input.branch);
  const attemptDigest = digest(input.attempt);
  const contractDigest = digest(input.contract);
  const profileDigest = digest(input.profile);
  const eventPrefix = {
    throughSeq: input.eventPrefix.throughSeq,
    headHash: requireNonEmpty(input.eventPrefix.headHash, 'eventPrefix.headHash'),
  };
  const context = normalizeVisibleContext(input.visibleContext);
  const permissions = normalizePermissions(input.permissions);
  const eventEvidenceRefs = normalizeRefs(
    input.eventPrefix.evidenceRefs,
    'eventPrefix.evidenceRefs',
  );

  const components: CheckpointComponentV1[] = [
    component('mission', 'portable', missionDigest, [`mission:${input.mission.missionId}`]),
    component('branch', 'portable', branchDigest, [`branch:${input.branch.branchId}`]),
    component('attempt', 'portable', attemptDigest, [`attempt:${input.attempt.attemptId}`]),
    component('contract', 'portable', contractDigest, [`contract:${input.contract.contractId}`]),
    component('profile', 'portable', profileDigest, [`profile:${input.profile.profileId}`]),
    component('event-prefix', 'portable', digest(eventPrefix), eventEvidenceRefs),
    context.component,
    workspaceComponent(input.workspace, workspace),
    component('permissions', 'portable', digest(permissions.value), permissions.evidenceRefs),
    component(
      'effect-frontier',
      'inspect-only',
      digest(normalizedEffects),
      normalizeRefs(
        normalizedEffects.flatMap((effect) => effect.evidenceRefs),
        'effects.evidenceRefs',
        true,
      ),
      'The ledger is portable evidence, but external target state is not restored by a Checkpoint.',
    ),
    component(
      'process',
      'inspect-only',
      digest(process),
      normalizeRefs(input.process.evidenceRefs, 'process.evidenceRefs'),
      'A stopped-process record is boundary evidence, not a restorable process image.',
    ),
    nativeSessionComponent(input.nativeSession, nativeSession),
  ];

  const core: CompositeCheckpointCoreV1 = {
    schemaVersion: COMPOSITE_CHECKPOINT_SCHEMA_VERSION,
    source: {
      missionId: input.mission.missionId,
      branchId: input.branch.branchId,
      attemptId: input.attempt.attemptId,
      contractId: input.contract.contractId,
      profileId: input.profile.profileId,
      workspaceKey: input.mission.workspaceKey,
    },
    eventPrefix,
    workspace,
    process,
    nativeSession,
    externalEffectFrontier,
    components,
    capturedAt: requireIsoTimestamp(input.capturedAt, 'capturedAt'),
  };
  const manifestHash = digest(core);
  return {
    ...core,
    checkpointId: `checkpoint-${manifestHash.slice('sha256:'.length)}`,
    manifestHash,
  };
}

export function verifyCompositeCheckpoint(manifest: CompositeCheckpointManifestV1): void {
  const { checkpointId: _checkpointId, manifestHash: _manifestHash, ...core } = manifest;
  const expectedHash = digest(core);
  const expectedId = `checkpoint-${expectedHash.slice('sha256:'.length)}`;
  if (manifest.manifestHash !== expectedHash || manifest.checkpointId !== expectedId) {
    throw new CompositeCheckpointIntegrityError(
      'Composite Checkpoint identity does not match its manifest content',
    );
  }
}

export type CheckpointOperationModeV1 =
  | 'playback'
  | 'cached-replay'
  | 'counterfactual-resample'
  | 'execution-fork';

export type CheckpointInterventionKindV1 =
  | 'context'
  | 'tool-result'
  | 'permission-narrowing'
  | 'profile'
  | 'workspace'
  | 'guidance';

export interface CheckpointInterventionV1 {
  readonly interventionId: string;
  readonly kind: CheckpointInterventionKindV1;
  readonly targetRef: string;
  readonly beforeDigest?: string;
  readonly afterDigest: string;
  readonly description: string;
  /** Fork and replay may keep or narrow authority, never expand it implicitly. */
  readonly authorityChange: 'unchanged' | 'narrowed';
}

export interface IsolatedWorktreePlanV1 {
  readonly worktreeId: string;
  readonly workspaceKey: string;
  readonly absolutePath: string;
  readonly isolationMechanism: 'git-worktree' | 'provider-worktree' | 'copy-on-write';
  readonly baselineWorkspaceDigest: string;
  readonly evidenceRefs: readonly string[];
}

export interface ExternalEffectReplayDecisionV1 {
  readonly effectId: string;
  readonly action: 'inherit-no-repeat';
}

export interface PlaybackRequestV1 {
  readonly mode: 'playback';
  readonly checkpoint: CompositeCheckpointManifestV1;
}

export interface BranchingCheckpointRequestV1 {
  readonly mode: Exclude<CheckpointOperationModeV1, 'playback'>;
  readonly checkpoint: CompositeCheckpointManifestV1;
  readonly childBranchId: string;
  readonly intervention: CheckpointInterventionV1;
  readonly isolatedWorktree: IsolatedWorktreePlanV1;
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
}

export type CheckpointOperationRequestV1 = PlaybackRequestV1 | BranchingCheckpointRequestV1;

export interface CheckpointOperationSemanticsV1 {
  readonly createsBranch: boolean;
  readonly producesNewEvidence: boolean;
  readonly modelExecution: 'none' | 'cached' | 'resampled' | 'live';
  readonly toolExecution: 'none' | 'cached' | 'live';
  readonly workspaceUse: 'read-only' | 'isolated-read-only' | 'isolated-writable';
  readonly sourceHistory: 'immutable';
}

interface CheckpointOperationPlanCoreV1 {
  readonly schemaVersion: typeof CHECKPOINT_OPERATION_SCHEMA_VERSION;
  readonly mode: CheckpointOperationModeV1;
  readonly parentCheckpointId: string;
  readonly parentBranchId: string;
  readonly inheritedExternalEffectFrontier: readonly CheckpointEffectFrontierEntryV1[];
  readonly semantics: CheckpointOperationSemanticsV1;
}

export interface PlaybackPlanV1 extends CheckpointOperationPlanCoreV1 {
  readonly mode: 'playback';
  readonly planId: string;
}

export interface BranchingCheckpointPlanV1 extends CheckpointOperationPlanCoreV1 {
  readonly mode: Exclude<CheckpointOperationModeV1, 'playback'>;
  readonly planId: string;
  readonly childBranchId: string;
  readonly intervention: CheckpointInterventionV1;
  readonly isolatedWorktree: IsolatedWorktreePlanV1;
  readonly externalEffectDecisions: readonly ExternalEffectReplayDecisionV1[];
}

export type CheckpointOperationPlanV1 = PlaybackPlanV1 | BranchingCheckpointPlanV1;

export type CheckpointOperationBlockerCodeV1 =
  | 'CHECKPOINT_COMPONENT_NOT_RECOVERABLE'
  | 'EXTERNAL_EFFECT_DECISION_REQUIRED'
  | 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED';

export interface CheckpointOperationBlockerV1 {
  readonly code: CheckpointOperationBlockerCodeV1;
  readonly checkpointId: string;
  readonly effectIds: readonly string[];
  readonly component?: CheckpointComponentNameV1;
  readonly detail: string;
}

export type CheckpointOperationPlanResultV1 =
  | { readonly ok: true; readonly plan: CheckpointOperationPlanV1 }
  | { readonly ok: false; readonly blocker: CheckpointOperationBlockerV1 };

export function planCheckpointOperation(
  request: CheckpointOperationRequestV1,
): CheckpointOperationPlanResultV1 {
  verifyCompositeCheckpoint(request.checkpoint);
  const common = {
    schemaVersion: CHECKPOINT_OPERATION_SCHEMA_VERSION,
    parentCheckpointId: request.checkpoint.checkpointId,
    parentBranchId: request.checkpoint.source.branchId,
    inheritedExternalEffectFrontier: request.checkpoint.externalEffectFrontier.map((effect) => ({
      ...effect,
      evidenceRefs: [...effect.evidenceRefs],
    })),
  } as const;

  if (request.mode === 'playback') {
    const core = {
      ...common,
      mode: 'playback' as const,
      semantics: semanticsFor('playback'),
    };
    return { ok: true, plan: { ...core, planId: operationPlanId(core) } };
  }

  const workspaceComponent = request.checkpoint.components.find(
    (candidate) => candidate.component === 'workspace',
  );
  if (workspaceComponent?.disposition !== 'recoverable') {
    return {
      ok: false,
      blocker: {
        code: 'CHECKPOINT_COMPONENT_NOT_RECOVERABLE',
        checkpointId: request.checkpoint.checkpointId,
        effectIds: [],
        component: 'workspace',
        detail: 'Branch-producing replay requires a recoverable workspace artifact.',
      },
    };
  }

  const uncertain = request.checkpoint.externalEffectFrontier
    .filter((effect) => unresolvedExternalStatuses.has(effect.status))
    .map((effect) => effect.effectId);
  if (uncertain.length > 0) {
    return {
      ok: false,
      blocker: {
        code: 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED',
        checkpointId: request.checkpoint.checkpointId,
        effectIds: uncertain,
        detail:
          'External Effect state is unresolved; reconcile the target and create a new Checkpoint before replay.',
      },
    };
  }

  const decisions = normalizeEffectDecisions(request.externalEffectDecisions);
  const confirmedEffectIds = request.checkpoint.externalEffectFrontier
    .filter((effect) => effect.status === 'confirmed')
    .map((effect) => effect.effectId);
  const decidedEffectIds = new Set(decisions.map((decision) => decision.effectId));
  const missingDecisions = confirmedEffectIds.filter((effectId) => !decidedEffectIds.has(effectId));
  if (missingDecisions.length > 0) {
    return {
      ok: false,
      blocker: {
        code: 'EXTERNAL_EFFECT_DECISION_REQUIRED',
        checkpointId: request.checkpoint.checkpointId,
        effectIds: missingDecisions,
        detail: 'Every confirmed external Effect must be explicitly inherited as no-repeat.',
      },
    };
  }
  const knownEffectIds = new Set(
    request.checkpoint.externalEffectFrontier.map((effect) => effect.effectId),
  );
  for (const decision of decisions) {
    if (!knownEffectIds.has(decision.effectId)) {
      throw new CompositeCheckpointValidationError(
        `External Effect decision references unknown Effect ${decision.effectId}`,
      );
    }
  }

  const intervention = normalizeIntervention(request.intervention);
  const isolatedWorktree = normalizeIsolatedWorktree(request.isolatedWorktree, request.checkpoint);
  const childBranchId = requireIdentifier(request.childBranchId, 'childBranchId');
  if (childBranchId === request.checkpoint.source.branchId) {
    throw new CompositeCheckpointValidationError(
      'A replay or Fork must create a child Branch distinct from its parent',
    );
  }
  const core = {
    ...common,
    mode: request.mode,
    childBranchId,
    intervention,
    isolatedWorktree,
    externalEffectDecisions: decisions,
    semantics: semanticsFor(request.mode),
  };
  return { ok: true, plan: { ...core, planId: operationPlanId(core) } };
}

const unresolvedExternalStatuses = new Set<EffectStatusV1>([
  'intended',
  'dispatch_started',
  'executed',
  'ambiguous',
  'conflict',
]);

function validateRelationships(input: CompositeCheckpointInputV1): void {
  for (const [path, value] of [
    ['mission.missionId', input.mission.missionId],
    ['mission.workspaceKey', input.mission.workspaceKey],
    ['branch.branchId', input.branch.branchId],
    ['attempt.attemptId', input.attempt.attemptId],
    ['contract.contractId', input.contract.contractId],
    ['profile.profileId', input.profile.profileId],
  ] as const) {
    requireIdentifier(value, path);
  }
  if (input.branch.missionId !== input.mission.missionId) {
    throw new CompositeCheckpointValidationError('Branch belongs to a different Mission');
  }
  if (
    input.attempt.missionId !== input.mission.missionId ||
    input.attempt.branchId !== input.branch.branchId
  ) {
    throw new CompositeCheckpointValidationError('Attempt does not belong to the source Branch');
  }
  if (input.attempt.profileId !== input.profile.profileId) {
    throw new CompositeCheckpointValidationError('Attempt does not bind the supplied Profile');
  }
  if (input.mission.contractId !== input.contract.contractId) {
    throw new CompositeCheckpointValidationError('Mission does not bind the supplied Contract');
  }
  if (input.workspace.workspaceKey !== input.mission.workspaceKey) {
    throw new CompositeCheckpointValidationError('Workspace evidence belongs to another workspace');
  }
  if (input.nativeSession.harness !== input.profile.harness) {
    throw new CompositeCheckpointValidationError(
      'Native session evidence belongs to another Harness',
    );
  }
  if (!Number.isSafeInteger(input.eventPrefix.throughSeq) || input.eventPrefix.throughSeq <= 0) {
    throw new CompositeCheckpointValidationError(
      'eventPrefix.throughSeq must be a positive safe integer',
    );
  }
  if (input.process.status !== 'stopped') {
    throw new CompositeCheckpointValidationError(
      'A Composite Checkpoint requires evidence that the Runtime process stopped',
    );
  }
  if (
    input.profile.permissionMode !== undefined &&
    input.profile.permissionMode !== input.permissions.permissionMode
  ) {
    throw new CompositeCheckpointValidationError(
      'Permission evidence disagrees with the effective Profile permission mode',
    );
  }
  const effectIds = new Set<string>();
  for (const effect of input.effects) {
    requireIdentifier(effect.effectId, 'effect.effectId');
    if (effect.missionId !== input.mission.missionId) {
      throw new CompositeCheckpointValidationError(
        `Effect ${effect.effectId} belongs to another Mission`,
      );
    }
    if (effectIds.has(effect.effectId)) {
      throw new CompositeCheckpointValidationError(`Duplicate Effect ${effect.effectId}`);
    }
    effectIds.add(effect.effectId);
  }
}

function normalizeWorkspace(input: CheckpointWorkspaceEvidenceV1): CheckpointWorkspaceV1 {
  requireIdentifier(input.workspaceKey, 'workspace.workspaceKey');
  if (input.kind === 'git-digest') {
    requireNonEmpty(input.snapshot.workspaceDigest, 'workspace.snapshot.workspaceDigest');
    requireNonEmpty(input.snapshot.statusDigest, 'workspace.snapshot.statusDigest');
    return {
      workspaceKey: input.workspaceKey,
      state: 'digest-only',
      workspaceDigest: input.snapshot.workspaceDigest,
      statusDigest: input.snapshot.statusDigest,
      head: input.snapshot.head,
    };
  }
  if (input.kind === 'restorable-artifact') {
    return {
      workspaceKey: input.workspaceKey,
      state: 'restorable-artifact',
      workspaceDigest: requireNonEmpty(input.workspaceDigest, 'workspace.workspaceDigest'),
      artifactRef: requireNonEmpty(input.artifactRef, 'workspace.artifactRef'),
      artifactDigest: requireNonEmpty(input.artifactDigest, 'workspace.artifactDigest'),
    };
  }
  return {
    workspaceKey: input.workspaceKey,
    state: 'unavailable',
    workspaceDigest: null,
    reason: requireNonEmpty(input.reason, 'workspace.reason'),
  };
}

function workspaceComponent(
  source: CheckpointWorkspaceEvidenceV1,
  workspace: CheckpointWorkspaceV1,
): CheckpointComponentV1 {
  const evidenceRefs = normalizeRefs(source.evidenceRefs, 'workspace.evidenceRefs');
  if (source.kind === 'git-digest') {
    return component(
      'workspace',
      'inspect-only',
      digest(workspace),
      evidenceRefs,
      'Git status and content digests do not contain restorable workspace bytes.',
    );
  }
  if (source.kind === 'restorable-artifact') {
    return component('workspace', 'recoverable', digest(workspace), evidenceRefs);
  }
  return component('workspace', 'unavailable', digest(workspace), evidenceRefs, workspace.reason);
}

function normalizeProcess(input: CheckpointStoppedProcessEvidenceV1): CheckpointProcessV1 {
  return {
    status: 'stopped',
    stoppedAt: requireIsoTimestamp(input.stoppedAt, 'process.stoppedAt'),
    ...(input.processRef === undefined
      ? {}
      : { processRef: requireNonEmpty(input.processRef, 'process.processRef') }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  };
}

function normalizeNativeSession(
  input: CheckpointNativeSessionEvidenceV1,
): CheckpointNativeSessionV1 {
  const harness = requireNonEmpty(input.harness, 'nativeSession.harness');
  if (input.status === 'available') {
    return {
      status: 'available',
      harness,
      sessionRef: requireNonEmpty(input.sessionRef, 'nativeSession.sessionRef'),
      resumeSupported: input.resumeSupported,
    };
  }
  return {
    status: 'unavailable',
    harness,
    reason: requireNonEmpty(input.reason, 'nativeSession.reason'),
  };
}

function nativeSessionComponent(
  source: CheckpointNativeSessionEvidenceV1,
  session: CheckpointNativeSessionV1,
): CheckpointComponentV1 {
  const evidenceRefs = normalizeRefs(source.evidenceRefs, 'nativeSession.evidenceRefs');
  if (session.status === 'unavailable') {
    return component(
      'native-session',
      'unavailable',
      digest(session),
      evidenceRefs,
      session.reason,
    );
  }
  return component(
    'native-session',
    session.resumeSupported ? 'recoverable' : 'inspect-only',
    digest(session),
    evidenceRefs,
    ...(session.resumeSupported
      ? []
      : ['The Runtime exposes a session reference but not a resumable native session.']),
  );
}

function normalizeVisibleContext(input: CheckpointVisibleContextEvidenceV1): {
  readonly component: CheckpointComponentV1;
} {
  if (input.status === 'captured') {
    const value = {
      status: 'captured' as const,
      contextDigest: requireNonEmpty(input.contextDigest, 'visibleContext.contextDigest'),
      artifactRefs: normalizeRefs(input.artifactRefs, 'visibleContext.artifactRefs'),
    };
    return {
      component: component(
        'visible-context',
        'portable',
        digest(value),
        normalizeRefs(
          [...value.artifactRefs, ...input.evidenceRefs],
          'visibleContext.evidenceRefs',
        ),
      ),
    };
  }
  const reason = requireNonEmpty(input.reason, 'visibleContext.reason');
  return {
    component: component(
      'visible-context',
      'unavailable',
      digest({ status: 'unavailable', reason }),
      normalizeRefs(input.evidenceRefs, 'visibleContext.evidenceRefs'),
      reason,
    ),
  };
}

function normalizePermissions(input: CheckpointPermissionEvidenceV1): {
  readonly value: { readonly permissionMode: string; readonly authorityRef?: string };
  readonly evidenceRefs: readonly string[];
} {
  return {
    value: {
      permissionMode: requireNonEmpty(input.permissionMode, 'permissions.permissionMode'),
      ...(input.authorityRef === undefined
        ? {}
        : { authorityRef: requireNonEmpty(input.authorityRef, 'permissions.authorityRef') }),
    },
    evidenceRefs: normalizeRefs(input.evidenceRefs, 'permissions.evidenceRefs'),
  };
}

function normalizeEffects(effects: readonly EffectV1[]): EffectV1[] {
  return effects
    .map((effect) => ({
      ...effect,
      evidenceRefs: normalizeRefs(effect.evidenceRefs, `Effect ${effect.effectId} evidenceRefs`),
    }))
    .sort((left, right) => compare(left.effectId, right.effectId));
}

function normalizeIntervention(input: CheckpointInterventionV1): CheckpointInterventionV1 {
  if (!interventionKinds.has(input.kind)) {
    throw new CompositeCheckpointValidationError(`Unsupported Intervention kind ${input.kind}`);
  }
  const beforeDigest =
    input.beforeDigest === undefined
      ? undefined
      : requireNonEmpty(input.beforeDigest, 'intervention.beforeDigest');
  const afterDigest = requireNonEmpty(input.afterDigest, 'intervention.afterDigest');
  if (beforeDigest !== undefined && beforeDigest === afterDigest) {
    throw new CompositeCheckpointValidationError(
      'Intervention beforeDigest and afterDigest must describe a real change',
    );
  }
  if (input.authorityChange !== 'unchanged' && input.authorityChange !== 'narrowed') {
    throw new CompositeCheckpointValidationError(
      'Intervention may keep or narrow authority but cannot expand it implicitly',
    );
  }
  return {
    interventionId: requireIdentifier(input.interventionId, 'intervention.interventionId'),
    kind: input.kind,
    targetRef: requireNonEmpty(input.targetRef, 'intervention.targetRef'),
    ...(beforeDigest === undefined ? {} : { beforeDigest }),
    afterDigest,
    description: requireNonEmpty(input.description, 'intervention.description'),
    authorityChange: input.authorityChange,
  };
}

function normalizeIsolatedWorktree(
  input: IsolatedWorktreePlanV1,
  checkpoint: CompositeCheckpointManifestV1,
): IsolatedWorktreePlanV1 {
  if (!isAbsolute(input.absolutePath)) {
    throw new CompositeCheckpointValidationError('isolatedWorktree.absolutePath must be absolute');
  }
  if (input.workspaceKey === checkpoint.source.workspaceKey) {
    throw new CompositeCheckpointValidationError(
      'Child Branch must use an isolated workspace identity',
    );
  }
  if (input.baselineWorkspaceDigest !== checkpoint.workspace.workspaceDigest) {
    throw new CompositeCheckpointValidationError(
      'Isolated worktree baseline does not match the parent Checkpoint workspace',
    );
  }
  return {
    worktreeId: requireIdentifier(input.worktreeId, 'isolatedWorktree.worktreeId'),
    workspaceKey: requireIdentifier(input.workspaceKey, 'isolatedWorktree.workspaceKey'),
    absolutePath: input.absolutePath,
    isolationMechanism: input.isolationMechanism,
    baselineWorkspaceDigest: requireNonEmpty(
      input.baselineWorkspaceDigest,
      'isolatedWorktree.baselineWorkspaceDigest',
    ),
    evidenceRefs: normalizeRefs(input.evidenceRefs, 'isolatedWorktree.evidenceRefs'),
  };
}

function normalizeEffectDecisions(
  decisions: readonly ExternalEffectReplayDecisionV1[],
): ExternalEffectReplayDecisionV1[] {
  const normalized = decisions
    .map((decision) => {
      if (decision.action !== 'inherit-no-repeat') {
        throw new CompositeCheckpointValidationError(
          `Unsupported external Effect replay action ${decision.action}`,
        );
      }
      return {
        effectId: requireIdentifier(decision.effectId, 'externalEffectDecision.effectId'),
        action: decision.action,
      };
    })
    .sort((left, right) => compare(left.effectId, right.effectId));
  if (new Set(normalized.map((decision) => decision.effectId)).size !== normalized.length) {
    throw new CompositeCheckpointValidationError('External Effect decisions must be unique');
  }
  return normalized;
}

const interventionKinds = new Set<CheckpointInterventionKindV1>([
  'context',
  'tool-result',
  'permission-narrowing',
  'profile',
  'workspace',
  'guidance',
]);

function semanticsFor(mode: CheckpointOperationModeV1): CheckpointOperationSemanticsV1 {
  switch (mode) {
    case 'playback':
      return {
        createsBranch: false,
        producesNewEvidence: false,
        modelExecution: 'none',
        toolExecution: 'none',
        workspaceUse: 'read-only',
        sourceHistory: 'immutable',
      };
    case 'cached-replay':
      return {
        createsBranch: true,
        producesNewEvidence: true,
        modelExecution: 'cached',
        toolExecution: 'cached',
        workspaceUse: 'isolated-read-only',
        sourceHistory: 'immutable',
      };
    case 'counterfactual-resample':
      return {
        createsBranch: true,
        producesNewEvidence: true,
        modelExecution: 'resampled',
        toolExecution: 'cached',
        workspaceUse: 'isolated-read-only',
        sourceHistory: 'immutable',
      };
    case 'execution-fork':
      return {
        createsBranch: true,
        producesNewEvidence: true,
        modelExecution: 'live',
        toolExecution: 'live',
        workspaceUse: 'isolated-writable',
        sourceHistory: 'immutable',
      };
  }
}

function component(
  name: CheckpointComponentNameV1,
  disposition: CheckpointComponentDispositionV1,
  contentDigest: string,
  evidenceRefs: readonly string[],
  reason?: string,
): CheckpointComponentV1 {
  return {
    component: name,
    disposition,
    contentDigest,
    evidenceRefs: normalizeRefs(evidenceRefs, `${name}.evidenceRefs`, true),
    ...(reason === undefined ? {} : { reason }),
  };
}

function operationPlanId(core: object): string {
  return `checkpoint-plan-${digest(core).slice('sha256:'.length)}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableCanonicalJson(value)).digest('hex')}`;
}

function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, candidate]) => candidate !== undefined)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, candidate]) => [key, canonicalize(candidate)]),
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new CompositeCheckpointValidationError(
    `Checkpoint content contains unsupported ${typeof value}`,
  );
}

function normalizeRefs(values: readonly string[], path: string, allowEmpty = false): string[] {
  const normalized = [...new Set(values.map((value) => requireNonEmpty(value, path)))].sort(
    compare,
  );
  if (!allowEmpty && normalized.length === 0) {
    throw new CompositeCheckpointValidationError(`${path} must contain evidence`);
  }
  return normalized;
}

function requireIdentifier(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new CompositeCheckpointValidationError(`${path} contains unsupported characters`);
  }
  return value;
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new CompositeCheckpointValidationError(`${path} must be non-empty`);
  }
  return value;
}

function requireIsoTimestamp(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new CompositeCheckpointValidationError(`${path} must be an ISO timestamp`);
  }
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
