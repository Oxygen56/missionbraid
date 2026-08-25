import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  ExternalEffectBlockedError,
  ExternalEffectCoordinator,
  projectExternalEffect,
  type ExternalEffectAppendPort,
  type ExternalEffectEvent,
  type ExternalEffectRequest,
  type ExternalEffectState,
  type QueryableEffectTarget,
} from './external-effect.js';

interface EffectPayload {
  readonly operation: string;
  readonly value: string;
}

interface HttpReceipt {
  readonly idempotencyKey: string;
  readonly recordId: string;
  readonly payload: EffectPayload;
}

type LookupMode = 'normal' | 'ambiguous' | 'unknown';

describe('queryable external Effect coordination', () => {
  it('recovers an accepted dispatch by lookup after the local result crashes', async () => {
    const trace: string[] = [];
    const fixture = await startHttpFixture('normal', trace);
    try {
      const events: ExternalEffectEvent<HttpReceipt>[] = [];
      const request = effectRequest('effect-create-1', 'create-1');
      const firstCoordinator = new ExternalEffectCoordinator(
        fixture.target,
        appendPort(events, trace, 'effect.executed'),
      );

      await expect(firstCoordinator.coordinate(request)).rejects.toThrow('injected append crash');

      expect(fixture.postCount()).toBe(1);
      expect(events.map((event) => event.type)).toEqual([
        'effect.intended',
        'effect.dispatch_started',
      ]);
      expect(trace).toEqual([
        'persist:effect.intended',
        'persist:effect.dispatch_started',
        'http:POST:create-1',
        'crash:effect.executed',
      ]);

      const interrupted = projectExternalEffect(events, request.effectId);
      expect(interrupted).toMatchObject({ status: 'dispatch_started', dispatchAttempts: 1 });
      if (interrupted === undefined) throw new Error('Expected the interrupted Effect projection');

      const callsBeforeRestart = fixture.calls().length;
      const restartedCoordinator = new ExternalEffectCoordinator(
        fixture.target,
        appendPort(events, trace),
      );
      const outcome = await restartedCoordinator.coordinate(request, interrupted);

      expect(outcome).toMatchObject({
        status: 'confirmed',
        source: 'lookup',
        receipt: { idempotencyKey: 'create-1', recordId: 'receipt-1' },
      });
      expect(fixture.calls().slice(callsBeforeRestart)).toEqual(['GET:create-1']);
      expect(fixture.postCount()).toBe(1);
      expect(projectExternalEffect(events, request.effectId)).toMatchObject({
        status: 'confirmed',
        dispatchAttempts: 1,
        receipt: { idempotencyKey: 'create-1', recordId: 'receipt-1' },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'effect.confirmed',
          effectId: request.effectId,
          source: 'lookup',
        }),
      );
    } finally {
      await fixture.close();
    }
  });

  it.each(['ambiguous', 'unknown'] as const)(
    'blocks a blind retry while target lookup is %s',
    async (lookupMode) => {
      const trace: string[] = [];
      const fixture = await startHttpFixture(lookupMode, trace);
      try {
        const events: ExternalEffectEvent<HttpReceipt>[] = [];
        const request = effectRequest(`effect-${lookupMode}`, `key-${lookupMode}`);
        const coordinator = new ExternalEffectCoordinator(
          fixture.target,
          appendPort(events, trace),
        );

        await expect(
          coordinator.coordinate(request, dispatchStartedState(request)),
        ).rejects.toEqual(
          expect.objectContaining<Partial<ExternalEffectBlockedError>>({
            name: 'ExternalEffectBlockedError',
            effectId: request.effectId,
            observedStatus: lookupMode,
          }),
        );

        expect(fixture.calls()).toEqual([`GET:key-${lookupMode}`]);
        expect(fixture.postCount()).toBe(0);
        expect(events.map((event) => event.type)).toEqual([
          'effect.reconcile_started',
          'effect.ambiguous',
        ]);
        expect(events.at(-1)).toMatchObject({
          type: 'effect.ambiguous',
          source: 'lookup',
          observedStatus: lookupMode,
        });
      } finally {
        await fixture.close();
      }
    },
  );

  it('records compensation as a separate Effect and idempotency key', async () => {
    const trace: string[] = [];
    const fixture = await startHttpFixture('normal', trace);
    try {
      const events: ExternalEffectEvent<HttpReceipt>[] = [];
      const coordinator = new ExternalEffectCoordinator(fixture.target, appendPort(events, trace));
      const originalRequest = effectRequest('effect-create', 'key-create');
      await coordinator.coordinate(originalRequest);
      const original = projectExternalEffect(events, originalRequest.effectId);
      if (original === undefined) throw new Error('Expected the original Effect projection');

      const compensationRequest = effectRequest('effect-remove', 'key-remove', {
        operation: 'remove',
        value: 'record-1',
      });
      await coordinator.compensate(original, compensationRequest);

      expect(fixture.postKeys()).toEqual(['key-create', 'key-remove']);
      expect(projectExternalEffect(events, originalRequest.effectId)).toMatchObject({
        status: 'confirmed',
      });
      expect(projectExternalEffect(events, compensationRequest.effectId)).toMatchObject({
        status: 'confirmed',
        effect: {
          effectId: compensationRequest.effectId,
          idempotencyKey: compensationRequest.idempotencyKey,
          compensatesEffectId: originalRequest.effectId,
        },
      });
    } finally {
      await fixture.close();
    }
  });
});

function effectRequest(
  effectId: string,
  idempotencyKey: string,
  payload: EffectPayload = { operation: 'create', value: 'record-1' },
): ExternalEffectRequest<EffectPayload> {
  return {
    effectId,
    targetId: 'http-fixture',
    kind: payload.operation,
    resourceKey: payload.value,
    authorityRef: 'grant:test-only',
    idempotencyKey,
    payloadDigest: `digest:${payload.operation}:${payload.value}`,
    payload,
  };
}

function dispatchStartedState(
  request: ExternalEffectRequest<EffectPayload>,
): ExternalEffectState<HttpReceipt> {
  return {
    effect: {
      effectId: request.effectId,
      targetId: request.targetId,
      kind: request.kind,
      resourceKey: request.resourceKey,
      authorityRef: request.authorityRef,
      idempotencyKey: request.idempotencyKey,
      payloadDigest: request.payloadDigest,
      controlLevel: 'guarded',
      scope: 'mission_global_external',
    },
    status: 'dispatch_started',
    dispatchAttempts: 1,
    evidenceRefs: [],
  };
}

function appendPort(
  events: ExternalEffectEvent<HttpReceipt>[],
  trace: string[],
  crashOnceOn?: ExternalEffectEvent<HttpReceipt>['type'],
): ExternalEffectAppendPort<HttpReceipt> {
  let pendingCrash = crashOnceOn;
  return {
    append: async (event) => {
      if (event.type === pendingCrash) {
        pendingCrash = undefined;
        trace.push(`crash:${event.type}`);
        throw new Error('injected append crash');
      }
      events.push(event);
      trace.push(`persist:${event.type}`);
    },
  };
}

async function startHttpFixture(
  mode: LookupMode,
  trace: string[],
): Promise<{
  readonly target: QueryableEffectTarget<EffectPayload, HttpReceipt>;
  readonly calls: () => readonly string[];
  readonly postCount: () => number;
  readonly postKeys: () => readonly string[];
  readonly close: () => Promise<void>;
}> {
  const records = new Map<string, HttpReceipt>();
  const calls: string[] = [];
  const postKeys: string[] = [];
  let postCount = 0;

  const server = createServer(async (request, response) => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url.startsWith('/effects/')) {
      const key = decodeURIComponent(url.slice('/effects/'.length));
      calls.push(`GET:${key}`);
      trace.push(`http:GET:${key}`);
      if (mode === 'ambiguous') {
        respondJson(response, 409, { detail: 'target has competing records' });
        return;
      }
      if (mode === 'unknown') {
        respondJson(response, 503, { detail: 'target lookup unavailable' });
        return;
      }
      const receipt = records.get(key);
      if (receipt === undefined) {
        respondJson(response, 404, { status: 'absent' });
        return;
      }
      respondJson(response, 200, receipt);
      return;
    }

    if (request.method === 'POST' && url === '/effects') {
      const keyHeader = request.headers['idempotency-key'];
      const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
      if (key === undefined || key.length === 0) {
        respondJson(response, 400, { detail: 'missing idempotency key' });
        return;
      }
      calls.push(`POST:${key}`);
      trace.push(`http:POST:${key}`);
      postCount += 1;
      postKeys.push(key);
      const payload = JSON.parse(await readBody(request)) as EffectPayload;
      const receipt =
        records.get(key) ??
        ({
          idempotencyKey: key,
          recordId: `receipt-${records.size + 1}`,
          payload,
        } satisfies HttpReceipt);
      records.set(key, receipt);
      respondJson(response, 201, receipt);
      return;
    }

    respondJson(response, 404, { detail: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const target: QueryableEffectTarget<EffectPayload, HttpReceipt> = {
    targetId: 'http-fixture',
    lookup: async (idempotencyKey) => {
      const response = await fetch(`${baseUrl}/effects/${encodeURIComponent(idempotencyKey)}`);
      const evidenceRefs = [`http:lookup:${response.status}:${idempotencyKey}`];
      if (response.status === 200) {
        return {
          status: 'found',
          receipt: (await response.json()) as HttpReceipt,
          evidenceRefs,
        };
      }
      if (response.status === 404) return { status: 'absent', evidenceRefs };
      if (response.status === 409) {
        return { status: 'ambiguous', evidenceRefs, detail: 'target has competing records' };
      }
      return { status: 'unknown', evidenceRefs, detail: 'target lookup unavailable' };
    },
    dispatch: async ({ idempotencyKey, payload }) => {
      const response = await fetch(`${baseUrl}/effects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const evidenceRefs = [`http:dispatch:${response.status}:${idempotencyKey}`];
      if (response.status === 201 || response.status === 200) {
        return {
          status: 'accepted',
          receipt: (await response.json()) as HttpReceipt,
          evidenceRefs,
        };
      }
      if (response.status >= 500) {
        return { status: 'unknown', evidenceRefs, detail: 'target dispatch unavailable' };
      }
      return { status: 'rejected', evidenceRefs, detail: 'target rejected dispatch' };
    },
  };

  return {
    target,
    calls: () => [...calls],
    postCount: () => postCount,
    postKeys: () => [...postKeys],
    close: async () => await closeServer(server),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function respondJson(
  response: ServerResponse<IncomingMessage>,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
