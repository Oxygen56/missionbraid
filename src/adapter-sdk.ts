/**
 * Public Adapter API v1.
 *
 * The boundary is intentionally evidence-only: an Adapter can describe a
 * Runtime, emit native evidence, and report its own run outcome. It receives no
 * port that can mutate Mission, Branch, Effect, failure, or Receipt state.
 */

export const ADAPTER_API_VERSION = '1.0.0' as const;
export const ADAPTER_MANIFEST_SCHEMA_VERSION = 'missionbraid.dev/adapter-manifest/v1' as const;
export const ADAPTER_EVENT_SCHEMA_VERSION = 'missionbraid.dev/adapter-event/v1' as const;

export const ADAPTER_CAPABILITY_NAMES = [
  'discover',
  'observe',
  'context-capture',
  'steer',
  'interrupt',
  'pre-tool-gate',
  'resume',
  'native-fork',
  'workspace-bind',
  'workspace-restore',
  'external-effect-control',
] as const;

export type AdapterCapabilityNameV1 = (typeof ADAPTER_CAPABILITY_NAMES)[number];
export type AdapterTransportKindV1 = 'direct' | 'acp' | 'provider-backed';
export type AdapterCapabilityStatusV1 = 'supported' | 'unsupported' | 'unknown';
export type AdapterCapabilityFidelityV1 =
  | 'native'
  | 'cooperative'
  | 'controller'
  | 'process-only'
  | 'observe-only'
  | 'unsupported'
  | 'unknown';

export interface AdapterCapabilityDeclarationV1 {
  readonly status: AdapterCapabilityStatusV1;
  readonly fidelity: AdapterCapabilityFidelityV1;
  /** A bounded claim about this Adapter implementation, not a Harness brand. */
  readonly detail: string;
}

export type AdapterCapabilitiesV1 = Readonly<
  Record<AdapterCapabilityNameV1, AdapterCapabilityDeclarationV1>
>;

export interface AdapterManifestV1 {
  readonly schemaVersion: typeof ADAPTER_MANIFEST_SCHEMA_VERSION;
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  readonly adapterId: string;
  /** Real Harness identity reported in Profiles, Events, Forks, and Receipts. */
  readonly harnessId: string;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly transport: AdapterTransportKindV1;
  readonly nativeProtocol: string;
  readonly capabilities: AdapterCapabilitiesV1;
}

export type AdapterRuntimeBindingV1 =
  | {
      readonly kind: 'direct';
      /** Stable executable identity or content reference; never command-line credentials. */
      readonly executableRef: string;
      readonly processOwnership: 'adapter' | 'host';
    }
  | {
      readonly kind: 'acp';
      readonly protocolVersion: string;
      readonly endpointRef: string;
      readonly sessionRef?: string;
    }
  | {
      readonly kind: 'provider-backed';
      readonly providerId: string;
      readonly providerVersion: string;
      readonly providerSessionRef: string;
      readonly providerWorkspaceRef: string;
    };

export type AdapterObservedFieldV1<T> =
  | { readonly status: 'known'; readonly value: T; readonly source: string }
  | { readonly status: 'unknown' | 'unsupported'; readonly reason: string };

export interface AdapterDiscoveryRequestV1 {
  readonly observedAt: string;
}

export interface AdapterDiscoveryV1 {
  readonly adapterId: string;
  readonly transport: AdapterTransportKindV1;
  readonly status: 'ready' | 'unavailable' | 'missing' | 'unknown';
  readonly runtimeVersion: AdapterObservedFieldV1<string>;
  /** Authentication readiness only. Secret values never cross this boundary. */
  readonly authentication: AdapterObservedFieldV1<'ready' | 'not-ready'>;
  readonly binding: AdapterRuntimeBindingV1;
  readonly observedAt: string;
  readonly evidenceRefs: readonly string[];
}

export type AdapterWorkspaceBindingV1 =
  | {
      readonly kind: 'local';
      readonly workspaceKey: string;
      readonly absolutePath: string;
      readonly access: 'read-only' | 'read-write';
    }
  | {
      readonly kind: 'provider';
      readonly workspaceKey: string;
      readonly workspaceRef: string;
      readonly access: 'read-only' | 'read-write';
    };

export interface AdapterExecutionIdentityV1 {
  /** Opaque host identities used only for evidence correlation. */
  readonly executionId: string;
  readonly missionId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly bindingId: string;
}

export interface AdapterProfileBindingV1 {
  readonly profileId: string;
  readonly configurationDigest: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: string;
}

export interface AdapterRunRequestV1 {
  readonly identity: AdapterExecutionIdentityV1;
  readonly workspace: AdapterWorkspaceBindingV1;
  readonly profile: AdapterProfileBindingV1;
  readonly instruction: string;
  readonly signal?: AbortSignal;
}

export type AdapterJsonPrimitive = string | number | boolean | null;
export type AdapterJsonValue =
  | AdapterJsonPrimitive
  | readonly AdapterJsonValue[]
  | { readonly [key: string]: AdapterJsonValue };

export type AdapterSemanticHintV1 =
  | 'runtime'
  | 'session'
  | 'model'
  | 'context'
  | 'tool'
  | 'workspace'
  | 'usage'
  | 'failure'
  | 'message'
  | 'unknown';

export interface AdapterNativeEventV1 {
  readonly schemaVersion: typeof ADAPTER_EVENT_SCHEMA_VERSION;
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  readonly adapterId: string;
  readonly runId: string;
  /** Adapter-local observation order; it does not claim a provider-global order. */
  readonly sequence: number;
  readonly sourceId: string;
  readonly sourceProtocol: string;
  readonly nativeEventType: string;
  readonly semanticHint: AdapterSemanticHintV1;
  readonly observedAt: string;
  readonly nativeOccurredAt?: string;
  readonly fidelity: 'native' | 'derived' | 'opaque';
  readonly payload: AdapterJsonValue;
  readonly sanitized: true;
  readonly evidenceRefs: readonly string[];
}

export interface AdapterEvidenceSinkV1 {
  /** Resolves only after the host durably accepts this evidence envelope. */
  append(event: AdapterNativeEventV1): Promise<void>;
}

export interface AdapterToolGateRequestV1 {
  readonly adapterId: string;
  readonly runId: string;
  readonly nativeRequestId: string;
  readonly toolName: string;
  readonly inputDigest: string;
  readonly mutable: boolean;
  readonly nativePayloadRef: string;
}

export type AdapterToolGateDecisionV1 =
  | { readonly action: 'approve'; readonly decisionRef: string }
  | { readonly action: 'reject'; readonly decisionRef: string; readonly reason: string }
  | {
      readonly action: 'modify';
      readonly decisionRef: string;
      readonly replacementPayloadRef: string;
    };

export interface AdapterToolGatePortV1 {
  /** The host owns authority and Effect identity; the Adapter only waits for a decision. */
  gate(request: AdapterToolGateRequestV1): Promise<AdapterToolGateDecisionV1>;
}

export interface AdapterHostPortsV1 {
  readonly evidence: AdapterEvidenceSinkV1;
  readonly toolGate?: AdapterToolGatePortV1;
}

export interface AdapterSessionOperationRequestV1 {
  readonly operationId: string;
  readonly executionId: string;
  readonly nativeSessionRef: string;
  /** Content-addressed intervention or control input; never an authority grant. */
  readonly inputRef: string;
  readonly signal?: AbortSignal;
}

export interface AdapterSessionOperationResultV1 {
  readonly operationId: string;
  readonly status: 'completed' | 'rejected' | 'unavailable' | 'unknown';
  readonly evidenceRefs: readonly string[];
  readonly outputRefs: readonly string[];
}

export interface AdapterContextCaptureResultV1 extends AdapterSessionOperationResultV1 {
  readonly contextDigest?: string;
  readonly contextArtifactRef?: string;
}

export interface AdapterResumeRequestV1 {
  readonly nativeSessionRef: string;
  readonly run: AdapterRunRequestV1;
}

export interface AdapterForkRequestV1 {
  readonly parentSessionRef: string;
  readonly parentCheckpointRef: string;
  readonly interventionRef: string;
  readonly run: AdapterRunRequestV1;
}

export interface AdapterWorkspaceRestoreRequestV1 {
  readonly operationId: string;
  readonly workspaceArtifactRef: string;
  readonly workspaceDigest: string;
  readonly target: AdapterWorkspaceBindingV1;
  readonly signal?: AbortSignal;
}

export interface AdapterWorkspaceRestoreResultV1 {
  readonly operationId: string;
  readonly status: 'restored' | 'unavailable' | 'unknown';
  readonly workspace: AdapterWorkspaceBindingV1;
  readonly observedWorkspaceDigest?: string;
  readonly evidenceRefs: readonly string[];
}

export interface AdapterExternalEffectRequestV1 {
  readonly effectId: string;
  readonly targetRef: string;
  readonly idempotencyKey: string;
  readonly payloadDigest: string;
  readonly payloadRef: string;
  readonly authorityRef: string;
}

export type AdapterExternalEffectLookupResultV1 =
  | {
      readonly status: 'found';
      readonly receiptRef: string;
      readonly evidenceRefs: readonly string[];
    }
  | { readonly status: 'absent'; readonly evidenceRefs: readonly string[] }
  | {
      readonly status: 'ambiguous' | 'unknown';
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    };

export type AdapterExternalEffectDispatchResultV1 =
  | {
      readonly status: 'accepted';
      readonly receiptRef: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly status: 'rejected' | 'ambiguous' | 'unknown';
      readonly evidenceRefs: readonly string[];
      readonly detail?: string;
    };

export type AdapterNativeSessionV1 =
  | { readonly status: 'available'; readonly sessionRef: string; readonly resumable: boolean }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface AdapterRunResultV1 {
  readonly adapterId: string;
  readonly runId: string;
  readonly transport: AdapterTransportKindV1;
  readonly binding: AdapterRuntimeBindingV1;
  /** Runtime-process outcome only; this never means Mission success or verification. */
  readonly status: 'completed' | 'failed' | 'aborted' | 'unknown';
  readonly exitCode?: number | null;
  readonly nativeSession: AdapterNativeSessionV1;
  readonly evidenceRefs: readonly string[];
}

export interface MissionBraidAdapterV1 {
  readonly manifest: AdapterManifestV1;
  discover(request: AdapterDiscoveryRequestV1): Promise<AdapterDiscoveryV1>;
  run(request: AdapterRunRequestV1, ports: AdapterHostPortsV1): Promise<AdapterRunResultV1>;
  captureContext?(
    request: AdapterSessionOperationRequestV1,
  ): Promise<AdapterContextCaptureResultV1>;
  steer?(request: AdapterSessionOperationRequestV1): Promise<AdapterSessionOperationResultV1>;
  interrupt?(request: AdapterSessionOperationRequestV1): Promise<AdapterSessionOperationResultV1>;
  resume?(request: AdapterResumeRequestV1, ports: AdapterHostPortsV1): Promise<AdapterRunResultV1>;
  fork?(request: AdapterForkRequestV1, ports: AdapterHostPortsV1): Promise<AdapterRunResultV1>;
  restoreWorkspace?(
    request: AdapterWorkspaceRestoreRequestV1,
  ): Promise<AdapterWorkspaceRestoreResultV1>;
  lookupExternalEffect?(idempotencyKey: string): Promise<AdapterExternalEffectLookupResultV1>;
  dispatchExternalEffect?(
    request: AdapterExternalEffectRequestV1,
  ): Promise<AdapterExternalEffectDispatchResultV1>;
}

export class AdapterContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterContractError';
  }
}

/** Validate and preserve the concrete Adapter type for external implementations. */
export function defineAdapterV1<TAdapter extends MissionBraidAdapterV1>(
  adapter: TAdapter,
): TAdapter {
  validateAdapterManifestV1(adapter.manifest);
  if (typeof adapter.discover !== 'function' || typeof adapter.run !== 'function') {
    throw new AdapterContractError('Adapter must implement discover and run');
  }
  return adapter;
}

/**
 * Transport-neutral extension registry. Registering an Adapter changes only
 * the Runtime data-plane inventory; it has no access to Kernel state machines.
 */
export class AdapterRegistryV1 {
  readonly #adapters = new Map<string, MissionBraidAdapterV1>();

  register<TAdapter extends MissionBraidAdapterV1>(adapter: TAdapter): TAdapter {
    defineAdapterV1(adapter);
    if (this.#adapters.has(adapter.manifest.adapterId)) {
      throw new AdapterContractError(`Adapter ${adapter.manifest.adapterId} is already registered`);
    }
    this.#adapters.set(adapter.manifest.adapterId, adapter);
    return adapter;
  }

  get(adapterId: string): MissionBraidAdapterV1 | undefined {
    return this.#adapters.get(adapterId);
  }

  list(): readonly AdapterManifestV1[] {
    return [...this.#adapters.values()]
      .map((adapter) => adapter.manifest)
      .sort((left, right) => left.adapterId.localeCompare(right.adapterId, 'en'));
  }
}

export function validateAdapterManifestV1(manifest: AdapterManifestV1): void {
  if (manifest.schemaVersion !== ADAPTER_MANIFEST_SCHEMA_VERSION) {
    throw new AdapterContractError('Adapter manifest schemaVersion is incompatible');
  }
  if (manifest.apiVersion !== ADAPTER_API_VERSION) {
    throw new AdapterContractError(
      `Adapter API ${manifest.apiVersion} is incompatible with ${ADAPTER_API_VERSION}`,
    );
  }
  requireIdentifier(manifest.adapterId, 'manifest.adapterId');
  requireIdentifier(manifest.harnessId, 'manifest.harnessId');
  requireNonEmpty(manifest.displayName, 'manifest.displayName');
  requireSemver(manifest.adapterVersion, 'manifest.adapterVersion');
  if (!adapterTransports.has(manifest.transport)) {
    throw new AdapterContractError(`Unsupported Adapter transport ${manifest.transport}`);
  }
  requireNonEmpty(manifest.nativeProtocol, 'manifest.nativeProtocol');

  const keys = Object.keys(manifest.capabilities).sort();
  const expected = [...ADAPTER_CAPABILITY_NAMES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new AdapterContractError('Adapter must declare every v1 capability exactly once');
  }
  for (const name of ADAPTER_CAPABILITY_NAMES) {
    validateCapability(name, manifest.capabilities[name]);
  }
}

export function validateAdapterRunRequestV1(
  manifest: AdapterManifestV1,
  request: AdapterRunRequestV1,
): void {
  for (const [path, value] of [
    ['identity.executionId', request.identity.executionId],
    ['identity.missionId', request.identity.missionId],
    ['identity.branchId', request.identity.branchId],
    ['identity.attemptId', request.identity.attemptId],
    ['identity.bindingId', request.identity.bindingId],
    ['workspace.workspaceKey', request.workspace.workspaceKey],
    ['profile.profileId', request.profile.profileId],
  ] as const) {
    requireIdentifier(value, path);
  }
  requireNonEmpty(request.profile.configurationDigest, 'profile.configurationDigest');
  requireNonEmpty(request.instruction, 'instruction');
  if (manifest.transport === 'direct' && request.workspace.kind !== 'local') {
    throw new AdapterContractError('A direct Adapter requires a local workspace binding');
  }
  if (manifest.transport === 'provider-backed' && request.workspace.kind !== 'provider') {
    throw new AdapterContractError(
      'A provider-backed Adapter requires a provider workspace binding',
    );
  }
  if (request.workspace.kind === 'local' && !request.workspace.absolutePath.startsWith('/')) {
    throw new AdapterContractError('Local workspace path must be absolute');
  }
}

export function validateAdapterRuntimeBindingV1(
  expectedTransport: AdapterTransportKindV1,
  binding: AdapterRuntimeBindingV1,
): void {
  if (binding.kind !== expectedTransport) {
    throw new AdapterContractError(
      `Adapter returned ${binding.kind} binding for ${expectedTransport} transport`,
    );
  }
  if (binding.kind === 'direct') {
    requireNonEmpty(binding.executableRef, 'binding.executableRef');
  } else if (binding.kind === 'acp') {
    requireNonEmpty(binding.protocolVersion, 'binding.protocolVersion');
    requireNonEmpty(binding.endpointRef, 'binding.endpointRef');
  } else {
    requireIdentifier(binding.providerId, 'binding.providerId');
    requireNonEmpty(binding.providerVersion, 'binding.providerVersion');
    requireNonEmpty(binding.providerSessionRef, 'binding.providerSessionRef');
    requireNonEmpty(binding.providerWorkspaceRef, 'binding.providerWorkspaceRef');
  }
}

function validateCapability(
  name: AdapterCapabilityNameV1,
  capability: AdapterCapabilityDeclarationV1,
): void {
  requireNonEmpty(capability.detail, `capabilities.${name}.detail`);
  if (!capabilityStatuses.has(capability.status)) {
    throw new AdapterContractError(`Unsupported capability status ${capability.status}`);
  }
  if (!capabilityFidelities.has(capability.fidelity)) {
    throw new AdapterContractError(`Unsupported capability fidelity ${capability.fidelity}`);
  }
  if (capability.status === 'supported') {
    if (capability.fidelity === 'unsupported' || capability.fidelity === 'unknown') {
      throw new AdapterContractError(
        `Supported capability ${name} must declare an implemented fidelity`,
      );
    }
  } else if (capability.status === 'unsupported' && capability.fidelity !== 'unsupported') {
    throw new AdapterContractError(`Unsupported capability ${name} must use unsupported fidelity`);
  } else if (capability.status === 'unknown' && capability.fidelity !== 'unknown') {
    throw new AdapterContractError(`Unknown capability ${name} must use unknown fidelity`);
  }
}

function requireSemver(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new AdapterContractError(`${path} must be semantic versioning`);
  }
  return value;
}

function requireIdentifier(value: string, path: string): string {
  requireNonEmpty(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new AdapterContractError(`${path} contains unsupported characters`);
  }
  return value;
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new AdapterContractError(`${path} must be non-empty`);
  }
  return value;
}

const adapterTransports = new Set<AdapterTransportKindV1>(['direct', 'acp', 'provider-backed']);
const capabilityStatuses = new Set<AdapterCapabilityStatusV1>([
  'supported',
  'unsupported',
  'unknown',
]);
const capabilityFidelities = new Set<AdapterCapabilityFidelityV1>([
  'native',
  'cooperative',
  'controller',
  'process-only',
  'observe-only',
  'unsupported',
  'unknown',
]);
