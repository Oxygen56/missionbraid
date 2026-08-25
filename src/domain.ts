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
  /** Reusable intent that produced this immutable Attempt-time snapshot. */
  readonly definition?: RuntimeProfileDefinitionV1;
  /** Runtime inventory fact used while resolving this snapshot. */
  readonly catalogObservation?: RuntimeCatalogObservationV1;
  /** Effective, non-secret values. Anything the Harness cannot expose stays explicit. */
  readonly effective?: RuntimeProfileEffectiveV1;
  readonly adapterCapabilities?: AdapterCapabilitiesV1;
  readonly resolvedAt?: IsoTimestamp;
}

export type RuntimeFieldV1<T extends JsonValue = JsonValue> =
  | { readonly status: 'known'; readonly value: T; readonly source: string }
  | {
      readonly status: 'partial';
      readonly value: T;
      readonly source: string;
      readonly reason: string;
    }
  | { readonly status: 'unknown' | 'unsupported'; readonly reason: string };

export interface RuntimeCatalogObservationV1 {
  readonly observationId: string;
  readonly harness: string;
  readonly executablePath: string | null;
  readonly availability: 'ready' | 'unavailable' | 'missing';
  readonly version: string | null;
  readonly authentication: RuntimeFieldV1;
  readonly quota: RuntimeFieldV1;
  readonly cost: RuntimeFieldV1;
  readonly observedAt: IsoTimestamp;
}

export interface RuntimeProfileDefinitionV1 {
  readonly definitionId: string;
  readonly harness: string;
  readonly requestedModel: string;
  readonly requestedReasoningEffort?: string;
  readonly permissionCeiling?: string;
  readonly injectionBudgetTokens?: number;
}

export interface RuntimeProfileEffectiveV1 {
  readonly model: RuntimeFieldV1;
  readonly reasoningEffort: RuntimeFieldV1;
  readonly instructions: RuntimeFieldV1;
  readonly skills: RuntimeFieldV1;
  readonly mcpServers: RuntimeFieldV1;
  readonly tools: RuntimeFieldV1;
  readonly permissions: RuntimeFieldV1;
  readonly contextWindowTokens: RuntimeFieldV1;
  readonly session: RuntimeFieldV1;
  readonly availability: RuntimeFieldV1;
  readonly quota: RuntimeFieldV1;
  readonly cost: RuntimeFieldV1;
}

export type RuntimeCapabilityFidelityV1 =
  | 'native'
  | 'cooperative'
  | 'process-only'
  | 'unsupported'
  | 'unknown';

export interface AdapterCapabilitiesV1 {
  readonly observe: RuntimeCapabilityFidelityV1;
  readonly contextCapture: RuntimeCapabilityFidelityV1;
  readonly steer: RuntimeCapabilityFidelityV1;
  readonly interrupt: RuntimeCapabilityFidelityV1;
  readonly preToolGate: RuntimeCapabilityFidelityV1;
  readonly resume: RuntimeCapabilityFidelityV1;
  readonly nativeFork: RuntimeCapabilityFidelityV1;
  readonly workspaceRestore: RuntimeCapabilityFidelityV1;
  readonly externalEffectControl: RuntimeCapabilityFidelityV1;
}

export interface MissionV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly missionId: string;
  readonly title: string;
  /** Stable, caller-defined identity for a disposable or real workspace. */
  readonly workspaceKey: string;
  readonly contractId: string;
  readonly initialProfileId: string;
  readonly rootBranchId: string;
  readonly status: MissionStatusV1;
  readonly createdAt: IsoTimestamp;
}

export interface BranchV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly branchId: string;
  readonly missionId: string;
  readonly parentBranchId?: string;
  readonly baseCheckpointId?: string;
  readonly status: 'active' | 'closed';
  readonly createdAt: IsoTimestamp;
}

export type AttemptStatusV1 = 'running' | 'handing_off' | 'succeeded' | 'failed' | 'abandoned';

export interface AttemptV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly attemptId: string;
  readonly missionId: string;
  readonly branchId: string;
  readonly profileId: string;
  readonly stageId?: string;
  readonly status: AttemptStatusV1;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly continuedFromAttemptId?: string;
}

export interface AttemptBindingV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly bindingId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly branchId: string;
  readonly contractId: string;
  readonly profileId: string;
  readonly workspaceKey: string;
  readonly planNodeId: string;
  readonly authority: 'workspace';
  readonly injectionBudgetTokens: number;
  readonly boundAt: IsoTimestamp;
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
  readonly controlLevel?: 'enforced' | 'guarded' | 'advisory' | 'unknown';
  readonly scope?: 'branch_local_workspace' | 'shared_resource' | 'mission_global_external';
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
  readonly controlLevel: 'enforced' | 'guarded' | 'advisory' | 'unknown';
  readonly kind: string;
  readonly resourceKey: string;
  readonly evidenceRefs: readonly string[];
}

export interface ReceiptV1 {
  readonly schemaVersion: typeof DOMAIN_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly missionId: string;
  readonly contractId: string;
  /**
   * Branch whose outcome this Receipt evaluates. Required for new records;
   * optional in the TypeScript shape only so persisted rootBranchId-era data
   * can still be decoded and normalized by the Mission Store.
   */
  readonly branchId?: string;
  /** @deprecated Legacy alias retained only for persisted root-Branch Receipts. */
  readonly rootBranchId?: string;
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

export interface BranchCreatedPayloadV1 {
  readonly branch: BranchV1;
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

export interface AttemptBoundPayloadV1 {
  readonly binding: AttemptBindingV1;
}

export interface ProfileSelectedPayloadV1 {
  readonly profile: ProfileV1;
  readonly reason: string;
}

export interface RuntimeCatalogObservedPayloadV1 {
  readonly observation: RuntimeCatalogObservationV1;
}

export interface ProfileDefinitionRecordedPayloadV1 {
  readonly definition: RuntimeProfileDefinitionV1;
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

export interface NativeArtifactRefV1 {
  readonly artifactId: string;
  readonly sha256: Sha256;
  readonly relativePath: string;
  readonly mediaType: 'application/json' | 'text/plain';
  readonly byteLength: number;
  readonly sanitized: true;
  readonly redactionCount: number;
}

export type RuntimeSemanticKindV1 =
  | 'runtime'
  | 'session'
  | 'turn'
  | 'model'
  | 'context'
  | 'tool'
  | 'workspace'
  | 'subagent'
  | 'usage'
  | 'message'
  | 'failure'
  | 'unknown';

export interface AgentRuntimeEventV1 {
  readonly runtimeEventId: string;
  readonly missionId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly bindingId: string;
  readonly planNodeId: string;
  readonly sourceHarness: string;
  readonly sourceProtocol: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly nativeEventType: string;
  readonly semanticKind: RuntimeSemanticKindV1;
  readonly causalParentIds: readonly string[];
  readonly correlationIds: readonly string[];
  readonly observedAt: IsoTimestamp;
  readonly nativeOccurredAt?: IsoTimestamp;
  readonly fidelity: 'native' | 'derived' | 'opaque';
  readonly normalized: JsonValue;
  readonly nativeArtifact: NativeArtifactRefV1;
}

export interface RuntimeEventRecordedPayloadV1 {
  readonly event: AgentRuntimeEventV1;
}

export type MissionCommandActionV1 = 'resume' | 'verify';
export type MissionCommandStatusV1 = 'pending' | 'dispatching' | 'completed' | 'failed';

export interface MissionCommandV1 {
  readonly commandId: string;
  readonly missionId: string;
  readonly branchId: string;
  readonly action: MissionCommandActionV1;
  readonly idempotencyKey: string;
  readonly expectedHeadHash: Sha256;
  readonly status: MissionCommandStatusV1;
  readonly acceptedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly dispatchCount: number;
  readonly lastError?: string;
}

export interface CommandAcceptedPayloadV1 {
  readonly command: MissionCommandV1;
}

export interface CommandStatusChangedPayloadV1 {
  readonly commandId: string;
  readonly status: MissionCommandStatusV1;
  readonly dispatchCount: number;
  readonly detail?: string;
}

export interface MissionEventPayloadsV1 {
  readonly 'mission.created': MissionCreatedPayloadV1;
  readonly 'mission.status_changed': MissionStatusChangedPayloadV1;
  readonly 'branch.created': BranchCreatedPayloadV1;
  readonly 'attempt.bound': AttemptBoundPayloadV1;
  readonly 'attempt.started': AttemptStartedPayloadV1;
  readonly 'attempt.finished': AttemptFinishedPayloadV1;
  readonly 'profile.selected': ProfileSelectedPayloadV1;
  readonly 'runtime.catalog_observed': RuntimeCatalogObservedPayloadV1;
  readonly 'profile.definition_recorded': ProfileDefinitionRecordedPayloadV1;
  readonly 'effect.recorded': EffectRecordedPayloadV1;
  readonly 'effect.status_changed': EffectStatusChangedPayloadV1;
  readonly 'receipt.issued': ReceiptIssuedPayloadV1;
  readonly 'runtime.event': RuntimeEventRecordedPayloadV1;
  readonly 'runtime.observation': RuntimeObservationPayloadV1;
  readonly 'command.accepted': CommandAcceptedPayloadV1;
  readonly 'command.status_changed': CommandStatusChangedPayloadV1;
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
  /** Absent only for legacy schema-v1 Missions created before Branch identity existed. */
  readonly rootBranchId?: string;
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
