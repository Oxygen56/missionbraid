import { createHash } from 'node:crypto';

import { sanitizeNativeArtifact } from './artifact-store.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type AttemptBindingV1,
  type EventV1,
  type JsonValue,
} from './domain.js';
import {
  EXECUTION_FORK_SCHEMA_VERSION,
  executionForkWorkspaceEffectId,
  type ExecutionForkEventTypeV1,
  type ExecutionForkEventV1,
  type ExecutionForkLineageV1,
  type ExecutionForkReceiptInputV1,
  type RuntimeContinuationResultV1,
} from './execution-fork.js';

const BRIDGE_SCHEMA_VERSION = 1 as const;
const OBSERVATION_KIND = 'execution-fork.transition';

type KernelRole =
  | 'observation'
  | 'branch-created'
  | 'effect-recorded'
  | 'effect-dispatch-started'
  | 'attempt-bound'
  | 'attempt-started'
  | 'attempt-finished'
  | 'effect-runtime-finished'
  | 'effect-confirmed';

export interface MissionExecutionForkContextV1 {
  readonly missionId: string;
  readonly childAttemptId: string;
  readonly binding: AttemptBindingV1;
  /** Exact source-event time; retries must reuse it. */
  readonly occurredAt: string;
}

interface ForkLineageIdentityV1 {
  readonly missionId: string;
  readonly contractId: string;
  readonly profileId: string;
  readonly parentAttemptId: string;
  readonly parentBranchId: string;
  readonly childBranchId: string;
  readonly parentCheckpointId: string;
  readonly childWorkspaceKey: string;
}

interface SanitizedPayloadEvidenceV1 {
  readonly sourceDigest: string;
  readonly sanitizedDigest: string;
  readonly sanitizedJson: string;
  readonly redactionCount: number;
}

interface RuntimeResultIdentityV1 {
  readonly runtimeRunId: string;
  readonly status: RuntimeContinuationResultV1['status'];
}

interface ReceiptInputIdentityV1 {
  readonly receiptInputId: string;
  readonly workspaceEffectId: string;
}

interface ExecutionForkBridgeObservationV1 {
  readonly schemaVersion: typeof BRIDGE_SCHEMA_VERSION;
  readonly bridge: 'mission-execution-fork';
  readonly forkId: string;
  readonly missionId: string;
  readonly transition: ExecutionForkEventTypeV1;
  readonly sourceEventId: string;
  readonly sourceEventHash: string;
  readonly sourceSequence: number;
  readonly sourcePreviousHash: string | null;
  readonly sourceOccurredAt: string;
  readonly bindingDigest: string;
  readonly childAttemptId: string;
  readonly effectId: string;
  readonly evidenceRefs: readonly string[];
  readonly payloadEvidence: SanitizedPayloadEvidenceV1;
  readonly lineage?: ForkLineageIdentityV1;
  readonly runtimeResult?: RuntimeResultIdentityV1;
  readonly receiptInput?: ReceiptInputIdentityV1;
  readonly observationDigest: string;
}

export interface MissionExecutionForkBridgeStateV1 {
  readonly forkId: string;
  readonly lastSequence: number;
  readonly lastEventHash: string;
  readonly lastTransition: ExecutionForkEventTypeV1;
  readonly bindingDigest: string;
  readonly childAttemptId: string;
  readonly effectId: string;
  readonly lineage: ForkLineageIdentityV1;
  readonly runtimeResult?: RuntimeResultIdentityV1;
  readonly receiptInput?: ReceiptInputIdentityV1;
}

export class MissionExecutionForkBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionExecutionForkBridgeError';
  }
}

/**
 * Convert one durable ExecutionFork journal event into one atomic Mission
 * Kernel append batch. The caller must pass the current Kernel history so
 * source ordering and immutable lineage can fail closed after restart.
 */
export function executionForkEventToMissionEvents(
  sourceEvent: ExecutionForkEventV1,
  context: MissionExecutionForkContextV1,
  priorMissionEvents: readonly EventV1[],
): readonly EventV1[] {
  validateContext(context);
  validateSourceEvent(sourceEvent);
  if (context.occurredAt !== sourceEvent.occurredAt) {
    throw new MissionExecutionForkBridgeError(
      'Bridge occurredAt must equal the durable ExecutionFork event time',
    );
  }

  const bindingDigest = digest({
    missionId: context.missionId,
    childAttemptId: context.childAttemptId,
    binding: context.binding,
  });
  const priorState = rebuildExecutionForkBridgeStateFromMissionEvents(
    priorMissionEvents,
    sourceEvent.forkId,
  );
  const existingObservation = bridgeObservations(priorMissionEvents).find(
    (observation) =>
      observation.forkId === sourceEvent.forkId &&
      observation.sourceSequence === sourceEvent.sequence,
  );
  if (existingObservation !== undefined) {
    if (
      existingObservation.sourceEventId !== sourceEvent.eventId ||
      existingObservation.sourceEventHash !== sourceEvent.eventHash ||
      existingObservation.bindingDigest !== bindingDigest
    ) {
      throw new MissionExecutionForkBridgeError(
        `Execution Fork ${sourceEvent.forkId} sequence ${sourceEvent.sequence} conflicts with Kernel history`,
      );
    }
  } else {
    validateNextTransition(sourceEvent, priorState, bindingDigest);
  }

  const lineage =
    sourceEvent.type === 'fork.planned'
      ? validatePlanned(sourceEvent, context)
      : requirePriorLineage(sourceEvent, context, priorState);
  const effectId = executionForkWorkspaceEffectId(sourceEvent.forkId, lineage.childWorkspaceKey);
  const normalized = normalizeSourceEvent(sourceEvent, effectId, lineage);
  const observationCore = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    bridge: 'mission-execution-fork' as const,
    forkId: sourceEvent.forkId,
    missionId: context.missionId,
    transition: sourceEvent.type,
    sourceEventId: sourceEvent.eventId,
    sourceEventHash: sourceEvent.eventHash,
    sourceSequence: sourceEvent.sequence,
    sourcePreviousHash: sourceEvent.previousHash,
    sourceOccurredAt: sourceEvent.occurredAt,
    bindingDigest,
    childAttemptId: context.childAttemptId,
    effectId,
    evidenceRefs: normalized.evidenceRefs,
    payloadEvidence: sanitizePayload(sourceEvent.payload),
    ...(sourceEvent.type === 'fork.planned' ? { lineage } : {}),
    ...(normalized.runtimeResult === undefined ? {} : { runtimeResult: normalized.runtimeResult }),
    ...(normalized.receiptInput === undefined ? {} : { receiptInput: normalized.receiptInput }),
  };
  const observationData: ExecutionForkBridgeObservationV1 = {
    ...observationCore,
    observationDigest: digest(observationCore),
  };
  const observationEventId = kernelEventId(sourceEvent, bindingDigest, 'observation');
  const observation: EventV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: observationEventId,
    missionId: context.missionId,
    attemptId: context.childAttemptId,
    occurredAt: context.occurredAt,
    type: 'runtime.observation',
    payload: {
      kind: OBSERVATION_KIND,
      data: observationData as unknown as JsonValue,
    },
  };
  const observationEvidence = `event:${observationEventId}`;

  switch (sourceEvent.type) {
    case 'fork.planned':
      return [
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: kernelEventId(sourceEvent, bindingDigest, 'branch-created'),
          missionId: context.missionId,
          occurredAt: context.occurredAt,
          type: 'branch.created',
          payload: {
            branch: {
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              branchId: lineage.childBranchId,
              missionId: context.missionId,
              parentBranchId: lineage.parentBranchId,
              baseCheckpointId: lineage.parentCheckpointId,
              status: 'active',
              createdAt: context.occurredAt,
            },
          },
        },
        observation,
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: kernelEventId(sourceEvent, bindingDigest, 'effect-recorded'),
          missionId: context.missionId,
          attemptId: context.childAttemptId,
          occurredAt: context.occurredAt,
          type: 'effect.recorded',
          payload: {
            effect: {
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              effectId,
              missionId: context.missionId,
              attemptId: context.childAttemptId,
              kind: 'workspace.execution-fork',
              resourceKey: lineage.childWorkspaceKey,
              controlLevel: 'enforced',
              scope: 'branch_local_workspace',
              status: 'intended',
              evidenceRefs: [observationEvidence],
              createdAt: context.occurredAt,
            },
          },
        },
      ];
    case 'worktree.create-started':
      return [
        observation,
        effectStatusEvent(
          sourceEvent,
          context,
          bindingDigest,
          effectId,
          'effect-dispatch-started',
          'dispatch_started',
          [observationEvidence],
        ),
      ];
    case 'runtime.started':
      return [
        observation,
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: kernelEventId(sourceEvent, bindingDigest, 'attempt-bound'),
          missionId: context.missionId,
          attemptId: context.childAttemptId,
          occurredAt: context.occurredAt,
          type: 'attempt.bound',
          payload: { binding: context.binding },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: kernelEventId(sourceEvent, bindingDigest, 'attempt-started'),
          missionId: context.missionId,
          attemptId: context.childAttemptId,
          occurredAt: context.occurredAt,
          type: 'attempt.started',
          payload: {
            attempt: {
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              attemptId: context.childAttemptId,
              missionId: context.missionId,
              branchId: context.binding.branchId,
              profileId: context.binding.profileId,
              stageId: context.binding.planNodeId,
              status: 'running',
              startedAt: context.occurredAt,
              continuedFromAttemptId: lineage.parentAttemptId,
            },
          },
        },
      ];
    case 'runtime.finished': {
      const result = normalized.runtimeResult!;
      const completed = result.status === 'completed';
      const evidenceRefs = normalizeEvidenceRefs([observationEvidence, ...normalized.evidenceRefs]);
      return [
        observation,
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: kernelEventId(sourceEvent, bindingDigest, 'attempt-finished'),
          missionId: context.missionId,
          attemptId: context.childAttemptId,
          occurredAt: context.occurredAt,
          type: 'attempt.finished',
          payload: {
            attemptId: context.childAttemptId,
            status: completed ? 'succeeded' : 'failed',
            endedAt: context.occurredAt,
            summary: completed
              ? 'Execution Fork Runtime completed with persisted evidence.'
              : 'Execution Fork Runtime failed; no success was inferred.',
          },
        },
        effectStatusEvent(
          sourceEvent,
          context,
          bindingDigest,
          effectId,
          'effect-runtime-finished',
          completed ? 'executed' : 'failed',
          evidenceRefs,
        ),
      ];
    }
    case 'receipt-input.ready':
      validateReceiptInputReady(sourceEvent, normalized.receiptInputPayload!, lineage, priorState!);
      return [
        observation,
        effectStatusEvent(
          sourceEvent,
          context,
          bindingDigest,
          effectId,
          'effect-confirmed',
          'confirmed',
          normalizeEvidenceRefs([observationEvidence, ...normalized.evidenceRefs]),
        ),
      ];
    case 'worktree.created':
    case 'runtime.evidence':
    case 'fork.failed':
    case 'worktree.cleaned':
      return [observation];
  }
}

/** Rebuild bridge state only when every required Kernel companion is present. */
export function rebuildExecutionForkBridgeStateFromMissionEvents(
  events: readonly EventV1[],
  forkId: string,
): MissionExecutionForkBridgeStateV1 | undefined {
  requireIdentifier('forkId', forkId);
  const observations = bridgeObservations(events)
    .filter((observation) => observation.forkId === forkId)
    .sort((left, right) => left.sourceSequence - right.sourceSequence);
  if (observations.length === 0) return undefined;

  let prior: ExecutionForkBridgeObservationV1 | undefined;
  let lineage: ForkLineageIdentityV1 | undefined;
  let runtimeResult: RuntimeResultIdentityV1 | undefined;
  let receiptInput: ReceiptInputIdentityV1 | undefined;
  for (const observation of observations) {
    if (prior === undefined) {
      if (
        observation.sourceSequence !== 1 ||
        observation.sourcePreviousHash !== null ||
        observation.transition !== 'fork.planned'
      ) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${forkId} Kernel history does not start at fork.planned`,
        );
      }
      lineage = observation.lineage;
      if (lineage === undefined) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${forkId} planned observation lacks lineage`,
        );
      }
      if (
        observation.missionId !== lineage.missionId ||
        observation.effectId !== executionForkWorkspaceEffectId(forkId, lineage.childWorkspaceKey)
      ) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${forkId} planned observation identities conflict`,
        );
      }
    } else {
      if (
        observation.sourceSequence !== prior.sourceSequence + 1 ||
        observation.sourcePreviousHash !== prior.sourceEventHash ||
        observation.missionId !== prior.missionId ||
        observation.bindingDigest !== prior.bindingDigest ||
        observation.childAttemptId !== prior.childAttemptId ||
        observation.effectId !== prior.effectId
      ) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${forkId} Kernel bridge sequence or identity conflicts`,
        );
      }
      assertAllowedTransition(observation.transition, prior.transition);
    }
    assertKernelCompanions(events, observation, lineage!);
    if (observation.runtimeResult !== undefined) runtimeResult = observation.runtimeResult;
    if (observation.receiptInput !== undefined) {
      if (observation.receiptInput.workspaceEffectId !== observation.effectId) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${forkId} Receipt input changed its predeclared Effect identity`,
        );
      }
      receiptInput = observation.receiptInput;
    }
    prior = observation;
  }

  return {
    forkId,
    lastSequence: prior!.sourceSequence,
    lastEventHash: prior!.sourceEventHash,
    lastTransition: prior!.transition,
    bindingDigest: prior!.bindingDigest,
    childAttemptId: prior!.childAttemptId,
    effectId: prior!.effectId,
    lineage: lineage!,
    ...(runtimeResult === undefined ? {} : { runtimeResult }),
    ...(receiptInput === undefined ? {} : { receiptInput }),
  };
}

function normalizeSourceEvent(
  event: ExecutionForkEventV1,
  effectId: string,
  lineage: ForkLineageIdentityV1,
): {
  readonly evidenceRefs: readonly string[];
  readonly runtimeResult?: RuntimeResultIdentityV1;
  readonly receiptInput?: ReceiptInputIdentityV1;
  readonly receiptInputPayload?: ExecutionForkReceiptInputV1;
} {
  switch (event.type) {
    case 'runtime.evidence': {
      const payload = event.payload as {
        readonly evidence?: {
          readonly evidenceId?: unknown;
          readonly evidenceRefs?: unknown;
        };
      };
      requireIdentifier('runtime.evidence.evidenceId', String(payload.evidence?.evidenceId ?? ''));
      return {
        evidenceRefs: normalizeEvidenceRefs(
          requireStringArray('runtime.evidence.evidenceRefs', payload.evidence?.evidenceRefs),
        ),
      };
    }
    case 'runtime.finished': {
      const payload = event.payload as { readonly result?: RuntimeContinuationResultV1 };
      const result = payload.result;
      if (result === undefined) {
        throw new MissionExecutionForkBridgeError('runtime.finished lacks a Runtime result');
      }
      requireIdentifier('runtimeRunId', result.runtimeRunId);
      if (result.status !== 'completed' && result.status !== 'failed') {
        throw new MissionExecutionForkBridgeError('runtime.finished has an invalid status');
      }
      return {
        runtimeResult: { runtimeRunId: result.runtimeRunId, status: result.status },
        evidenceRefs: normalizeEvidenceRefs([
          ...requireStringArray('toolExecutionEvidenceRefs', result.toolExecutionEvidenceRefs),
          ...requireStringArray('verificationEvidenceRefs', result.verificationEvidenceRefs),
        ]),
      };
    }
    case 'receipt-input.ready': {
      const payload = event.payload as { readonly receiptInput?: ExecutionForkReceiptInputV1 };
      const input = payload.receiptInput;
      if (input === undefined) {
        throw new MissionExecutionForkBridgeError('receipt-input.ready lacks receipt input');
      }
      requireIdentifier('receiptInputId', input.receiptInputId);
      const refs = normalizeEvidenceRefs([
        ...requireStringArray('futureEvidenceRefs', input.futureEvidenceRefs),
        ...requireStringArray('toolExecutionEvidenceRefs', input.toolExecutionEvidenceRefs),
        ...requireStringArray('verificationEvidenceRefs', input.verificationEvidenceRefs),
        ...requireStringArray(
          'workspaceEffectInput.evidenceRefs',
          input.workspaceEffectInput.evidenceRefs,
        ),
      ]);
      return {
        evidenceRefs: refs,
        receiptInput: {
          receiptInputId: input.receiptInputId,
          workspaceEffectId: input.workspaceEffectInput.effectId,
        },
        receiptInputPayload: input,
      };
    }
    case 'fork.planned':
      return { evidenceRefs: [`checkpoint:${lineage.parentCheckpointId}`] };
    default:
      return { evidenceRefs: [] };
  }
}

function validatePlanned(
  event: ExecutionForkEventV1,
  context: MissionExecutionForkContextV1,
): ForkLineageIdentityV1 {
  const payload = event.payload as {
    readonly lineage?: ExecutionForkLineageV1;
    readonly plan?: {
      readonly mode?: unknown;
      readonly parentCheckpointId?: unknown;
      readonly parentBranchId?: unknown;
      readonly childBranchId?: unknown;
      readonly isolatedWorktree?: { readonly workspaceKey?: unknown };
      readonly intervention?: unknown;
    };
  };
  const source = payload.lineage;
  const plan = payload.plan;
  if (source === undefined || plan === undefined) {
    throw new MissionExecutionForkBridgeError('fork.planned lacks lineage or plan');
  }
  const lineage: ForkLineageIdentityV1 = {
    missionId: requireIdentifier('lineage.missionId', source.missionId),
    contractId: requireIdentifier('lineage.contractId', source.contractId),
    profileId: requireIdentifier('lineage.profileId', source.profileId),
    parentAttemptId: requireIdentifier('lineage.parentAttemptId', source.parentAttemptId),
    parentBranchId: requireIdentifier('lineage.parentBranchId', source.parentBranchId),
    childBranchId: requireIdentifier('lineage.childBranchId', source.childBranchId),
    parentCheckpointId: requireIdentifier('lineage.parentCheckpointId', source.parentCheckpointId),
    childWorkspaceKey: requireIdentifier('lineage.childWorkspaceKey', source.childWorkspaceKey),
  };
  if (
    source.schemaVersion !== EXECUTION_FORK_SCHEMA_VERSION ||
    source.forkId !== event.forkId ||
    lineage.parentBranchId === lineage.childBranchId ||
    plan.mode !== 'execution-fork' ||
    plan.parentCheckpointId !== lineage.parentCheckpointId ||
    plan.parentBranchId !== lineage.parentBranchId ||
    plan.childBranchId !== lineage.childBranchId ||
    plan.isolatedWorktree?.workspaceKey !== lineage.childWorkspaceKey ||
    stableJson(plan.intervention) !== stableJson(source.intervention)
  ) {
    throw new MissionExecutionForkBridgeError('fork.planned lineage and plan disagree');
  }
  validateContextAgainstLineage(context, lineage);
  return lineage;
}

function requirePriorLineage(
  event: ExecutionForkEventV1,
  context: MissionExecutionForkContextV1,
  state: MissionExecutionForkBridgeStateV1 | undefined,
): ForkLineageIdentityV1 {
  if (state === undefined) {
    throw new MissionExecutionForkBridgeError(
      `${event.type} cannot be bridged before fork.planned is authoritative`,
    );
  }
  validateContextAgainstLineage(context, state.lineage);
  return state.lineage;
}

function validateContextAgainstLineage(
  context: MissionExecutionForkContextV1,
  lineage: ForkLineageIdentityV1,
): void {
  const binding = context.binding;
  if (
    context.missionId !== lineage.missionId ||
    binding.missionId !== lineage.missionId ||
    binding.attemptId !== context.childAttemptId ||
    binding.branchId !== lineage.childBranchId ||
    binding.contractId !== lineage.contractId ||
    binding.profileId !== lineage.profileId ||
    binding.workspaceKey !== lineage.childWorkspaceKey
  ) {
    throw new MissionExecutionForkBridgeError(
      'Execution Fork context conflicts with immutable child lineage',
    );
  }
}

function validateReceiptInputReady(
  event: ExecutionForkEventV1,
  input: ExecutionForkReceiptInputV1,
  lineage: ForkLineageIdentityV1,
  state: MissionExecutionForkBridgeStateV1,
): void {
  const expectedEffectId = executionForkWorkspaceEffectId(event.forkId, lineage.childWorkspaceKey);
  const effect = input.workspaceEffectInput;
  if (
    state.runtimeResult === undefined ||
    state.runtimeResult.status !== 'completed' ||
    input.runtimeStatus !== 'completed' ||
    input.runtimeRunId !== state.runtimeResult.runtimeRunId ||
    input.forkId !== event.forkId ||
    input.missionId !== lineage.missionId ||
    input.contractId !== lineage.contractId ||
    input.parentBranchId !== lineage.parentBranchId ||
    input.childBranchId !== lineage.childBranchId ||
    input.parentCheckpointId !== lineage.parentCheckpointId ||
    input.authority !== 'receipt-input-not-kernel-state' ||
    effect.effectId !== expectedEffectId ||
    effect.kind !== 'workspace.execution-fork' ||
    effect.resourceKey !== lineage.childWorkspaceKey ||
    effect.scope !== 'branch_local_workspace' ||
    effect.controlLevel !== 'enforced' ||
    effect.status !== 'executed'
  ) {
    throw new MissionExecutionForkBridgeError(
      'receipt-input.ready conflicts with the predeclared workspace Effect or Fork lineage',
    );
  }
}

function validateNextTransition(
  event: ExecutionForkEventV1,
  prior: MissionExecutionForkBridgeStateV1 | undefined,
  bindingDigest: string,
): void {
  if (prior === undefined) {
    if (event.sequence !== 1 || event.previousHash !== null || event.type !== 'fork.planned') {
      throw new MissionExecutionForkBridgeError('The first bridged event must be fork.planned');
    }
    return;
  }
  if (
    event.sequence !== prior.lastSequence + 1 ||
    event.previousHash !== prior.lastEventHash ||
    bindingDigest !== prior.bindingDigest
  ) {
    throw new MissionExecutionForkBridgeError(
      `Execution Fork ${event.forkId} source chain or binding changed`,
    );
  }
  assertAllowedTransition(event.type, prior.lastTransition);
}

function assertAllowedTransition(
  current: ExecutionForkEventTypeV1,
  previous: ExecutionForkEventTypeV1,
): void {
  const allowed =
    current === 'worktree.create-started'
      ? previous === 'fork.planned'
      : current === 'worktree.created'
        ? previous === 'worktree.create-started'
        : current === 'runtime.started'
          ? previous === 'worktree.created'
          : current === 'runtime.evidence'
            ? previous === 'runtime.started' || previous === 'runtime.evidence'
            : current === 'runtime.finished'
              ? previous === 'runtime.started' || previous === 'runtime.evidence'
              : current === 'receipt-input.ready'
                ? previous === 'runtime.finished'
                : current === 'fork.failed'
                  ? !['receipt-input.ready', 'fork.failed', 'worktree.cleaned'].includes(previous)
                  : current === 'worktree.cleaned'
                    ? previous === 'receipt-input.ready' || previous === 'fork.failed'
                    : false;
  if (!allowed) {
    throw new MissionExecutionForkBridgeError(
      `Execution Fork transition ${previous} -> ${current} is invalid`,
    );
  }
}

function assertKernelCompanions(
  events: readonly EventV1[],
  observation: ExecutionForkBridgeObservationV1,
  lineage: ForkLineageIdentityV1,
): void {
  const source = sourceIdentityFromObservation(observation);
  const find = (role: KernelRole): EventV1 | undefined =>
    events.find(
      (event) => event.eventId === kernelEventId(source, observation.bindingDigest, role),
    );
  const requireType = <Type extends EventV1['type']>(role: KernelRole, type: Type): EventV1 => {
    const event = find(role);
    if (event?.type !== type) {
      throw new MissionExecutionForkBridgeError(
        `Execution Fork ${observation.forkId} ${observation.transition} lacks Kernel ${type}`,
      );
    }
    return event;
  };

  requireType('observation', 'runtime.observation');
  switch (observation.transition) {
    case 'fork.planned': {
      const branch = requireType('branch-created', 'branch.created');
      const effect = requireType('effect-recorded', 'effect.recorded');
      if (
        branch.type !== 'branch.created' ||
        branch.payload.branch.branchId !== lineage.childBranchId ||
        branch.payload.branch.parentBranchId !== lineage.parentBranchId ||
        branch.payload.branch.baseCheckpointId !== lineage.parentCheckpointId ||
        effect.type !== 'effect.recorded' ||
        effect.payload.effect.effectId !== observation.effectId ||
        effect.payload.effect.attemptId !== observation.childAttemptId ||
        effect.payload.effect.kind !== 'workspace.execution-fork' ||
        effect.payload.effect.resourceKey !== lineage.childWorkspaceKey ||
        effect.payload.effect.status !== 'intended'
      ) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${observation.forkId} planned Kernel records conflict`,
        );
      }
      break;
    }
    case 'worktree.create-started':
      assertEffectStatus(
        requireType('effect-dispatch-started', 'effect.status_changed'),
        observation,
        'dispatch_started',
      );
      break;
    case 'runtime.started': {
      const bound = requireType('attempt-bound', 'attempt.bound');
      const started = requireType('attempt-started', 'attempt.started');
      if (
        bound.type !== 'attempt.bound' ||
        bound.payload.binding.attemptId !== observation.childAttemptId ||
        bound.payload.binding.branchId !== lineage.childBranchId ||
        started.type !== 'attempt.started' ||
        started.payload.attempt.attemptId !== observation.childAttemptId ||
        started.payload.attempt.branchId !== lineage.childBranchId ||
        started.payload.attempt.continuedFromAttemptId !== lineage.parentAttemptId
      ) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${observation.forkId} Attempt binding conflicts`,
        );
      }
      break;
    }
    case 'runtime.finished': {
      const finished = requireType('attempt-finished', 'attempt.finished');
      const expectedStatus =
        observation.runtimeResult?.status === 'completed' ? 'executed' : 'failed';
      if (
        finished.type !== 'attempt.finished' ||
        finished.payload.attemptId !== observation.childAttemptId
      ) {
        throw new MissionExecutionForkBridgeError(
          `Execution Fork ${observation.forkId} finished Attempt conflicts`,
        );
      }
      assertEffectStatus(
        requireType('effect-runtime-finished', 'effect.status_changed'),
        observation,
        expectedStatus,
      );
      break;
    }
    case 'receipt-input.ready':
      assertEffectStatus(
        requireType('effect-confirmed', 'effect.status_changed'),
        observation,
        'confirmed',
      );
      break;
    default:
      break;
  }
}

function assertEffectStatus(
  event: EventV1,
  observation: ExecutionForkBridgeObservationV1,
  status: 'dispatch_started' | 'executed' | 'confirmed' | 'failed',
): void {
  if (
    event.type !== 'effect.status_changed' ||
    event.payload.effectId !== observation.effectId ||
    event.payload.status !== status ||
    !event.payload.evidenceRefs.includes(
      `event:${kernelEventId(
        sourceIdentityFromObservation(observation),
        observation.bindingDigest,
        'observation',
      )}`,
    )
  ) {
    throw new MissionExecutionForkBridgeError(
      `Execution Fork ${observation.forkId} Effect ${status} evidence conflicts`,
    );
  }
}

function effectStatusEvent(
  sourceEvent: ExecutionForkEventV1,
  context: MissionExecutionForkContextV1,
  bindingDigest: string,
  effectId: string,
  role: Extract<
    KernelRole,
    'effect-dispatch-started' | 'effect-runtime-finished' | 'effect-confirmed'
  >,
  status: 'dispatch_started' | 'executed' | 'confirmed' | 'failed',
  evidenceRefs: readonly string[],
): EventV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: kernelEventId(sourceEvent, bindingDigest, role),
    missionId: context.missionId,
    attemptId: context.childAttemptId,
    occurredAt: context.occurredAt,
    type: 'effect.status_changed',
    payload: { effectId, status, evidenceRefs },
  };
}

function bridgeObservations(events: readonly EventV1[]): ExecutionForkBridgeObservationV1[] {
  return events.flatMap((event) => {
    if (event.type !== 'runtime.observation' || event.payload.kind !== OBSERVATION_KIND) return [];
    const data = asRecord(event.payload.data);
    if (
      data.schemaVersion !== BRIDGE_SCHEMA_VERSION ||
      data.bridge !== 'mission-execution-fork' ||
      typeof data.forkId !== 'string' ||
      typeof data.missionId !== 'string' ||
      !isTransition(data.transition) ||
      typeof data.sourceEventId !== 'string' ||
      typeof data.sourceEventHash !== 'string' ||
      typeof data.sourceSequence !== 'number' ||
      !(data.sourcePreviousHash === null || typeof data.sourcePreviousHash === 'string') ||
      typeof data.sourceOccurredAt !== 'string' ||
      typeof data.bindingDigest !== 'string' ||
      typeof data.childAttemptId !== 'string' ||
      typeof data.effectId !== 'string' ||
      typeof data.observationDigest !== 'string'
    ) {
      throw new MissionExecutionForkBridgeError(
        `Kernel event ${event.eventId} has invalid Execution Fork bridge data`,
      );
    }
    const observation = data as unknown as ExecutionForkBridgeObservationV1;
    const { observationDigest: _observationDigest, ...unsigned } = observation;
    if (digest(unsigned) !== observation.observationDigest) {
      throw new MissionExecutionForkBridgeError(
        `Kernel event ${event.eventId} failed Execution Fork observation digest verification`,
      );
    }
    if (
      event.missionId !== observation.missionId ||
      event.attemptId !== observation.childAttemptId
    ) {
      throw new MissionExecutionForkBridgeError(
        `Kernel event ${event.eventId} envelope conflicts with Execution Fork bridge data`,
      );
    }
    return [observation];
  });
}

function sanitizePayload(payload: unknown): SanitizedPayloadEvidenceV1 {
  const raw = stableJson(payload);
  const sanitized = sanitizeNativeArtifact(raw);
  if (sanitized.mediaType !== 'application/json') {
    throw new MissionExecutionForkBridgeError('Execution Fork payload must be JSON');
  }
  const sanitizedJson = stableJson(JSON.parse(sanitized.content) as JsonValue);
  return {
    sourceDigest: digest(raw),
    sanitizedDigest: digest(sanitizedJson),
    sanitizedJson,
    redactionCount: sanitized.redactionCount,
  };
}

function validateContext(context: MissionExecutionForkContextV1): void {
  requireIdentifier('missionId', context.missionId);
  requireIdentifier('childAttemptId', context.childAttemptId);
  if (!Number.isFinite(Date.parse(context.occurredAt))) {
    throw new MissionExecutionForkBridgeError('occurredAt must be an ISO-compatible timestamp');
  }
  const binding = context.binding;
  if (
    binding.schemaVersion !== DOMAIN_SCHEMA_VERSION ||
    binding.missionId !== context.missionId ||
    binding.attemptId !== context.childAttemptId ||
    binding.authority !== 'workspace' ||
    !Number.isSafeInteger(binding.injectionBudgetTokens) ||
    binding.injectionBudgetTokens < 0 ||
    !Number.isFinite(Date.parse(binding.boundAt))
  ) {
    throw new MissionExecutionForkBridgeError('Execution Fork Attempt Binding is invalid');
  }
  for (const [name, value] of [
    ['bindingId', binding.bindingId],
    ['branchId', binding.branchId],
    ['contractId', binding.contractId],
    ['profileId', binding.profileId],
    ['workspaceKey', binding.workspaceKey],
    ['planNodeId', binding.planNodeId],
  ] as const) {
    requireIdentifier(name, value);
  }
}

function validateSourceEvent(event: ExecutionForkEventV1): void {
  if (
    event.schemaVersion !== EXECUTION_FORK_SCHEMA_VERSION ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence <= 0 ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    !isTransition(event.type)
  ) {
    throw new MissionExecutionForkBridgeError('Execution Fork source event envelope is invalid');
  }
  requireIdentifier('forkId', event.forkId);
  const expectedHash = forkDigest({
    schemaVersion: event.schemaVersion,
    forkId: event.forkId,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: event.payload,
    sequence: event.sequence,
    previousHash: event.previousHash,
  });
  if (
    event.eventHash !== expectedHash ||
    event.eventId !== `execution-fork-event-${expectedHash.slice('sha256:'.length)}`
  ) {
    throw new MissionExecutionForkBridgeError('Execution Fork source event hash is invalid');
  }
}

function kernelEventId(
  source: Pick<ExecutionForkEventV1, 'eventId' | 'eventHash'>,
  bindingDigest: string,
  role: KernelRole,
): string {
  return `event-execution-fork-${role}-${digest({
    bridge: 'mission-execution-fork',
    sourceEventId: source.eventId,
    sourceEventHash: source.eventHash,
    bindingDigest,
    role,
  })}`;
}

function sourceIdentityFromObservation(
  observation: ExecutionForkBridgeObservationV1,
): Pick<ExecutionForkEventV1, 'eventId' | 'eventHash'> {
  return { eventId: observation.sourceEventId, eventHash: observation.sourceEventHash };
}

function normalizeEvidenceRefs(references: readonly string[]): readonly string[] {
  return [...new Set(references.map(sanitizeEvidenceRef))].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

function sanitizeEvidenceRef(reference: string): string {
  if (reference.trim().length === 0) {
    throw new MissionExecutionForkBridgeError('Evidence reference must not be empty');
  }
  const sanitized = sanitizeNativeArtifact(JSON.stringify(reference));
  let value = JSON.parse(sanitized.content) as string;
  value = value.replace(
    /([?&])(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password)=[^&#\s]+/gi,
    '$1redacted=[REDACTED]',
  );
  return value;
}

function requireStringArray(name: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new MissionExecutionForkBridgeError(`${name} must be a string array`);
  }
  return value;
}

function requireIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new MissionExecutionForkBridgeError(`${name} must be a stable identifier`);
  }
  return value;
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new MissionExecutionForkBridgeError('Execution Fork observation must be an object');
  }
  return value;
}

function isTransition(value: unknown): value is ExecutionForkEventTypeV1 {
  return [
    'fork.planned',
    'worktree.create-started',
    'worktree.created',
    'runtime.started',
    'runtime.evidence',
    'runtime.finished',
    'receipt-input.ready',
    'fork.failed',
    'worktree.cleaned',
  ].includes(value as ExecutionForkEventTypeV1);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function forkDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(forkCanonicalize(value)))
    .digest('hex')}`;
}

function forkCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forkCanonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, candidate]) => candidate !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, candidate]) => [key, forkCanonicalize(candidate)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MissionExecutionForkBridgeError('Canonical JSON forbids non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const member = record[key];
        if (member === undefined) {
          throw new MissionExecutionForkBridgeError(`Canonical JSON forbids undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${stableJson(member)}`;
      })
      .join(',')}}`;
  }
  throw new MissionExecutionForkBridgeError(`Canonical JSON cannot encode a ${typeof value} value`);
}
