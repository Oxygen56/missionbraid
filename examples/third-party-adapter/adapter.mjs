import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  defineAdapterV1,
  validateAdapterRunRequestV1,
} from 'missionbraid/adapter-sdk/v1';

const unsupported = (detail) => ({
  status: 'unsupported',
  fidelity: 'unsupported',
  detail,
});

export const manifest = {
  schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
  apiVersion: ADAPTER_API_VERSION,
  adapterId: 'example.third-party-direct',
  displayName: 'Third-party Direct Adapter Example',
  adapterVersion: '1.0.0',
  transport: 'direct',
  nativeProtocol: 'third-party-example/v1',
  capabilities: {
    discover: {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Reports the example Runtime binding without exposing credentials.',
    },
    observe: {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Emits one sanitized native evidence envelope for each run.',
    },
    'context-capture': unsupported('This example does not expose model context.'),
    steer: unsupported('This example has no live Runtime control channel.'),
    interrupt: unsupported('This example owns no long-lived process.'),
    'pre-tool-gate': unsupported('This example does not invoke mutable tools.'),
    resume: unsupported('This example creates no resumable native session.'),
    'native-fork': unsupported('This example creates no native session Fork.'),
    'workspace-bind': {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Acknowledges the host-supplied local workspace binding as evidence.',
    },
    'workspace-restore': unsupported('Workspace restoration remains a host responsibility.'),
    'external-effect-control': unsupported('This example dispatches no external Effects.'),
  },
};

export function createThirdPartyAdapter({ now = () => new Date() } = {}) {
  return defineAdapterV1({
    manifest,

    async discover(request) {
      return {
        adapterId: manifest.adapterId,
        transport: manifest.transport,
        status: 'ready',
        runtimeVersion: {
          status: 'known',
          value: 'example-runtime-1.0.0',
          source: 'third-party-example',
        },
        authentication: {
          status: 'unsupported',
          reason: 'The example Runtime needs no authentication.',
        },
        binding: {
          kind: 'direct',
          executableRef: 'example:third-party-direct',
          processOwnership: 'adapter',
        },
        observedAt: request.observedAt,
        evidenceRefs: ['third-party-example:discovery'],
      };
    },

    async run(request, ports) {
      validateAdapterRunRequestV1(manifest, request);
      const runId = `run-${request.identity.executionId}`;
      await ports.evidence.append({
        schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
        apiVersion: ADAPTER_API_VERSION,
        adapterId: manifest.adapterId,
        runId,
        sequence: 1,
        sourceId: `source-${request.identity.executionId}`,
        sourceProtocol: manifest.nativeProtocol,
        nativeEventType: 'workspace.bound',
        semanticHint: 'workspace',
        observedAt: now().toISOString(),
        fidelity: 'derived',
        payload: {
          workspaceKey: request.workspace.workspaceKey,
          access: request.workspace.access,
        },
        sanitized: true,
        evidenceRefs: [`third-party-example:workspace:${request.workspace.workspaceKey}`],
      });

      return {
        adapterId: manifest.adapterId,
        runId,
        transport: manifest.transport,
        binding: {
          kind: 'direct',
          executableRef: 'example:third-party-direct',
          processOwnership: 'adapter',
        },
        status: 'completed',
        exitCode: 0,
        nativeSession: {
          status: 'unavailable',
          reason: 'The example Runtime creates no native session.',
        },
        evidenceRefs: [`third-party-example:run:${runId}`],
      };
    },
  });
}
