/**
 * Idempotent coordination for queryable external effects.
 *
 * This module deliberately owns no Mission state. Callers supply the latest
 * durable projection and an append port whose promise resolves only after the
 * emitted transition is durable. The coordinator never dispatches before the
 * `intended` and `dispatch_started` transitions have been acknowledged.
 */

export type ExternalEffectStatus =
  | 'intended'
  | 'dispatch_started'
  | 'executed'
  | 'confirmed'
  | 'failed'
  | 'ambiguous'
  | 'conflict';

export interface ExternalEffectRequest<TPayload> {
  readonly effectId: string;
  readonly targetId: string;
  readonly kind: string;
  readonly resourceKey: string;
  readonly authorityRef: string;
  readonly idempotencyKey: string;
  /** Stable caller-owned digest of the exact payload sent to the target. */
  readonly payloadDigest: string;
  readonly payload: TPayload;
  /** Compensation is always represented by a distinct Effect identity. */
  readonly compensatesEffectId?: string;
}

export interface ExternalEffectDescriptor {
  readonly effectId: string;
  readonly targetId: string;
  readonly kind: string;
  readonly resourceKey: string;
  readonly authorityRef: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly controlLevel: 'guarded';
  readonly scope: 'mission_global_external';
  readonly compensatesEffectId?: string;
}

export type QueryableEffectLookup<TReceipt> =
  | {
      readonly status: 'found';
      readonly receipt: TReceipt;
      readonly evidenceRefs: readonly string[];
    }
  | { readonly status: 'absent'; readonly evidenceRefs: readonly string[] }
  | {
      readonly status: 'ambiguous' | 'unknown';
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    };

export type QueryableEffectDispatch<TReceipt> =
  | {
      readonly status: 'accepted';
      readonly receipt: TReceipt;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: 'rejected';
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    }
  | {
      readonly status: 'ambiguous' | 'unknown';
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    };

export interface QueryableEffectTarget<TPayload, TReceipt> {
  readonly targetId: string;
  lookup(idempotencyKey: string): Promise<QueryableEffectLookup<TReceipt>>;
  dispatch(input: {
    readonly idempotencyKey: string;
    readonly payload: TPayload;
  }): Promise<QueryableEffectDispatch<TReceipt>>;
}

export type ExternalEffectEvent<TReceipt> =
  | { readonly type: 'effect.intended'; readonly effect: ExternalEffectDescriptor }
  | {
      readonly type: 'effect.dispatch_started';
      readonly effectId: string;
      readonly idempotencyKey: string;
      readonly dispatchAttempt: number;
    }
  | {
      readonly type: 'effect.reconcile_started';
      readonly effectId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: 'effect.reconciled_absent';
      readonly effectId: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly type: 'effect.executed';
      readonly effectId: string;
      readonly receipt: TReceipt;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly type: 'effect.confirmed';
      readonly effectId: string;
      readonly source: 'dispatch' | 'lookup';
      readonly receipt: TReceipt;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly type: 'effect.failed';
      readonly effectId: string;
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    }
  | {
      readonly type: 'effect.ambiguous';
      readonly effectId: string;
      readonly source: 'dispatch' | 'lookup';
      readonly observedStatus: 'ambiguous' | 'unknown';
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    };

export interface ExternalEffectAppendPort<TReceipt> {
  /** Resolves only after the transition is durably committed by the caller. */
  append(event: ExternalEffectEvent<TReceipt>): Promise<void>;
}

export interface ExternalEffectState<TReceipt> {
  readonly effect: ExternalEffectDescriptor;
  readonly status: ExternalEffectStatus;
  readonly dispatchAttempts: number;
  readonly receipt?: TReceipt;
  readonly evidenceRefs: readonly string[];
  readonly detail?: string;
}

export type ExternalEffectOutcome<TReceipt> =
  | {
      readonly status: 'confirmed';
      readonly source: 'dispatch' | 'lookup' | 'persisted';
      readonly receipt: TReceipt;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly source: 'dispatch' | 'persisted';
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    };

export class ExternalEffectBlockedError extends Error {
  readonly effectId: string;
  readonly observedStatus: 'ambiguous' | 'unknown' | 'conflict';

  constructor(
    effectId: string,
    observedStatus: 'ambiguous' | 'unknown' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ExternalEffectBlockedError';
    this.effectId = effectId;
    this.observedStatus = observedStatus;
  }
}

export class ExternalEffectInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalEffectInvariantError';
  }
}

export class ExternalEffectCoordinator<TPayload, TReceipt> {
  readonly #target: QueryableEffectTarget<TPayload, TReceipt>;
  readonly #events: ExternalEffectAppendPort<TReceipt>;

  constructor(
    target: QueryableEffectTarget<TPayload, TReceipt>,
    events: ExternalEffectAppendPort<TReceipt>,
  ) {
    this.#target = target;
    this.#events = events;
  }

  async coordinate(
    request: ExternalEffectRequest<TPayload>,
    persisted?: ExternalEffectState<TReceipt>,
  ): Promise<ExternalEffectOutcome<TReceipt>> {
    validateRequest(request, this.#target.targetId);

    if (persisted === undefined) {
      await this.#events.append({
        type: 'effect.intended',
        effect: descriptor(request),
      });
      return await this.#startDispatch(request, 1);
    }

    assertSameEffect(request, persisted.effect);
    switch (persisted.status) {
      case 'confirmed':
        if (persisted.receipt === undefined) {
          throw new ExternalEffectInvariantError(
            `Confirmed Effect ${request.effectId} is missing its receipt`,
          );
        }
        return {
          status: 'confirmed',
          source: 'persisted',
          receipt: persisted.receipt,
          evidenceRefs: [...persisted.evidenceRefs],
        };
      case 'failed':
        return {
          status: 'failed',
          source: 'persisted',
          evidenceRefs: [...persisted.evidenceRefs],
          ...(persisted.detail === undefined ? {} : { detail: persisted.detail }),
        };
      case 'conflict':
        throw new ExternalEffectBlockedError(
          request.effectId,
          'conflict',
          `Effect ${request.effectId} is in conflict and cannot be dispatched`,
        );
      case 'intended':
        // A durable intended state proves dispatch_started was never committed,
        // so no target dispatch could have been initiated by this coordinator.
        return await this.#startDispatch(request, persisted.dispatchAttempts + 1);
      case 'dispatch_started':
      case 'executed':
      case 'ambiguous':
        // These states may mean the target accepted the request before the
        // local result was durable. Reconciliation must precede any retry.
        return await this.#reconcile(request, persisted.dispatchAttempts);
    }
  }

  async compensate(
    original: ExternalEffectState<unknown>,
    compensation: ExternalEffectRequest<TPayload>,
    persistedCompensation?: ExternalEffectState<TReceipt>,
  ): Promise<ExternalEffectOutcome<TReceipt>> {
    if (original.status !== 'confirmed' && original.status !== 'executed') {
      throw new ExternalEffectInvariantError(
        `Effect ${original.effect.effectId} is not confirmed or executed and cannot be compensated`,
      );
    }
    if (compensation.effectId === original.effect.effectId) {
      throw new ExternalEffectInvariantError('Compensation must use a new Effect identity');
    }
    if (compensation.idempotencyKey === original.effect.idempotencyKey) {
      throw new ExternalEffectInvariantError('Compensation must use a new idempotency key');
    }
    if (
      compensation.compensatesEffectId !== undefined &&
      compensation.compensatesEffectId !== original.effect.effectId
    ) {
      throw new ExternalEffectInvariantError(
        'Compensation references an Effect other than the supplied original',
      );
    }

    return await this.coordinate(
      { ...compensation, compensatesEffectId: original.effect.effectId },
      persistedCompensation,
    );
  }

  async #startDispatch(
    request: ExternalEffectRequest<TPayload>,
    dispatchAttempt: number,
  ): Promise<ExternalEffectOutcome<TReceipt>> {
    await this.#events.append({
      type: 'effect.dispatch_started',
      effectId: request.effectId,
      idempotencyKey: request.idempotencyKey,
      dispatchAttempt,
    });
    return await this.#dispatch(request);
  }

  async #dispatch(
    request: ExternalEffectRequest<TPayload>,
  ): Promise<ExternalEffectOutcome<TReceipt>> {
    let result: QueryableEffectDispatch<TReceipt>;
    try {
      result = await this.#target.dispatch({
        idempotencyKey: request.idempotencyKey,
        payload: request.payload,
      });
    } catch {
      return await this.#recordAmbiguous(
        request.effectId,
        'dispatch',
        'unknown',
        [],
        'Target dispatch threw before its outcome could be established',
      );
    }

    if (result.status === 'accepted') {
      await this.#events.append({
        type: 'effect.executed',
        effectId: request.effectId,
        receipt: result.receipt,
        evidenceRefs: [...result.evidenceRefs],
      });
      await this.#events.append({
        type: 'effect.confirmed',
        effectId: request.effectId,
        source: 'dispatch',
        receipt: result.receipt,
        evidenceRefs: [...result.evidenceRefs],
      });
      return {
        status: 'confirmed',
        source: 'dispatch',
        receipt: result.receipt,
        evidenceRefs: [...result.evidenceRefs],
      };
    }

    if (result.status === 'rejected') {
      await this.#events.append({
        type: 'effect.failed',
        effectId: request.effectId,
        evidenceRefs: [...result.evidenceRefs],
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      return {
        status: 'failed',
        source: 'dispatch',
        evidenceRefs: [...result.evidenceRefs],
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    }

    return await this.#recordAmbiguous(
      request.effectId,
      'dispatch',
      result.status,
      result.evidenceRefs,
      result.detail,
    );
  }

  async #reconcile(
    request: ExternalEffectRequest<TPayload>,
    dispatchAttempts: number,
  ): Promise<ExternalEffectOutcome<TReceipt>> {
    await this.#events.append({
      type: 'effect.reconcile_started',
      effectId: request.effectId,
      idempotencyKey: request.idempotencyKey,
    });

    let result: QueryableEffectLookup<TReceipt>;
    try {
      result = await this.#target.lookup(request.idempotencyKey);
    } catch {
      return await this.#recordAmbiguous(
        request.effectId,
        'lookup',
        'unknown',
        [],
        'Target lookup threw before the Effect outcome could be established',
      );
    }

    if (result.status === 'found') {
      await this.#events.append({
        type: 'effect.confirmed',
        effectId: request.effectId,
        source: 'lookup',
        receipt: result.receipt,
        evidenceRefs: [...result.evidenceRefs],
      });
      return {
        status: 'confirmed',
        source: 'lookup',
        receipt: result.receipt,
        evidenceRefs: [...result.evidenceRefs],
      };
    }

    if (result.status === 'absent') {
      await this.#events.append({
        type: 'effect.reconciled_absent',
        effectId: request.effectId,
        evidenceRefs: [...result.evidenceRefs],
      });
      return await this.#startDispatch(request, dispatchAttempts + 1);
    }

    return await this.#recordAmbiguous(
      request.effectId,
      'lookup',
      result.status,
      result.evidenceRefs,
      result.detail,
    );
  }

  async #recordAmbiguous(
    effectId: string,
    source: 'dispatch' | 'lookup',
    observedStatus: 'ambiguous' | 'unknown',
    evidenceRefs: readonly string[],
    detail?: string,
  ): Promise<never> {
    await this.#events.append({
      type: 'effect.ambiguous',
      effectId,
      source,
      observedStatus,
      evidenceRefs: [...evidenceRefs],
      ...(detail === undefined ? {} : { detail }),
    });
    throw new ExternalEffectBlockedError(
      effectId,
      observedStatus,
      `Effect ${effectId} remains ${observedStatus}; retry is blocked until lookup resolves it`,
    );
  }
}

export function projectExternalEffect<TReceipt>(
  events: readonly ExternalEffectEvent<TReceipt>[],
  effectId: string,
): ExternalEffectState<TReceipt> | undefined {
  let state: ExternalEffectState<TReceipt> | undefined;
  for (const event of events) {
    if (event.type === 'effect.intended') {
      if (event.effect.effectId !== effectId) continue;
      state = {
        effect: event.effect,
        status: 'intended',
        dispatchAttempts: 0,
        evidenceRefs: [],
      };
      continue;
    }
    if (event.effectId !== effectId || state === undefined) continue;
    switch (event.type) {
      case 'effect.dispatch_started':
        state = {
          ...state,
          status: 'dispatch_started',
          dispatchAttempts: Math.max(state.dispatchAttempts, event.dispatchAttempt),
        };
        break;
      case 'effect.reconcile_started':
        break;
      case 'effect.reconciled_absent':
        state = { ...state, evidenceRefs: [...event.evidenceRefs] };
        break;
      case 'effect.executed':
        state = {
          ...state,
          status: 'executed',
          receipt: event.receipt,
          evidenceRefs: [...event.evidenceRefs],
        };
        break;
      case 'effect.confirmed':
        state = {
          ...state,
          status: 'confirmed',
          receipt: event.receipt,
          evidenceRefs: [...event.evidenceRefs],
        };
        break;
      case 'effect.failed':
        state = {
          ...state,
          status: 'failed',
          evidenceRefs: [...event.evidenceRefs],
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        };
        break;
      case 'effect.ambiguous':
        state = {
          ...state,
          status: 'ambiguous',
          evidenceRefs: [...event.evidenceRefs],
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        };
        break;
    }
  }
  return state;
}

function descriptor<TPayload>(request: ExternalEffectRequest<TPayload>): ExternalEffectDescriptor {
  return {
    effectId: request.effectId,
    targetId: request.targetId,
    kind: request.kind,
    resourceKey: request.resourceKey,
    authorityRef: request.authorityRef,
    idempotencyKey: request.idempotencyKey,
    payloadDigest: request.payloadDigest,
    controlLevel: 'guarded',
    scope: 'mission_global_external',
    ...(request.compensatesEffectId === undefined
      ? {}
      : { compensatesEffectId: request.compensatesEffectId }),
  };
}

function validateRequest<TPayload>(
  request: ExternalEffectRequest<TPayload>,
  targetId: string,
): void {
  for (const [name, value] of [
    ['effectId', request.effectId],
    ['targetId', request.targetId],
    ['kind', request.kind],
    ['resourceKey', request.resourceKey],
    ['authorityRef', request.authorityRef],
    ['idempotencyKey', request.idempotencyKey],
    ['payloadDigest', request.payloadDigest],
  ] as const) {
    if (value.trim().length === 0) {
      throw new ExternalEffectInvariantError(`${name} must not be empty`);
    }
  }
  if (request.targetId !== targetId) {
    throw new ExternalEffectInvariantError(
      `Effect target ${request.targetId} does not match coordinator target ${targetId}`,
    );
  }
}

function assertSameEffect<TPayload>(
  request: ExternalEffectRequest<TPayload>,
  effect: ExternalEffectDescriptor,
): void {
  const candidate = descriptor(request);
  for (const field of [
    'effectId',
    'targetId',
    'kind',
    'resourceKey',
    'authorityRef',
    'idempotencyKey',
    'payloadDigest',
    'compensatesEffectId',
  ] as const) {
    if (candidate[field] !== effect[field]) {
      throw new ExternalEffectInvariantError(
        `Persisted Effect ${effect.effectId} disagrees on ${field}`,
      );
    }
  }
}
