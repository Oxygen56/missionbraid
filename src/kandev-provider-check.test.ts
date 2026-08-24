import { describe, expect, it, vi } from 'vitest';

import {
  KANDEV_PROVIDER_CHECK_CONFIG_SCHEMA,
  KandevProviderCheckError,
  parseKandevProviderCheckConfig,
  runKandevProviderCheck,
  verifyKandevProviderCheckResult,
  type KandevProviderCheckClient,
  type KandevProviderCheckConfigV1,
} from './kandev-provider-check.js';
import {
  KANDEV_COMMIT,
  KANDEV_VERSION,
  KandevTimeoutError,
  type KandevPreparedTaskResult,
  type KandevProcess,
} from './providers/kandev.js';

const config: KandevProviderCheckConfigV1 = {
  schemaVersion: KANDEV_PROVIDER_CHECK_CONFIG_SCHEMA,
  baseUrl: 'http://127.0.0.1:18080',
  workspaceId: 'workspace-1',
  workflowId: 'workflow-1',
  repositoryId: 'repository-1',
  baseBranch: 'main',
  agentProfileId: 'agent-profile-1',
  executorId: 'exec-worktree',
  executorProfileId: 'executor-profile-1',
  scriptName: 'probe-sleep',
  externalId: 'missionbraid-kandev-check-test-1',
};

const task: KandevPreparedTaskResult = {
  provider: 'kandev',
  detection: {
    provider: 'kandev',
    compatible: true,
    version: KANDEV_VERSION,
    commit: KANDEV_COMMIT.slice(0, 7),
    commitKind: 'prefix',
    bootId: 'boot-1',
  },
  taskId: 'task-1',
  externalId: config.externalId,
  deduplicated: false,
  creationComplete: true,
  sessionReconciled: false,
  session: {
    id: 'session-1',
    taskId: 'task-1',
    repositoryId: config.repositoryId,
    agentProfileId: config.agentProfileId,
    executorId: config.executorId,
    executorProfileId: config.executorProfileId,
    worktreeId: 'worktree-1',
    worktreePath: '/data/tasks/check/repository',
    worktreeBranch: 'feature/check-abc',
    workspacePath: '/data/tasks/check/repository',
    isPrimary: true,
  },
};

const process: KandevProcess = {
  id: 'process-1',
  sessionId: task.session.id,
  kind: 'custom',
  scriptName: config.scriptName,
  workingDirectory: task.session.worktreePath,
  status: 'running',
};

describe('Kandev provider compatibility check', () => {
  it('runs one start, verifies the worktree binding, stops, and hashes the result', async () => {
    const client = fakeClient();

    const result = await runKandevProviderCheck(config, client, {
      now: () => new Date('2026-08-24T01:02:03.000Z'),
    });

    expect(client.detect).toHaveBeenCalledTimes(1);
    expect(client.createPreparedTask).toHaveBeenCalledTimes(1);
    expect(client.startPreconfiguredCustomProcess).toHaveBeenCalledTimes(1);
    expect(client.stopProcess).toHaveBeenCalledWith('session-1', 'process-1', {
      timeoutMs: 15_000,
    });
    expect(result.process.acquisition).toBe('started');
    expect(result.binding.worktreePath).toBe('/data/tasks/check/repository');
    expect(result.claimBoundary).toEqual({
      missionExecutionObserved: false,
      sessionLifecycleObserved: false,
      outcomeReceiptIssued: false,
      providerSupportEstablished: false,
      productionReadinessEstablished: false,
    });
    expect(result.observedAt).toBe('2026-08-24T01:02:03.000Z');
    expect(verifyKandevProviderCheckResult(result)).toBe(true);
    expect(verifyKandevProviderCheckResult({ ...result, observedAt: 'changed' })).toBe(false);
  });

  it('reconciles an unknown start outcome without sending a second start', async () => {
    const client = fakeClient();
    let now = 0;
    vi.mocked(client.listProcesses)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([process]);
    vi.mocked(client.startPreconfiguredCustomProcess).mockRejectedValueOnce(
      new KandevTimeoutError('request timed out'),
    );

    const result = await runKandevProviderCheck(config, client, {
      cleanupTimeoutMs: 1_000,
      clock: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    });

    expect(client.startPreconfiguredCustomProcess).toHaveBeenCalledTimes(1);
    expect(client.getProcess).not.toHaveBeenCalled();
    expect(result.process.acquisition).toBe('reconciled-after-unknown-start');
    expect(result.process.automaticStartRetries).toBe(0);
    expect(client.stopProcess).toHaveBeenCalledTimes(1);
  });

  it('recovers the only matching process in its dedicated prepared session', async () => {
    const client = fakeClient();
    vi.mocked(client.listProcesses).mockResolvedValueOnce([process]);

    const result = await runKandevProviderCheck(config, client);

    expect(client.startPreconfiguredCustomProcess).not.toHaveBeenCalled();
    expect(result.process.acquisition).toBe('recovered-existing');
    expect(client.stopProcess).toHaveBeenCalledTimes(1);
  });

  it('does not start or stop when the prepared session has unrelated processes', async () => {
    const client = fakeClient();
    vi.mocked(client.listProcesses).mockResolvedValueOnce([
      { ...process, id: 'other-process', scriptName: 'user-script' },
    ]);

    await expect(runKandevProviderCheck(config, client)).rejects.toThrow(
      'ambiguous or unrelated processes',
    );
    expect(client.startPreconfiguredCustomProcess).not.toHaveBeenCalled();
    expect(client.stopProcess).not.toHaveBeenCalled();
  });

  it('stops a started process when its status or worktree binding is invalid', async () => {
    const client = fakeClient();
    vi.mocked(client.getProcess).mockResolvedValueOnce({ ...process, status: 'exited' });

    await expect(runKandevProviderCheck(config, client)).rejects.toThrow(
      'does not match the prepared worktree or is not running',
    );
    expect(client.stopProcess).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an unknown start cannot be reconciled', async () => {
    const client = fakeClient();
    let now = 0;
    vi.mocked(client.listProcesses).mockResolvedValue([]);
    vi.mocked(client.startPreconfiguredCustomProcess).mockRejectedValueOnce(
      new KandevTimeoutError('request timed out'),
    );

    await expect(
      runKandevProviderCheck(config, client, {
        cleanupTimeoutMs: 10,
        clock: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      }),
    ).rejects.toThrow('start outcome is unknown');
    expect(client.startPreconfiguredCustomProcess).toHaveBeenCalledTimes(1);
    expect(client.stopProcess).not.toHaveBeenCalled();
  });

  it('does not call an already-absent process an accepted stop', async () => {
    const client = fakeClient();
    vi.mocked(client.stopProcess).mockResolvedValueOnce({
      provider: 'kandev',
      detection: task.detection,
      sessionId: task.session.id,
      processId: process.id,
      stopStatus: 404,
      absentFromGet: true,
      absentFromList: true,
    });

    await expect(runKandevProviderCheck(config, client)).rejects.toThrow(
      'did not observe an accepted stop request',
    );
  });
});

describe('parseKandevProviderCheckConfig', () => {
  it('accepts the strict v1 shape and normalizes the URL origin', () => {
    expect(parseKandevProviderCheckConfig(config)).toEqual(config);
  });

  it.each([
    [{ ...config, token: 'secret' }, 'Unknown Kandev provider-check config field'],
    [{ ...config, baseUrl: 'https://user:secret@example.test' }, 'without credentials'],
    [{ ...config, baseUrl: 'https://example.test/api' }, 'without credentials, path'],
    [{ ...config, externalId: 'other-tool-check-1' }, 'must use the missionbraid'],
    [
      { ...config, schemaVersion: 'missionbraid.dev/provider-check/kandev/config/v2' },
      'Unsupported',
    ],
  ])('rejects an invalid or expanded config', (candidate, message) => {
    expect(() => parseKandevProviderCheckConfig(candidate)).toThrow(message);
  });

  it('rejects non-object input', () => {
    expect(() => parseKandevProviderCheckConfig('config')).toThrow(KandevProviderCheckError);
  });
});

function fakeClient(): KandevProviderCheckClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    detect: vi.fn().mockResolvedValue(task.detection),
    createPreparedTask: vi.fn().mockResolvedValue(task),
    listProcesses: vi.fn().mockResolvedValue([]),
    startPreconfiguredCustomProcess: vi.fn().mockResolvedValue({
      provider: 'kandev',
      detection: task.detection,
      sessionId: task.session.id,
      processId: process.id,
      repositoryId: config.repositoryId,
      scriptName: config.scriptName,
      workingDirectory: process.workingDirectory,
      status: process.status,
    }),
    getProcess: vi.fn().mockResolvedValue(process),
    stopProcess: vi.fn().mockResolvedValue({
      provider: 'kandev',
      detection: task.detection,
      sessionId: task.session.id,
      processId: process.id,
      stopStatus: 204,
      absentFromGet: true,
      absentFromList: true,
    }),
  };
}
