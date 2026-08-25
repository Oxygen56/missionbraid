import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { APP_CSS, APP_HTML, APP_JAVASCRIPT } from './app-page.js';
import type { NativeArtifactContent } from './artifact-store.js';
import type { ContextGraphV1 } from './context-graph.js';
import {
  MissionEngine,
  type ExecuteMissionOptions,
  type MissionCreationResult,
  type MissionExecutionResult,
  type MissionStatusView,
  type MissionTimelineEntry,
} from './engine.js';
import { createMissionDraft, MissionDraftError } from './mission-draft.js';
import { discoverRuntimeCatalog, type RuntimeCatalogEntry } from './runtime-catalog.js';
import type { MissionCommandActionV1, MissionCommandV1, MissionProjectionV1 } from './domain.js';
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
  acceptCommand(
    missionId: string,
    action: MissionCommandActionV1,
    idempotencyKey?: string,
  ): Promise<MissionCommandV1>;
  claimNextCommand(ownerId: string): MissionCommandV1 | undefined;
  renewCommandClaim(commandId: string, ownerId: string): MissionCommandV1;
  executeCommand(commandId: string, signal?: AbortSignal): Promise<MissionExecutionResult>;
  command(commandId: string): MissionCommandV1 | undefined;
  commands(missionId?: string): MissionCommandV1[];
  artifact(artifactId: string): Promise<NativeArtifactContent | undefined>;
  contextGraph(missionId: string): Promise<ContextGraphV1>;
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
type OperationPhase = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

interface OperationView {
  readonly commandId?: string;
  readonly action: OperationAction;
  readonly phase: OperationPhase;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly resultStatus?: MissionExecutionResult['status'];
  readonly error?: string;
}

interface RunningOperation {
  readonly commandId: string;
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
  const eventStreams = new Set<ServerResponse>();
  const supervisorId = `supervisor-${id()}`;
  let closing = false;
  let draining = false;
  let supervisorTimer: NodeJS.Timeout | undefined;

  const launchCommand = (command: MissionCommandV1, action: OperationAction): OperationView => {
    if (closing) {
      return {
        commandId: command.commandId,
        action,
        phase: 'queued',
        startedAt: command.acceptedAt,
      };
    }
    const controller = new AbortController();
    const operation: RunningOperation = {
      commandId: command.commandId,
      controller,
      view: {
        commandId: command.commandId,
        action,
        phase: 'running',
        startedAt: now().toISOString(),
      },
      promise: Promise.resolve(),
    };
    operations.set(command.missionId, operation);
    operation.promise = (async () => {
      const engine = engineFactory(stateDir);
      const heartbeat = setInterval(() => {
        if (closing) return;
        const renewal = engineFactory(stateDir);
        try {
          renewal.renewCommandClaim(command.commandId, supervisorId);
        } catch {
          controller.abort();
        } finally {
          renewal.close();
        }
      }, 10_000);
      heartbeat.unref();
      try {
        const result = await engine.executeCommand(command.commandId, controller.signal);
        const durable = engine.command(command.commandId);
        operation.view = {
          ...operation.view,
          phase: durable?.status === 'pending' ? 'interrupted' : 'completed',
          endedAt: now().toISOString(),
          resultStatus: result.status,
          ...(durable?.status === 'pending'
            ? { error: 'The controller stopped; the durable command remains queued.' }
            : {}),
        };
      } catch (error) {
        operation.view = {
          ...operation.view,
          phase: 'failed',
          endedAt: now().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearInterval(heartbeat);
        engine.close();
        if (!closing) void drainCommands();
      }
    })();
    return operation.view;
  };

  const queueView = (command: MissionCommandV1, action: OperationAction): OperationView => {
    const operation: RunningOperation = {
      commandId: command.commandId,
      controller: new AbortController(),
      view: {
        commandId: command.commandId,
        action,
        phase: 'queued',
        startedAt: command.acceptedAt,
      },
      promise: Promise.resolve(),
    };
    operations.set(command.missionId, operation);
    return operation.view;
  };

  const drainCommands = async (): Promise<void> => {
    if (closing || draining) return;
    if ([...operations.values()].some((operation) => operation.view.phase === 'running')) return;
    draining = true;
    try {
      const engine = engineFactory(stateDir);
      let command: MissionCommandV1 | undefined;
      try {
        command = engine.claimNextCommand(supervisorId);
      } finally {
        engine.close();
      }
      if (command !== undefined && !closing) {
        const existing = operations.get(command.missionId);
        const action = existing?.view.action ?? (command.action === 'verify' ? 'verify' : 'resume');
        launchCommand(command, action);
      }
    } finally {
      draining = false;
    }
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
            operation: operationView(
              mission,
              operations.get(mission.missionId),
              engine.commands(mission.missionId).at(-1),
            ),
          })),
        });
      } finally {
        engine.close();
      }
      return;
    }
    const artifactId = matchArtifactId(url.pathname);
    if (artifactId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        const artifact = await engine.artifact(artifactId);
        if (artifact === undefined) {
          throw new AppHttpError(404, 'ARTIFACT_NOT_FOUND', 'Native artifact not found.', {
            artifactId,
          });
        }
        sendJson(response, 200, artifact);
      } finally {
        engine.close();
      }
      return;
    }
    const missionEventStreamId = matchMissionEventStreamId(url.pathname);
    if (missionEventStreamId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        engine.status(missionEventStreamId);
      } finally {
        engine.close();
      }
      streamMissionEvents({
        request,
        response,
        missionId: missionEventStreamId,
        stateDir,
        engineFactory,
        now,
        streams: eventStreams,
        after: eventStreamCursor(request, url),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/missions') {
      if (closing) throw new AppHttpError(503, 'APP_STOPPING', 'MissionBraid app is stopping.');
      let draft: ReturnType<typeof createMissionDraft>;
      try {
        draft = createMissionDraft(await readJson(request));
      } catch (error) {
        if (error instanceof MissionDraftError) {
          throw new AppHttpError(400, 'INVALID_MISSION_DRAFT', error.message, {
            detail: error.message,
          });
        }
        throw error;
      }
      snapshotGitWorkspace(draft.document.workspace);
      const runtimes = await discoverRuntimes();
      for (const stage of draft.document.attemptPlan) {
        const runtime = runtimes.find((candidate) => candidate.id === stage.profile.harness);
        if (runtime?.status !== 'ready-supported') {
          throw new AppHttpError(
            409,
            'RUNTIME_NOT_READY',
            `${stage.profile.harness} is not ready for Mission execution: ${runtime?.reason ?? 'not discovered'}`,
            { runtime: stage.profile.harness, reason: runtime?.reason ?? 'not discovered' },
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
      let command: MissionCommandV1;
      try {
        created = await engine.create(missionFile);
        if (closing) {
          throw new AppHttpError(503, 'APP_STOPPING', 'MissionBraid app is stopping.');
        }
        command = await engine.acceptCommand(created.missionId, 'resume', `create:${missionFile}`);
      } finally {
        engine.close();
      }
      const operation = queueView(command, 'run');
      void drainCommands();
      sendJson(response, 202, { ...created, commandId: command.commandId, operation });
      return;
    }

    const missionAction = matchMissionAction(url.pathname);
    if (missionAction !== undefined && request.method === 'POST') {
      if (closing) throw new AppHttpError(503, 'APP_STOPPING', 'MissionBraid app is stopping.');
      const engine = engineFactory(stateDir);
      let command: MissionCommandV1;
      try {
        const active = engine
          .commands(missionAction.missionId)
          .find(
            (candidate) => candidate.status === 'pending' || candidate.status === 'dispatching',
          );
        if (active !== undefined) {
          throw new AppHttpError(
            409,
            'MISSION_ALREADY_RUNNING',
            `Mission ${missionAction.missionId} already has an accepted command.`,
            { missionId: missionAction.missionId, commandId: active.commandId },
          );
        }
        command = await engine.acceptCommand(
          missionAction.missionId,
          missionAction.action,
          `${missionAction.action}:${id()}`,
        );
      } finally {
        engine.close();
      }
      const operation = queueView(command, missionAction.action);
      void drainCommands();
      sendJson(response, 202, {
        missionId: missionAction.missionId,
        commandId: command.commandId,
        operation,
      });
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
          contextGraph: await engine.contextGraph(missionId),
          operation: operationView(
            status.mission,
            operations.get(missionId),
            engine.commands(missionId).at(-1),
          ),
        });
      } finally {
        engine.close();
      }
      return;
    }
    throw new AppHttpError(404, 'ROUTE_NOT_FOUND', 'Route not found.');
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
        code: error instanceof AppHttpError ? error.code : 'INTERNAL_SERVER_ERROR',
        ...(error instanceof AppHttpError && error.params !== undefined
          ? { params: error.params }
          : {}),
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  const actualPort = await listen(server, port, host);
  supervisorTimer = setInterval(() => void drainCommands(), 1_000);
  supervisorTimer.unref();
  void drainCommands();

  return {
    host,
    port: actualPort,
    stateDir,
    url: `http://${formatHost(host)}:${String(actualPort)}`,
    close: async () => {
      if (closing) return;
      closing = true;
      if (supervisorTimer !== undefined) clearInterval(supervisorTimer);
      for (const operation of operations.values()) {
        if (operation.view.phase === 'running') operation.controller.abort();
      }
      for (const stream of eventStreams) stream.end();
      eventStreams.clear();
      await closeServer(server);
      await Promise.allSettled([...operations.values()].map((operation) => operation.promise));
    },
  };
}

function operationView(
  mission: MissionProjectionV1,
  operation: RunningOperation | undefined,
  command: MissionCommandV1 | undefined,
): OperationView | null {
  if (operation !== undefined) return operation.view;
  if (command !== undefined) {
    const action = command.action === 'verify' ? 'verify' : 'resume';
    if (command.status === 'pending') {
      return {
        commandId: command.commandId,
        action,
        phase: 'queued',
        startedAt: command.acceptedAt,
      };
    }
    if (command.status === 'dispatching') {
      return {
        commandId: command.commandId,
        action,
        phase: 'interrupted',
        startedAt: command.acceptedAt,
        error: 'The durable command is waiting for its previous controller claim to expire.',
      };
    }
    return {
      commandId: command.commandId,
      action,
      phase: command.status === 'completed' ? 'completed' : 'failed',
      startedAt: command.acceptedAt,
      endedAt: command.updatedAt,
      ...(command.lastError === undefined ? {} : { error: command.lastError }),
    };
  }
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
  readonly code: string;
  readonly params: Readonly<Record<string, string>> | undefined;

  constructor(
    status: number,
    code: string,
    message = code,
    params?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AppHttpError(415, 'INVALID_CONTENT_TYPE', 'Content-Type must be application/json.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new AppHttpError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AppHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

function matchMissionId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionEventStreamId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/events$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function eventStreamCursor(request: IncomingMessage, url: URL): number {
  const header = request.headers['last-event-id'];
  const raw =
    (Array.isArray(header) ? header.at(-1) : header) ?? url.searchParams.get('after') ?? '0';
  const cursor = Number.parseInt(raw, 10);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

interface MissionEventStreamOptions {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly missionId: string;
  readonly stateDir: string;
  readonly engineFactory: (stateDir: string) => AppEngine;
  readonly now: () => Date;
  readonly streams: Set<ServerResponse>;
  readonly after: number;
}

/** Stream only events already committed to the durable Mission journal. */
function streamMissionEvents(options: MissionEventStreamOptions): void {
  const { request, response, missionId, stateDir, engineFactory, now, streams } = options;
  let cursor = options.after;
  let closed = false;
  let polling = false;

  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
  streams.add(response);

  const poll = (): void => {
    if (closed || polling) return;
    polling = true;
    const engine = engineFactory(stateDir);
    try {
      for (const entry of engine.timeline(missionId)) {
        if (entry.seq <= cursor) continue;
        const sentAt = now().toISOString();
        const recordedAtMs = Date.parse(entry.recordedAt);
        const sentAtMs = Date.parse(sentAt);
        const journalToWireLatencyMs =
          Number.isFinite(recordedAtMs) && Number.isFinite(sentAtMs)
            ? Math.max(0, sentAtMs - recordedAtMs)
            : null;
        response.write(`id: ${String(entry.seq)}\n`);
        response.write('event: timeline\n');
        response.write(
          `data: ${JSON.stringify({ missionId, entry, sentAt, journalToWireLatencyMs })}\n\n`,
        );
        cursor = entry.seq;
      }
    } catch (error) {
      response.write('event: stream-error\n');
      response.write(
        `data: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`,
      );
    } finally {
      engine.close();
      polling = false;
    }
  };

  const heartbeat = setInterval(() => {
    if (!closed) response.write(`: heartbeat ${now().toISOString()}\n\n`);
  }, 10_000);
  heartbeat.unref();
  const interval = setInterval(poll, 100);
  interval.unref();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    clearInterval(heartbeat);
    streams.delete(response);
  };
  request.once('close', cleanup);
  response.once('close', cleanup);
  poll();
}

function matchArtifactId(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/artifacts\/(artifact-[a-f0-9]{64})$/);
  return match?.[1];
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
