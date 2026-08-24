import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { APP_CSS, APP_HTML, APP_JAVASCRIPT } from './app-page.js';
import {
  MissionEngine,
  type ExecuteMissionOptions,
  type MissionCreationResult,
  type MissionExecutionResult,
  type MissionStatusView,
  type MissionTimelineEntry,
} from './engine.js';
import { createMissionDraft } from './mission-draft.js';
import { discoverRuntimeCatalog, type RuntimeCatalogEntry } from './runtime-catalog.js';
import type { MissionProjectionV1 } from './domain.js';
import { snapshotGitWorkspace } from './workspace.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4317;
const MAX_REQUEST_BYTES = 256 * 1024;

export interface AppEngine {
  create(
    missionFile: string,
    options?: Omit<ExecuteMissionOptions, 'signal'>,
  ): Promise<MissionCreationResult>;
  resume(
    missionId: string,
    options?: Omit<ExecuteMissionOptions, 'workspace'>,
  ): Promise<MissionExecutionResult>;
  verify(
    missionId: string,
    options?: Omit<ExecuteMissionOptions, 'workspace'>,
  ): Promise<MissionExecutionResult>;
  status(missionId: string): MissionStatusView;
  timeline(missionId: string): MissionTimelineEntry[];
  list(): MissionProjectionV1[];
  close(): void;
}

export interface MissionBraidAppOptions {
  readonly stateDir?: string;
  readonly host?: string;
  readonly port?: number;
  readonly engineFactory?: (stateDir: string) => AppEngine;
  readonly discoverRuntimes?: () => Promise<readonly RuntimeCatalogEntry[]>;
  readonly now?: () => Date;
  readonly id?: () => string;
}

export interface MissionBraidApp {
  readonly host: string;
  readonly port: number;
  readonly stateDir: string;
  readonly url: string;
  close(): Promise<void>;
}

type OperationAction = 'run' | 'resume' | 'verify';
type OperationPhase = 'running' | 'completed' | 'failed' | 'interrupted';

interface OperationView {
  readonly action: OperationAction;
  readonly phase: OperationPhase;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly resultStatus?: MissionExecutionResult['status'];
  readonly error?: string;
}

interface RunningOperation {
  view: OperationView;
  readonly controller: AbortController;
  promise: Promise<void>;
}

export async function startMissionBraidApp(
  options: MissionBraidAppOptions = {},
): Promise<MissionBraidApp> {
  const host = options.host ?? DEFAULT_HOST;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new TypeError('MissionBraid app currently binds only to a loopback host.');
  }
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('MissionBraid app port must be an integer from 0 to 65535.');
  }
  const stateDir = resolve(options.stateDir ?? join(homedir(), '.missionbraid'));
  await mkdir(stateDir, { recursive: true });

  const engineFactory =
    options.engineFactory ?? ((directory) => new MissionEngine({ stateDir: directory }));
  const discoverRuntimes = options.discoverRuntimes ?? discoverRuntimeCatalog;
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const operations = new Map<string, RunningOperation>();
  let closing = false;

  const launchOperation = (missionId: string, action: OperationAction): OperationView => {
    if (closing) throw new AppHttpError(503, 'MissionBraid app is stopping.');
    const existing = operations.get(missionId);
    if (existing?.view.phase === 'running') {
      throw new AppHttpError(409, `Mission ${missionId} already has a running operation.`);
    }
    const controller = new AbortController();
    const operation: RunningOperation = {
      controller,
      view: {
        action,
        phase: 'running',
        startedAt: now().toISOString(),
      },
      promise: Promise.resolve(),
    };
    operations.set(missionId, operation);
    operation.promise = (async () => {
      const engine = engineFactory(stateDir);
      try {
        const result =
          action === 'verify'
            ? await engine.verify(missionId, { signal: controller.signal })
            : await engine.resume(missionId, { signal: controller.signal });
        operation.view = {
          ...operation.view,
          phase: 'completed',
          endedAt: now().toISOString(),
          resultStatus: result.status,
        };
      } catch (error) {
        operation.view = {
          ...operation.view,
          phase: 'failed',
          endedAt: now().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        engine.close();
      }
    })();
    return operation.view;
  };

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/') {
      sendText(response, 200, APP_HTML, 'text/html; charset=utf-8', true);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/app.css') {
      sendText(response, 200, APP_CSS, 'text/css; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      sendText(response, 200, APP_JAVASCRIPT, 'text/javascript; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/runtimes') {
      sendJson(response, 200, {
        runtimes: await discoverRuntimes(),
        providers: [
          {
            id: 'local-direct',
            status: 'active',
            label: 'Local direct execution',
          },
          {
            id: 'kandev',
            status: 'compatibility-only',
            label: 'Kandev v0.91.0 public interface checked; Mission execution not enabled',
          },
        ],
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/missions') {
      const engine = engineFactory(stateDir);
      try {
        sendJson(response, 200, {
          missions: engine.list().map((mission) => ({
            ...mission,
            operation: operationView(mission, operations.get(mission.missionId)),
          })),
        });
      } finally {
        engine.close();
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/missions') {
      if (closing) throw new AppHttpError(503, 'MissionBraid app is stopping.');
      const draft = createMissionDraft(await readJson(request));
      snapshotGitWorkspace(draft.document.workspace);
      const runtimes = await discoverRuntimes();
      for (const stage of draft.document.attemptPlan) {
        const runtime = runtimes.find((candidate) => candidate.id === stage.profile.harness);
        if (runtime?.status !== 'ready-supported') {
          throw new AppHttpError(
            409,
            `${stage.profile.harness} is not ready for Mission execution: ${runtime?.reason ?? 'not discovered'}`,
          );
        }
      }
      const draftsDir = join(stateDir, 'drafts');
      await mkdir(draftsDir, { recursive: true });
      const missionFile = join(
        draftsDir,
        `${fileTimestamp(now())}-${id().replaceAll(/[^a-zA-Z0-9_-]/g, '-')}.yaml`,
      );
      await writeFile(missionFile, draft.yaml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const engine = engineFactory(stateDir);
      let created: MissionCreationResult;
      try {
        created = await engine.create(missionFile);
      } finally {
        engine.close();
      }
      const operation = launchOperation(created.missionId, 'run');
      sendJson(response, 202, { ...created, operation });
      return;
    }

    const missionAction = matchMissionAction(url.pathname);
    if (missionAction !== undefined && request.method === 'POST') {
      if (closing) throw new AppHttpError(503, 'MissionBraid app is stopping.');
      const operation = launchOperation(missionAction.missionId, missionAction.action);
      sendJson(response, 202, { missionId: missionAction.missionId, operation });
      return;
    }
    const missionId = matchMissionId(url.pathname);
    if (missionId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        const status = engine.status(missionId);
        sendJson(response, 200, {
          ...status,
          timeline: engine.timeline(missionId),
          operation: operationView(status.mission, operations.get(missionId)),
        });
      } finally {
        engine.close();
      }
      return;
    }
    throw new AppHttpError(404, 'Route not found.');
  };

  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof AppHttpError ? error.status : 500;
      sendJson(response, status, {
        error: status === 500 ? 'InternalServerError' : 'RequestError',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  const actualPort = await listen(server, port, host);

  return {
    host,
    port: actualPort,
    stateDir,
    url: `http://${formatHost(host)}:${String(actualPort)}`,
    close: async () => {
      if (closing) return;
      closing = true;
      for (const operation of operations.values()) {
        if (operation.view.phase === 'running') operation.controller.abort();
      }
      await closeServer(server);
      await Promise.allSettled([...operations.values()].map((operation) => operation.promise));
    },
  };
}

function operationView(
  mission: MissionProjectionV1,
  operation: RunningOperation | undefined,
): OperationView | null {
  if (operation !== undefined) return operation.view;
  if (mission.status !== 'running' && mission.status !== 'verifying') return null;
  return {
    action: 'resume',
    phase: 'interrupted',
    startedAt: mission.updatedAt,
    error: 'The controller stopped before this Mission reached a durable terminal state.',
  };
}

class AppHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AppHttpError(415, 'Content-Type must be application/json.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new AppHttpError(413, 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AppHttpError(400, 'Request body must be valid JSON.');
  }
}

function matchMissionId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionAction(
  pathname: string,
):
  | { readonly missionId: string; readonly action: Extract<OperationAction, 'resume' | 'verify'> }
  | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/(resume|verify)$/);
  if (match?.[1] === undefined || (match[2] !== 'resume' && match[2] !== 'verify')) {
    return undefined;
  }
  return { missionId: decodeURIComponent(match[1]), action: match[2] };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(
    response,
    status,
    `${JSON.stringify(value, null, 2)}\n`,
    'application/json; charset=utf-8',
  );
}

function sendText(
  response: ServerResponse,
  status: number,
  value: string,
  contentType: string,
  html = false,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (html) {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    );
  }
  response.end(value);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('MissionBraid app did not receive a TCP address.'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
    server.closeIdleConnections();
  });
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function fileTimestamp(value: Date): string {
  return value.toISOString().replaceAll(/[:.]/g, '-');
}
