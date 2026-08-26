import { performance } from 'node:perf_hooks';

import type {
  RuntimeDetection,
  RuntimeId,
  RuntimeOutputLine,
  RuntimeRunResult,
} from './adapters/types.js';
import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  AdapterContractError,
  AdapterRegistryV1,
  validateAdapterRuntimeBindingV1,
  type AdapterManifestV1,
  type AdapterNativeEventV1,
  type AdapterRunRequestV1,
  type AdapterRunResultV1,
  type AdapterWorkspaceBindingV1,
} from './adapter-sdk.js';

export interface AdapterHostProfileV1 {
  readonly profileId: string;
  readonly adapterId: string;
  readonly harness: RuntimeId;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: string;
  readonly configurationDigest: string;
  readonly providerWorkspaceRef?: string;
}

export interface AdapterHostRunRequestV1 {
  readonly identity: {
    readonly executionId: string;
    readonly missionId: string;
    readonly branchId: string;
    readonly attemptId: string;
    readonly bindingId: string;
  };
  readonly profile: AdapterHostProfileV1;
  readonly workspaceKey: string;
  readonly localWorkspace: string;
  readonly instruction: string;
  readonly signal?: AbortSignal;
  readonly onStart?: (pid: number) => void | Promise<void>;
  readonly onOutput?: (line: RuntimeOutputLine) => void | Promise<void>;
}

/**
 * Public Adapter execution host. It translates Adapter evidence and Runtime
 * outcome into the existing process-facing engine port; it has no Kernel state
 * mutation capability of its own.
 */
export class AdapterHostV1 {
  readonly #registry: AdapterRegistryV1;
  readonly #now: () => Date;

  constructor(options: { readonly registry: AdapterRegistryV1; readonly now?: () => Date }) {
    this.#registry = options.registry;
    this.#now = options.now ?? (() => new Date());
  }

  manifest(adapterId: string): AdapterManifestV1 {
    const adapter = this.#registry.get(adapterId);
    if (adapter === undefined)
      throw new AdapterContractError(`Adapter ${adapterId} is not registered`);
    return adapter.manifest;
  }

  nativeProtocol(adapterId: string): string {
    return this.manifest(adapterId).nativeProtocol;
  }

  async detect(adapterId: string, harness: RuntimeId): Promise<RuntimeDetection> {
    const adapter = this.#registry.get(adapterId);
    if (adapter === undefined) {
      return missingDetection(adapterId, harness, this.#now().toISOString());
    }
    assertHarnessBinding(adapter.manifest, harness);
    const started = performance.now();
    const requestedAt = this.#now().toISOString();
    try {
      const discovery = await adapter.discover({ observedAt: requestedAt });
      if (discovery.adapterId !== adapterId || discovery.transport !== adapter.manifest.transport) {
        throw new AdapterContractError('Adapter discovery identity does not match its manifest');
      }
      validateAdapterRuntimeBindingV1(adapter.manifest.transport, discovery.binding);
      const ready =
        discovery.status === 'ready' &&
        !(
          discovery.authentication.status === 'known' &&
          discovery.authentication.value === 'not-ready'
        );
      return {
        runtime: harness,
        command: `adapter:${adapterId}`,
        executablePath: null,
        available: discovery.status !== 'missing',
        responsive: ready,
        status:
          discovery.status === 'missing' ? 'missing' : ready ? 'ready' : 'present-unresponsive',
        version:
          discovery.runtimeVersion.status === 'known'
            ? discovery.runtimeVersion.value
            : adapter.manifest.adapterVersion,
        versionSource: 'output',
        checkedAt: discovery.observedAt,
        durationMs: performance.now() - started,
        probeExitCode: ready ? 0 : null,
        probeSignal: null,
      };
    } catch {
      return {
        runtime: harness,
        command: `adapter:${adapterId}`,
        executablePath: null,
        available: true,
        responsive: false,
        status: 'present-error',
        version: adapter.manifest.adapterVersion,
        versionSource: 'output',
        checkedAt: requestedAt,
        durationMs: performance.now() - started,
        probeExitCode: null,
        probeSignal: null,
      };
    }
  }

  async run(request: AdapterHostRunRequestV1): Promise<RuntimeRunResult> {
    const adapter = this.#registry.get(request.profile.adapterId);
    if (adapter === undefined) {
      throw new AdapterContractError(`Adapter ${request.profile.adapterId} is not registered`);
    }
    assertHarnessBinding(adapter.manifest, request.profile.harness);
    const startedAt = this.#now();
    const workspace = workspaceBinding(adapter.manifest, request);
    const runRequest: AdapterRunRequestV1 = {
      identity: request.identity,
      workspace,
      profile: {
        profileId: request.profile.profileId,
        configurationDigest: request.profile.configurationDigest,
        ...(request.profile.model === 'default' ? {} : { model: request.profile.model }),
        ...(request.profile.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.profile.reasoningEffort }),
        ...(request.profile.permissionMode === undefined
          ? {}
          : { permissionMode: request.profile.permissionMode }),
      },
      instruction: request.instruction,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    let outputLines = 0;
    let stdoutLines = 0;
    let adapterRunId: string | undefined;
    let adapterSequence = 0;
    let result: AdapterRunResultV1;
    try {
      result = await adapter.run(runRequest, {
        evidence: {
          append: async (event) => {
            validateEvidenceIdentity(event, adapter.manifest);
            if (adapterRunId !== undefined && event.runId !== adapterRunId) {
              throw new AdapterContractError('Adapter evidence changed runId during one run');
            }
            if (!Number.isSafeInteger(event.sequence) || event.sequence <= adapterSequence) {
              throw new AdapterContractError(
                'Adapter evidence sequence is not strictly increasing',
              );
            }
            adapterRunId = event.runId;
            adapterSequence = event.sequence;
            outputLines += 1;
            stdoutLines += 1;
            await request.onOutput?.(
              adapterLine(event, request.profile.harness, outputLines, this.#now()),
            );
          },
        },
      });
      validateResultIdentity(result, adapter.manifest);
      if (adapterRunId !== undefined && result.runId !== adapterRunId) {
        throw new AdapterContractError('Adapter result runId does not match emitted evidence');
      }
    } catch (error) {
      const endedAt = this.#now();
      return {
        runtime: request.profile.harness,
        outputProtocol: 'adapter-v1',
        process: {
          invocation: adapterInvocation(request),
          pid: null,
          exitCode: null,
          signal: null,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          aborted: request.signal?.aborted === true,
          stdoutLineCount: stdoutLines,
          stderrLineCount: 0,
          spawnError: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }

    outputLines += 1;
    stdoutLines += 1;
    await request.onOutput?.(
      adapterLine(
        {
          schemaVersion: 'missionbraid.dev/adapter-event/v1',
          apiVersion: '1.0.0',
          adapterId: adapter.manifest.adapterId,
          runId: result.runId,
          sequence: Number.MAX_SAFE_INTEGER,
          sourceId: result.runId,
          sourceProtocol: adapter.manifest.nativeProtocol,
          nativeEventType: 'adapter.run.completed',
          semanticHint: result.status === 'failed' ? 'failure' : 'runtime',
          observedAt: this.#now().toISOString(),
          fidelity: 'derived',
          payload: {
            status: result.status,
            exitCode: result.exitCode ?? null,
            evidenceRefs: [...result.evidenceRefs],
          },
          sanitized: true,
          evidenceRefs: result.evidenceRefs,
        },
        request.profile.harness,
        outputLines,
        this.#now(),
      ),
    );
    const endedAt = this.#now();
    return {
      runtime: request.profile.harness,
      outputProtocol: 'adapter-v1',
      process: {
        invocation: adapterInvocation(request),
        pid: null,
        exitCode:
          result.status === 'completed'
            ? (result.exitCode ?? 0)
            : result.status === 'failed'
              ? (result.exitCode ?? 1)
              : null,
        signal: null,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        aborted: result.status === 'aborted' || request.signal?.aborted === true,
        stdoutLineCount: stdoutLines,
        stderrLineCount: 0,
      },
    };
  }
}

function assertHarnessBinding(manifest: AdapterManifestV1, harness: RuntimeId): void {
  if (manifest.harnessId !== harness) {
    throw new AdapterContractError(
      `Adapter ${manifest.adapterId} is bound to Harness ${manifest.harnessId}, not ${harness}`,
    );
  }
}

function workspaceBinding(
  manifest: AdapterManifestV1,
  request: AdapterHostRunRequestV1,
): AdapterWorkspaceBindingV1 {
  if (manifest.transport === 'provider-backed') {
    const workspaceRef = request.profile.providerWorkspaceRef;
    if (workspaceRef === undefined || workspaceRef.trim() === '') {
      throw new AdapterContractError(
        `Provider-backed Adapter ${manifest.adapterId} requires profile.providerWorkspaceRef`,
      );
    }
    return {
      kind: 'provider',
      workspaceKey: request.workspaceKey,
      workspaceRef,
      access: 'read-write',
    };
  }
  if (manifest.transport === 'acp' && request.profile.providerWorkspaceRef !== undefined) {
    return {
      kind: 'provider',
      workspaceKey: request.workspaceKey,
      workspaceRef: request.profile.providerWorkspaceRef,
      access: 'read-write',
    };
  }
  return {
    kind: 'local',
    workspaceKey: request.workspaceKey,
    absolutePath: request.localWorkspace,
    access: 'read-write',
  };
}

function adapterLine(
  event: AdapterNativeEventV1,
  runtime: RuntimeId,
  sequence: number,
  receivedAt: Date,
): RuntimeOutputLine {
  return {
    runtime,
    sequence,
    streamSequence: sequence,
    stream: 'stdout',
    line: JSON.stringify(event),
    value: event,
    receivedAt: receivedAt.toISOString(),
  };
}

function validateEvidenceIdentity(event: AdapterNativeEventV1, manifest: AdapterManifestV1): void {
  if (
    event.schemaVersion !== ADAPTER_EVENT_SCHEMA_VERSION ||
    event.apiVersion !== ADAPTER_API_VERSION
  ) {
    throw new AdapterContractError('Adapter evidence version is incompatible');
  }
  if (event.adapterId !== manifest.adapterId || event.sourceProtocol !== manifest.nativeProtocol) {
    throw new AdapterContractError('Adapter evidence identity does not match its manifest');
  }
  if (event.sanitized !== true) throw new AdapterContractError('Adapter evidence is not sanitized');
  for (const [label, value] of [
    ['runId', event.runId],
    ['sourceId', event.sourceId],
    ['nativeEventType', event.nativeEventType],
  ] as const) {
    if (value.trim() === '' || value.includes('\0')) {
      throw new AdapterContractError(`Adapter evidence ${label} is empty`);
    }
  }
  if (Number.isNaN(Date.parse(event.observedAt))) {
    throw new AdapterContractError('Adapter evidence observedAt is not ISO time');
  }
  if (event.evidenceRefs.length === 0) {
    throw new AdapterContractError('Adapter evidence must contain evidenceRefs');
  }
}

function validateResultIdentity(result: AdapterRunResultV1, manifest: AdapterManifestV1): void {
  if (result.adapterId !== manifest.adapterId || result.transport !== manifest.transport) {
    throw new AdapterContractError('Adapter result identity does not match its manifest');
  }
  validateAdapterRuntimeBindingV1(manifest.transport, result.binding);
  if (result.evidenceRefs.length === 0) {
    throw new AdapterContractError('Adapter result must contain evidence');
  }
}

function adapterInvocation(request: AdapterHostRunRequestV1) {
  return {
    command: `adapter:${request.profile.adapterId}`,
    args: [],
    cwd: request.localWorkspace,
  };
}

function missingDetection(
  adapterId: string,
  harness: RuntimeId,
  checkedAt: string,
): RuntimeDetection {
  return {
    runtime: harness,
    command: `adapter:${adapterId}`,
    executablePath: null,
    available: false,
    responsive: false,
    status: 'missing',
    version: null,
    versionSource: null,
    checkedAt,
    durationMs: 0,
    probeExitCode: null,
    probeSignal: null,
  };
}
