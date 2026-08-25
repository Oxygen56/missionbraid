import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DOMAIN_SCHEMA_VERSION,
  type ContractV1,
  type EventV1,
  type JsonValue,
  type MissionV1,
  type ProfileV1,
} from './domain.js';
import type { ExternalEffectDescriptor, ExternalEffectEvent } from './external-effect.js';
import {
  MissionExternalEffectBridgeError,
  externalEffectEventToMissionEvents,
  rebuildExternalEffectStateFromMissionEvents,
  type MissionExternalEffectContextV1,
} from './mission-external-effect.js';
import { MissionStore } from './store.js';

const NOW = '2026-08-26T00:00:00.000Z';
const disposableDirectories: string[] = [];

afterEach(() => {
  for (const directory of disposableDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Mission External Effect bridge', () => {
  it('produces a deterministic append batch that the Kernel deduplicates under a fence', () => {
    const fixture = createStoreFixture();
    const batch = externalEffectEventToMissionEvents(
      { type: 'effect.intended', effect: descriptor() },
      context(0),
    );
    const repeated = externalEffectEventToMissionEvents(
      { type: 'effect.intended', effect: descriptor() },
      context(0),
    );

    expect(repeated).toEqual(batch);
    expect(batch.map((event) => event.type)).toEqual(['runtime.observation', 'effect.recorded']);
    expect(
      fixture.store.appendEvents(batch, fixture.fence).map((result) => result.inserted),
    ).toEqual([true, true]);
    expect(
      fixture.store.appendEvents(batch, fixture.fence).map((result) => result.inserted),
    ).toEqual([false, false]);

    const persisted = fixture.store.listEvents(MISSION_ID);
    const recorded = persisted.find((event) => event.type === 'effect.recorded');
    expect(recorded?.type === 'effect.recorded' && recorded.payload.effect).toMatchObject({
      effectId: EFFECT_ID,
      kind: 'github.issue.comment',
      resourceKey: 'github:issue:owner/repo#42',
      authorityRef: 'authority:github-user-consent',
      idempotencyKey: 'mission-1:comment-42',
      controlLevel: 'guarded',
      scope: 'mission_global_external',
    });
    const observation = persisted.find(
      (event) =>
        event.type === 'runtime.observation' && event.payload.kind === 'external-effect.transition',
    );
    expect(observation?.type === 'runtime.observation' && observation.payload.data).toMatchObject({
      descriptor: {
        targetId: 'github-rest',
        payloadDigest: 'sha256:payload',
        authorityRef: 'authority:github-user-consent',
        idempotencyKey: 'mission-1:comment-42',
      },
    });
    fixture.store.close();
  });

  it('rebuilds confirmed state only from a Kernel transition with redacted receipt evidence', () => {
    const fixture = createStoreFixture();
    const receipt: JsonValue = {
      receiptId: 'comment-991',
      url: 'https://github.example/comment/991',
      accessToken: 'sk-proj-this-must-never-be-persisted',
      nested: { authorization: 'Bearer another-sensitive-value' },
    };
    const bridgeEvents = lifecycle([
      {
        type: 'effect.dispatch_started',
        effectId: EFFECT_ID,
        idempotencyKey: descriptor().idempotencyKey,
        dispatchAttempt: 1,
      },
      {
        type: 'effect.executed',
        effectId: EFFECT_ID,
        receipt,
        evidenceRefs: ['github:request:991'],
      },
      {
        type: 'effect.confirmed',
        effectId: EFFECT_ID,
        source: 'dispatch',
        receipt,
        evidenceRefs: ['github:comment:991'],
      },
    ]);
    fixture.store.appendEvents(bridgeEvents, fixture.fence);
    const events = fixture.store.listEvents(MISSION_ID);
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain('this-must-never-be-persisted');
    expect(serialized).not.toContain('another-sensitive-value');
    expect(serialized).toContain('[REDACTED]');
    expect(rebuildExternalEffectStateFromMissionEvents(events, EFFECT_ID)).toEqual({
      effect: descriptor(),
      status: 'confirmed',
      dispatchAttempts: 1,
      receipt: {
        accessToken: '[REDACTED]',
        nested: { authorization: '[REDACTED]' },
        receiptId: 'comment-991',
        url: 'https://github.example/comment/991',
      },
      evidenceRefs: ['github:comment:991'],
    });
    fixture.store.close();
  });

  it('keeps unknown target outcomes ambiguous and omits raw failure detail', () => {
    const rawDetail = 'authorization=top-secret-target-response';
    const events = lifecycle([
      {
        type: 'effect.dispatch_started',
        effectId: EFFECT_ID,
        idempotencyKey: descriptor().idempotencyKey,
        dispatchAttempt: 2,
      },
      {
        type: 'effect.ambiguous',
        effectId: EFFECT_ID,
        source: 'dispatch',
        observedStatus: 'unknown',
        evidenceRefs: ['https://target.example/check?token=raw-token-value'],
        detail: rawDetail,
      },
    ]);
    const state = rebuildExternalEffectStateFromMissionEvents(events, EFFECT_ID);

    expect(state).toMatchObject({
      status: 'ambiguous',
      dispatchAttempts: 2,
      evidenceRefs: ['https://target.example/check?token=[REDACTED]'],
    });
    expect(JSON.stringify(events)).not.toContain(rawDetail);
    expect(
      events.some(
        (event) => event.type === 'effect.status_changed' && event.payload.status === 'confirmed',
      ),
    ).toBe(false);
  });

  it('treats reconciliation as evidence without inventing a successful status', () => {
    const intended = externalEffectEventToMissionEvents(
      { type: 'effect.intended', effect: descriptor() },
      context(0),
    );
    const reconcileStarted = externalEffectEventToMissionEvents(
      {
        type: 'effect.reconcile_started',
        effectId: EFFECT_ID,
        idempotencyKey: descriptor().idempotencyKey,
      },
      context(1),
    );
    const absent = externalEffectEventToMissionEvents(
      {
        type: 'effect.reconciled_absent',
        effectId: EFFECT_ID,
        evidenceRefs: ['target:lookup:absent'],
      },
      context(2),
    );
    const events = [...intended, ...reconcileStarted, ...absent];

    expect(reconcileStarted).toHaveLength(1);
    expect(absent).toHaveLength(1);
    expect(rebuildExternalEffectStateFromMissionEvents(events, EFFECT_ID)).toMatchObject({
      status: 'intended',
      evidenceRefs: ['target:lookup:absent'],
    });
  });

  it('requires the receipt observation and Kernel transition to agree before success', () => {
    const intended = externalEffectEventToMissionEvents(
      { type: 'effect.intended', effect: descriptor() },
      context(0),
    );
    const confirmed = externalEffectEventToMissionEvents(
      {
        type: 'effect.confirmed',
        effectId: EFFECT_ID,
        source: 'lookup',
        receipt: { receiptId: 'found-1' },
        evidenceRefs: ['lookup:found-1'],
      },
      context(1),
    );

    expect(
      rebuildExternalEffectStateFromMissionEvents([...intended, confirmed[0]!], EFFECT_ID)?.status,
    ).toBe('intended');
    expect(() =>
      rebuildExternalEffectStateFromMissionEvents([...intended, confirmed[1]!], EFFECT_ID),
    ).toThrow(MissionExternalEffectBridgeError);
  });

  it('rejects a Kernel Effect record that disagrees with immutable target intent', () => {
    const events = externalEffectEventToMissionEvents(
      { type: 'effect.intended', effect: descriptor() },
      context(0),
    );
    const tampered = events.map((event) =>
      event.type === 'effect.recorded'
        ? {
            ...event,
            payload: {
              effect: { ...event.payload.effect, authorityRef: 'authority:different-user' },
            },
          }
        : event,
    ) as readonly EventV1[];

    expect(() => rebuildExternalEffectStateFromMissionEvents(tampered, EFFECT_ID)).toThrow(
      /disagrees with descriptor/,
    );
  });
});

const MISSION_ID = 'mission-external-effect';
const ATTEMPT_ID = 'attempt-external-effect';
const EFFECT_ID = 'effect-github-comment-42';

function descriptor(): ExternalEffectDescriptor {
  return {
    effectId: EFFECT_ID,
    targetId: 'github-rest',
    kind: 'github.issue.comment',
    resourceKey: 'github:issue:owner/repo#42',
    authorityRef: 'authority:github-user-consent',
    idempotencyKey: 'mission-1:comment-42',
    payloadDigest: 'sha256:payload',
    controlLevel: 'guarded',
    scope: 'mission_global_external',
  };
}

function context(offsetSeconds: number): MissionExternalEffectContextV1 {
  return {
    missionId: MISSION_ID,
    attemptId: ATTEMPT_ID,
    occurredAt: new Date(Date.parse(NOW) + offsetSeconds * 1_000).toISOString(),
  };
}

function lifecycle(events: readonly ExternalEffectEvent<JsonValue>[]): readonly EventV1[] {
  return [
    ...externalEffectEventToMissionEvents(
      { type: 'effect.intended', effect: descriptor() },
      context(0),
    ),
    ...events.flatMap((event, index) =>
      externalEffectEventToMissionEvents(event, context(index + 1)),
    ),
  ];
}

function createStoreFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'missionbraid-external-effect-'));
  disposableDirectories.push(directory);
  const store = new MissionStore(join(directory, 'kernel.sqlite'), { now: () => new Date(NOW) });
  const contract: ContractV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    contractId: 'contract-external-effect',
    objective: 'Persist one external Effect without duplicate dispatch',
    acceptanceCriteria: [
      {
        criterionId: 'receipt-confirmed',
        description: 'The target receipt is confirmed',
        verifier: { kind: 'receipt', configuration: {} },
      },
    ],
    createdAt: NOW,
  };
  const profile: ProfileV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: 'profile-codex',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    capabilities: ['external-effect'],
    configurationDigest: 'a'.repeat(64),
  };
  const mission: MissionV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    missionId: MISSION_ID,
    title: 'External Effect bridge fixture',
    workspaceKey: 'workspace-external-effect',
    contractId: contract.contractId,
    initialProfileId: profile.profileId,
    rootBranchId: 'branch-external-effect',
    status: 'pending',
    createdAt: NOW,
  };
  const fence = store.acquireWorkspaceLease(mission.workspaceKey, 'bridge-test', {
    ttlMs: 60_000,
  });
  store.createMission(
    {
      eventId: 'event-create-external-effect',
      occurredAt: NOW,
      mission,
      contract,
      profile,
    },
    fence,
  );
  return { store, fence };
}
