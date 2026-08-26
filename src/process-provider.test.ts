import { describe, expect, it, vi } from 'vitest';

import { runAdapterConformanceSuiteV1 } from './adapter-conformance.js';
import type { AdapterRunRequestV1 } from './adapter-sdk.js';
import {
  PROCESS_PROVIDER_API_VERSION,
  PROCESS_PROVIDER_MANIFEST_SCHEMA_VERSION,
  createProcessProviderAdapterV1,
  type ProcessExecutionProviderV1,
  type ProcessProviderObservationV1,
} from './process-provider.js';

const observedAt = '2026-08-26T12:00:00.000Z';

describe('replaceable process provider Adapter', () => {
  it('runs a provider-backed process through the public Adapter API and conformance suite', async () => {
    const provider = fakeProvider();
    const adapter = createProcessProviderAdapterV1({
      provider,
      now: () => new Date(observedAt),
      sleep: async () => undefined,
    });

    const report = await runAdapterConformanceSuiteV1(adapter, {
      discoveryRequest: { observedAt },
      runRequest: providerRequest(),
      timeoutMs: 1_000,
    });

    expect(report.passed).toBe(true);
    expect(report.transport).toBe('provider-backed');
    expect(provider.start).toHaveBeenCalledOnce();
    expect(provider.observe).toHaveBeenCalledTimes(2);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ checkId: 'capability:workspace-bind', status: 'passed' }),
    );
  });

  it('rejects a provider that silently rebinds the workspace', async () => {
    const provider = fakeProvider();
    vi.mocked(provider.start).mockResolvedValueOnce({
      providerRunId: 'provider-run-1',
      providerSessionRef: 'provider-session-1',
      providerWorkspaceRef: 'provider-workspace:different',
      startedAt: observedAt,
      evidenceRefs: ['provider:start:1'],
    });
    const adapter = createProcessProviderAdapterV1({ provider, sleep: async () => undefined });

    await expect(adapter.run(providerRequest(), { evidence: { append: vi.fn() } })).rejects.toThrow(
      'different workspace binding',
    );
  });

  it('rejects duplicate or out-of-order provider event sequences', async () => {
    const provider = fakeProvider();
    vi.mocked(provider.observe)
      .mockReset()
      .mockResolvedValueOnce(observation('running', [providerEvent(1), providerEvent(1)]));
    const adapter = createProcessProviderAdapterV1({ provider, sleep: async () => undefined });

    await expect(
      adapter.run(providerRequest(), {
        evidence: { append: vi.fn().mockResolvedValue(undefined) },
      }),
    ).rejects.toThrow('not strictly increasing');
  });
});

function fakeProvider(): ProcessExecutionProviderV1 {
  return {
    manifest: {
      schemaVersion: PROCESS_PROVIDER_MANIFEST_SCHEMA_VERSION,
      apiVersion: PROCESS_PROVIDER_API_VERSION,
      providerId: 'fixture-process-provider',
      displayName: 'Fixture Process Provider',
      providerVersion: '1.0.0',
      nativeProtocol: 'fixture-process-provider/v1',
    },
    discover: vi.fn().mockResolvedValue({
      status: 'ready',
      runtimeVersion: { status: 'known', value: '1.0.0', source: 'fixture' },
      authentication: { status: 'unsupported', reason: 'No authentication in fixture.' },
      endpointRef: 'process-provider:fixture',
      discoverySessionRef: 'provider-session:unbound',
      discoveryWorkspaceRef: 'provider-workspace:unbound',
      observedAt,
      evidenceRefs: ['provider:discovery'],
    }),
    start: vi.fn().mockResolvedValue({
      providerRunId: 'provider-run-1',
      providerSessionRef: 'provider-session-1',
      providerWorkspaceRef: 'provider-workspace:fixture',
      startedAt: observedAt,
      evidenceRefs: ['provider:start:1'],
    }),
    observe: vi
      .fn()
      .mockResolvedValueOnce(observation('running', [providerEvent(1)]))
      .mockResolvedValueOnce(observation('completed', [providerEvent(2)], 0)),
    stop: vi.fn().mockResolvedValue(observation('aborted', [], null)),
  };
}

function providerRequest(): AdapterRunRequestV1 {
  return {
    identity: {
      executionId: 'execution-provider-fixture',
      missionId: 'mission-provider-fixture',
      branchId: 'branch-provider-fixture',
      attemptId: 'attempt-provider-fixture',
      bindingId: 'binding-provider-fixture',
    },
    workspace: {
      kind: 'provider',
      workspaceKey: 'workspace-provider-fixture',
      workspaceRef: 'provider-workspace:fixture',
      access: 'read-write',
    },
    profile: {
      profileId: 'profile-provider-fixture',
      configurationDigest: 'sha256:provider-fixture',
    },
    instruction: 'Write the provider-owned fixture result.',
  };
}

function providerEvent(sequence: number) {
  return {
    sequence,
    sourceId: 'provider-process-1',
    nativeEventType: sequence === 1 ? 'process.started' : 'process.completed',
    semanticHint: 'runtime' as const,
    occurredAt: observedAt,
    fidelity: 'native' as const,
    payload: { sequence },
    sanitized: true as const,
    evidenceRefs: [`provider:event:${String(sequence)}`],
  };
}

function observation(
  status: ProcessProviderObservationV1['status'],
  events: ProcessProviderObservationV1['events'],
  exitCode?: number | null,
): ProcessProviderObservationV1 {
  return {
    status,
    ...(exitCode === undefined ? {} : { exitCode }),
    observedAt,
    events,
    evidenceRefs: [`provider:observation:${status}`],
  };
}
