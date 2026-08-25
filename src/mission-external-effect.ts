import { createHash } from 'node:crypto';

import { sanitizeNativeArtifact } from './artifact-store.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type EffectStatusV1,
  type EventV1,
  type JsonValue,
} from './domain.js';
import type {
  ExternalEffectDescriptor,
  ExternalEffectEvent,
  ExternalEffectState,
} from './external-effect.js';

const BRIDGE_SCHEMA_VERSION = 1 as const;
const OBSERVATION_KIND = 'external-effect.transition';

type ExternalEffectTransition = ExternalEffectEvent<JsonValue>['type'];

export interface MissionExternalEffectContextV1 {
  readonly missionId: string;
  readonly attemptId: string;
  /**
   * Stable source-event time. A retry must reuse this value so the Kernel can
   * recognize the exact same event envelope as an idempotent replay.
   */
  readonly occurredAt: string;
}

export class MissionExternalEffectBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionExternalEffectBridgeError';
  }
}

interface ReceiptEvidenceV1 {
  readonly sourceDigest: string;
  readonly sanitizedDigest: string;
  readonly sanitizedJson: string;
  readonly redactionCount: number;
}

interface BridgeObservationV1 {
  readonly schemaVersion: typeof BRIDGE_SCHEMA_VERSION;
  readonly bridge: 'mission-external-effect';
  readonly transition: ExternalEffectTransition;
  readonly transitionDigest: string;
  readonly effectId: string;
  readonly evidenceRefs: readonly string[];
  readonly descriptor?: ExternalEffectDescriptor;
  readonly idempotencyKey?: string;
  readonly dispatchAttempt?: number;
  readonly source?: 'dispatch' | 'lookup';
  readonly observedStatus?: 'ambiguous' | 'unknown';
  readonly receiptEvidence?: ReceiptEvidenceV1;
  readonly detailDigest?: string;
}

/**
 * Convert one coordinator event into an atomic Kernel append batch.
 *
 * The caller owns the workspace fence and can pass the result directly to
 * `MissionStore.appendEvents(result, fence)`. Exact retries must reuse the
 * same context, including `occurredAt`.
 */
export function externalEffectEventToMissionEvents(
  event: ExternalEffectEvent<JsonValue>,
  context: MissionExternalEffectContextV1,
): readonly EventV1[] {
  validateContext(context);
  const observationData = normalizeExternalEvent(event);
  const identityDigest = digest({ context, observationData });
  const observationEventId = `event-external-effect-observation-${identityDigest}`;
  const observation: EventV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: observationEventId,
    missionId: context.missionId,
    attemptId: context.attemptId,
    occurredAt: context.occurredAt,
    type: 'runtime.observation',
    payload: {
      kind: OBSERVATION_KIND,
      data: observationData as unknown as JsonValue,
    },
  };

  if (event.type === 'effect.reconcile_started' || event.type === 'effect.reconciled_absent') {
    return [observation];
  }

  if (event.type === 'effect.intended') {
    const effect = event.effect;
    return [
      observation,
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-external-effect-recorded-${identityDigest}`,
        missionId: context.missionId,
        attemptId: context.attemptId,
        occurredAt: context.occurredAt,
        type: 'effect.recorded',
        payload: {
          effect: {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            effectId: effect.effectId,
            missionId: context.missionId,
            attemptId: context.attemptId,
            kind: effect.kind,
            resourceKey: effect.resourceKey,
            controlLevel: effect.controlLevel,
            scope: effect.scope,
            status: 'intended',
            authorityRef: effect.authorityRef,
            idempotencyKey: effect.idempotencyKey,
            evidenceRefs: [`event:${observationEventId}`],
            createdAt: context.occurredAt,
          },
        },
      },
    ];
  }

  const status = kernelStatusFor(event);
  return [
    observation,
    {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: `event-external-effect-status-${identityDigest}`,
      missionId: context.missionId,
      attemptId: context.attemptId,
      occurredAt: context.occurredAt,
      type: 'effect.status_changed',
      payload: {
        effectId: event.effectId,
        status,
        evidenceRefs: normalizeEvidenceRefs([
          ...observationData.evidenceRefs,
          `event:${observationEventId}`,
        ]),
      },
    },
  ];
}

/**
 * Rebuild coordinator state from the authoritative Kernel history.
 * Runtime observations supply descriptor and receipt evidence, but never
 * advance status without the matching Kernel Effect transition.
 */
export function rebuildExternalEffectStateFromMissionEvents(
  events: readonly EventV1[],
  effectId: string,
): ExternalEffectState<JsonValue> | undefined {
  requireNonEmpty('effectId', effectId);

  const observations = new Map<string, BridgeObservationV1>();
  for (const event of events) {
    const observation = parseBridgeObservation(event);
    if (observation !== undefined) observations.set(event.eventId, observation);
  }

  const intendedObservations = [...observations.values()].filter(
    (observation) =>
      observation.effectId === effectId && observation.transition === 'effect.intended',
  );
  if (intendedObservations.length === 0) return undefined;
  const descriptor = intendedObservations[0]?.descriptor;
  if (descriptor === undefined) {
    throw new MissionExternalEffectBridgeError(
      `External Effect ${effectId} has no persisted descriptor evidence`,
    );
  }
  for (const observation of intendedObservations.slice(1)) {
    if (stableJson(observation.descriptor) !== stableJson(descriptor)) {
      throw new MissionExternalEffectBridgeError(
        `External Effect ${effectId} has conflicting descriptor evidence`,
      );
    }
  }

  let state: ExternalEffectState<JsonValue> | undefined;
  for (const event of events) {
    if (event.type === 'effect.recorded' && event.payload.effect.effectId === effectId) {
      assertRecordedEffectMatches(event, descriptor);
      if (state !== undefined) {
        throw new MissionExternalEffectBridgeError(
          `External Effect ${effectId} was recorded more than once`,
        );
      }
      state = {
        effect: descriptor,
        status: 'intended',
        dispatchAttempts: 0,
        evidenceRefs: [],
      };
      continue;
    }

    const observation = parseBridgeObservation(event);
    if (
      observation !== undefined &&
      observation.effectId === effectId &&
      observation.transition === 'effect.reconciled_absent' &&
      state !== undefined
    ) {
      state = { ...state, evidenceRefs: [...observation.evidenceRefs] };
      continue;
    }

    if (event.type !== 'effect.status_changed' || event.payload.effectId !== effectId) continue;
    if (state === undefined) {
      throw new MissionExternalEffectBridgeError(
        `External Effect ${effectId} changed status before it was recorded`,
      );
    }
    if (event.payload.status === 'conflict') {
      state = {
        ...state,
        status: 'conflict',
        evidenceRefs: [...event.payload.evidenceRefs],
      };
      continue;
    }

    const matchingObservation = referencedTransitionObservation(
      event.payload.evidenceRefs,
      observations,
      effectId,
      transitionForStatus(event.payload.status),
    );
    switch (event.payload.status) {
      case 'dispatch_started': {
        if (
          matchingObservation.dispatchAttempt === undefined ||
          matchingObservation.idempotencyKey !== descriptor.idempotencyKey
        ) {
          throw new MissionExternalEffectBridgeError(
            `External Effect ${effectId} has invalid dispatch evidence`,
          );
        }
        state = {
          ...state,
          status: 'dispatch_started',
          dispatchAttempts: Math.max(state.dispatchAttempts, matchingObservation.dispatchAttempt),
        };
        break;
      }
      case 'executed':
      case 'confirmed': {
        const receipt = receiptFromObservation(matchingObservation);
        state = {
          ...state,
          status: event.payload.status,
          receipt,
          evidenceRefs: [...matchingObservation.evidenceRefs],
        };
        break;
      }
      case 'failed':
      case 'ambiguous':
        state = {
          ...state,
          status: event.payload.status,
          evidenceRefs: [...matchingObservation.evidenceRefs],
        };
        break;
      case 'intended':
      case 'skipped':
        throw new MissionExternalEffectBridgeError(
          `Kernel status ${event.payload.status} cannot reconstruct External Effect ${effectId}`,
        );
    }
  }

  if (state === undefined) {
    throw new MissionExternalEffectBridgeError(
      `External Effect ${effectId} has descriptor evidence but no Effect record`,
    );
  }
  return state;
}

function normalizeExternalEvent(event: ExternalEffectEvent<JsonValue>): BridgeObservationV1 {
  const common = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    bridge: 'mission-external-effect' as const,
    transition: event.type,
    effectId: event.type === 'effect.intended' ? event.effect.effectId : event.effectId,
  };
  requireNonEmpty('effectId', common.effectId);

  let data: Omit<BridgeObservationV1, 'transitionDigest'>;
  switch (event.type) {
    case 'effect.intended':
      validateDescriptor(event.effect);
      data = {
        ...common,
        evidenceRefs: [],
        descriptor: { ...event.effect },
      };
      break;
    case 'effect.dispatch_started':
      requireNonEmpty('idempotencyKey', event.idempotencyKey);
      if (!Number.isSafeInteger(event.dispatchAttempt) || event.dispatchAttempt <= 0) {
        throw new MissionExternalEffectBridgeError(
          'dispatchAttempt must be a positive safe integer',
        );
      }
      data = {
        ...common,
        evidenceRefs: [],
        idempotencyKey: event.idempotencyKey,
        dispatchAttempt: event.dispatchAttempt,
      };
      break;
    case 'effect.reconcile_started':
      requireNonEmpty('idempotencyKey', event.idempotencyKey);
      data = {
        ...common,
        evidenceRefs: [],
        idempotencyKey: event.idempotencyKey,
      };
      break;
    case 'effect.reconciled_absent':
      data = {
        ...common,
        evidenceRefs: normalizeEvidenceRefs(event.evidenceRefs),
      };
      break;
    case 'effect.executed':
      data = {
        ...common,
        evidenceRefs: normalizeEvidenceRefs(event.evidenceRefs),
        receiptEvidence: sanitizeReceipt(event.receipt),
      };
      break;
    case 'effect.confirmed':
      data = {
        ...common,
        evidenceRefs: normalizeEvidenceRefs(event.evidenceRefs),
        source: event.source,
        receiptEvidence: sanitizeReceipt(event.receipt),
      };
      break;
    case 'effect.failed':
      data = {
        ...common,
        evidenceRefs: normalizeEvidenceRefs(event.evidenceRefs),
        ...(event.detail === undefined ? {} : { detailDigest: digest(event.detail) }),
      };
      break;
    case 'effect.ambiguous':
      data = {
        ...common,
        evidenceRefs: normalizeEvidenceRefs(event.evidenceRefs),
        source: event.source,
        observedStatus: event.observedStatus,
        ...(event.detail === undefined ? {} : { detailDigest: digest(event.detail) }),
      };
      break;
  }
  return { ...data, transitionDigest: digest(data) };
}

function kernelStatusFor(
  event: Exclude<
    ExternalEffectEvent<JsonValue>,
    | { readonly type: 'effect.intended' }
    | { readonly type: 'effect.reconcile_started' }
    | { readonly type: 'effect.reconciled_absent' }
  >,
): Extract<EffectStatusV1, 'dispatch_started' | 'executed' | 'confirmed' | 'failed' | 'ambiguous'> {
  switch (event.type) {
    case 'effect.dispatch_started':
      return 'dispatch_started';
    case 'effect.executed':
      return 'executed';
    case 'effect.confirmed':
      return 'confirmed';
    case 'effect.failed':
      return 'failed';
    case 'effect.ambiguous':
      return 'ambiguous';
  }
}

function transitionForStatus(status: EffectStatusV1): ExternalEffectTransition {
  switch (status) {
    case 'dispatch_started':
      return 'effect.dispatch_started';
    case 'executed':
      return 'effect.executed';
    case 'confirmed':
      return 'effect.confirmed';
    case 'failed':
      return 'effect.failed';
    case 'ambiguous':
      return 'effect.ambiguous';
    case 'intended':
    case 'skipped':
    case 'conflict':
      throw new MissionExternalEffectBridgeError(
        `Kernel status ${status} has no External Effect transition`,
      );
  }
}

function referencedTransitionObservation(
  evidenceRefs: readonly string[],
  observations: ReadonlyMap<string, BridgeObservationV1>,
  effectId: string,
  transition: ExternalEffectTransition,
): BridgeObservationV1 {
  for (const reference of evidenceRefs) {
    if (!reference.startsWith('event:')) continue;
    const observation = observations.get(reference.slice('event:'.length));
    if (observation?.effectId === effectId && observation.transition === transition) {
      return observation;
    }
  }
  throw new MissionExternalEffectBridgeError(
    `External Effect ${effectId} status ${transition} lacks matching observation evidence`,
  );
}

function assertRecordedEffectMatches(
  event: Extract<EventV1, { readonly type: 'effect.recorded' }>,
  descriptor: ExternalEffectDescriptor,
): void {
  const effect = event.payload.effect;
  const matches =
    event.missionId === effect.missionId &&
    event.attemptId === effect.attemptId &&
    effect.effectId === descriptor.effectId &&
    effect.kind === descriptor.kind &&
    effect.resourceKey === descriptor.resourceKey &&
    effect.controlLevel === descriptor.controlLevel &&
    effect.scope === descriptor.scope &&
    effect.status === 'intended' &&
    effect.authorityRef === descriptor.authorityRef &&
    effect.idempotencyKey === descriptor.idempotencyKey;
  if (!matches) {
    throw new MissionExternalEffectBridgeError(
      `Kernel Effect record disagrees with descriptor ${descriptor.effectId}`,
    );
  }
}

function parseBridgeObservation(event: EventV1): BridgeObservationV1 | undefined {
  if (event.type !== 'runtime.observation' || event.payload.kind !== OBSERVATION_KIND) {
    return undefined;
  }
  const data = asRecord(event.payload.data);
  if (
    data.schemaVersion !== BRIDGE_SCHEMA_VERSION ||
    data.bridge !== 'mission-external-effect' ||
    !isExternalEffectTransition(data.transition) ||
    typeof data.transitionDigest !== 'string' ||
    typeof data.effectId !== 'string' ||
    !Array.isArray(data.evidenceRefs) ||
    !data.evidenceRefs.every((reference) => typeof reference === 'string')
  ) {
    throw new MissionExternalEffectBridgeError(
      `Runtime observation ${event.eventId} has invalid External Effect bridge data`,
    );
  }
  const candidate = data as unknown as BridgeObservationV1;
  const { transitionDigest: _transitionDigest, ...unsigned } = candidate;
  if (digest(unsigned) !== candidate.transitionDigest) {
    throw new MissionExternalEffectBridgeError(
      `Runtime observation ${event.eventId} failed transition digest verification`,
    );
  }
  return candidate;
}

function receiptFromObservation(observation: BridgeObservationV1): JsonValue {
  const evidence = observation.receiptEvidence;
  if (evidence === undefined) {
    throw new MissionExternalEffectBridgeError(
      `External Effect ${observation.effectId} success lacks receipt evidence`,
    );
  }
  if (digest(evidence.sanitizedJson) !== evidence.sanitizedDigest) {
    throw new MissionExternalEffectBridgeError(
      `External Effect ${observation.effectId} receipt evidence failed digest verification`,
    );
  }
  try {
    return JSON.parse(evidence.sanitizedJson) as JsonValue;
  } catch {
    throw new MissionExternalEffectBridgeError(
      `External Effect ${observation.effectId} receipt evidence is not JSON`,
    );
  }
}

function sanitizeReceipt(receipt: JsonValue): ReceiptEvidenceV1 {
  const raw = stableJson(receipt);
  const sanitized = sanitizeNativeArtifact(raw);
  if (sanitized.mediaType !== 'application/json') {
    throw new MissionExternalEffectBridgeError('External Effect receipt must be JSON');
  }
  const parsed = JSON.parse(sanitized.content) as JsonValue;
  const sanitizedJson = stableJson(parsed);
  return {
    sourceDigest: digest(raw),
    sanitizedDigest: digest(sanitizedJson),
    sanitizedJson,
    redactionCount: sanitized.redactionCount,
  };
}

function normalizeEvidenceRefs(evidenceRefs: readonly string[]): readonly string[] {
  return [
    ...new Set(evidenceRefs.map(sanitizeEvidenceRef).filter((value) => value.length > 0)),
  ].sort();
}

function sanitizeEvidenceRef(reference: string): string {
  requireNonEmpty('evidenceRef', reference);
  const sanitized = sanitizeNativeArtifact(JSON.stringify(reference));
  let value = JSON.parse(sanitized.content) as string;
  value = value.replace(
    /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password)=)[^&#\s]+/gi,
    '$1[REDACTED]',
  );
  return value.trim();
}

function validateContext(context: MissionExternalEffectContextV1): void {
  requireNonEmpty('missionId', context.missionId);
  requireNonEmpty('attemptId', context.attemptId);
  if (!Number.isFinite(Date.parse(context.occurredAt))) {
    throw new MissionExternalEffectBridgeError('occurredAt must be an ISO-compatible timestamp');
  }
}

function validateDescriptor(descriptor: ExternalEffectDescriptor): void {
  for (const [name, value] of [
    ['effectId', descriptor.effectId],
    ['targetId', descriptor.targetId],
    ['kind', descriptor.kind],
    ['resourceKey', descriptor.resourceKey],
    ['authorityRef', descriptor.authorityRef],
    ['idempotencyKey', descriptor.idempotencyKey],
    ['payloadDigest', descriptor.payloadDigest],
  ] as const) {
    requireNonEmpty(name, value);
  }
  if (descriptor.controlLevel !== 'guarded' || descriptor.scope !== 'mission_global_external') {
    throw new MissionExternalEffectBridgeError(
      'External Effect descriptor must be guarded and mission-global',
    );
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new MissionExternalEffectBridgeError(`${name} must not be empty`);
  }
}

function isExternalEffectTransition(value: unknown): value is ExternalEffectTransition {
  return [
    'effect.intended',
    'effect.dispatch_started',
    'effect.reconcile_started',
    'effect.reconciled_absent',
    'effect.executed',
    'effect.confirmed',
    'effect.failed',
    'effect.ambiguous',
  ].includes(value as ExternalEffectTransition);
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new MissionExternalEffectBridgeError(
      'External Effect observation data must be an object',
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MissionExternalEffectBridgeError('Canonical JSON forbids non-finite numbers');
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
          throw new MissionExternalEffectBridgeError(`Canonical JSON forbids undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${stableJson(member)}`;
      })
      .join(',')}}`;
  }
  throw new MissionExternalEffectBridgeError(
    `Canonical JSON cannot encode a ${typeof value} value`,
  );
}
