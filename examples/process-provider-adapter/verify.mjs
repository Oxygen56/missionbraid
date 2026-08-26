import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAdapterConformanceSuiteV1 } from 'missionbraid/adapter-conformance/v1';

import { createExampleProcessProviderAdapter } from './provider.mjs';

const workspace = await mkdtemp(join(tmpdir(), 'missionbraid-process-provider-example-'));
try {
  const workspaceRef = 'provider-workspace:conformance';
  const adapter = createExampleProcessProviderAdapter({
    workspaceByRef: new Map([[workspaceRef, workspace]]),
  });
  const report = await runAdapterConformanceSuiteV1(adapter, {
    discoveryRequest: { observedAt: new Date().toISOString() },
    runRequest: {
      identity: {
        executionId: 'execution-process-provider-example',
        missionId: 'mission-process-provider-example',
        branchId: 'branch-process-provider-example',
        attemptId: 'attempt-process-provider-example',
        bindingId: 'binding-process-provider-example',
      },
      workspace: {
        kind: 'provider',
        workspaceKey: 'workspace-process-provider-example',
        workspaceRef,
        access: 'read-write',
      },
      profile: {
        profileId: 'profile-process-provider-example',
        configurationDigest: 'sha256:process-provider-example',
      },
      instruction: 'Write the process provider result.',
    },
    timeoutMs: 15_000,
  });
  if ((await readFile(join(workspace, 'provider-result.txt'), 'utf8')) !== 'provider-completed\n') {
    throw new Error('The provider-owned process did not produce the expected workspace result.');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
