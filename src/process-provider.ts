import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  defineAdapterV1,
  validateAdapterRunRequestV1,
  type AdapterJsonValue,
  type AdapterManifestV1,
  type AdapterNativeEventV1,
  type AdapterObservedFieldV1,
  type AdapterSemanticHintV1,
  type MissionBraidAdapterV1,
} from './adapter-sdk.js';

export const PROCESS_PROVIDER_API_VERSION = '1.0.0' as const;
export const PROCESS_PROVIDER_MANIFEST_SCHEMA_VERSION =
  'missionbraid.dev/process-provider-manifest/v1' as const;

export interface ProcessProviderManifestV1 {
  readonly schemaVersion: typeof PROCESS_PROVIDER_MANIFEST_SCHEMA_VERSION;
  readonly apiVersion: typeof PROCESS_PROVIDER_API_VERSION;
  readonly providerId: string;
  readonly displayName: string;
  readonly providerVersion: string;
  /** Public protocol implemented by this separately installed provider. */
  readonly nativeProtocol: string;
}

export interface ProcessProviderDiscoveryV1 {
  readonly status: 'ready' | 'unavailable' | 'missing' | 'unknown';
  readonly runtimeVersion: AdapterObservedFieldV1<string>;
  readonly authentication: AdapterObservedFieldV1<'ready' | 'not-ready'>;
  /** A non-secret provider endpoint or process identity. */
  readonly endpointRef: string;
  /** An unbound provider session identity used only for discovery evidence. */
  readonly discoverySessionRef: string;
  /** An unbound provider workspace identity used only for discovery evidence. */
  readonly discoveryWorkspaceRef: string;
  readonly observedAt: string;
  readonly evidenceRefs: readonly string[];
}

export interface ProcessProviderRunRequestV1 {
  readonly clientRunId: string;
  readonly execution: {
    readonly executionId: string;
    readonly missionId: string;
    readonly branchId: string;
    readonly attemptId: string;
    readonly bindingId: string;
  };
  readonly workspace: {
    readonly workspaceKey: string;
    readonly workspaceRef: string;
    readonly access: 'read-only' | 'read-write';
  };
  readonly profile: {
    readonly profileId: string;
    readonly configurationDigest: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly permissionMode?: string;
  };
  readonly instruction: string;
}

export interface ProcessProviderRunHandleV1 {
  readonly providerRunId: string;
  readonly providerSessionRef: string;
  readonly providerWorkspaceRef: string;
  readonly startedAt: string;
  readonly evidenceRefs: readonly string[];
}

export interface ProcessProviderEventV1 {
  /** Strictly increasing within one provider run. */
  readonly sequence: number;
  readonly sourceId: string;
  readonly nativeEventType: string;
  readonly semanticHint: AdapterSemanticHintV1;
  readonly occurredAt?: string;
  readonly fidelity: 'native' | 'derived' | 'opaque';
  readonly payload: AdapterJsonValue;
  readonly sanitized: true;
  readonly evidenceRefs: readonly string[];
}

export interface ProcessProviderObservationV1 {
  readonly status: 'running' | 'completed' | 'failed' | 'aborted' | 'unknown';
  readonly exitCode?: number | null;
  readonly observedAt: string;
  readonly events: readonly ProcessProviderEventV1[];
  readonly evidenceRefs: readonly string[];
}

/**
 * Minimal replaceable execution-provider boundary. The provider owns process
 * placement and its workspace mapping. MissionBraid owns Mission authority and
 * receives only sanitized evidence plus a Runtime-process outcome.
 */
export interface ProcessExecutionProviderV1 {
  readonly manifest: ProcessProviderManifestV1;
  discover(options?: { readonly signal?: AbortSignal }): Promise<ProcessProviderDiscoveryV1>;
  start(
    request: ProcessProviderRunRequestV1,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessProviderRunHandleV1>;
  observe(
    handle: ProcessProviderRunHandleV1,
    options: { readonly afterSequence: number; readonly signal?: AbortSignal },
  ): Promise<ProcessProviderObservationV1>;
  stop?(
    handle: ProcessProviderRunHandleV1,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessProviderObservationV1>;
}

export interface ProcessProviderAdapterOptionsV1 {
  readonly provider: ProcessExecutionProviderV1;
  readonly adapterId?: string;
  readonly harnessId?: string;
  readonly displayName?: string;
  readonly adapterVersion?: string;
  readonly pollIntervalMs?: number;
  readonly runTimeoutMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Adapt any ProcessExecutionProviderV1 to the stable public Adapter API. No
 * Mission, Branch, Effect, failure, or Receipt state-machine port is exposed.
 */
export function createProcessProviderAdapterV1(
  options: ProcessProviderAdapterOptionsV1,
): MissionBraidAdapterV1 {
  const { provider } = options;
  validateProviderManifest(provider.manifest);
  const pollIntervalMs = positive(options.pollIntervalMs ?? 25, 'pollIntervalMs');
  const runTimeoutMs = positive(options.runTimeoutMs ?? 120_000, 'runTimeoutMs');
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const adapterId = options.adapterId ?? `provider.${provider.manifest.providerId}`;
  const harnessId = options.harnessId ?? adapterId;
  const manifest = {
    schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
    apiVersion: ADAPTER_API_VERSION,
    adapterId,
    harnessId,
    displayName: options.displayName ?? `${provider.manifest.displayName} Adapter`,
    adapterVersion: options.adapterVersion ?? '1.0.0',
    transport: 'provider-backed',
    nativeProtocol: provider.manifest.nativeProtocol,
    capabilities: processProviderCapabilities,
  } as const satisfies AdapterManifestV1;

  return defineAdapterV1({
    manifest,

    async discover(request) {
      const discovery = await provider.discover();
      return {
        adapterId,
        transport: 'provider-backed',
        status: discovery.status,
        runtimeVersion: discovery.runtimeVersion,
        authentication: discovery.authentication,
        binding: {
          kind: 'provider-backed',
          providerId: provider.manifest.providerId,
          providerVersion: provider.manifest.providerVersion,
          providerSessionRef: discovery.discoverySessionRef,
          providerWorkspaceRef: discovery.discoveryWorkspaceRef,
        },
        observedAt: discovery.observedAt || request.observedAt,
        evidenceRefs: discovery.evidenceRefs,
      };
    },

    async run(request, ports) {
      validateAdapterRunRequestV1(manifest, request);
      if (request.workspace.kind !== 'provider') {
        throw new TypeError('Process Provider Adapter requires a provider workspace.');
      }
      const runId = `run-${request.identity.executionId}`;
      const handle = await provider.start(
        {
          clientRunId: runId,
          execution: request.identity,
          workspace: {
            workspaceKey: request.workspace.workspaceKey,
            workspaceRef: request.workspace.workspaceRef,
            access: request.workspace.access,
          },
          profile: request.profile,
          instruction: request.instruction,
        },
        signalOptions(request.signal),
      );
      validateHandle(handle, request.workspace.workspaceRef);

      let adapterSequence = 0;
      let providerSequence = 0;
      await ports.evidence.append({
        schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
        apiVersion: ADAPTER_API_VERSION,
        adapterId,
        runId,
        sequence: ++adapterSequence,
        sourceId: handle.providerRunId,
        sourceProtocol: provider.manifest.nativeProtocol,
        nativeEventType: 'provider.workspace.bound',
        semanticHint: 'workspace',
        observedAt: now().toISOString(),
        fidelity: 'native',
        payload: {
          providerId: provider.manifest.providerId,
          workspaceKey: request.workspace.workspaceKey,
          workspaceRef: handle.providerWorkspaceRef,
          access: request.workspace.access,
        },
        sanitized: true,
        evidenceRefs: handle.evidenceRefs,
      });

      const deadline = Date.now() + runTimeoutMs;
      for (;;) {
        if (request.signal?.aborted === true) {
          const stopped =
            provider.stop === undefined
              ? undefined
              : await provider.stop(handle, signalOptions(undefined));
          return runResult(
            manifest,
            provider.manifest,
            handle,
            runId,
            stopped?.evidenceRefs ?? handle.evidenceRefs,
            {
              status: 'aborted',
              ...(stopped?.exitCode === undefined ? {} : { exitCode: stopped.exitCode }),
            },
          );
        }
        if (Date.now() >= deadline) {
          const stopped =
            provider.stop === undefined
              ? undefined
              : await provider.stop(handle, signalOptions(undefined));
          return runResult(
            manifest,
            provider.manifest,
            handle,
            runId,
            stopped?.evidenceRefs ?? handle.evidenceRefs,
            {
              status: 'unknown',
              ...(stopped?.exitCode === undefined ? {} : { exitCode: stopped.exitCode }),
            },
          );
        }

        const observation = await provider.observe(handle, {
          afterSequence: providerSequence,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        validateObservation(observation, providerSequence);
        for (const event of observation.events) {
          providerSequence = event.sequence;
          const envelope: AdapterNativeEventV1 = {
            schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
            apiVersion: ADAPTER_API_VERSION,
            adapterId,
            runId,
            sequence: ++adapterSequence,
            sourceId: event.sourceId,
            sourceProtocol: provider.manifest.nativeProtocol,
            nativeEventType: event.nativeEventType,
            semanticHint: event.semanticHint,
            observedAt: observation.observedAt,
            ...(event.occurredAt === undefined ? {} : { nativeOccurredAt: event.occurredAt }),
            fidelity: event.fidelity,
            payload: event.payload,
            sanitized: true,
            evidenceRefs: event.evidenceRefs,
          };
          await ports.evidence.append(envelope);
        }
        if (observation.status !== 'running') {
          return runResult(manifest, provider.manifest, handle, runId, observation.evidenceRefs, {
            status: observation.status,
            ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
          });
        }
        await sleep(pollIntervalMs);
      }
    },
  });
}

const processProviderCapabilities = {
  discover: {
    status: 'supported',
    fidelity: 'controller',
    detail: 'Discovers the separately installed execution provider.',
  },
  observe: {
    status: 'supported',
    fidelity: 'controller',
    detail: 'Preserves sanitized provider process events in provider order.',
  },
  'context-capture': {
    status: 'unknown',
    fidelity: 'unknown',
    detail: 'The generic process provider contract does not expose model context.',
  },
  steer: {
    status: 'unsupported',
    fidelity: 'unsupported',
    detail: 'The v1 process provider contract is one-shot.',
  },
  interrupt: {
    status: 'unsupported',
    fidelity: 'unsupported',
    detail: 'Abort cleanup is controller-owned; no public native-session interrupt is claimed.',
  },
  'pre-tool-gate': {
    status: 'unsupported',
    fidelity: 'unsupported',
    detail: 'The generic provider boundary does not mediate tool calls.',
  },
  resume: {
    status: 'unsupported',
    fidelity: 'unsupported',
    detail: 'The v1 provider contract does not resume completed calls.',
  },
  'native-fork': {
    status: 'unsupported',
    fidelity: 'unsupported',
    detail: 'The v1 provider contract does not expose native Fork.',
  },
  'workspace-bind': {
    status: 'supported',
    fidelity: 'controller',
    detail: 'Binds an opaque provider workspace reference.',
  },
  'workspace-restore': {
    status: 'unsupported',
    fidelity: 'unsupported',
    detail: 'Workspace restoration is not part of the minimal provider contract.',
  },
  'external-effect-control': {
    status: 'unsupported',
    fidelity: 'unsupported',
    detail: 'External Effects remain outside this process boundary.',
  },
} as const;

function runResult(
  manifest: AdapterManifestV1,
  providerManifest: ProcessProviderManifestV1,
  handle: ProcessProviderRunHandleV1,
  runId: string,
  evidenceRefs: readonly string[],
  outcome: {
    readonly status: 'completed' | 'failed' | 'aborted' | 'unknown';
    readonly exitCode?: number | null;
  },
) {
  return {
    adapterId: manifest.adapterId,
    runId,
    transport: 'provider-backed' as const,
    binding: {
      kind: 'provider-backed' as const,
      providerId: providerManifest.providerId,
      providerVersion: providerManifest.providerVersion,
      providerSessionRef: handle.providerSessionRef,
      providerWorkspaceRef: handle.providerWorkspaceRef,
    },
    status: outcome.status,
    ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
    nativeSession: {
      status: 'available' as const,
      sessionRef: handle.providerSessionRef,
      resumable: false,
    },
    evidenceRefs,
  };
}

function validateProviderManifest(manifest: ProcessProviderManifestV1): void {
  if (manifest.schemaVersion !== PROCESS_PROVIDER_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError('Process provider manifest schemaVersion is incompatible.');
  }
  if (manifest.apiVersion !== PROCESS_PROVIDER_API_VERSION) {
    throw new TypeError('Process provider API version is incompatible.');
  }
  for (const [name, value] of Object.entries({
    providerId: manifest.providerId,
    displayName: manifest.displayName,
    providerVersion: manifest.providerVersion,
    nativeProtocol: manifest.nativeProtocol,
  })) {
    requireText(value, `provider manifest ${name}`);
  }
}

function validateHandle(handle: ProcessProviderRunHandleV1, expectedWorkspaceRef: string): void {
  requireText(handle.providerRunId, 'providerRunId');
  requireText(handle.providerSessionRef, 'providerSessionRef');
  requireText(handle.providerWorkspaceRef, 'providerWorkspaceRef');
  if (handle.providerWorkspaceRef !== expectedWorkspaceRef) {
    throw new TypeError('Process provider returned a different workspace binding.');
  }
  requireIso(handle.startedAt, 'provider startedAt');
  requireRefs(handle.evidenceRefs, 'provider start evidenceRefs');
}

function validateObservation(observation: ProcessProviderObservationV1, after: number): void {
  requireIso(observation.observedAt, 'provider observedAt');
  requireRefs(observation.evidenceRefs, 'provider observation evidenceRefs');
  let sequence = after;
  for (const event of observation.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= sequence) {
      throw new TypeError('Process provider event sequence is not strictly increasing.');
    }
    sequence = event.sequence;
    requireText(event.sourceId, 'provider event sourceId');
    requireText(event.nativeEventType, 'provider event nativeEventType');
    if (event.occurredAt !== undefined) requireIso(event.occurredAt, 'provider event occurredAt');
    if (event.sanitized !== true) throw new TypeError('Process provider event is not sanitized.');
    requireRefs(event.evidenceRefs, 'provider event evidenceRefs');
  }
}

function requireText(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new TypeError(`${label} must be non-empty.`);
  }
}

function requireIso(value: string, label: string): void {
  requireText(value, label);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be ISO time.`);
}

function requireRefs(refs: readonly string[], label: string): void {
  if (!Array.isArray(refs) || refs.length === 0) throw new TypeError(`${label} must be non-empty.`);
  refs.forEach((ref) => requireText(ref, label));
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive.`);
  return value;
}

function signalOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
