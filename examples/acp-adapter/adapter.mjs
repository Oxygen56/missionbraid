import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  defineAdapterV1,
  validateAdapterRunRequestV1,
} from 'missionbraid/adapter-sdk/v1';

const defaultAgentPath = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url));
const unsupported = (detail) => ({ status: 'unsupported', fidelity: 'unsupported', detail });

export const manifest = {
  schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
  apiVersion: ADAPTER_API_VERSION,
  adapterId: 'example.acp-stdio',
  harnessId: 'acp-stdio-agent',
  displayName: 'ACP stdio Adapter Example',
  adapterVersion: '1.0.0',
  transport: 'acp',
  nativeProtocol: 'agent-client-protocol/v1',
  capabilities: {
    discover: {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Checks the configured ACP stdio Agent entry point.',
    },
    observe: {
      status: 'supported',
      fidelity: 'native',
      detail: 'Preserves ordered ACP session/update notifications.',
    },
    'context-capture': unsupported('The reference client does not export hidden model context.'),
    steer: unsupported('The reference client exposes one prompt turn only.'),
    interrupt: unsupported('The example does not claim a reusable native interrupt channel.'),
    'pre-tool-gate': unsupported('ACP permission mediation is outside this minimal example.'),
    resume: unsupported('The minimal example creates a fresh ACP session.'),
    'native-fork': unsupported('The minimal example does not request ACP session/fork.'),
    'workspace-bind': {
      status: 'supported',
      fidelity: 'native',
      detail: 'Passes the absolute host workspace as ACP session/new cwd.',
    },
    'workspace-restore': unsupported('The ACP example does not restore workspace snapshots.'),
    'external-effect-control': unsupported('The ACP example dispatches no external Effects.'),
  },
};

export function createAcpStdioAdapter({
  agentPath = defaultAgentPath,
  now = () => new Date(),
} = {}) {
  return defineAdapterV1({
    manifest,

    async discover(request) {
      try {
        await access(agentPath);
      } catch {
        return {
          adapterId: manifest.adapterId,
          transport: manifest.transport,
          status: 'missing',
          runtimeVersion: { status: 'unknown', reason: 'ACP Agent entry point is missing.' },
          authentication: { status: 'unsupported', reason: 'No authentication in the fixture.' },
          binding: {
            kind: 'acp',
            protocolVersion: '1',
            endpointRef: `stdio:${agentPath}`,
          },
          observedAt: request.observedAt,
          evidenceRefs: ['acp-example:discovery:missing'],
        };
      }
      return {
        adapterId: manifest.adapterId,
        transport: manifest.transport,
        status: 'ready',
        runtimeVersion: { status: 'known', value: 'ACP v1 fixture', source: 'fixture-agent' },
        authentication: { status: 'unsupported', reason: 'No authentication in the fixture.' },
        binding: {
          kind: 'acp',
          protocolVersion: '1',
          endpointRef: `stdio:${agentPath}`,
        },
        observedAt: request.observedAt,
        evidenceRefs: ['acp-example:discovery:ready'],
      };
    },

    async run(request, ports) {
      validateAdapterRunRequestV1(manifest, request);
      if (request.workspace.kind !== 'local') {
        throw new TypeError('The ACP stdio example requires a local workspace binding.');
      }
      const runId = `run-${request.identity.executionId}`;
      let sequence = 0;
      const connection = createJsonRpcConnection(agentPath, request.workspace.absolutePath, {
        signal: request.signal,
        onNotification: async (message) => {
          if (message.method !== 'session/update') return;
          await ports.evidence.append({
            schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
            apiVersion: ADAPTER_API_VERSION,
            adapterId: manifest.adapterId,
            runId,
            sequence: ++sequence,
            sourceId: String(message.params?.sessionId ?? 'acp-session'),
            sourceProtocol: manifest.nativeProtocol,
            nativeEventType: 'session/update',
            semanticHint: acpSemanticHint(message.params?.update?.sessionUpdate),
            observedAt: now().toISOString(),
            fidelity: 'native',
            payload: message.params,
            sanitized: true,
            evidenceRefs: [`acp-example:notification:${String(sequence)}`],
          });
        },
      });
      try {
        const initialized = await connection.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'missionbraid-example', version: '1.0.0' },
        });
        if (initialized?.protocolVersion !== 1) throw new Error('ACP v1 negotiation failed.');
        const session = await connection.request('session/new', {
          cwd: request.workspace.absolutePath,
          mcpServers: [],
        });
        if (typeof session?.sessionId !== 'string' || session.sessionId === '') {
          throw new Error('ACP Agent returned no sessionId.');
        }
        await ports.evidence.append({
          schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
          apiVersion: ADAPTER_API_VERSION,
          adapterId: manifest.adapterId,
          runId,
          sequence: ++sequence,
          sourceId: session.sessionId,
          sourceProtocol: manifest.nativeProtocol,
          nativeEventType: 'acp.workspace.bound',
          semanticHint: 'workspace',
          observedAt: now().toISOString(),
          fidelity: 'derived',
          payload: {
            workspaceKey: request.workspace.workspaceKey,
            cwd: request.workspace.absolutePath,
          },
          sanitized: true,
          evidenceRefs: [`acp-example:workspace:${request.workspace.workspaceKey}`],
        });
        const completed = await connection.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: request.instruction }],
        });
        const exit = await connection.close();
        const completedTurn = completed?.stopReason === 'end_turn' && exit === 0;
        return {
          adapterId: manifest.adapterId,
          runId,
          transport: manifest.transport,
          binding: {
            kind: 'acp',
            protocolVersion: '1',
            endpointRef: `stdio:${agentPath}`,
            sessionRef: session.sessionId,
          },
          status:
            request.signal?.aborted === true ? 'aborted' : completedTurn ? 'completed' : 'failed',
          exitCode: exit,
          nativeSession: {
            status: 'available',
            sessionRef: session.sessionId,
            resumable: false,
          },
          evidenceRefs: [`acp-example:session:${session.sessionId}`, 'acp-example:prompt-response'],
        };
      } catch (error) {
        await connection.close().catch(() => undefined);
        throw error;
      }
    },
  });
}

function createJsonRpcConnection(agentPath, cwd, options) {
  const child = spawn(process.execPath, [agentPath], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '' },
  });
  const pending = new Map();
  let nextId = 0;
  let stdoutBuffer = '';
  let messageQueue = Promise.resolve();
  let closePromise;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line === '') continue;
      messageQueue = messageQueue.then(async () => {
        const message = JSON.parse(line);
        if (message.method !== undefined && message.id === undefined) {
          await options.onNotification(message);
          return;
        }
        const waiter = pending.get(message.id);
        if (waiter === undefined) return;
        pending.delete(message.id);
        if (message.error !== undefined) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      });
    }
  });
  child.stderr.resume();
  child.once('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  const abort = () => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: {} })}\n`,
    );
    child.kill('SIGTERM');
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  return {
    request(method, params) {
      const id = ++nextId;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
    async close() {
      options.signal?.removeEventListener('abort', abort);
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      closePromise ??= new Promise((resolve, reject) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else {
          child.once('error', reject);
          child.once('exit', (code) => resolve(code ?? 1));
        }
      });
      const exit = await closePromise;
      await messageQueue;
      return exit;
    },
  };
}

function acpSemanticHint(updateType) {
  if (typeof updateType !== 'string') return 'unknown';
  if (updateType.includes('tool')) return 'tool';
  if (updateType.includes('message')) return 'message';
  if (updateType.includes('plan')) return 'context';
  return 'runtime';
}

export default createAcpStdioAdapter();
