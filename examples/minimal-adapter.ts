import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  defineAdapterV1,
  validateAdapterRunRequestV1,
  type AdapterCapabilitiesV1,
  type AdapterDiscoveryRequestV1,
  type AdapterDiscoveryV1,
  type AdapterHostPortsV1,
  type AdapterManifestV1,
  type AdapterRunRequestV1,
  type AdapterRunResultV1,
  type MissionBraidAdapterV1,
} from '../src/adapter-sdk.js';

const unsupported = (detail: string) =>
  ({ status: 'unsupported', fidelity: 'unsupported', detail }) as const;

export const MINIMAL_DIRECT_ADAPTER_CAPABILITIES = {
  discover: {
    status: 'supported',
    fidelity: 'controller',
    detail: 'The example exposes a deterministic local availability observation.',
  },
  observe: {
    status: 'supported',
    fidelity: 'controller',
    detail: 'The example emits one sanitized Adapter event through the durable evidence port.',
  },
  'context-capture': unsupported('The example does not expose model context.'),
  steer: unsupported('The example has no live Runtime channel.'),
  interrupt: unsupported('The example finishes synchronously and exposes no owned process.'),
  'pre-tool-gate': unsupported('The example invokes no tools.'),
  resume: unsupported('The example creates no resumable native session.'),
  'native-fork': unsupported('The example creates no native session Fork.'),
  'workspace-bind': {
    status: 'supported',
    fidelity: 'controller',
    detail: 'The example acknowledges the supplied local workspace identity as evidence.',
  },
  'workspace-restore': unsupported('Workspace restoration remains a host responsibility.'),
  'external-effect-control': unsupported('The example dispatches no external Effects.'),
} as const satisfies AdapterCapabilitiesV1;

export const MINIMAL_DIRECT_ADAPTER_MANIFEST = {
  schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
  apiVersion: ADAPTER_API_VERSION,
  adapterId: 'example.minimal-direct',
  displayName: 'Minimal Direct Adapter',
  adapterVersion: '1.0.0',
  transport: 'direct',
  nativeProtocol: 'example-minimal/v1',
  capabilities: MINIMAL_DIRECT_ADAPTER_CAPABILITIES,
} as const satisfies AdapterManifestV1;

export interface MinimalDirectAdapterOptions {
  readonly now?: () => Date;
}

/**
 * Small compileable extension example. It is conformance-fixture evidence, not
 * a real Harness implementation or independent external reproduction.
 */
export class MinimalDirectAdapter implements MissionBraidAdapterV1 {
  readonly manifest = MINIMAL_DIRECT_ADAPTER_MANIFEST;
  readonly #now: () => Date;

  constructor(options: MinimalDirectAdapterOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async discover(request: AdapterDiscoveryRequestV1): Promise<AdapterDiscoveryV1> {
    return {
      adapterId: this.manifest.adapterId,
      transport: this.manifest.transport,
      status: 'ready',
      runtimeVersion: { status: 'known', value: 'fixture-1.0.0', source: 'example' },
      authentication: { status: 'unsupported', reason: 'The example needs no authentication.' },
      binding: {
        kind: 'direct',
        executableRef: 'example:minimal-direct',
        processOwnership: 'adapter',
      },
      observedAt: request.observedAt,
      evidenceRefs: ['example:minimal-direct:discovery'],
    };
  }

  async run(request: AdapterRunRequestV1, ports: AdapterHostPortsV1): Promise<AdapterRunResultV1> {
    validateAdapterRunRequestV1(this.manifest, request);
    const runId = `run-${request.identity.executionId}`;
    const observedAt = this.#now().toISOString();
    await ports.evidence.append({
      schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
      apiVersion: ADAPTER_API_VERSION,
      adapterId: this.manifest.adapterId,
      runId,
      sequence: 1,
      sourceId: `source-${request.identity.executionId}`,
      sourceProtocol: this.manifest.nativeProtocol,
      nativeEventType: 'workspace.bound',
      semanticHint: 'workspace',
      observedAt,
      fidelity: 'derived',
      payload: {
        workspaceKey: request.workspace.workspaceKey,
        access: request.workspace.access,
      },
      sanitized: true,
      evidenceRefs: [`example:workspace:${request.workspace.workspaceKey}`],
    });

    return {
      adapterId: this.manifest.adapterId,
      runId,
      transport: this.manifest.transport,
      binding: {
        kind: 'direct',
        executableRef: 'example:minimal-direct',
        processOwnership: 'adapter',
      },
      status: 'completed',
      exitCode: 0,
      nativeSession: {
        status: 'unavailable',
        reason: 'The minimal example owns no native session.',
      },
      evidenceRefs: [`example:run:${runId}`],
    };
  }
}

export function createMinimalDirectAdapter(
  options: MinimalDirectAdapterOptions = {},
): MinimalDirectAdapter {
  return defineAdapterV1(new MinimalDirectAdapter(options));
}
