import { describe, expect, it } from 'vitest';

import { createMinimalDirectAdapter } from '../examples/minimal-adapter.js';
import {
  AdapterContractError,
  AdapterRegistryV1,
  defineAdapterV1,
  validateAdapterManifestV1,
  validateAdapterRunRequestV1,
  validateAdapterRuntimeBindingV1,
  type AdapterManifestV1,
  type AdapterRunRequestV1,
} from './adapter-sdk.js';

describe('Adapter SDK v1 contract', () => {
  it('defines a complete versioned Adapter without exposing Kernel mutation ports', () => {
    const adapter = createMinimalDirectAdapter({
      now: () => new Date('2026-08-26T01:00:00.000Z'),
    });

    expect(defineAdapterV1(adapter)).toBe(adapter);
    expect(adapter.manifest).toMatchObject({
      apiVersion: '1.0.0',
      adapterId: 'example.minimal-direct',
      harnessId: 'minimal-direct',
      transport: 'direct',
    });
    expect(Object.keys(adapter.manifest.capabilities).sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(['manifest', 'discover', 'run'].every((member) => member in adapter)).toBe(true);
    expect(['mission', 'branch', 'effect', 'failure', 'receipt']).not.toEqual(
      expect.arrayContaining(Object.keys(adapter)),
    );

    const registry = new AdapterRegistryV1();
    expect(registry.register(adapter)).toBe(adapter);
    expect(registry.get('example.minimal-direct')).toBe(adapter);
    expect(registry.list()).toEqual([adapter.manifest]);
    expect(() => registry.register(adapter)).toThrow('already registered');
  });

  it('rejects missing and self-contradictory capability declarations', () => {
    const valid = createMinimalDirectAdapter().manifest;
    expect(() =>
      validateAdapterManifestV1({
        ...valid,
        harnessId: '   ',
      }),
    ).toThrow('harnessId');

    const { steer: _steer, ...missingSteer } = valid.capabilities;
    expect(() =>
      validateAdapterManifestV1({
        ...valid,
        capabilities: missingSteer,
      } as unknown as AdapterManifestV1),
    ).toThrow('declare every v1 capability exactly once');

    expect(() =>
      validateAdapterManifestV1({
        ...valid,
        capabilities: {
          ...valid.capabilities,
          interrupt: {
            status: 'supported',
            fidelity: 'unsupported',
            detail: 'contradictory fixture',
          },
        },
      }),
    ).toThrow('Supported capability interrupt must declare an implemented fidelity');
  });

  it('keeps direct, ACP, and provider-backed workspace/binding shapes distinct', () => {
    const direct = createMinimalDirectAdapter().manifest;
    expect(() => validateAdapterRunRequestV1(direct, runRequest('local'))).not.toThrow();
    expect(() => validateAdapterRunRequestV1(direct, runRequest('provider'))).toThrow(
      'direct Adapter requires a local workspace',
    );

    const providerManifest = {
      ...direct,
      adapterId: 'fixture.provider',
      transport: 'provider-backed',
    } as const satisfies AdapterManifestV1;
    expect(() =>
      validateAdapterRunRequestV1(providerManifest, runRequest('provider')),
    ).not.toThrow();
    expect(() => validateAdapterRunRequestV1(providerManifest, runRequest('local'))).toThrow(
      'provider-backed Adapter requires a provider workspace',
    );

    const acpManifest = {
      ...direct,
      adapterId: 'fixture.acp',
      transport: 'acp',
    } as const satisfies AdapterManifestV1;
    expect(() => validateAdapterRunRequestV1(acpManifest, runRequest('local'))).not.toThrow();
    expect(() => validateAdapterRunRequestV1(acpManifest, runRequest('provider'))).not.toThrow();

    expect(() =>
      validateAdapterRuntimeBindingV1('acp', {
        kind: 'acp',
        protocolVersion: '0.1.0',
        endpointRef: 'acp:fixture',
      }),
    ).not.toThrow();
    expect(() =>
      validateAdapterRuntimeBindingV1('provider-backed', {
        kind: 'provider-backed',
        providerId: 'fixture-provider',
        providerVersion: '1.0.0',
        providerSessionRef: 'provider-session:1',
        providerWorkspaceRef: 'provider-workspace:1',
      }),
    ).not.toThrow();
    expect(() =>
      validateAdapterRuntimeBindingV1('direct', {
        kind: 'acp',
        protocolVersion: '0.1.0',
        endpointRef: 'acp:fixture',
      }),
    ).toThrow(AdapterContractError);
  });
});

function runRequest(workspaceKind: 'local' | 'provider'): AdapterRunRequestV1 {
  return {
    identity: {
      executionId: 'execution-1',
      missionId: 'mission-1',
      branchId: 'branch-1',
      attemptId: 'attempt-1',
      bindingId: 'binding-1',
    },
    workspace:
      workspaceKind === 'local'
        ? {
            kind: 'local',
            workspaceKey: 'workspace-1',
            absolutePath: '/tmp/missionbraid-adapter-fixture',
            access: 'read-write',
          }
        : {
            kind: 'provider',
            workspaceKey: 'workspace-1',
            workspaceRef: 'provider-workspace:1',
            access: 'read-write',
          },
    profile: {
      profileId: 'profile-1',
      configurationDigest: 'sha256:profile',
      model: 'fixture-model',
    },
    instruction: 'Emit the bounded fixture evidence.',
  };
}
