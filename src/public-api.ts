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
export * from './process-provider.js';
export * from './package-contract.js';
// These modules are pure, content-addressed projections. They expose the
// Agent Revision/Evaluation and Mission Plan contracts without exposing the
// Mission Kernel's mutable state machines.
export * from './outcome-studio.js';
export * from './mission-plan.js';
export * from './mission-plan-runtime.js';
