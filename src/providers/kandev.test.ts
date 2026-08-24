import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KANDEV_COMMIT,
  KANDEV_VERSION,
  KandevClient,
  KandevCompatibilityError,
  KandevHttpError,
  KandevProtocolError,
  KandevTimeoutError,
  type CreateKandevPreparedTaskRequest,
  type KandevReadyTaskSession,
} from './kandev.js';

interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

type FakeHandler = (request: FakeRequest, response: ServerResponse) => void | Promise<void>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe('KandevClient v0.91.0 HTTP contract', () => {
  it('detects the pinned build, creates one prepared repository, and exposes process get/list', async () => {
    const seen: FakeRequest[] = [];
    const process = processWire();
    const baseUrl = await fakeServer(async (request, response) => {
      seen.push(request);
      if (serveCompatibleBuild(request, response)) return;
      if (request.method === 'POST' && request.path === '/api/v1/tasks') {
        json(response, 200, taskCreateWire({ session_id: 'session-1' }));
        return;
      }
      if (request.method === 'GET' && request.path === '/api/v1/task-sessions/session-1') {
        json(response, 200, { session: readySessionWire() });
        return;
      }
      if (
        request.method === 'POST' &&
        request.path === '/api/v1/task-sessions/session-1/processes/start'
      ) {
        json(response, 200, { process });
        return;
      }
      if (
        request.method === 'GET' &&
        request.path === '/api/v1/task-sessions/session-1/processes/process-1'
      ) {
        json(response, 200, process);
        return;
      }
      if (
        request.method === 'GET' &&
        request.path === '/api/v1/task-sessions/session-1/processes'
      ) {
        json(response, 200, [process]);
        return;
      }
      json(response, 404, { error: 'not found' });
    });
    const client = new KandevClient({ baseUrl, bearerToken: 'fixture-token' });

    const prepared = await client.createPreparedTask(preparedTaskRequest());
    const started = await client.startPreconfiguredCustomProcess({
      session: prepared.session,
      repositoryId: 'repo-1',
      scriptName: 'fixture-check',
    });

    await expect(client.getProcess('session-1', 'process-1')).resolves.toEqual({
      id: 'process-1',
      sessionId: 'session-1',
      kind: 'custom',
      scriptName: 'fixture-check',
      workingDirectory: '/tmp/worktrees/task-1',
      status: 'running',
    });
    await expect(client.listProcesses('session-1')).resolves.toHaveLength(1);
    expect(prepared).toMatchObject({
      taskId: 'task-1',
      externalId: 'effect-1',
      deduplicated: false,
      creationComplete: true,
      sessionReconciled: false,
      detection: { version: KANDEV_VERSION, commit: KANDEV_COMMIT, commitKind: 'full' },
    });
    expect(started).toMatchObject({
      processId: 'process-1',
      workingDirectory: '/tmp/worktrees/task-1',
    });
    const createBody = seen.find(
      (request) => request.method === 'POST' && request.path === '/api/v1/tasks',
    )?.body;
    expect(createBody).toEqual({
      external_id: 'effect-1',
      workspace_id: 'workspace-1',
      workflow_id: 'workflow-1',
      title: 'Prepared fixture task',
      description: 'Run the configured fixture check.',
      repositories: [{ repository_id: 'repo-1', base_branch: 'main' }],
      prepare_session: true,
      start_agent: false,
      agent_profile_id: 'agent-profile-1',
      executor_id: 'exec-worktree',
      executor_profile_id: 'executor-profile-1',
    });
    expect(seen.every((request) => request.authorization === 'Bearer fixture-token')).toBe(true);
  });

  it('fails closed when health reports a different version', async () => {
    const baseUrl = await fakeServer((request, response) => {
      if (request.path === '/health') {
        json(response, 200, { status: 'ok', service: 'kandev', version: 'v0.90.0' });
        return;
      }
      if (request.path === '/api/v1/system/info') {
        json(response, 200, {
          version: KANDEV_VERSION,
          commit: KANDEV_COMMIT.slice(0, 7),
          boot_id: 'boot-1',
        });
        return;
      }
      json(response, 404, {});
    });

    await expect(new KandevClient({ baseUrl }).detect()).rejects.toBeInstanceOf(
      KandevCompatibilityError,
    );
  });

  it('reconciles a deduplicated response with no session id and polls until every path is ready', async () => {
    let listCalls = 0;
    let getCalls = 0;
    let now = 0;
    const baseUrl = await fakeServer((request, response) => {
      if (serveCompatibleBuild(request, response, KANDEV_COMMIT.slice(0, 7))) return;
      if (request.method === 'POST' && request.path === '/api/v1/tasks') {
        json(response, 200, taskCreateWire({ deduplicated: true }));
        return;
      }
      if (request.method === 'GET' && request.path === '/api/v1/tasks/task-1/sessions') {
        listCalls += 1;
        json(response, 200, {
          sessions: listCalls === 1 ? [] : [readySessionWire({ worktree_path: '' })],
          total: listCalls === 1 ? 0 : 1,
        });
        return;
      }
      if (request.method === 'GET' && request.path === '/api/v1/task-sessions/session-1') {
        getCalls += 1;
        json(response, 200, {
          session:
            getCalls === 1
              ? readySessionWire({ worktree_path: '', workspace_path: '' })
              : readySessionWire(),
        });
        return;
      }
      json(response, 404, {});
    });
    const client = new KandevClient({
      baseUrl,
      clock: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
      pollIntervalMs: 10,
    });

    const result = await client.createPreparedTask(preparedTaskRequest());

    expect(result.sessionReconciled).toBe(true);
    expect(result.deduplicated).toBe(true);
    expect(result.session.worktreePath).toBe('/tmp/worktrees/task-1');
    expect(result.detection.commitKind).toBe('prefix');
    expect(listCalls).toBe(2);
    expect(getCalls).toBe(2);
    expect(now).toBe(20);
  });

  it('rejects a deduplicated task whose persistent binding differs from the request', async () => {
    const baseUrl = await fakeServer((request, response) => {
      if (serveCompatibleBuild(request, response)) return;
      if (request.method === 'POST' && request.path === '/api/v1/tasks') {
        json(
          response,
          200,
          taskCreateWire({ workspace_id: 'other-workspace', deduplicated: true }),
        );
        return;
      }
      json(response, 404, {});
    });

    await expect(
      new KandevClient({ baseUrl }).createPreparedTask(preparedTaskRequest()),
    ).rejects.toThrow('different task binding');
  });

  it('rejects a custom process that starts outside the prepared worktree', async () => {
    const baseUrl = await fakeServer((request, response) => {
      if (serveCompatibleBuild(request, response)) return;
      if (request.path.endsWith('/processes/start')) {
        json(response, 200, {
          process: processWire({ working_dir: '/tmp/unrelated' }),
        });
        return;
      }
      json(response, 404, {});
    });
    const client = new KandevClient({ baseUrl });

    await expect(
      client.startPreconfiguredCustomProcess({
        session: readySession(),
        repositoryId: 'repo-1',
        scriptName: 'fixture-check',
      }),
    ).rejects.toThrowError(KandevProtocolError);
  });

  it('waits for both GET 404 and list absence after stop', async () => {
    let getCalls = 0;
    let listCalls = 0;
    let now = 0;
    const baseUrl = await fakeServer((request, response) => {
      if (serveCompatibleBuild(request, response)) return;
      if (request.method === 'POST' && request.path.endsWith('/process-1/stop')) {
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'GET' && request.path.endsWith('/processes/process-1')) {
        getCalls += 1;
        if (getCalls === 1) json(response, 200, processWire());
        else json(response, 404, { error: 'gone' });
        return;
      }
      if (request.method === 'GET' && request.path.endsWith('/processes')) {
        listCalls += 1;
        json(response, 200, listCalls < 3 ? [processWire()] : []);
        return;
      }
      json(response, 404, {});
    });
    const client = new KandevClient({
      baseUrl,
      clock: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
      pollIntervalMs: 5,
    });

    const receipt = await client.stopProcess('session-1', 'process-1');

    expect(receipt).toMatchObject({
      processId: 'process-1',
      stopStatus: 204,
      absentFromGet: true,
      absentFromList: true,
    });
    expect(getCalls).toBe(3);
    expect(listCalls).toBe(3);
    expect(now).toBe(10);
  });

  it('reports method, path, and status without exposing an HTTP response body or bearer secret', async () => {
    const baseUrl = await fakeServer((request, response) => {
      if (serveCompatibleBuild(request, response)) return;
      json(response, 500, { error: 'response-secret-must-not-leak' });
    });
    const client = new KandevClient({ baseUrl, bearerToken: 'bearer-secret-must-not-leak' });

    let failure: unknown;
    try {
      await client.createPreparedTask(preparedTaskRequest());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(KandevHttpError);
    expect(failure).toMatchObject({
      method: 'POST',
      path: '/api/v1/tasks',
      status: 500,
    });
    expect(String(failure)).not.toContain('response-secret-must-not-leak');
    expect(String(failure)).not.toContain('bearer-secret-must-not-leak');
  });

  it('times out even after response headers arrive when the JSON body never completes', async () => {
    const baseUrl = await fakeServer((request, response) => {
      if (request.path === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"status":"ok"');
        return;
      }
      json(response, 404, {});
    });

    await expect(new KandevClient({ baseUrl }).detect({ timeoutMs: 50 })).rejects.toBeInstanceOf(
      KandevTimeoutError,
    );
  });
});

function preparedTaskRequest(): CreateKandevPreparedTaskRequest {
  return {
    externalId: 'effect-1',
    workspaceId: 'workspace-1',
    workflowId: 'workflow-1',
    title: 'Prepared fixture task',
    description: 'Run the configured fixture check.',
    repository: { repositoryId: 'repo-1', baseBranch: 'main' },
    profiles: {
      agentProfileId: 'agent-profile-1',
      executorId: 'exec-worktree',
      executorProfileId: 'executor-profile-1',
    },
  };
}

function readySession(): KandevReadyTaskSession {
  return {
    id: 'session-1',
    taskId: 'task-1',
    repositoryId: 'repo-1',
    agentProfileId: 'agent-profile-1',
    executorId: 'exec-worktree',
    executorProfileId: 'executor-profile-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/worktrees/task-1',
    worktreeBranch: 'kandev/task-1',
    workspacePath: '/tmp/worktrees/task-1',
    isPrimary: true,
  };
}

function readySessionWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session-1',
    task_id: 'task-1',
    repository_id: 'repo-1',
    agent_profile_id: 'agent-profile-1',
    executor_id: 'exec-worktree',
    executor_profile_id: 'executor-profile-1',
    worktree_id: 'worktree-1',
    worktree_path: '/tmp/worktrees/task-1',
    worktree_branch: 'kandev/task-1',
    workspace_path: '/tmp/worktrees/task-1',
    is_primary: true,
    ...overrides,
  };
}

function taskCreateWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    external_id: 'effect-1',
    workspace_id: 'workspace-1',
    workflow_id: 'workflow-1',
    workflow_step_id: 'step-1',
    title: 'Prepared fixture task',
    repositories: [{ repository_id: 'repo-1', base_branch: 'main' }],
    metadata: {
      agent_profile_id: 'agent-profile-1',
      executor_profile_id: 'executor-profile-1',
    },
    deduplicated: false,
    creation_complete: true,
    ...overrides,
  };
}

function processWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'process-1',
    session_id: 'session-1',
    kind: 'custom',
    script_name: 'fixture-check',
    working_dir: '/tmp/worktrees/task-1',
    status: 'running',
    ...overrides,
  };
}

function serveCompatibleBuild(
  request: FakeRequest,
  response: ServerResponse,
  commit: string = KANDEV_COMMIT,
): boolean {
  if (request.method === 'GET' && request.path === '/health') {
    json(response, 200, {
      status: 'ok',
      service: 'kandev',
      mode: 'websocket+http',
      version: KANDEV_VERSION,
    });
    return true;
  }
  if (request.method === 'GET' && request.path === '/api/v1/system/info') {
    json(response, 200, {
      version: KANDEV_VERSION,
      commit,
      boot_id: 'boot-1',
    });
    return true;
  }
  return false;
}

async function fakeServer(handler: FakeHandler): Promise<string> {
  const server = createServer(async (request, response) => {
    try {
      await handler(await fakeRequest(request), response);
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'fake server failure' });
      else response.destroy();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function fakeRequest(request: IncomingMessage): Promise<FakeRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const source = Buffer.concat(chunks).toString('utf8');
  return {
    method: request.method ?? '',
    path: new URL(request.url ?? '/', 'http://fixture.invalid').pathname,
    body: source === '' ? undefined : (JSON.parse(source) as unknown),
    authorization: request.headers.authorization,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
