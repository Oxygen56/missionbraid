import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAdapterConformanceSuiteV1 } from 'missionbraid/adapter-conformance/v1';

import { createAcpStdioAdapter } from './adapter.mjs';

const workspace = await mkdtemp(join(tmpdir(), 'missionbraid-acp-example-'));
try {
  const adapter = createAcpStdioAdapter();
  const report = await runAdapterConformanceSuiteV1(adapter, {
    discoveryRequest: { observedAt: new Date().toISOString() },
    runRequest: {
      identity: {
        executionId: 'execution-acp-example',
        missionId: 'mission-acp-example',
        branchId: 'branch-acp-example',
        attemptId: 'attempt-acp-example',
        bindingId: 'binding-acp-example',
      },
      workspace: {
        kind: 'local',
        workspaceKey: 'workspace-acp-example',
        absolutePath: workspace,
        access: 'read-write',
      },
      profile: {
        profileId: 'profile-acp-example',
        configurationDigest: 'sha256:acp-example',
      },
      instruction: 'Write the ACP fixture result.',
    },
    timeoutMs: 15_000,
  });
  if ((await readFile(join(workspace, 'acp-result.txt'), 'utf8')) !== 'acp-completed\n') {
    throw new Error('The ACP fixture Agent did not produce the expected workspace result.');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
