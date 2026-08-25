import { resolve } from 'node:path';

import { runAdapterConformanceSuiteV1 } from 'missionbraid/adapter-conformance/v1';

import { createThirdPartyAdapter } from './adapter.mjs';

const observedAt = '2026-08-26T00:00:00.000Z';
const report = await runAdapterConformanceSuiteV1(
  createThirdPartyAdapter({ now: () => new Date(observedAt) }),
  {
    discoveryRequest: { observedAt },
    runRequest: {
      identity: {
        executionId: 'execution-third-party-example',
        missionId: 'mission-third-party-example',
        branchId: 'branch-third-party-example',
        attemptId: 'attempt-third-party-example',
        bindingId: 'binding-third-party-example',
      },
      workspace: {
        kind: 'local',
        workspaceKey: 'workspace-third-party-example',
        absolutePath: resolve(process.cwd()),
        access: 'read-write',
      },
      profile: {
        profileId: 'profile-third-party-example',
        configurationDigest: 'sha256:third-party-example-profile',
      },
      instruction: 'Emit bounded local conformance evidence.',
    },
  },
);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
