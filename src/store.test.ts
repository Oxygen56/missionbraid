import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DOMAIN_SCHEMA_VERSION,
  type ContractV1,
  type EventV1,
  type MissionV1,
  type ProfileV1,
} from './domain.js';
import {
  CredentialMaterialError,
  EventIdentityConflictError,
  MissionInvariantError,
  MissionStore,
  StaleFencingTokenError,
  WorkspaceLeaseConflictError,
  canonicalJson,
  computeEventHash,
  hashPayload,
} from './store.js';

const disposableDirectories: string[] = [];

afterEach(() => {
  for (const directory of disposableDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MissionStore', () => {
  it('deduplicates an identical event id without advancing the Mission sequence', () => {
    const fixture = createFixture();
    const first = fixture.store.createMission(fixture.creation, fixture.fence);
    const replay = fixture.store.createMission(fixture.creation, fixture.fence);

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.event).toEqual(first.event);
    expect(fixture.store.listEvents(fixture.mission.missionId)).toHaveLength(1);
    expect(fixture.store.getMission(fixture.mission.missionId)?.lastSeq).toBe(1);

    expect(() =>
      fixture.store.createMission(
        {
          ...fixture.creation,
          mission: { ...fixture.mission, title: 'Different content under the same event id' },
        },
        fixture.fence,
      ),
    ).toThrow(EventIdentityConflictError);
    fixture.store.close();
  });

  it('creates a canonical payload hash and a contiguous per-Mission hash chain', () => {
    const fixture = createFixture();
    const created = fixture.store.createMission(fixture.creation, fixture.fence).event;
    const running = fixture.store.appendEvent(
      statusEvent(
        fixture.mission.missionId,
        'event-running',
        'running',
        '2026-08-24T00:00:01.000Z',
      ),
      fixture.fence,
    ).event;
    const waiting = fixture.store.appendEvent(
      statusEvent(
        fixture.mission.missionId,
        'event-waiting',
        'waiting',
        '2026-08-24T00:00:02.000Z',
      ),
      fixture.fence,
    ).event;

    expect(created.seq).toBe(1);
    expect(created.prevHash).toBeNull();
    expect(created.payloadHash).toBe(hashPayload(created.payload));
    expect(running.seq).toBe(2);
    expect(running.prevHash).toBe(created.hash);
    expect(waiting.seq).toBe(3);
    expect(waiting.prevHash).toBe(running.hash);
    expect(fixture.store.verifyEventChain(fixture.mission.missionId)).toEqual({
      valid: true,
      checked: 3,
      headHash: waiting.hash,
    });
    expect(fixture.store.getMission(fixture.mission.missionId)).toMatchObject({
      status: 'waiting',
      lastSeq: 3,
      headHash: waiting.hash,
    });
    fixture.store.close();
  });

  it('atomically creates a Mission with its specification snapshot and replays the batch', () => {
    const fixture = createFixture();
    const created = creationEvent(fixture.creation);
    const snapshot: EventV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: 'event-spec-snapshot',
      missionId: fixture.mission.missionId,
      occurredAt: '2026-08-24T00:00:00.000Z',
      type: 'runtime.observation',
      payload: {
        kind: 'mission.spec_snapshot',
        data: { snapshotHash: 'b'.repeat(64), snapshot: { schemaVersion: 1 } },
      },
    };

    const first = fixture.store.appendEvents([created, snapshot], fixture.fence);
    const replay = fixture.store.appendEvents([created, snapshot], fixture.fence);

    expect(first.map((result) => result.inserted)).toEqual([true, true]);
    expect(replay.map((result) => result.inserted)).toEqual([false, false]);
    expect(first[0]?.event.seq).toBe(1);
    expect(first[1]?.event.seq).toBe(2);
    expect(first[1]?.event.prevHash).toBe(first[0]?.event.hash);
    expect(fixture.store.getMission(fixture.mission.missionId)?.lastSeq).toBe(2);
    expect(fixture.store.verifyEventChain(fixture.mission.missionId)).toMatchObject({
      valid: true,
      checked: 2,
    });
    fixture.store.close();
  });

  it('does not leave a Mission without its required creation batch when the batch fails', () => {
    const fixture = createFixture();
    const created = creationEvent(fixture.creation);
    const snapshot: EventV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: 'event-spec-snapshot-before-failure',
      missionId: fixture.mission.missionId,
      occurredAt: '2026-08-24T00:00:00.000Z',
      type: 'runtime.observation',
      payload: {
        kind: 'mission.spec_snapshot',
        data: { snapshotHash: 'b'.repeat(64), snapshot: { schemaVersion: 1 } },
      },
    };
    const invalidSuccess: EventV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: 'event-invalid-creation-success',
      missionId: fixture.mission.missionId,
      occurredAt: '2026-08-24T00:00:00.000Z',
      type: 'mission.status_changed',
      payload: { status: 'succeeded' },
    };

    expect(() =>
      fixture.store.appendEvents([created, snapshot, invalidSuccess], fixture.fence),
    ).toThrow(MissionInvariantError);
    expect(fixture.store.getMission(fixture.mission.missionId)).toBeUndefined();
    expect(fixture.store.listEvents(fixture.mission.missionId)).toEqual([]);
    fixture.store.close();
  });

  it('rolls back every prepared Attempt event when a later event violates an invariant', () => {
    const fixture = createFixture();
    fixture.store.createMission(fixture.creation, fixture.fence);
    const attemptId = 'attempt-atomic-preparation';
    const preparation: EventV1[] = [
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: 'event-attempt-baseline',
        missionId: fixture.mission.missionId,
        attemptId,
        occurredAt: '2026-08-24T00:00:01.000Z',
        type: 'runtime.observation',
        payload: {
          kind: 'attempt.baseline',
          data: { attemptId, stageId: 'stage-1', profileId: fixture.profile.profileId },
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: 'event-attempt-effect',
        missionId: fixture.mission.missionId,
        attemptId,
        occurredAt: '2026-08-24T00:00:01.000Z',
        type: 'effect.recorded',
        payload: {
          effect: {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            effectId: 'effect-atomic-preparation',
            missionId: fixture.mission.missionId,
            attemptId,
            kind: 'workspace.stage_mutation',
            resourceKey: 'workspace-stage:stage-1',
            status: 'intended',
            evidenceRefs: [],
            createdAt: '2026-08-24T00:00:01.000Z',
          },
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: 'event-attempt-plan',
        missionId: fixture.mission.missionId,
        attemptId,
        occurredAt: '2026-08-24T00:00:01.000Z',
        type: 'runtime.observation',
        payload: {
          kind: 'attempt.plan',
          data: {
            attemptId,
            stageId: 'stage-1',
            harness: 'codex',
            profileId: fixture.profile.profileId,
          },
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: 'event-invalid-success',
        missionId: fixture.mission.missionId,
        occurredAt: '2026-08-24T00:00:01.000Z',
        type: 'mission.status_changed',
        payload: { status: 'succeeded' },
      },
    ];

    expect(() => fixture.store.appendEvents(preparation, fixture.fence)).toThrow(
      MissionInvariantError,
    );
    expect(fixture.store.listEvents(fixture.mission.missionId)).toHaveLength(1);
    expect(fixture.store.getMission(fixture.mission.missionId)).toMatchObject({
      status: 'pending',
      lastSeq: 1,
    });
    expect(fixture.store.verifyEventChain(fixture.mission.missionId)).toMatchObject({
      valid: true,
      checked: 1,
    });
    fixture.store.close();
  });

  it('restores the authoritative log and projection after the process reopens', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'kernel.sqlite');
    let currentMs = Date.parse('2026-08-24T00:00:00.000Z');
    const now = () => new Date(currentMs);
    const firstStore = new MissionStore(databasePath, { now });
    const { mission, contract, profile, creation } = entities('reopen-workspace');
    const lease = firstStore.acquireWorkspaceLease(mission.workspaceKey, 'runner-a', {
      ttlMs: 60_000,
    });
    firstStore.createMission(creation, lease);
    firstStore.appendEvent(
      statusEvent(mission.missionId, 'event-running', 'running', '2026-08-24T00:00:01.000Z'),
      lease,
    );
    const headBeforeClose = firstStore.getMission(mission.missionId)?.headHash;
    firstStore.close();

    currentMs += 1_000;
    const reopened = new MissionStore(databasePath, { now });
    expect(reopened.getMission(mission.missionId)).toMatchObject({
      missionId: mission.missionId,
      status: 'running',
      lastSeq: 2,
      headHash: headBeforeClose,
      contract,
      activeProfile: profile,
    });
    const resumed = reopened.appendEvent(
      statusEvent(mission.missionId, 'event-resumed', 'waiting', '2026-08-24T00:00:03.000Z'),
      lease,
    ).event;
    expect(resumed.seq).toBe(3);
    expect(resumed.prevHash).toBe(headBeforeClose);
    expect(reopened.verifyEventChain(mission.missionId).valid).toBe(true);
    reopened.close();
  });

  it('commits command intent with its outbox row and recovers it after reopen', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'kernel.sqlite');
    let currentMs = Date.parse('2026-08-24T00:00:00.000Z');
    const now = () => new Date(currentMs);
    const first = new MissionStore(databasePath, { now });
    const fixture = entities('command-restart');
    const lease = first.acquireWorkspaceLease(fixture.mission.workspaceKey, 'runner-command', {
      ttlMs: 60_000,
    });
    first.createMission(fixture.creation, lease);
    const head = first.getMission(fixture.mission.missionId)!.headHash;
    const accepted = first.acceptCommand(
      {
        commandId: 'command-restart-1',
        eventId: 'event-command-restart-1',
        missionId: fixture.mission.missionId,
        action: 'resume',
        idempotencyKey: 'ui-submit-1',
        expectedHeadHash: head,
        occurredAt: '2026-08-24T00:00:01.000Z',
      },
      lease,
    );
    expect(accepted).toMatchObject({ status: 'pending', dispatchCount: 0 });
    expect(first.listEvents(fixture.mission.missionId).at(-1)?.type).toBe('command.accepted');
    first.close();

    currentMs += 1_000;
    const reopened = new MissionStore(databasePath, { now });
    expect(reopened.getCommand(accepted.commandId)).toMatchObject({
      commandId: accepted.commandId,
      status: 'pending',
      branchId: fixture.mission.rootBranchId,
    });
    const claimed = reopened.claimNextCommand('supervisor-a', { claimTtlMs: 30_000 });
    expect(claimed).toMatchObject({ commandId: accepted.commandId, status: 'dispatching' });
    expect(claimed?.dispatchCount).toBe(1);
    reopened.recordCommandStatus(
      accepted.commandId,
      'completed',
      'event-command-completed',
      lease,
      'Mission succeeded',
    );
    expect(reopened.getCommand(accepted.commandId)?.status).toBe('completed');
    expect(reopened.verifyEventChain(fixture.mission.missionId).valid).toBe(true);
    reopened.close();
  });

  it('rolls back command intent when the outbox insert conflicts', () => {
    const fixture = createFixture();
    fixture.store.createMission(fixture.creation, fixture.fence);
    const firstHead = fixture.store.getMission(fixture.mission.missionId)!.headHash;
    fixture.store.acceptCommand(
      {
        commandId: 'command-shared',
        eventId: 'event-command-first',
        missionId: fixture.mission.missionId,
        action: 'resume',
        idempotencyKey: 'submit-first',
        expectedHeadHash: firstHead,
        occurredAt: '2026-08-24T00:00:01.000Z',
      },
      fixture.fence,
    );
    const before = fixture.store.listEvents(fixture.mission.missionId);
    const nextHead = fixture.store.getMission(fixture.mission.missionId)!.headHash;

    expect(() =>
      fixture.store.acceptCommand(
        {
          commandId: 'command-shared',
          eventId: 'event-command-conflict',
          missionId: fixture.mission.missionId,
          action: 'verify',
          idempotencyKey: 'submit-second',
          expectedHeadHash: nextHead,
          occurredAt: '2026-08-24T00:00:02.000Z',
        },
        fixture.fence,
      ),
    ).toThrow();
    expect(fixture.store.listEvents(fixture.mission.missionId)).toEqual(before);
    expect(fixture.store.listCommands(fixture.mission.missionId)).toHaveLength(1);
    expect(fixture.store.verifyEventChain(fixture.mission.missionId).valid).toBe(true);
    fixture.store.close();
  });

  it('migrates a schema-v1 Mission without inventing root Branch history', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'kernel.sqlite');
    const fixture = entities('legacy-schema-v1');
    const { rootBranchId: _rootBranchId, ...legacyMission } = fixture.mission;
    const payload = {
      mission: legacyMission,
      contract: fixture.contract,
      profile: fixture.profile,
    };
    const payloadJson = canonicalJson(payload);
    const payloadHash = hashPayload(payload);
    const recordedAt = '2026-08-24T00:00:00.000Z';
    const eventHash = computeEventHash({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: 'event-legacy-schema-v1',
      missionId: fixture.mission.missionId,
      attemptId: null,
      seq: 1,
      type: 'mission.created',
      occurredAt: fixture.mission.createdAt,
      recordedAt,
      payloadHash,
      prevHash: null,
    });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE mission_events (
        schema_version INTEGER NOT NULL, event_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL,
        attempt_id TEXT, seq INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        prev_hash TEXT, event_hash TEXT NOT NULL, UNIQUE (mission_id, seq)
      ) STRICT;
      CREATE TABLE missions (
        mission_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, contract_json TEXT NOT NULL, profile_json TEXT NOT NULL,
        receipt_json TEXT, last_seq INTEGER NOT NULL, head_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE workspace_leases (
        workspace_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
        acquired_at_ms INTEGER NOT NULL, lease_until_ms INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    legacy
      .prepare(
        `INSERT INTO mission_events VALUES (?, ?, ?, NULL, 1, 'mission.created', ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        DOMAIN_SCHEMA_VERSION,
        'event-legacy-schema-v1',
        fixture.mission.missionId,
        fixture.mission.createdAt,
        recordedAt,
        payloadJson,
        payloadHash,
        eventHash,
      );
    legacy
      .prepare(`INSERT INTO missions VALUES (?, ?, ?, 'pending', ?, ?, NULL, 1, ?, ?, ?)`)
      .run(
        fixture.mission.missionId,
        fixture.mission.workspaceKey,
        fixture.mission.title,
        canonicalJson(fixture.contract),
        canonicalJson(fixture.profile),
        eventHash,
        fixture.mission.createdAt,
        recordedAt,
      );
    legacy.close();

    const migrated = new MissionStore(databasePath);
    expect(migrated.getMission(fixture.mission.missionId)).toMatchObject({
      missionId: fixture.mission.missionId,
      status: 'pending',
    });
    expect(migrated.getMission(fixture.mission.missionId)?.rootBranchId).toBeUndefined();
    expect(migrated.verifyEventChain(fixture.mission.missionId).valid).toBe(true);
    const lease = migrated.acquireWorkspaceLease(fixture.mission.workspaceKey, 'legacy-runner');
    expect(() =>
      migrated.acceptCommand(
        {
          commandId: 'command-legacy',
          eventId: 'event-command-legacy',
          missionId: fixture.mission.missionId,
          action: 'resume',
          idempotencyKey: 'legacy-submit',
          expectedHeadHash: eventHash,
          occurredAt: '2026-08-24T00:00:01.000Z',
        },
        lease,
      ),
    ).toThrow(/no Branch identity/);
    migrated.close();
  });

  it('serializes workspace ownership and rejects writes from an old fencing token', () => {
    let currentMs = Date.parse('2026-08-24T00:00:00.000Z');
    const now = () => new Date(currentMs);
    const fixture = createFixture(now, 100);
    const contender = new MissionStore(fixture.databasePath, { now });
    fixture.store.createMission(fixture.creation, fixture.fence);

    expect(() =>
      contender.acquireWorkspaceLease(fixture.mission.workspaceKey, 'runner-b', {
        ttlMs: 100,
      }),
    ).toThrow(WorkspaceLeaseConflictError);

    currentMs += 101;
    const successor = contender.acquireWorkspaceLease(fixture.mission.workspaceKey, 'runner-b', {
      ttlMs: 100,
    });
    expect(successor.fencingToken).toBe(fixture.fence.fencingToken + 1);

    const candidate = statusEvent(
      fixture.mission.missionId,
      'event-after-takeover',
      'running',
      '2026-08-24T00:00:01.000Z',
    );
    expect(() => fixture.store.appendEvent(candidate, fixture.fence)).toThrow(
      StaleFencingTokenError,
    );

    expect(contender.appendEvent(candidate, successor).inserted).toBe(true);
    expect(contender.getMission(fixture.mission.missionId)?.lastSeq).toBe(2);
    contender.close();
    fixture.store.close();
  });

  it('rejects credential material and direct success claims before persisting them', () => {
    const fixture = createFixture();
    fixture.store.createMission(fixture.creation, fixture.fence);

    expect(() =>
      fixture.store.appendEvent(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: 'event-secret-observation',
          missionId: fixture.mission.missionId,
          occurredAt: '2026-08-24T00:00:01.000Z',
          type: 'runtime.observation',
          payload: { kind: 'adapter-output', data: { apiKey: 'must-not-be-stored' } },
        },
        fixture.fence,
      ),
    ).toThrow(CredentialMaterialError);

    expect(() =>
      fixture.store.appendEvent(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: 'event-secret-suffixed-observation',
          missionId: fixture.mission.missionId,
          occurredAt: '2026-08-24T00:00:01.500Z',
          type: 'runtime.observation',
          payload: {
            kind: 'adapter-output',
            data: { OPENAI_API_KEY: 'sk-proj-fixture-private-value' },
          },
        },
        fixture.fence,
      ),
    ).toThrow(CredentialMaterialError);

    expect(() =>
      fixture.store.appendEvent(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: 'event-self-declared-success',
          missionId: fixture.mission.missionId,
          occurredAt: '2026-08-24T00:00:02.000Z',
          type: 'mission.status_changed',
          payload: { status: 'succeeded' },
        },
        fixture.fence,
      ),
    ).toThrow(MissionInvariantError);

    expect(fixture.store.listEvents(fixture.mission.missionId)).toHaveLength(1);
    fixture.store.close();
  });

  it('rejects a verified Receipt with unresolved Effects or unresolved items', () => {
    const fixture = createFixture();
    fixture.store.createMission(fixture.creation, fixture.fence);
    const effectId = 'effect-unresolved';
    fixture.store.appendEvent(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: 'event-effect-unresolved',
        missionId: fixture.mission.missionId,
        attemptId: 'attempt-unresolved',
        occurredAt: '2026-08-24T00:00:01.000Z',
        type: 'effect.recorded',
        payload: {
          effect: {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            effectId,
            missionId: fixture.mission.missionId,
            attemptId: 'attempt-unresolved',
            kind: 'workspace.stage_mutation',
            resourceKey: 'workspace-stage:fixture',
            controlLevel: 'advisory',
            status: 'ambiguous',
            evidenceRefs: [],
            createdAt: '2026-08-24T00:00:01.000Z',
          },
        },
      },
      fixture.fence,
    );

    const appendVerifiedReceipt = (
      eventId: string,
      status: 'ambiguous' | 'confirmed',
      unresolvedItems: readonly string[],
    ): void => {
      const current = fixture.store.getMission(fixture.mission.missionId)!;
      fixture.store.appendEvent(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId,
          missionId: fixture.mission.missionId,
          occurredAt: '2026-08-24T00:00:03.000Z',
          type: 'receipt.issued',
          payload: {
            receipt: {
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              receiptId: `receipt-${eventId}`,
              missionId: fixture.mission.missionId,
              contractId: fixture.contract.contractId,
              outcome: 'verified',
              verifications: [
                {
                  criterionId: 'events-restored',
                  status: 'passed',
                  evidenceRefs: ['fixture:passed'],
                },
              ],
              verifiedHeadHash: current.headHash,
              verifiedThroughSeq: current.lastSeq,
              effectIds: [effectId],
              effects: [
                {
                  effectId,
                  status,
                  controlLevel: 'advisory',
                  kind: 'workspace.stage_mutation',
                  resourceKey: 'workspace-stage:fixture',
                  evidenceRefs: status === 'confirmed' ? ['checkpoint:fixture'] : [],
                },
              ],
              unresolvedItems,
              issuedAt: '2026-08-24T00:00:03.000Z',
            },
          },
        },
        fixture.fence,
      );
    };

    expect(() => appendVerifiedReceipt('event-receipt-ambiguous', 'ambiguous', [])).toThrow(
      /unresolved Effects/,
    );

    fixture.store.appendEvent(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: 'event-effect-confirmed',
        missionId: fixture.mission.missionId,
        attemptId: 'attempt-unresolved',
        occurredAt: '2026-08-24T00:00:02.000Z',
        type: 'effect.status_changed',
        payload: {
          effectId,
          status: 'confirmed',
          evidenceRefs: ['checkpoint:fixture'],
        },
      },
      fixture.fence,
    );
    expect(() =>
      appendVerifiedReceipt('event-receipt-unresolved-item', 'confirmed', ['manual-review']),
    ).toThrow(/unresolved items/);

    fixture.store.close();
  });
});

function createFixture(now = () => new Date('2026-08-24T00:00:00.000Z'), ttlMs = 60_000) {
  const directory = temporaryDirectory();
  const databasePath = join(directory, 'kernel.sqlite');
  const store = new MissionStore(databasePath, { now });
  const entitySet = entities('workspace-1');
  const fence = store.acquireWorkspaceLease(entitySet.mission.workspaceKey, 'runner-a', {
    ttlMs,
  });
  return { store, databasePath, fence, ...entitySet };
}

function entities(workspaceKey: string): {
  mission: MissionV1;
  contract: ContractV1;
  profile: ProfileV1;
  creation: Parameters<MissionStore['createMission']>[0];
} {
  const contract: ContractV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    contractId: 'contract-1',
    objective: 'Persist and resume one Mission',
    acceptanceCriteria: [
      {
        criterionId: 'events-restored',
        description: 'The event chain survives a process restart',
        verifier: { kind: 'kernel-query', configuration: { minimumEvents: 2 } },
      },
    ],
    createdAt: '2026-08-24T00:00:00.000Z',
  };
  const profile: ProfileV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: 'profile-codex',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    capabilities: ['workspace-write'],
    configurationDigest: 'a'.repeat(64),
  };
  const mission: MissionV1 = {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    missionId: `mission-${workspaceKey}`,
    title: 'E0 restart fixture',
    workspaceKey,
    contractId: contract.contractId,
    initialProfileId: profile.profileId,
    rootBranchId: `branch-root-${workspaceKey}`,
    status: 'pending',
    createdAt: '2026-08-24T00:00:00.000Z',
  };
  return {
    mission,
    contract,
    profile,
    creation: {
      eventId: `event-create-${workspaceKey}`,
      occurredAt: mission.createdAt,
      mission,
      contract,
      profile,
    },
  };
}

function statusEvent(
  missionId: string,
  eventId: string,
  status: 'running' | 'waiting',
  occurredAt: string,
): EventV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId,
    missionId,
    occurredAt,
    type: 'mission.status_changed',
    payload: { status },
  };
}

function creationEvent(
  input: Parameters<MissionStore['createMission']>[0],
): Extract<EventV1, { type: 'mission.created' }> {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    eventId: input.eventId,
    missionId: input.mission.missionId,
    occurredAt: input.occurredAt,
    type: 'mission.created',
    payload: {
      mission: input.mission,
      contract: input.contract,
      profile: input.profile,
    },
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'missionbraid-store-'));
  disposableDirectories.push(directory);
  return directory;
}
