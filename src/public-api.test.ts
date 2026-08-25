import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as publicApi from './public-api.js';

describe('versioned public API and package contract', () => {
  it('exports the Adapter SDK and conformance surface without Kernel mutation APIs', () => {
    expect(publicApi.MISSIONBRAID_PUBLIC_API_VERSION).toBe('1.0.0');
    expect(publicApi.ADAPTER_API_VERSION).toBe('1.0.0');
    expect(publicApi.MISSIONBRAID_PUBLIC_API_SURFACE_V1).toMatchObject({
      adapterTransports: ['direct', 'acp', 'provider-backed'],
      adapterOutputs: ['capability-observation', 'native-evidence', 'runtime-run-outcome'],
      hostOwnedStateMachines: ['Mission', 'Branch', 'Effect', 'failure', 'Receipt'],
      independentExternalReproduction: { status: 'not-established' },
    });
    expect(publicApi.defineAdapterV1).toBeTypeOf('function');
    expect(publicApi.runAdapterConformanceSuiteV1).toBeTypeOf('function');
    expect(publicApi.validatePackageManifestV1).toBeTypeOf('function');
    expect(Object.keys(publicApi)).not.toEqual(
      expect.arrayContaining([
        'MissionStore',
        'appendMissionEvent',
        'changeBranchStatus',
        'changeEffectStatus',
        'issueReceipt',
      ]),
    );
  });

  it('defines and validates the exact 1.x ESM export map without publishing it', () => {
    const contract = publicApi.MISSIONBRAID_PACKAGE_CONTRACT_V1;
    const candidate = {
      name: contract.packageName,
      version: '1.0.0',
      private: false,
      type: contract.moduleType,
      engines: { node: contract.nodeEngine },
      bin: contract.cli,
      types: contract.types,
      files: [...contract.files],
      exports: contract.exports,
    };

    expect(publicApi.validatePackageManifestV1(candidate)).toEqual({
      schemaVersion: 'missionbraid.dev/package-contract/v1',
      conforms: true,
      issues: [],
      independentExternalReproduction: 'not-established',
    });
    expect(contract.exports).toMatchObject({
      '.': {
        types: './dist/src/public-api.d.ts',
        import: './dist/src/public-api.js',
      },
      './adapter-sdk': {
        types: './dist/src/adapter-sdk.d.ts',
        import: './dist/src/adapter-sdk.js',
      },
      './adapter-sdk/v1': {
        types: './dist/src/adapter-sdk.d.ts',
        import: './dist/src/adapter-sdk.js',
      },
      './adapter-conformance': {
        types: './dist/src/adapter-conformance.d.ts',
        import: './dist/src/adapter-conformance.js',
      },
    });

    const unwired = publicApi.validatePackageManifestV1({
      name: 'missionbraid',
      version: '0.0.0',
      private: true,
      type: 'module',
    });
    expect(unwired.conforms).toBe(false);
    expect(unwired.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['private', 'version', 'engines.node', 'exports...types']),
    );

    const repositoryManifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    expect(publicApi.validatePackageManifestV1(repositoryManifest)).toEqual({
      schemaVersion: 'missionbraid.dev/package-contract/v1',
      conforms: true,
      issues: [],
      independentExternalReproduction: 'not-established',
    });
  });

  it('keeps examples independent of Mission state-machine modules', () => {
    const exampleSource = readFileSync(
      new URL('../examples/minimal-adapter.ts', import.meta.url),
      'utf8',
    );
    expect(exampleSource).toContain("from '../src/adapter-sdk.js'");
    expect(exampleSource).not.toMatch(
      /from ['"].*(?:domain|engine|store|failure-intelligence|external-effect).*['"]/,
    );
    const thirdPartySource = readFileSync(
      new URL('../examples/third-party-adapter/adapter.mjs', import.meta.url),
      'utf8',
    );
    expect(thirdPartySource).toContain("from 'missionbraid/adapter-sdk/v1'");
    expect(thirdPartySource).not.toMatch(/from ['"]\.\.\/(?:src|dist)\//);
    expect(publicApi.MISSIONBRAID_PACKAGE_CONTRACT_V1.publicationBoundary).toEqual({
      packageManifestWired: true,
      localTarballInstallable: true,
      registryPublication: 'not-performed',
      independentExternalReproduction: 'not-established',
    });
  });
});
