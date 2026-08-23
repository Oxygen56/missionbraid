/**
 * Version 1 of the authoritative Mission Kernel domain contract.
 *
 * These types intentionally contain references and digests rather than secrets.
 * Runtime credentials stay behind adapters and must never enter an event payload.
 */

export const DOMAIN_SCHEMA_VERSION = 1 as const;

export type Sha256 = string;
export type IsoTimestamp = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MissionStatusV1 =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AcceptanceCriterionV1 {
  readonly criterionId: string;
  readonly description: string;
  readonly verifier: {
    readonly kind: string;
    readonly configuration: { readonly [key: string]: JsonValue };
  };
}

export interface ContractV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly contractId: string;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionV1[];
  readonly createdAt: IsoTimestamp;
}

export interface ProfileV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly profileId: string;
  readonly harness: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly runtimeVersion?: string;
  readonly injectionBudgetTokens?: number;
  readonly permissionMode?: string;
  readonly capabilities: readonly string[];
  /** Digest of non-secret runtime configuration visible to the planner. */
  readonly configurationDigest: Sha256;
}

export interface MissionV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly missionId: string;
  readonly title: string;
  /** Stable, caller-defined identity for a disposable or real workspace. */
  readonly workspaceKey: string;
  readonly contractId: string;
  readonly initialProfileId: string;
  readonly status: MissionStatusV1;
  readonly createdAt: IsoTimestamp;
}

export type AttemptStatusV1 = 'running' | 'handing_off' | 'succeeded' | 'failed' | 'abandoned';

export interface AttemptV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly attemptId: string;
  readonly missionId: string;
  readonly profileId: string;
  readonly stageId?: string;
  readonly status: AttemptStatusV1;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly continuedFromAttemptId?: string;
}

export type EffectStatusV1 =
  | 'intended'
  | 'dispatch_started'
  | 'executed'
  | 'confirmed'
  | 'skipped'
  | 'ambiguous'
  | 'conflict'
  | 'failed';

export interface EffectV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly effectId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly resourceKey: string;
  readonly controlLevel?: 'enforced' | 'guarded' | 'advisory';
  readonly status: EffectStatusV1;
  /** Reference to authority held outside the Kernel; never the authority itself. */
  readonly authorityRef?: string;
  readonly idempotencyKey?: string;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: IsoTimestamp;
}

export interface VerificationResultV1 {
  readonly criterionId: string;
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly evidenceRefs: readonly string[];
  readonly detail?: string;
}

export interface ReceiptEffectResultV1 {
  readonly effectId: string;
  readonly status: EffectStatusV1;
  readonly controlLevel: 'enforced' | 'guarded' | 'advisory';
  readonly kind: string;
  readonly resourceKey: string;
  readonly evidenceRefs: readonly string[];
}

export interface ReceiptV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly outcome: 'verified' | 'rejected';
  readonly verifications: readonly VerificationResultV1[];
  /** Event-chain head verified before this receipt was issued. */
  readonly verifiedHeadHash: Sha256;
  readonly verifiedThroughSeq: number;
  readonly attemptIds?: readonly string[];
  readonly handoffIds?: readonly string[];
  readonly effectIds?: readonly string[];
  readonly effects?: readonly ReceiptEffectResultV1[];
  readonly unresolvedItems?: readonly string[];
  readonly issuedAt: IsoTimestamp;
}

export interface MissionCreatedPayloadV1 {
  readonly mission: MissionV1;
  readonly contract: ContractV1;
  readonly profile: ProfileV1;
}

export interface MissionStatusChangedPayloadV1 {
  readonly status: MissionStatusV1;
  readonly reason?: string;
}

export interface AttemptStartedPayloadV1 {
  readonly attempt: AttemptV1;
}

export interface AttemptFinishedPayloadV1 {
  readonly attemptId: string;
  readonly status: Extract<AttemptStatusV1, 'succeeded' | 'failed' | 'abandoned'>;
  readonly endedAt: IsoTimestamp;
  readonly summary?: string;
}

export interface ProfileSelectedPayloadV1 {
  readonly profile: ProfileV1;
  readonly reason: string;
}

export interface EffectRecordedPayloadV1 {
  readonly effect: EffectV1;
}

export interface EffectStatusChangedPayloadV1 {
  readonly effectId: string;
  readonly status: EffectStatusV1;
  readonly evidenceRefs: readonly string[];
}

export interface ReceiptIssuedPayloadV1 {
  readonly receipt: ReceiptV1;
}

export interface RuntimeObservationPayloadV1 {
  readonly kind: string;
  readonly data: JsonValue;
}

export interface MissionEventPayloadsV1 {
  readonly 'mission.created': MissionCreatedPayloadV1;
  readonly 'mission.status_changed': MissionStatusChangedPayloadV1;
  readonly 'attempt.started': AttemptStartedPayloadV1;
  readonly 'attempt.finished': AttemptFinishedPayloadV1;
  readonly 'profile.selected': ProfileSelectedPayloadV1;
  readonly 'effect.recorded': EffectRecordedPayloadV1;
  readonly 'effect.status_changed': EffectStatusChangedPayloadV1;
  readonly 'receipt.issued': ReceiptIssuedPayloadV1;
  readonly 'runtime.observation': RuntimeObservationPayloadV1;
}

export type MissionEventTypeV1 = keyof MissionEventPayloadsV1;

export type EventV1 = {
  [Type in MissionEventTypeV1]: {
    readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
    readonly eventId: string;
    readonly missionId: string;
    readonly attemptId?: string;
    readonly occurredAt: IsoTimestamp;
    readonly type: Type;
    readonly payload: MissionEventPayloadsV1[Type];
  };
}[MissionEventTypeV1];

export type StoredEventV1 = EventV1 & {
  readonly seq: number;
  readonly recordedAt: IsoTimestamp;
  readonly payloadHash: Sha256;
  readonly prevHash: Sha256 | null;
  readonly hash: Sha256;
};

export interface MissionProjectionV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly missionId: string;
  readonly workspaceKey: string;
  readonly title: string;
  readonly status: MissionStatusV1;
  readonly contract: ContractV1;
  readonly activeProfile: ProfileV1;
  readonly lastSeq: number;
  readonly headHash: Sha256;
  readonly receipt?: ReceiptV1;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface WorkspaceLeaseV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly workspaceKey: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface WorkspaceFenceV1 {
  readonly workspaceKey: string;
  readonly ownerId: string;
  readonly fencingToken: number;
}

export interface AppendEventResultV1 {
  readonly inserted: boolean;
  readonly event: StoredEventV1;
}

// Descriptive aliases used by higher layers.
export type OutcomeContractV1 = ContractV1;
export type RuntimeProfileV1 = ProfileV1;
export type MissionEventV1 = EventV1;
export type OutcomeReceiptV1 = ReceiptV1;
