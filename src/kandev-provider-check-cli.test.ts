import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseKandevProviderCheckArguments,
  runKandevProviderCheckCommand,
} from './kandev-provider-check-cli.js';
import {
  KANDEV_PROVIDER_CHECK_CONFIG_SCHEMA,
  verifyKandevProviderCheckResult,
  type KandevProviderCheckClient,
  type KandevProviderCheckResultV1,
} from './kandev-provider-check.js';
import { KANDEV_COMMIT, KANDEV_VERSION } from './providers/kandev.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Kandev provider-check CLI', () => {
  it('parses the narrow provider command and resolves file paths', () => {
    expect(
      parseKandevProviderCheckArguments(['kandev', 'check.json', '--output', 'result.json']),
    ).toEqual({
      configFile: resolve('check.json'),
      outputFile: resolve('result.json'),
    });
  });

  it('runs without Mission state and writes the same hash-bound JSON it prints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-kandev-check-cli-'));
    roots.push(root);
    const configFile = join(root, 'config.json');
    const outputFile = join(root, 'result.json');
    await writeFile(
      configFile,
      JSON.stringify({
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
        externalId: 'missionbraid-kandev-check-cli-test',
      }),
      'utf8',
    );
    let printed = '';
    let reportedError = '';

    const code = await runKandevProviderCheckCommand(
      ['kandev', configFile, '--output', outputFile],
      {
        createClient: () => fakeClient(),
        stdout: (text) => {
          printed += text;
        },
        stderr: (text) => {
          reportedError += text;
        },
        now: () => new Date('2026-08-24T01:02:03.000Z'),
      },
    );

    expect(code).toBe(0);
    expect(reportedError).toBe('');
    expect(await readFile(outputFile, 'utf8')).toBe(printed);
    const result = JSON.parse(printed) as KandevProviderCheckResultV1;
    expect(verifyKandevProviderCheckResult(result)).toBe(true);
    await expect(readFile(join(root, '.missionbraid', 'missions.sqlite'))).rejects.toThrow();
  });

  it('reports usage errors without creating a client', async () => {
    const createClient = vi.fn();
    let stderr = '';
    const code = await runKandevProviderCheckCommand(['kandev'], {
      createClient,
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(code).toBe(64);
    expect(stderr).toContain('requires a config JSON file');
    expect(createClient).not.toHaveBeenCalled();
  });
});

function fakeClient(): KandevProviderCheckClient {
  const detection = {
    provider: 'kandev' as const,
    compatible: true as const,
    version: KANDEV_VERSION,
    commit: KANDEV_COMMIT.slice(0, 7),
    commitKind: 'prefix' as const,
    bootId: 'boot-1',
  };
  const session = {
    id: 'session-1',
    taskId: 'task-1',
    repositoryId: 'repository-1',
    agentProfileId: 'agent-profile-1',
    executorId: 'exec-worktree',
    executorProfileId: 'executor-profile-1',
    worktreeId: 'worktree-1',
    worktreePath: '/data/tasks/check/repository',
    worktreeBranch: 'feature/check-abc',
    workspacePath: '/data/tasks/check/repository',
    isPrimary: true,
  };
  const process = {
    id: 'process-1',
    sessionId: session.id,
    kind: 'custom',
    scriptName: 'probe-sleep',
    workingDirectory: session.worktreePath,
    status: 'running',
  };
  return {
    detect: vi.fn().mockResolvedValue(detection),
    createPreparedTask: vi.fn().mockResolvedValue({
      provider: 'kandev',
      detection,
      taskId: 'task-1',
      externalId: 'missionbraid-kandev-check-cli-test',
      deduplicated: false,
      creationComplete: true,
      sessionReconciled: false,
      session,
    }),
    listProcesses: vi.fn().mockResolvedValue([]),
    startPreconfiguredCustomProcess: vi.fn().mockResolvedValue({
      provider: 'kandev',
      detection,
      sessionId: session.id,
      processId: process.id,
      repositoryId: session.repositoryId,
      scriptName: process.scriptName,
      workingDirectory: process.workingDirectory,
      status: process.status,
    }),
    getProcess: vi.fn().mockResolvedValue(process),
    stopProcess: vi.fn().mockResolvedValue({
      provider: 'kandev',
      detection,
      sessionId: session.id,
      processId: process.id,
      stopStatus: 204,
      absentFromGet: true,
      absentFromList: true,
    }),
  };
}
