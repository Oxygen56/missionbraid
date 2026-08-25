import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DOMAIN_SCHEMA_VERSION,
  type AppendEventResultV1,
  type ContractV1,
  type EffectV1,
  type EventV1,
  type MissionProjectionV1,
  type MissionCommandActionV1,
  type MissionCommandStatusV1,
  type MissionCommandV1,
  type MissionStatusV1,
  type ProfileV1,
  type ReceiptV1,
  type Sha256,
  type StoredEventV1,
  type WorkspaceFenceV1,
  type WorkspaceLeaseV1,
} from './domain.js';

const STORE_SCHEMA_VERSION = 2;
const DEFAULT_LEASE_TTL_MS = 30_000;

type SqlRow = Record<string, unknown>;

interface MissionRow extends SqlRow {
  mission_id: string;
  workspace_key: string;
  root_branch_id: string | null;
  title: string;
  status: MissionStatusV1;
  contract_json: string;
  profile_json: string;
  receipt_json: string | null;
  last_seq: number;
  head_hash: string;
  created_at: string;
  updated_at: string;
}

interface CommandRow extends SqlRow {
  command_id: string;
  mission_id: string;
  branch_id: string;
  action: MissionCommandActionV1;
  idempotency_key: string;
  expected_head_hash: string;
  status: MissionCommandStatusV1;
  claim_owner: string | null;
  claim_until_ms: number | null;
  dispatch_count: number;
  accepted_at: string;
  updated_at: string;
  last_error: string | null;
}

interface EventRow extends SqlRow {
  schema_version: number;
  event_id: string;
  mission_id: string;
  attempt_id: string | null;
  seq: number;
  event_type: EventV1['type'];
  occurred_at: string;
  recorded_at: string;
  payload_json: string;
  payload_hash: string;
  prev_hash: string | null;
  event_hash: string;
}

interface LeaseRow extends SqlRow {
  workspace_key: string;
  owner_id: string;
  fencing_token: number;
  acquired_at_ms: number;
  lease_until_ms: number;
}

export class MissionStoreError extends Error {}

export class EventIdentityConflictError extends MissionStoreError {}

export class MissionInvariantError extends MissionStoreError {}

export class WorkspaceLeaseConflictError extends MissionStoreError {}

export class StaleFencingTokenError extends MissionStoreError {}

export class CredentialMaterialError extends MissionStoreError {}

export interface MissionStoreOptions {
  readonly now?: () => Date;
}

export interface AcquireLeaseOptions {
  readonly ttlMs?: number;
}

export interface AcceptMissionCommandInput {
  readonly commandId: string;
  readonly eventId: string;
  readonly missionId: string;
  readonly action: MissionCommandActionV1;
  readonly idempotencyKey: string;
  readonly expectedHeadHash: Sha256;
  readonly occurredAt: string;
}

export interface ClaimMissionCommandOptions {
  readonly claimTtlMs?: number;
}

/**
 * Single-process SQLite implementation of the authoritative Mission event log.
 * SQLite's WAL plus BEGIN IMMEDIATE serializes sequence allocation and projection.
 */
export class MissionStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  #closed = false;

  constructor(databasePath: string, options: MissionStoreOptions = {}) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.#now = options.now ?? (() => new Date());
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA foreign_keys = ON;');
    this.#database.exec('PRAGMA busy_timeout = 5000;');
    this.#database.exec('PRAGMA journal_mode = WAL;');
    this.#migrate();
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  acquireWorkspaceLease(
    workspaceKey: string,
    ownerId: string,
    options: AcquireLeaseOptions = {},
  ): WorkspaceLeaseV1 {
    assertIdentifier('workspaceKey', workspaceKey);
    assertIdentifier('ownerId', ownerId);
    const ttlMs = assertTtl(options.ttlMs ?? DEFAULT_LEASE_TTL_MS);
    const nowMs = this.#now().getTime();

    return this.#transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT workspace_key, owner_id, fencing_token, acquired_at_ms, lease_until_ms
             FROM workspace_leases
            WHERE workspace_key = ?`,
        )
        .get(workspaceKey) as LeaseRow | undefined;

      if (existing !== undefined && existing.lease_until_ms > nowMs) {
        if (existing.owner_id !== ownerId) {
          throw new WorkspaceLeaseConflictError(
            `Workspace ${workspaceKey} is leased by ${existing.owner_id}`,
          );
        }

        const leaseUntilMs = nowMs + ttlMs;
        this.#database
          .prepare(
            `UPDATE workspace_leases
                SET lease_until_ms = ?
              WHERE workspace_key = ? AND owner_id = ? AND fencing_token = ?`,
          )
          .run(leaseUntilMs, workspaceKey, ownerId, existing.fencing_token);
        return leaseFromRow({ ...existing, lease_until_ms: leaseUntilMs });
      }

      const fencingToken = (existing?.fencing_token ?? 0) + 1;
      const leaseUntilMs = nowMs + ttlMs;
      this.#database
        .prepare(
          `INSERT INTO workspace_leases (
             workspace_key, owner_id, fencing_token, acquired_at_ms, lease_until_ms
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(workspace_key) DO UPDATE SET
             owner_id = excluded.owner_id,
             fencing_token = excluded.fencing_token,
             acquired_at_ms = excluded.acquired_at_ms,
             lease_until_ms = excluded.lease_until_ms`,
        )
        .run(workspaceKey, ownerId, fencingToken, nowMs, leaseUntilMs);

      return leaseFromRow({
        workspace_key: workspaceKey,
        owner_id: ownerId,
        fencing_token: fencingToken,
        acquired_at_ms: nowMs,
        lease_until_ms: leaseUntilMs,
      });
    });
  }

  renewWorkspaceLease(
    fence: WorkspaceFenceV1,
    options: AcquireLeaseOptions = {},
  ): WorkspaceLeaseV1 {
    const ttlMs = assertTtl(options.ttlMs ?? DEFAULT_LEASE_TTL_MS);
    const nowMs = this.#now().getTime();

    return this.#transaction(() => {
      const existing = this.#assertFence(fence, nowMs);
      const leaseUntilMs = nowMs + ttlMs;
      this.#database
        .prepare(
          `UPDATE workspace_leases SET lease_until_ms = ?
            WHERE workspace_key = ? AND owner_id = ? AND fencing_token = ?`,
        )
        .run(leaseUntilMs, fence.workspaceKey, fence.ownerId, fence.fencingToken);
      return leaseFromRow({
        workspace_key: fence.workspaceKey,
        owner_id: fence.ownerId,
        fencing_token: fence.fencingToken,
        acquired_at_ms: existing.acquired_at_ms,
        lease_until_ms: leaseUntilMs,
      });
    });
  }

  releaseWorkspaceLease(fence: WorkspaceFenceV1): void {
    const nowMs = this.#now().getTime();
    this.#transaction(() => {
      this.#assertFence(fence, nowMs);
      this.#database
        .prepare(
          `UPDATE workspace_leases SET lease_until_ms = 0
            WHERE workspace_key = ? AND owner_id = ? AND fencing_token = ?`,
        )
        .run(fence.workspaceKey, fence.ownerId, fence.fencingToken);
    });
  }

  getWorkspaceLease(workspaceKey: string): WorkspaceLeaseV1 | undefined {
    const row = this.#database
      .prepare(
        `SELECT workspace_key, owner_id, fencing_token, acquired_at_ms, lease_until_ms
           FROM workspace_leases
          WHERE workspace_key = ?`,
      )
      .get(workspaceKey) as LeaseRow | undefined;
    return row === undefined ? undefined : leaseFromRow(row);
  }

  createMission(
    input: {
      readonly eventId: string;
      readonly occurredAt: string;
      readonly mission: Extract<EventV1, { type: 'mission.created' }>['payload']['mission'];
      readonly contract: ContractV1;
      readonly profile: ProfileV1;
    },
    fence: WorkspaceFenceV1,
  ): AppendEventResultV1 {
    return this.appendEvent(
      {
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
      },
      fence,
    );
  }

  appendEvent(event: EventV1, fence: WorkspaceFenceV1): AppendEventResultV1 {
    return this.appendEvents([event], fence)[0]!;
  }

  /**
   * Append one per-Mission event batch under a single SQLite transaction.
   * Either every new event and its projection are committed, or none are.
   */
  appendEvents(events: readonly EventV1[], fence: WorkspaceFenceV1): AppendEventResultV1[] {
    if (events.length === 0) return [];
    const missionId = events[0]!.missionId;
    const prepared = events.map((event) => {
      assertEventEnvelope(event);
      if (event.missionId !== missionId) {
        throw new MissionInvariantError('An atomic event batch must belong to one Mission');
      }
      assertNoCredentialMaterial(event.payload);
      const canonicalPayload = canonicalJson(event.payload);
      return { event, canonicalPayload, payloadHash: sha256(canonicalPayload) };
    });
    const now = this.#now();

    return this.#transaction(() => {
      this.#assertFence(fence, now.getTime());
      return prepared.map(({ event, canonicalPayload, payloadHash }) =>
        this.#appendEventInTransaction(event, canonicalPayload, payloadHash, fence, now),
      );
    });
  }

  #appendEventInTransaction(
    event: EventV1,
    canonicalPayload: string,
    payloadHash: Sha256,
    fence: WorkspaceFenceV1,
    now: Date,
  ): AppendEventResultV1 {
    const existing = this.#findEventById(event.eventId);
    if (existing !== undefined) {
      this.#assertIdempotentReplay(existing, event, payloadHash);
      return { inserted: false, event: existing };
    }

    const projection = this.getMission(event.missionId);
    let workspaceKey: string;
    let nextSeq: number;
    let prevHash: Sha256 | null;

    if (event.type === 'mission.created') {
      this.#assertMissionCreated(event, projection);
      workspaceKey = event.payload.mission.workspaceKey;
      nextSeq = 1;
      prevHash = null;
    } else {
      if (projection === undefined) {
        throw new MissionInvariantError(`Mission ${event.missionId} does not exist`);
      }
      workspaceKey = projection.workspaceKey;
      nextSeq = projection.lastSeq + 1;
      prevHash = projection.headHash;
    }

    if (fence.workspaceKey !== workspaceKey) {
      throw new MissionInvariantError(
        `Fence workspace ${fence.workspaceKey} does not own mission workspace ${workspaceKey}`,
      );
    }

    const recordedAt = now.toISOString();
    const hash = computeEventHash({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      missionId: event.missionId,
      attemptId: event.attemptId ?? null,
      seq: nextSeq,
      type: event.type,
      occurredAt: event.occurredAt,
      recordedAt,
      payloadHash,
      prevHash,
    });

    this.#database
      .prepare(
        `INSERT INTO mission_events (
             schema_version, event_id, mission_id, attempt_id, seq, event_type,
             occurred_at, recorded_at, payload_json, payload_hash, prev_hash, event_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.schemaVersion,
        event.eventId,
        event.missionId,
        event.attemptId ?? null,
        nextSeq,
        event.type,
        event.occurredAt,
        recordedAt,
        canonicalPayload,
        payloadHash,
        prevHash,
        hash,
      );

    const stored = {
      ...event,
      seq: nextSeq,
      recordedAt,
      payloadHash,
      prevHash,
      hash,
    } as StoredEventV1;
    this.#project(stored, projection);
    return { inserted: true, event: stored };
  }

  getMission(missionId: string): MissionProjectionV1 | undefined {
    const row = this.#database
      .prepare(
        `SELECT mission_id, workspace_key, root_branch_id, title, status, contract_json, profile_json,
                receipt_json, last_seq, head_hash, created_at, updated_at
           FROM missions
          WHERE mission_id = ?`,
      )
      .get(missionId) as MissionRow | undefined;
    return row === undefined ? undefined : missionFromRow(row);
  }

  listMissions(): MissionProjectionV1[] {
    const rows = this.#database
      .prepare(
        `SELECT mission_id, workspace_key, root_branch_id, title, status, contract_json, profile_json,
                receipt_json, last_seq, head_hash, created_at, updated_at
           FROM missions
          ORDER BY created_at ASC, mission_id ASC`,
      )
      .all() as unknown as MissionRow[];
    return rows.map(missionFromRow);
  }

  getEvent(eventId: string): StoredEventV1 | undefined {
    return this.#findEventById(eventId);
  }

  listEvents(missionId: string): StoredEventV1[] {
    const rows = this.#database
      .prepare(
        `SELECT schema_version, event_id, mission_id, attempt_id, seq, event_type,
                occurred_at, recorded_at, payload_json, payload_hash, prev_hash, event_hash
           FROM mission_events
          WHERE mission_id = ?
          ORDER BY seq ASC`,
      )
      .all(missionId) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }

  /** Commit the authoritative command intent and its dispatch row together. */
  acceptCommand(input: AcceptMissionCommandInput, fence: WorkspaceFenceV1): MissionCommandV1 {
    assertIdentifier('commandId', input.commandId);
    assertIdentifier('idempotencyKey', input.idempotencyKey);
    const now = this.#now();
    return this.#transaction(() => {
      this.#assertFence(fence, now.getTime());
      const mission = this.getMission(input.missionId);
      if (mission === undefined) {
        throw new MissionInvariantError(`Mission ${input.missionId} does not exist`);
      }
      if (mission.workspaceKey !== fence.workspaceKey) {
        throw new MissionInvariantError('Command fence does not own the Mission workspace');
      }
      if (mission.rootBranchId === undefined) {
        throw new MissionInvariantError(
          'Legacy Mission has no Branch identity and cannot queue commands',
        );
      }
      const existing = this.#database
        .prepare(
          `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                  expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                  accepted_at, updated_at, last_error
             FROM mission_commands
            WHERE mission_id = ? AND idempotency_key = ?`,
        )
        .get(input.missionId, input.idempotencyKey) as CommandRow | undefined;
      if (existing !== undefined) {
        const command = commandFromRow(existing);
        if (
          command.commandId !== input.commandId ||
          command.action !== input.action ||
          command.expectedHeadHash !== input.expectedHeadHash
        ) {
          throw new EventIdentityConflictError(
            `Command idempotency key ${input.idempotencyKey} was reused for different intent`,
          );
        }
        return command;
      }
      if (mission.headHash !== input.expectedHeadHash) {
        throw new MissionInvariantError('Command expectedHeadHash is stale');
      }

      const acceptedAt = input.occurredAt;
      const command: MissionCommandV1 = {
        commandId: input.commandId,
        missionId: input.missionId,
        branchId: mission.rootBranchId,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        expectedHeadHash: input.expectedHeadHash,
        status: 'pending',
        acceptedAt,
        updatedAt: acceptedAt,
        dispatchCount: 0,
      };
      const event: EventV1 = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: input.eventId,
        missionId: input.missionId,
        occurredAt: input.occurredAt,
        type: 'command.accepted',
        payload: { command },
      };
      assertEventEnvelope(event);
      assertNoCredentialMaterial(event.payload);
      const canonicalPayload = canonicalJson(event.payload);
      const appended = this.#appendEventInTransaction(
        event,
        canonicalPayload,
        sha256(canonicalPayload),
        fence,
        now,
      );
      this.#database
        .prepare(
          `INSERT INTO mission_commands (
             command_id, mission_id, branch_id, action, idempotency_key, expected_head_hash,
             status, claim_owner, claim_until_ms, dispatch_count, accepted_at, updated_at, last_error
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?, NULL)`,
        )
        .run(
          command.commandId,
          command.missionId,
          command.branchId,
          command.action,
          command.idempotencyKey,
          command.expectedHeadHash,
          command.acceptedAt,
          appended.event.recordedAt,
        );
      return { ...command, updatedAt: appended.event.recordedAt };
    });
  }

  getCommand(commandId: string): MissionCommandV1 | undefined {
    const row = this.#database
      .prepare(
        `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                accepted_at, updated_at, last_error
           FROM mission_commands
          WHERE command_id = ?`,
      )
      .get(commandId) as CommandRow | undefined;
    return row === undefined ? undefined : commandFromRow(row);
  }

  listCommands(missionId?: string): MissionCommandV1[] {
    const rows = (missionId === undefined
      ? this.#database
          .prepare(
            `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                      expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                      accepted_at, updated_at, last_error
                 FROM mission_commands ORDER BY accepted_at ASC, command_id ASC`,
          )
          .all()
      : this.#database
          .prepare(
            `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                      expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                      accepted_at, updated_at, last_error
                 FROM mission_commands WHERE mission_id = ?
                 ORDER BY accepted_at ASC, command_id ASC`,
          )
          .all(missionId)) as unknown as CommandRow[];
    return rows.map(commandFromRow);
  }

  claimNextCommand(
    ownerId: string,
    options: ClaimMissionCommandOptions = {},
  ): MissionCommandV1 | undefined {
    assertIdentifier('ownerId', ownerId);
    const ttlMs = assertTtl(options.claimTtlMs ?? DEFAULT_LEASE_TTL_MS);
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                  expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                  accepted_at, updated_at, last_error
             FROM mission_commands
            WHERE status = 'pending'
               OR (status = 'dispatching' AND claim_until_ms <= ?)
            ORDER BY accepted_at ASC, command_id ASC
            LIMIT 1`,
        )
        .get(now.getTime()) as CommandRow | undefined;
      if (row === undefined) return undefined;
      const nextCount = row.dispatch_count + 1;
      this.#database
        .prepare(
          `UPDATE mission_commands
              SET status = 'dispatching', claim_owner = ?, claim_until_ms = ?,
                  dispatch_count = ?, updated_at = ?, last_error = NULL
            WHERE command_id = ?`,
        )
        .run(ownerId, now.getTime() + ttlMs, nextCount, now.toISOString(), row.command_id);
      return commandFromRow({
        ...row,
        status: 'dispatching',
        claim_owner: ownerId,
        claim_until_ms: now.getTime() + ttlMs,
        dispatch_count: nextCount,
        updated_at: now.toISOString(),
        last_error: null,
      });
    });
  }

  claimCommand(
    commandId: string,
    ownerId: string,
    options: ClaimMissionCommandOptions = {},
  ): MissionCommandV1 {
    assertIdentifier('ownerId', ownerId);
    const ttlMs = assertTtl(options.claimTtlMs ?? DEFAULT_LEASE_TTL_MS);
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                  expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                  accepted_at, updated_at, last_error
             FROM mission_commands WHERE command_id = ?`,
        )
        .get(commandId) as CommandRow | undefined;
      if (row === undefined) throw new MissionInvariantError(`Unknown command ${commandId}`);
      const claimable =
        row.status === 'pending' ||
        (row.status === 'dispatching' &&
          row.claim_until_ms !== null &&
          row.claim_until_ms <= now.getTime());
      if (!claimable) {
        throw new MissionInvariantError(`Command ${commandId} is not claimable`);
      }
      const nextCount = row.dispatch_count + 1;
      this.#database
        .prepare(
          `UPDATE mission_commands
              SET status = 'dispatching', claim_owner = ?, claim_until_ms = ?,
                  dispatch_count = ?, updated_at = ?, last_error = NULL
            WHERE command_id = ?`,
        )
        .run(ownerId, now.getTime() + ttlMs, nextCount, now.toISOString(), commandId);
      return commandFromRow({
        ...row,
        status: 'dispatching',
        claim_owner: ownerId,
        claim_until_ms: now.getTime() + ttlMs,
        dispatch_count: nextCount,
        updated_at: now.toISOString(),
        last_error: null,
      });
    });
  }

  renewCommandClaim(
    commandId: string,
    ownerId: string,
    options: ClaimMissionCommandOptions = {},
  ): MissionCommandV1 {
    const ttlMs = assertTtl(options.claimTtlMs ?? DEFAULT_LEASE_TTL_MS);
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                  expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                  accepted_at, updated_at, last_error
             FROM mission_commands WHERE command_id = ?`,
        )
        .get(commandId) as CommandRow | undefined;
      if (
        row === undefined ||
        row.status !== 'dispatching' ||
        row.claim_owner !== ownerId ||
        row.claim_until_ms === null ||
        row.claim_until_ms <= now.getTime()
      ) {
        throw new MissionInvariantError(`Command claim ${commandId}/${ownerId} is stale`);
      }
      this.#database
        .prepare(
          `UPDATE mission_commands SET claim_until_ms = ?, updated_at = ? WHERE command_id = ?`,
        )
        .run(now.getTime() + ttlMs, now.toISOString(), commandId);
      return commandFromRow({
        ...row,
        claim_until_ms: now.getTime() + ttlMs,
        updated_at: now.toISOString(),
      });
    });
  }

  recordCommandStatus(
    commandId: string,
    status: MissionCommandStatusV1,
    eventId: string,
    fence: WorkspaceFenceV1,
    detail?: string,
  ): MissionCommandV1 {
    const now = this.#now();
    return this.#transaction(() => {
      this.#assertFence(fence, now.getTime());
      const row = this.#database
        .prepare(
          `SELECT command_id, mission_id, branch_id, action, idempotency_key,
                  expected_head_hash, status, claim_owner, claim_until_ms, dispatch_count,
                  accepted_at, updated_at, last_error
             FROM mission_commands WHERE command_id = ?`,
        )
        .get(commandId) as CommandRow | undefined;
      if (row === undefined) throw new MissionInvariantError(`Unknown command ${commandId}`);
      const mission = this.getMission(row.mission_id);
      if (mission === undefined || mission.workspaceKey !== fence.workspaceKey) {
        throw new MissionInvariantError('Command fence does not own the Mission workspace');
      }
      if (row.status === 'completed' || row.status === 'failed') {
        if (row.status !== status) {
          throw new MissionInvariantError(`Command ${commandId} is already terminal`);
        }
        return commandFromRow(row);
      }
      const event: EventV1 = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId,
        missionId: row.mission_id,
        occurredAt: now.toISOString(),
        type: 'command.status_changed',
        payload: {
          commandId,
          status,
          dispatchCount: row.dispatch_count,
          ...(detail === undefined ? {} : { detail }),
        },
      };
      assertNoCredentialMaterial(event.payload);
      const canonicalPayload = canonicalJson(event.payload);
      const appended = this.#appendEventInTransaction(
        event,
        canonicalPayload,
        sha256(canonicalPayload),
        fence,
        now,
      );
      if (status === 'dispatching') {
        this.#database
          .prepare(
            `UPDATE mission_commands SET updated_at = ?, last_error = NULL WHERE command_id = ?`,
          )
          .run(appended.event.recordedAt, commandId);
      } else {
        this.#database
          .prepare(
            `UPDATE mission_commands
                SET status = ?, claim_owner = NULL, claim_until_ms = NULL,
                    updated_at = ?, last_error = ?
              WHERE command_id = ?`,
          )
          .run(
            status,
            appended.event.recordedAt,
            status === 'failed' ? (detail ?? 'Command failed') : null,
            commandId,
          );
      }
      return commandFromRow({
        ...row,
        status,
        claim_owner: status === 'dispatching' ? row.claim_owner : null,
        claim_until_ms: status === 'dispatching' ? row.claim_until_ms : null,
        updated_at: appended.event.recordedAt,
        last_error: status === 'failed' ? (detail ?? 'Command failed') : null,
      });
    });
  }

  verifyEventChain(missionId: string): {
    readonly valid: boolean;
    readonly checked: number;
    readonly headHash: Sha256 | null;
    readonly error?: string;
  } {
    const events = this.listEvents(missionId);
    let expectedPrevHash: Sha256 | null = null;

    for (const event of events) {
      if (event.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          checked: event.seq - 1,
          headHash: expectedPrevHash,
          error: `Event ${event.eventId} has an unexpected prevHash`,
        };
      }
      if (sha256(canonicalJson(event.payload)) !== event.payloadHash) {
        return {
          valid: false,
          checked: event.seq - 1,
          headHash: expectedPrevHash,
          error: `Event ${event.eventId} payload hash does not match`,
        };
      }
      const computedHash = computeEventHash({
        schemaVersion: event.schemaVersion,
        eventId: event.eventId,
        missionId: event.missionId,
        attemptId: event.attemptId ?? null,
        seq: event.seq,
        type: event.type,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        payloadHash: event.payloadHash,
        prevHash: event.prevHash,
      });
      if (computedHash !== event.hash) {
        return {
          valid: false,
          checked: event.seq - 1,
          headHash: expectedPrevHash,
          error: `Event ${event.eventId} hash does not match`,
        };
      }
      expectedPrevHash = event.hash;
    }

    const projection = this.getMission(missionId);
    if (
      projection !== undefined &&
      (projection.lastSeq !== events.length || projection.headHash !== expectedPrevHash)
    ) {
      return {
        valid: false,
        checked: events.length,
        headHash: expectedPrevHash,
        error: 'Mission projection head does not match its event chain',
      };
    }
    return { valid: true, checked: events.length, headHash: expectedPrevHash };
  }

  #migrate(): void {
    const version = this.#database.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (version.user_version > STORE_SCHEMA_VERSION) {
      throw new MissionStoreError(
        `Store schema ${version.user_version} is newer than supported ${STORE_SCHEMA_VERSION}`,
      );
    }

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS mission_events (
        schema_version INTEGER NOT NULL,
        event_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        attempt_id TEXT,
        seq INTEGER NOT NULL CHECK (seq > 0),
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        prev_hash TEXT,
        event_hash TEXT NOT NULL,
        UNIQUE (mission_id, seq)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS mission_events_mission_idx
        ON mission_events (mission_id, seq);

      CREATE TRIGGER IF NOT EXISTS mission_events_forbid_update
      BEFORE UPDATE ON mission_events
      BEGIN
        SELECT RAISE(ABORT, 'mission_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS mission_events_forbid_delete
      BEFORE DELETE ON mission_events
      BEGIN
        SELECT RAISE(ABORT, 'mission_events is append-only');
      END;

      CREATE TABLE IF NOT EXISTS missions (
        mission_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        root_branch_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        receipt_json TEXT,
        last_seq INTEGER NOT NULL CHECK (last_seq > 0),
        head_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workspace_leases (
        workspace_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        acquired_at_ms INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL
      ) STRICT;
    `);

    if (!this.#hasColumn('missions', 'root_branch_id')) {
      this.#database.exec('ALTER TABLE missions ADD COLUMN root_branch_id TEXT;');
    }
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS mission_commands (
        command_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('resume', 'verify')),
        idempotency_key TEXT NOT NULL,
        expected_head_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'completed', 'failed')),
        claim_owner TEXT,
        claim_until_ms INTEGER,
        dispatch_count INTEGER NOT NULL CHECK (dispatch_count >= 0),
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        UNIQUE (mission_id, idempotency_key),
        FOREIGN KEY (mission_id) REFERENCES missions (mission_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS mission_commands_dispatch_idx
        ON mission_commands (status, claim_until_ms, accepted_at);

      PRAGMA user_version = ${STORE_SCHEMA_VERSION};
    `);
  }

  #hasColumn(table: string, column: string): boolean {
    const rows = this.#database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === column);
  }

  #assertFence(fence: WorkspaceFenceV1, nowMs: number): LeaseRow {
    const row = this.#database
      .prepare(
        `SELECT workspace_key, owner_id, fencing_token, acquired_at_ms, lease_until_ms
           FROM workspace_leases
          WHERE workspace_key = ?`,
      )
      .get(fence.workspaceKey) as LeaseRow | undefined;
    if (
      row === undefined ||
      row.owner_id !== fence.ownerId ||
      row.fencing_token !== fence.fencingToken ||
      row.lease_until_ms <= nowMs
    ) {
      throw new StaleFencingTokenError(
        `Lease fence ${fence.workspaceKey}/${fence.ownerId}/${fence.fencingToken} is stale`,
      );
    }
    return row;
  }

  #assertMissionCreated(
    event: Extract<EventV1, { type: 'mission.created' }>,
    projection: MissionProjectionV1 | undefined,
  ): void {
    const { mission, contract, profile } = event.payload;
    if (projection !== undefined) {
      throw new MissionInvariantError(`Mission ${event.missionId} already exists`);
    }
    if (
      mission.missionId !== event.missionId ||
      mission.contractId !== contract.contractId ||
      mission.initialProfileId !== profile.profileId
    ) {
      throw new MissionInvariantError('Mission, contract, profile, and event identities disagree');
    }
    if (mission.status !== 'pending') {
      throw new MissionInvariantError('A new mission must start in pending status');
    }
    assertIdentifier('mission.rootBranchId', mission.rootBranchId);
  }

  #assertIdempotentReplay(
    existing: StoredEventV1,
    candidate: EventV1,
    candidatePayloadHash: Sha256,
  ): void {
    if (
      existing.schemaVersion !== candidate.schemaVersion ||
      existing.missionId !== candidate.missionId ||
      existing.attemptId !== candidate.attemptId ||
      existing.type !== candidate.type ||
      existing.occurredAt !== candidate.occurredAt ||
      existing.payloadHash !== candidatePayloadHash
    ) {
      throw new EventIdentityConflictError(
        `Event id ${candidate.eventId} was already used for different content`,
      );
    }
  }

  #project(event: StoredEventV1, current: MissionProjectionV1 | undefined): void {
    if (event.type === 'mission.created') {
      const { mission, contract, profile } = event.payload;
      this.#database
        .prepare(
          `INSERT INTO missions (
             mission_id, workspace_key, root_branch_id, title, status, contract_json, profile_json,
             receipt_json, last_seq, head_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          mission.missionId,
          mission.workspaceKey,
          mission.rootBranchId,
          mission.title,
          mission.status,
          canonicalJson(contract),
          canonicalJson(profile),
          event.seq,
          event.hash,
          mission.createdAt,
          event.recordedAt,
        );
      return;
    }

    if (current === undefined) {
      throw new MissionInvariantError(`Mission ${event.missionId} does not exist`);
    }

    let status = current.status;
    let profile = current.activeProfile;
    let receipt = current.receipt;

    switch (event.type) {
      case 'mission.status_changed':
        if (event.payload.status === 'succeeded') {
          throw new MissionInvariantError(
            'A Mission can only become succeeded through a verified receipt',
          );
        }
        status = event.payload.status;
        break;
      case 'attempt.started':
        if (event.payload.attempt.missionId !== event.missionId) {
          throw new MissionInvariantError('Attempt belongs to a different mission');
        }
        if (
          current.rootBranchId !== undefined &&
          event.payload.attempt.branchId !== current.rootBranchId
        ) {
          throw new MissionInvariantError('Iteration 2 Attempt must remain on the root Branch');
        }
        status = 'running';
        break;
      case 'branch.created':
        if (
          event.payload.branch.missionId !== event.missionId ||
          current.rootBranchId !== event.payload.branch.branchId
        ) {
          throw new MissionInvariantError('Root Branch identity does not match its Mission');
        }
        break;
      case 'attempt.bound':
        if (
          event.payload.binding.missionId !== event.missionId ||
          event.payload.binding.branchId !== current.rootBranchId
        ) {
          throw new MissionInvariantError('Attempt Binding does not match its Mission Branch');
        }
        break;
      case 'runtime.event':
        if (
          event.payload.event.missionId !== event.missionId ||
          event.payload.event.attemptId !== event.attemptId ||
          event.payload.event.branchId !== current.rootBranchId
        ) {
          throw new MissionInvariantError('Runtime event identities do not match the Mission');
        }
        break;
      case 'profile.selected':
        profile = event.payload.profile;
        break;
      case 'receipt.issued':
        if (
          event.payload.receipt.missionId !== event.missionId ||
          event.payload.receipt.contractId !== current.contract.contractId
        ) {
          throw new MissionInvariantError('Receipt belongs to a different mission or contract');
        }
        if (
          event.payload.receipt.rootBranchId !== undefined &&
          event.payload.receipt.rootBranchId !== current.rootBranchId
        ) {
          throw new MissionInvariantError('Receipt belongs to a different Branch');
        }
        receipt = event.payload.receipt;
        this.#assertReceipt(current, receipt);
        status = receipt.outcome === 'verified' ? 'succeeded' : 'failed';
        break;
      default:
        break;
    }

    this.#database
      .prepare(
        `UPDATE missions
            SET status = ?, profile_json = ?, receipt_json = ?, last_seq = ?,
                head_hash = ?, updated_at = ?
          WHERE mission_id = ?`,
      )
      .run(
        status,
        canonicalJson(profile),
        receipt === undefined ? null : canonicalJson(receipt),
        event.seq,
        event.hash,
        event.recordedAt,
        event.missionId,
      );
  }

  #assertReceipt(current: MissionProjectionV1, receipt: ReceiptV1): void {
    if (
      receipt.verifiedThroughSeq !== current.lastSeq ||
      receipt.verifiedHeadHash !== current.headHash
    ) {
      throw new MissionInvariantError(
        'Receipt must bind to the current pre-receipt event-chain head',
      );
    }
    const hasRecordedEffects = this.listEvents(current.missionId).some(
      (event) => event.type === 'effect.recorded',
    );
    if (hasRecordedEffects && receipt.effects === undefined) {
      throw new MissionInvariantError('Receipt must disclose every recorded Effect');
    }
    if (receipt.effects !== undefined) {
      const recorded = new Map<string, EffectV1>();
      const statuses = new Map<
        string,
        { status: EffectV1['status']; evidenceRefs: readonly string[] }
      >();
      for (const event of this.listEvents(current.missionId)) {
        if (event.type === 'effect.recorded') {
          recorded.set(event.payload.effect.effectId, event.payload.effect);
          statuses.set(event.payload.effect.effectId, {
            status: event.payload.effect.status,
            evidenceRefs: event.payload.effect.evidenceRefs,
          });
        } else if (event.type === 'effect.status_changed') {
          statuses.set(event.payload.effectId, {
            status: event.payload.status,
            evidenceRefs: event.payload.evidenceRefs,
          });
        }
      }
      const disclosed = new Map(receipt.effects.map((effect) => [effect.effectId, effect]));
      if (disclosed.size !== receipt.effects.length || disclosed.size !== recorded.size) {
        throw new MissionInvariantError('Receipt must disclose every Effect exactly once');
      }
      for (const [effectId, effect] of recorded) {
        const disclosure = disclosed.get(effectId);
        const latest = statuses.get(effectId);
        if (
          disclosure === undefined ||
          latest === undefined ||
          disclosure.status !== latest.status ||
          disclosure.kind !== effect.kind ||
          disclosure.resourceKey !== effect.resourceKey ||
          disclosure.controlLevel !== (effect.controlLevel ?? 'advisory') ||
          canonicalJson(disclosure.evidenceRefs) !== canonicalJson(latest.evidenceRefs)
        ) {
          throw new MissionInvariantError(`Receipt Effect disclosure does not match ${effectId}`);
        }
      }
      if (
        receipt.effectIds === undefined ||
        canonicalJson([...receipt.effectIds].sort()) !== canonicalJson([...recorded.keys()].sort())
      ) {
        throw new MissionInvariantError('Receipt effectIds do not match its Effect disclosures');
      }
    }

    if (receipt.outcome !== 'verified') return;

    const unresolvedEffectStatuses = new Set([
      'intended',
      'dispatch_started',
      'executed',
      'ambiguous',
      'conflict',
    ]);
    if (receipt.effects?.some((effect) => unresolvedEffectStatuses.has(effect.status)) === true) {
      throw new MissionInvariantError('A verified receipt cannot contain unresolved Effects');
    }
    if ((receipt.unresolvedItems?.length ?? 0) > 0) {
      throw new MissionInvariantError('A verified receipt cannot contain unresolved items');
    }

    const results = new Map(receipt.verifications.map((result) => [result.criterionId, result]));
    if (results.size !== receipt.verifications.length) {
      throw new MissionInvariantError('Receipt contains duplicate verification criteria');
    }
    const expectedIds = new Set(
      current.contract.acceptanceCriteria.map((criterion) => criterion.criterionId),
    );
    if (
      results.size !== expectedIds.size ||
      [...expectedIds].some((criterionId) => results.get(criterionId)?.status !== 'passed')
    ) {
      throw new MissionInvariantError(
        'A verified receipt must pass every contracted acceptance criterion exactly once',
      );
    }
  }

  #findEventById(eventId: string): StoredEventV1 | undefined {
    const row = this.#database
      .prepare(
        `SELECT schema_version, event_id, mission_id, attempt_id, seq, event_type,
                occurred_at, recorded_at, payload_json, payload_hash, prev_hash, event_hash
           FROM mission_events
          WHERE event_id = ?`,
      )
      .get(eventId) as EventRow | undefined;
    return row === undefined ? undefined : eventFromRow(row);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.#database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function hashPayload(payload: unknown): Sha256 {
  return sha256(canonicalJson(payload));
}

export function computeEventHash(input: {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly missionId: string;
  readonly attemptId: string | null;
  readonly seq: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly payloadHash: Sha256;
  readonly prevHash: Sha256 | null;
}): Sha256 {
  return sha256(canonicalJson(input));
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new MissionInvariantError('Canonical JSON forbids non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const member = record[key];
        if (member === undefined) {
          throw new MissionInvariantError(`Canonical JSON forbids undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${canonicalize(member)}`;
      })
      .join(',')}}`;
  }
  throw new MissionInvariantError(`Value of type ${typeof value} is not canonical JSON`);
}

function sha256(value: string): Sha256 {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertNoCredentialMaterial(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((member, index) => assertNoCredentialMaterial(member, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'string') {
    if (looksLikeCredentialValue(value)) {
      throw new CredentialMaterialError(`Credential-like value at ${path} cannot be persisted`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const blockedSuffixes = [
    'apikey',
    'authorization',
    'credential',
    'credentials',
    'password',
    'passwd',
    'privatekey',
    'refreshtoken',
    'secret',
    'accesstoken',
    'token',
  ];
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    if (blockedSuffixes.some((suffix) => normalizedKey.endsWith(suffix))) {
      throw new CredentialMaterialError(`Credential-like field ${path}.${key} cannot be persisted`);
    }
    assertNoCredentialMaterial(member, `${path}.${key}`);
  }
}

function looksLikeCredentialValue(value: string): boolean {
  return [
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*[^\s,;]+/i,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/i,
    /\b(?:ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/i,
    /\bAKIA[A-Z0-9]{12,}\b/,
  ].some((pattern) => pattern.test(value));
}

function assertEventEnvelope(event: EventV1): void {
  if (event.schemaVersion !== DOMAIN_SCHEMA_VERSION) {
    throw new MissionInvariantError(`Unsupported event schema ${event.schemaVersion as number}`);
  }
  assertIdentifier('eventId', event.eventId);
  assertIdentifier('missionId', event.missionId);
  if (!Number.isFinite(Date.parse(event.occurredAt))) {
    throw new MissionInvariantError('occurredAt must be an ISO-compatible timestamp');
  }
}

function assertIdentifier(name: string, value: string): void {
  if (value.trim().length === 0) throw new MissionInvariantError(`${name} cannot be empty`);
}

function assertTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new MissionInvariantError('Lease ttlMs must be a positive safe integer');
  }
  return ttlMs;
}

function eventFromRow(row: EventRow): StoredEventV1 {
  return {
    schemaVersion: row.schema_version as typeof DOMAIN_SCHEMA_VERSION,
    eventId: row.event_id,
    missionId: row.mission_id,
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    seq: row.seq,
    type: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    payload: JSON.parse(row.payload_json) as EventV1['payload'],
    payloadHash: row.payload_hash,
    prevHash: row.prev_hash,
    hash: row.event_hash,
  } as StoredEventV1;
}

function missionFromRow(row: MissionRow): MissionProjectionV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    missionId: row.mission_id,
    workspaceKey: row.workspace_key,
    ...(row.root_branch_id === null ? {} : { rootBranchId: row.root_branch_id }),
    title: row.title,
    status: row.status,
    contract: JSON.parse(row.contract_json) as ContractV1,
    activeProfile: JSON.parse(row.profile_json) as ProfileV1,
    lastSeq: row.last_seq,
    headHash: row.head_hash,
    ...(row.receipt_json === null ? {} : { receipt: JSON.parse(row.receipt_json) as ReceiptV1 }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commandFromRow(row: CommandRow): MissionCommandV1 {
  return {
    commandId: row.command_id,
    missionId: row.mission_id,
    branchId: row.branch_id,
    action: row.action,
    idempotencyKey: row.idempotency_key,
    expectedHeadHash: row.expected_head_hash,
    status: row.status,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    dispatchCount: row.dispatch_count,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function leaseFromRow(row: LeaseRow): WorkspaceLeaseV1 {
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    workspaceKey: row.workspace_key,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    acquiredAt: new Date(row.acquired_at_ms).toISOString(),
    expiresAt: new Date(row.lease_until_ms).toISOString(),
  };
}
