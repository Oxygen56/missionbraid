export const MISSIONBRAID_PUBLIC_API_VERSION = '1.0.0' as const;
export const MISSIONBRAID_PUBLIC_API_SCHEMA_VERSION = 'missionbraid.dev/public-api/v1' as const;

/** Machine-readable authority and evidence boundary for public integrations. */
export const MISSIONBRAID_PUBLIC_API_SURFACE_V1 = {
  schemaVersion: MISSIONBRAID_PUBLIC_API_SCHEMA_VERSION,
  apiVersion: MISSIONBRAID_PUBLIC_API_VERSION,
  adapterTransports: ['direct', 'acp', 'provider-backed'],
  adapterOutputs: ['capability-observation', 'native-evidence', 'runtime-run-outcome'],
  hostOwnedStateMachines: ['Mission', 'Branch', 'Effect', 'failure', 'Receipt'],
  independentExternalReproduction: {
    status: 'not-established',
    requires: 'independent-external-developer-and-operator',
  },
} as const;

export * from './adapter-sdk.js';
export * from './adapter-conformance.js';
export * from './package-contract.js';
