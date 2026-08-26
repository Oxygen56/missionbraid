import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROCESS_PROVIDER_API_VERSION,
  PROCESS_PROVIDER_MANIFEST_SCHEMA_VERSION,
  createProcessProviderAdapterV1,
} from 'missionbraid/process-provider/v1';

const defaultWorker = fileURLToPath(new URL('./worker.mjs', import.meta.url));

export function createLocalProcessProvider({
  workspaceByRef,
  workerPath = defaultWorker,
  now = () => new Date(),
} = {}) {
  const workspaces =
    workspaceByRef ??
    new Map([
      ['provider-workspace:default', process.env.MISSIONBRAID_PROVIDER_WORKSPACE ?? process.cwd()],
    ]);
  const runs = new Map();
  let runCounter = 0;

  return {
    manifest: {
      schemaVersion: PROCESS_PROVIDER_MANIFEST_SCHEMA_VERSION,
      apiVersion: PROCESS_PROVIDER_API_VERSION,
      providerId: 'example-local-process',
      displayName: 'Example Local Process Provider',
      providerVersion: '1.0.0',
      nativeProtocol: 'example-local-process/v1',
    },

    async discover() {
      return {
        status: 'ready',
        runtimeVersion: { status: 'known', value: process.version, source: 'node-runtime' },
        authentication: {
          status: 'unsupported',
          reason: 'The local fixture needs no credentials.',
        },
        endpointRef: `process:${process.execPath}`,
        discoverySessionRef: 'provider-session:unbound',
        discoveryWorkspaceRef: 'provider-workspace:unbound',
        observedAt: now().toISOString(),
        evidenceRefs: ['example-process-provider:discovery'],
      };
    },

    async start(request) {
      const workspace = workspaces.get(request.workspace.workspaceRef);
      if (workspace === undefined) {
        throw new Error(`Unknown provider workspace ${request.workspace.workspaceRef}`);
      }
      const providerRunId = `provider-run-${String(++runCounter)}`;
      const child = spawn(process.execPath, [workerPath], {
        cwd: workspace,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '' },
      });
      const state = {
        child,
        status: 'running',
        exitCode: undefined,
        events: [],
        nextSequence: 1,
        stdoutBuffer: '',
      };
      runs.set(providerRunId, state);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => consumeWorkerOutput(state, chunk, now));
      child.stderr.resume();
      child.once('exit', (code, signal) => {
        consumeWorkerOutput(state, '\n', now);
        state.exitCode = code;
        state.status = signal === null && code === 0 ? 'completed' : 'failed';
        state.events.push({
          sequence: state.nextSequence++,
          sourceId: providerRunId,
          nativeEventType: 'process.completed',
          semanticHint: state.status === 'completed' ? 'runtime' : 'failure',
          occurredAt: now().toISOString(),
          fidelity: 'native',
          payload: { exitCode: code, signal: signal ?? null },
          sanitized: true,
          evidenceRefs: [`example-process-provider:exit:${providerRunId}`],
        });
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      state.events.push({
        sequence: state.nextSequence++,
        sourceId: providerRunId,
        nativeEventType: 'process.started',
        semanticHint: 'runtime',
        occurredAt: now().toISOString(),
        fidelity: 'native',
        payload: { executable: 'node', worker: 'worker.mjs' },
        sanitized: true,
        evidenceRefs: [`example-process-provider:spawn:${providerRunId}`],
      });
      child.stdin.end(
        JSON.stringify({ workspace, instruction: request.instruction }, null, 0) + '\n',
      );
      return {
        providerRunId,
        providerSessionRef: `provider-session:${providerRunId}`,
        providerWorkspaceRef: request.workspace.workspaceRef,
        startedAt: now().toISOString(),
        evidenceRefs: [`example-process-provider:start:${providerRunId}`],
      };
    },

    async observe(handle, options) {
      const state = requireRun(runs, handle.providerRunId);
      return {
        status: state.status,
        ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
        observedAt: now().toISOString(),
        events: state.events.filter((event) => event.sequence > options.afterSequence),
        evidenceRefs: [
          `example-process-provider:observe:${handle.providerRunId}:${String(options.afterSequence)}`,
        ],
      };
    },

    async stop(handle) {
      const state = requireRun(runs, handle.providerRunId);
      if (state.status === 'running') childKill(state.child);
      return {
        status: state.status === 'running' ? 'aborted' : state.status,
        ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
        observedAt: now().toISOString(),
        events: [],
        evidenceRefs: [`example-process-provider:stop:${handle.providerRunId}`],
      };
    },
  };
}

export function createExampleProcessProviderAdapter(options = {}) {
  return createProcessProviderAdapterV1({
    provider: createLocalProcessProvider(options),
    adapterId: 'example.process-provider',
    harnessId: 'process-provider-example',
    displayName: 'Example Process Provider Adapter',
    pollIntervalMs: 10,
    runTimeoutMs: 10_000,
  });
}

function consumeWorkerOutput(state, chunk, now) {
  state.stdoutBuffer += chunk;
  for (;;) {
    const newline = state.stdoutBuffer.indexOf('\n');
    if (newline < 0) return;
    const line = state.stdoutBuffer.slice(0, newline).trim();
    state.stdoutBuffer = state.stdoutBuffer.slice(newline + 1);
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'workspace.result-written' || event.path !== 'provider-result.txt')
      continue;
    state.events.push({
      sequence: state.nextSequence++,
      sourceId: 'provider-worker',
      nativeEventType: event.type,
      semanticHint: 'workspace',
      occurredAt: now().toISOString(),
      fidelity: 'native',
      payload: { path: event.path },
      sanitized: true,
      evidenceRefs: ['example-process-provider:worker:result-written'],
    });
  }
}

function requireRun(runs, providerRunId) {
  const state = runs.get(providerRunId);
  if (state === undefined) throw new Error(`Unknown provider run ${providerRunId}`);
  return state;
}

function childKill(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

export default createExampleProcessProviderAdapter();
