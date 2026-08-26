import { describe, expect, it } from 'vitest';

import {
  MINIMAL_DIRECT_ADAPTER_CAPABILITIES,
  createMinimalDirectAdapter,
} from '../examples/minimal-adapter.js';
import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  type AdapterManifestV1,
  type AdapterRunRequestV1,
  type AdapterRuntimeBindingV1,
  type MissionBraidAdapterV1,
} from './adapter-sdk.js';
import { runAdapterConformanceSuiteV1 } from './adapter-conformance.js';

describe('Adapter capability conformance suite v1', () => {
  it('passes the minimal external-style Adapter and preserves the evidence boundary', async () => {
    const adapter = createMinimalDirectAdapter({
      now: () => new Date('2026-08-26T01:00:01.000Z'),
    });
    const report = await runAdapterConformanceSuiteV1(adapter, fixture('local'));

    expect(report.passed).toBe(true);
    expect(report).toMatchObject({
      adapterApiVersion: '1.0.0',
      adapterId: 'example.minimal-direct',
      transport: 'direct',
      evidenceLevel: 'local-conformance',
      independentExternalReproduction: { status: 'not-established' },
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'manifest', status: 'passed' }),
        expect.objectContaining({ checkId: 'event-stream', status: 'passed' }),
        expect.objectContaining({
          checkId: 'kernel-authority-boundary',
          status: 'passed',
        }),
        expect.objectContaining({
          checkId: 'capability:workspace-bind',
          status: 'passed',
        }),
        expect.objectContaining({
          checkId: 'capability:pre-tool-gate',
          status: 'not-applicable',
        }),
      ]),
    );
  });

  it('accepts direct, ACP, and provider-backed implementations through one API shape', async () => {
    const cases = [
      {
        adapter: createMinimalDirectAdapter({
          now: () => new Date('2026-08-26T01:00:02.000Z'),
        }),
        fixture: fixture('local'),
      },
      { adapter: transportFixtureAdapter('acp'), fixture: fixture('local') },
      {
        adapter: transportFixtureAdapter('provider-backed'),
        fixture: fixture('provider'),
      },
    ] as const;

    const reports = await Promise.all(
      cases.map(
        async (candidate) =>
          await runAdapterConformanceSuiteV1(candidate.adapter, candidate.fixture),
      ),
    );
    expect(reports.map((report) => [report.transport, report.passed])).toEqual([
      ['direct', true],
      ['acp', true],
      ['provider-backed', true],
    ]);
  });

  it('requires a behavioral probe for each extra capability claimed as supported', async () => {
    const base = createMinimalDirectAdapter({
      now: () => new Date('2026-08-26T01:00:03.000Z'),
    });
    const adapter: MissionBraidAdapterV1 = {
      manifest: {
        ...base.manifest,
        capabilities: {
          ...base.manifest.capabilities,
          interrupt: {
            status: 'supported',
            fidelity: 'controller',
            detail: 'Fixture claims an owned interrupt boundary.',
          },
        },
      },
      discover: (request) => base.discover(request),
      run: (request, ports) => base.run(request, ports),
      interrupt: async (request) => ({
        operationId: request.operationId,
        status: 'completed',
        evidenceRefs: ['fixture:interrupt:stopped'],
        outputRefs: [],
      }),
    };

    const missingProbe = await runAdapterConformanceSuiteV1(adapter, fixture('local'));
    expect(missingProbe.passed).toBe(false);
    expect(missingProbe.checks).toContainEqual(
      expect.objectContaining({
        checkId: 'capability:interrupt',
        status: 'failed',
        detail: expect.stringContaining('requires a behavioral conformance probe'),
      }),
    );

    const probed = await runAdapterConformanceSuiteV1(adapter, {
      ...fixture('local'),
      capabilityProbes: {
        interrupt: async ({ adapter: candidate }) => {
          const outcome = await candidate.interrupt?.({
            operationId: 'interrupt-1',
            executionId: 'execution-conformance',
            nativeSessionRef: 'fixture-session:1',
            inputRef: 'intervention:interrupt-1',
          });
          return {
            passed: outcome?.status === 'completed',
            detail: 'Fixture observed the owned process stop before the deadline.',
            evidenceRefs: outcome?.evidenceRefs ?? [],
          };
        },
      },
    });
    expect(probed.passed).toBe(true);
    expect(probed.checks).toContainEqual(
      expect.objectContaining({ checkId: 'capability:interrupt', status: 'passed' }),
    );
  });

  it('rejects an Adapter result that tries to emit host-authority state', async () => {
    const base = createMinimalDirectAdapter({
      now: () => new Date('2026-08-26T01:00:04.000Z'),
    });
    const adapter: MissionBraidAdapterV1 = {
      manifest: base.manifest,
      discover: (request) => base.discover(request),
      run: async (request, ports) => {
        const result = await base.run(request, ports);
        return { ...result, receiptOutcome: 'verified' } as unknown as typeof result;
      },
    };

    const report = await runAdapterConformanceSuiteV1(adapter, fixture('local'));
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        checkId: 'run-lifecycle',
        status: 'failed',
        detail: expect.stringContaining('unsupported fields: receiptOutcome'),
      }),
    );
  });

  it('treats Kernel-like nested payload fields as non-authoritative evidence', async () => {
    const base = createMinimalDirectAdapter({
      now: () => new Date('2026-08-26T01:00:05.000Z'),
    });
    const adapter: MissionBraidAdapterV1 = {
      manifest: base.manifest,
      discover: (request) => base.discover(request),
      run: async (request, ports) =>
        await base.run(request, {
          ...ports,
          evidence: {
            append: async (event) =>
              await ports.evidence.append({
                ...event,
                payload: {
                  adapterObservation: event.payload,
                  nested: {
                    missionStatus: 'succeeded',
                    receiptOutcome: 'verified',
                  },
                },
              }),
          },
        }),
    };

    const report = await runAdapterConformanceSuiteV1(adapter, fixture('local'));
    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        checkId: 'kernel-authority-boundary',
        status: 'passed',
        detail: expect.stringContaining('no Kernel mutation port'),
      }),
    );
  });
});

function fixture(workspace: 'local' | 'provider') {
  return {
    discoveryRequest: { observedAt: '2026-08-26T01:00:00.000Z' },
    runRequest: runRequest(workspace),
    timeoutMs: 1_000,
  } as const;
}

function runRequest(workspace: 'local' | 'provider'): AdapterRunRequestV1 {
  return {
    identity: {
      executionId: 'execution-conformance',
      missionId: 'mission-conformance',
      branchId: 'branch-conformance',
      attemptId: 'attempt-conformance',
      bindingId: 'binding-conformance',
    },
    workspace:
      workspace === 'local'
        ? {
            kind: 'local',
            workspaceKey: 'workspace-conformance',
            absolutePath: '/tmp/missionbraid-conformance',
            access: 'read-write',
          }
        : {
            kind: 'provider',
            workspaceKey: 'workspace-conformance',
            workspaceRef: 'provider-workspace:conformance',
            access: 'read-write',
          },
    profile: {
      profileId: 'profile-conformance',
      configurationDigest: 'sha256:profile-conformance',
    },
    instruction: 'Emit bounded conformance evidence.',
  };
}

function transportFixtureAdapter(transport: 'acp' | 'provider-backed'): MissionBraidAdapterV1 {
  const adapterId = `fixture.${transport}`;
  const nativeProtocol = transport === 'acp' ? 'acp/0.1' : 'fixture-provider/v1';
  const manifest = {
    schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
    apiVersion: ADAPTER_API_VERSION,
    adapterId,
    harnessId: `fixture-${transport}`,
    displayName: `Fixture ${transport}`,
    adapterVersion: '1.0.0',
    transport,
    nativeProtocol,
    capabilities: MINIMAL_DIRECT_ADAPTER_CAPABILITIES,
  } as const satisfies AdapterManifestV1;
  const binding = (): AdapterRuntimeBindingV1 =>
    transport === 'acp'
      ? {
          kind: 'acp',
          protocolVersion: '0.1.0',
          endpointRef: 'acp:fixture-endpoint',
          sessionRef: 'acp-session:fixture',
        }
      : {
          kind: 'provider-backed',
          providerId: 'fixture-provider',
          providerVersion: '1.0.0',
          providerSessionRef: 'provider-session:fixture',
          providerWorkspaceRef: 'provider-workspace:conformance',
        };

  return {
    manifest,
    discover: async (request) => ({
      adapterId,
      transport,
      status: 'ready',
      runtimeVersion: { status: 'known', value: '1.0.0', source: 'fixture' },
      authentication: { status: 'known', value: 'ready', source: 'fixture' },
      binding: binding(),
      observedAt: request.observedAt,
      evidenceRefs: [`fixture:${transport}:discovery`],
    }),
    run: async (request, ports) => {
      const runId = `run-${transport}`;
      await ports.evidence.append({
        schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
        apiVersion: ADAPTER_API_VERSION,
        adapterId,
        runId,
        sequence: 1,
        sourceId: `source-${transport}`,
        sourceProtocol: nativeProtocol,
        nativeEventType: 'workspace.bound',
        semanticHint: 'workspace',
        observedAt: '2026-08-26T01:00:05.000Z',
        fidelity: 'native',
        payload: { workspaceKey: request.workspace.workspaceKey },
        sanitized: true,
        evidenceRefs: [`fixture:${transport}:workspace-bound`],
      });
      return {
        adapterId,
        runId,
        transport,
        binding: binding(),
        status: 'completed',
        nativeSession:
          transport === 'acp'
            ? { status: 'available', sessionRef: 'acp-session:fixture', resumable: true }
            : {
                status: 'available',
                sessionRef: 'provider-session:fixture',
                resumable: true,
              },
        evidenceRefs: [`fixture:${transport}:run`],
      };
    },
  };
}
