import {
  ADAPTER_API_VERSION,
  ADAPTER_CAPABILITY_NAMES,
  ADAPTER_EVENT_SCHEMA_VERSION,
  AdapterContractError,
  validateAdapterManifestV1,
  validateAdapterRunRequestV1,
  validateAdapterRuntimeBindingV1,
  type AdapterCapabilityNameV1,
  type AdapterDiscoveryV1,
  type AdapterHostPortsV1,
  type AdapterNativeEventV1,
  type AdapterRunRequestV1,
  type AdapterRunResultV1,
  type MissionBraidAdapterV1,
} from './adapter-sdk.js';

export const ADAPTER_CONFORMANCE_SCHEMA_VERSION =
  'missionbraid.dev/adapter-conformance/v1' as const;

export type AdapterConformanceCheckStatusV1 = 'passed' | 'failed' | 'not-applicable';

export interface AdapterConformanceCheckV1 {
  readonly checkId: string;
  readonly status: AdapterConformanceCheckStatusV1;
  readonly detail: string;
  readonly evidenceRefs: readonly string[];
}

export interface AdapterCapabilityProbeContextV1 {
  readonly adapter: MissionBraidAdapterV1;
  readonly discovery: AdapterDiscoveryV1;
  readonly request: AdapterRunRequestV1;
  readonly result: AdapterRunResultV1;
  readonly events: readonly AdapterNativeEventV1[];
}

export interface AdapterCapabilityProbeResultV1 {
  readonly passed: boolean;
  readonly detail: string;
  readonly evidenceRefs: readonly string[];
}

export type AdapterCapabilityProbeV1 = (
  context: AdapterCapabilityProbeContextV1,
) => Promise<AdapterCapabilityProbeResultV1> | AdapterCapabilityProbeResultV1;

export interface AdapterConformanceFixtureV1 {
  readonly discoveryRequest: { readonly observedAt: string };
  readonly runRequest: AdapterRunRequestV1;
  readonly toolGate?: AdapterHostPortsV1['toolGate'];
  readonly capabilityProbes?: Partial<
    Readonly<Record<AdapterCapabilityNameV1, AdapterCapabilityProbeV1>>
  >;
  readonly timeoutMs?: number;
}

export interface AdapterConformanceReportV1 {
  readonly schemaVersion: typeof ADAPTER_CONFORMANCE_SCHEMA_VERSION;
  readonly adapterApiVersion: typeof ADAPTER_API_VERSION;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly transport: 'direct' | 'acp' | 'provider-backed';
  readonly passed: boolean;
  readonly checks: readonly AdapterConformanceCheckV1[];
  readonly evidenceLevel: 'local-conformance';
  readonly independentExternalReproduction: {
    readonly status: 'not-established';
    readonly requirement: string;
  };
}

export class AdapterConformanceTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterConformanceTimeoutError';
  }
}

/**
 * Execute the public Adapter boundary without importing or mutating any Kernel
 * state machine. Supported optional capabilities require behavioral evidence;
 * unsupported and unknown capabilities remain explicit instead of failing a
 * false lowest-common-denominator suite.
 */
export async function runAdapterConformanceSuiteV1(
  adapter: MissionBraidAdapterV1,
  fixture: AdapterConformanceFixtureV1,
): Promise<AdapterConformanceReportV1> {
  const timeoutMs = positiveTimeout(fixture.timeoutMs ?? 2_000);
  const checks: AdapterConformanceCheckV1[] = [];

  try {
    validateAdapterManifestV1(adapter.manifest);
    checks.push(pass('manifest', 'Versioned manifest and complete capability matrix are valid.'));
  } catch (error) {
    checks.push(fail('manifest', errorMessage(error)));
    return report(adapter, checks);
  }

  const missingBaseline = baselineCapabilities.filter(
    (name) => adapter.manifest.capabilities[name].status !== 'supported',
  );
  checks.push(
    missingBaseline.length === 0
      ? pass(
          'baseline-capabilities',
          'Discovery, observation, and workspace binding are explicitly supported.',
        )
      : fail(
          'baseline-capabilities',
          `Runnable v1 Adapter is missing baseline capabilities: ${missingBaseline.join(', ')}`,
        ),
  );

  try {
    validateAdapterRunRequestV1(adapter.manifest, fixture.runRequest);
    checks.push(pass('run-request', 'Run request matches the declared transport boundary.'));
  } catch (error) {
    checks.push(fail('run-request', errorMessage(error)));
    return report(adapter, checks);
  }

  let discovery: AdapterDiscoveryV1;
  try {
    discovery = await withTimeout(
      adapter.discover(fixture.discoveryRequest),
      timeoutMs,
      'Adapter discovery timed out',
    );
    validateDiscovery(adapter, discovery);
    checks.push(
      pass('discovery', 'Discovery identity, transport, binding, and evidence are coherent.', [
        ...discovery.evidenceRefs,
      ]),
    );
  } catch (error) {
    checks.push(fail('discovery', errorMessage(error)));
    return report(adapter, capabilityNotRun(adapter, checks));
  }

  if (discovery.status !== 'ready') {
    checks.push(
      fail('run-lifecycle', `Fixture Adapter discovery returned ${discovery.status}, not ready.`),
    );
    return report(adapter, capabilityNotRun(adapter, checks));
  }

  const events: AdapterNativeEventV1[] = [];
  const hostPorts: AdapterHostPortsV1 = Object.freeze({
    evidence: Object.freeze({
      append: async (event: AdapterNativeEventV1) => {
        events.push(event);
      },
    }),
    ...(fixture.toolGate === undefined ? {} : { toolGate: fixture.toolGate }),
  });
  let result: AdapterRunResultV1;
  try {
    result = await withTimeout(
      adapter.run(fixture.runRequest, hostPorts),
      timeoutMs,
      'Adapter run timed out',
    );
    validateRunResult(adapter, result);
    checks.push(
      pass(
        'run-lifecycle',
        'Run returned a transport-bound Runtime outcome, not a Mission outcome.',
        [...result.evidenceRefs],
      ),
    );
  } catch (error) {
    checks.push(fail('run-lifecycle', errorMessage(error)));
    return report(adapter, capabilityNotRun(adapter, checks));
  }

  const eventErrors = validateEvents(adapter, result, events);
  checks.push(
    eventErrors.length === 0
      ? pass('event-stream', `Accepted ${events.length} ordered sanitized evidence event(s).`, [
          ...events.flatMap((event) => event.evidenceRefs),
        ])
      : fail('event-stream', eventErrors.join('; ')),
  );
  const authoritySurfaceErrors = kernelAuthorityPortSurfaceErrors(hostPorts);
  checks.push(
    authoritySurfaceErrors.length === 0
      ? pass(
          'kernel-authority-boundary',
          'The SDK host exposes evidence append and optional tool-gate decisions only; Adapter payload remains non-authoritative evidence and has no Kernel mutation port.',
        )
      : fail(
          'kernel-authority-boundary',
          `The SDK host exposed unexpected authority surface: ${authoritySurfaceErrors.join(', ')}`,
        ),
  );

  const context: AdapterCapabilityProbeContextV1 = {
    adapter,
    discovery,
    request: fixture.runRequest,
    result,
    events,
  };
  for (const capabilityName of ADAPTER_CAPABILITY_NAMES) {
    const declaration = adapter.manifest.capabilities[capabilityName];
    const checkId = `capability:${capabilityName}`;
    if (declaration.status !== 'supported') {
      checks.push({
        checkId,
        status: 'not-applicable',
        detail: `${declaration.status}: ${declaration.detail}`,
        evidenceRefs: [],
      });
      continue;
    }

    const requiredMethods = capabilityMethods[capabilityName];
    const missingMethods = requiredMethods.filter(
      (method) => typeof adapter[method] !== 'function',
    );
    if (missingMethods.length > 0) {
      checks.push(
        fail(
          checkId,
          `Supported capability ${capabilityName} is missing SDK method(s): ${missingMethods.join(', ')}`,
        ),
      );
      continue;
    }

    const builtIn = builtInCapabilityResult(capabilityName, discovery, events);
    if (builtIn !== undefined) {
      checks.push({ checkId, ...builtIn });
      continue;
    }

    const probe = fixture.capabilityProbes?.[capabilityName];
    if (probe === undefined) {
      checks.push(
        fail(
          checkId,
          `Supported capability ${capabilityName} requires a behavioral conformance probe.`,
        ),
      );
      continue;
    }
    try {
      const probeResult = await withTimeout(
        Promise.resolve(probe(context)),
        timeoutMs,
        `Capability probe ${capabilityName} timed out`,
      );
      checks.push({
        checkId,
        status: probeResult.passed ? 'passed' : 'failed',
        detail: probeResult.detail,
        evidenceRefs: normalizeRefs(probeResult.evidenceRefs),
      });
    } catch (error) {
      checks.push(fail(checkId, errorMessage(error)));
    }
  }

  return report(adapter, checks);
}

function validateDiscovery(adapter: MissionBraidAdapterV1, discovery: AdapterDiscoveryV1): void {
  if (discovery.adapterId !== adapter.manifest.adapterId) {
    throw new AdapterContractError('Discovery adapterId does not match its manifest');
  }
  if (discovery.transport !== adapter.manifest.transport) {
    throw new AdapterContractError('Discovery transport does not match its manifest');
  }
  validateAdapterRuntimeBindingV1(adapter.manifest.transport, discovery.binding);
  requireIso(discovery.observedAt, 'discovery.observedAt');
  requireEvidence(discovery.evidenceRefs, 'discovery.evidenceRefs');
  assertAllowedKeys(discovery, discoveryKeys, 'discovery');
}

function validateRunResult(adapter: MissionBraidAdapterV1, result: AdapterRunResultV1): void {
  if (result.adapterId !== adapter.manifest.adapterId) {
    throw new AdapterContractError('Run result adapterId does not match its manifest');
  }
  if (result.transport !== adapter.manifest.transport) {
    throw new AdapterContractError('Run result transport does not match its manifest');
  }
  requireIdentifier(result.runId, 'result.runId');
  validateAdapterRuntimeBindingV1(adapter.manifest.transport, result.binding);
  requireEvidence(result.evidenceRefs, 'result.evidenceRefs');
  if (result.nativeSession.status === 'available') {
    requireNonEmpty(result.nativeSession.sessionRef, 'result.nativeSession.sessionRef');
  } else {
    requireNonEmpty(result.nativeSession.reason, 'result.nativeSession.reason');
  }
  assertAllowedKeys(result, resultKeys, 'result');
}

function validateEvents(
  adapter: MissionBraidAdapterV1,
  result: AdapterRunResultV1,
  events: readonly AdapterNativeEventV1[],
): string[] {
  const errors: string[] = [];
  let previousSequence = 0;
  for (const [index, event] of events.entries()) {
    const path = `events[${index}]`;
    try {
      assertAllowedKeys(event, eventKeys, path);
      if (event.schemaVersion !== ADAPTER_EVENT_SCHEMA_VERSION) {
        throw new AdapterContractError(`${path}.schemaVersion is incompatible`);
      }
      if (event.apiVersion !== ADAPTER_API_VERSION) {
        throw new AdapterContractError(`${path}.apiVersion is incompatible`);
      }
      if (event.adapterId !== adapter.manifest.adapterId || event.runId !== result.runId) {
        throw new AdapterContractError(`${path} identity does not match the run`);
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
        throw new AdapterContractError(`${path}.sequence is not strictly increasing`);
      }
      previousSequence = event.sequence;
      if (event.sourceProtocol !== adapter.manifest.nativeProtocol) {
        throw new AdapterContractError(`${path}.sourceProtocol does not match the manifest`);
      }
      requireNonEmpty(event.sourceId, `${path}.sourceId`);
      requireNonEmpty(event.nativeEventType, `${path}.nativeEventType`);
      requireIso(event.observedAt, `${path}.observedAt`);
      if (event.nativeOccurredAt !== undefined) {
        requireIso(event.nativeOccurredAt, `${path}.nativeOccurredAt`);
      }
      if (event.sanitized !== true) {
        throw new AdapterContractError(`${path} is not marked sanitized`);
      }
      requireEvidence(event.evidenceRefs, `${path}.evidenceRefs`);
      validateJson(event.payload, `${path}.payload`);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return errors;
}

function builtInCapabilityResult(
  capability: AdapterCapabilityNameV1,
  discovery: AdapterDiscoveryV1,
  events: readonly AdapterNativeEventV1[],
): Omit<AdapterConformanceCheckV1, 'checkId'> | undefined {
  if (capability === 'discover') {
    return {
      status: 'passed',
      detail: 'Discovery returned a coherent ready Runtime binding.',
      evidenceRefs: [...discovery.evidenceRefs],
    };
  }
  if (capability === 'observe') {
    return events.length === 0
      ? {
          status: 'failed',
          detail: 'Observe is supported but emitted no evidence.',
          evidenceRefs: [],
        }
      : {
          status: 'passed',
          detail: 'Observe emitted ordered sanitized evidence.',
          evidenceRefs: normalizeRefs(events.flatMap((event) => event.evidenceRefs)),
        };
  }
  if (capability === 'workspace-bind') {
    const workspaceEvents = events.filter((event) => event.semanticHint === 'workspace');
    return workspaceEvents.length === 0
      ? {
          status: 'failed',
          detail: 'Workspace bind is supported but emitted no workspace binding evidence.',
          evidenceRefs: [],
        }
      : {
          status: 'passed',
          detail: 'Workspace binding produced explicit evidence.',
          evidenceRefs: normalizeRefs(workspaceEvents.flatMap((event) => event.evidenceRefs)),
        };
  }
  return undefined;
}

function capabilityNotRun(
  adapter: MissionBraidAdapterV1,
  checks: AdapterConformanceCheckV1[],
): AdapterConformanceCheckV1[] {
  for (const name of ADAPTER_CAPABILITY_NAMES) {
    checks.push({
      checkId: `capability:${name}`,
      status: 'not-applicable',
      detail: `Not run because the Adapter lifecycle did not reach capability probes (${adapter.manifest.capabilities[name].status}).`,
      evidenceRefs: [],
    });
  }
  return checks;
}

function kernelAuthorityPortSurfaceErrors(ports: AdapterHostPortsV1): string[] {
  const errors: string[] = [];
  const allowedHostPorts = new Set(['evidence', 'toolGate']);
  for (const key of Object.keys(ports)) {
    if (!allowedHostPorts.has(key)) errors.push(`ports.${key}`);
  }
  for (const key of Object.keys(ports.evidence)) {
    if (key !== 'append') errors.push(`ports.evidence.${key}`);
  }
  if (typeof ports.evidence.append !== 'function') errors.push('ports.evidence.append');
  if (ports.toolGate !== undefined && typeof ports.toolGate.gate !== 'function') {
    errors.push('ports.toolGate.gate');
  }
  return errors.sort();
}

function report(
  adapter: MissionBraidAdapterV1,
  checks: readonly AdapterConformanceCheckV1[],
): AdapterConformanceReportV1 {
  return {
    schemaVersion: ADAPTER_CONFORMANCE_SCHEMA_VERSION,
    adapterApiVersion: ADAPTER_API_VERSION,
    adapterId: adapter.manifest.adapterId,
    adapterVersion: adapter.manifest.adapterVersion,
    transport: adapter.manifest.transport,
    passed: checks.every((check) => check.status !== 'failed'),
    checks,
    evidenceLevel: 'local-conformance',
    independentExternalReproduction: {
      status: 'not-established',
      requirement:
        'An independent external developer and operator must implement or connect an Adapter and reproduce the flagship evidence matrix.',
    },
  };
}

function pass(
  checkId: string,
  detail: string,
  evidenceRefs: readonly string[] = [],
): AdapterConformanceCheckV1 {
  return { checkId, status: 'passed', detail, evidenceRefs: normalizeRefs(evidenceRefs) };
}

function fail(checkId: string, detail: string): AdapterConformanceCheckV1 {
  return { checkId, status: 'failed', detail, evidenceRefs: [] };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AdapterConformanceTimeoutError(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AdapterContractError('Conformance timeoutMs must be positive');
  }
  return value;
}

function assertAllowedKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new AdapterContractError(`${path} contains unsupported fields: ${unexpected.join(', ')}`);
  }
}

function validateJson(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJson(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      validateJson(entry, `${path}.${key}`);
    }
    return;
  }
  throw new AdapterContractError(`${path} is not JSON evidence`);
}

function requireEvidence(refs: readonly string[], path: string): void {
  if (refs.length === 0) throw new AdapterContractError(`${path} must contain evidence`);
  refs.forEach((ref) => requireNonEmpty(ref, path));
}

function normalizeRefs(refs: readonly string[]): string[] {
  return [...new Set(refs)].sort();
}

function requireIdentifier(value: string, path: string): void {
  requireNonEmpty(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new AdapterContractError(`${path} contains unsupported characters`);
  }
}

function requireNonEmpty(value: string, path: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new AdapterContractError(`${path} must be non-empty`);
  }
}

function requireIso(value: string, path: string): void {
  requireNonEmpty(value, path);
  if (Number.isNaN(Date.parse(value))) throw new AdapterContractError(`${path} must be ISO time`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const discoveryKeys = new Set([
  'adapterId',
  'transport',
  'status',
  'runtimeVersion',
  'authentication',
  'binding',
  'observedAt',
  'evidenceRefs',
]);
const resultKeys = new Set([
  'adapterId',
  'runId',
  'transport',
  'binding',
  'status',
  'exitCode',
  'nativeSession',
  'evidenceRefs',
]);
const eventKeys = new Set([
  'schemaVersion',
  'apiVersion',
  'adapterId',
  'runId',
  'sequence',
  'sourceId',
  'sourceProtocol',
  'nativeEventType',
  'semanticHint',
  'observedAt',
  'nativeOccurredAt',
  'fidelity',
  'payload',
  'sanitized',
  'evidenceRefs',
]);
const baselineCapabilities = [
  'discover',
  'observe',
  'workspace-bind',
] as const satisfies readonly AdapterCapabilityNameV1[];
const capabilityMethods = {
  discover: [],
  observe: [],
  'context-capture': ['captureContext'],
  steer: ['steer'],
  interrupt: ['interrupt'],
  'pre-tool-gate': [],
  resume: ['resume'],
  'native-fork': ['fork'],
  'workspace-bind': [],
  'workspace-restore': ['restoreWorkspace'],
  'external-effect-control': ['lookupExternalEffect', 'dispatchExternalEffect'],
} as const satisfies Readonly<
  Record<AdapterCapabilityNameV1, readonly (keyof MissionBraidAdapterV1)[]>
>;
