import { createHash } from 'node:crypto';

import {
  KANDEV_COMMIT,
  KANDEV_VERSION,
  type CreateKandevPreparedTaskRequest,
  type KandevDetectionResult,
  type KandevPreparedTaskResult,
  type KandevProcess,
  type KandevStartedProcessResult,
  type KandevStoppedProcessResult,
} from './providers/kandev.js';
import { canonicalJson } from './store.js';

export const KANDEV_PROVIDER_CHECK_CONFIG_SCHEMA =
  'missionbraid.dev/provider-check/kandev/config/v1' as const;
export const KANDEV_PROVIDER_CHECK_RESULT_SCHEMA =
  'missionbraid.dev/provider-check/kandev/result/v1' as const;

const EXTERNAL_ID_PREFIX = 'missionbraid-kandev-check-';

export interface KandevProviderCheckConfigV1 {
  readonly schemaVersion: typeof KANDEV_PROVIDER_CHECK_CONFIG_SCHEMA;
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly agentProfileId: string;
  readonly executorId: string;
  readonly executorProfileId: string;
  readonly scriptName: string;
  readonly externalId: string;
}

export interface KandevProviderCheckClient {
  detect(options?: { readonly signal?: AbortSignal }): Promise<KandevDetectionResult>;
  createPreparedTask(
    request: CreateKandevPreparedTaskRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<KandevPreparedTaskResult>;
  listProcesses(
    sessionId: string,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<readonly KandevProcess[]>;
  startPreconfiguredCustomProcess(
    request: {
      readonly session: KandevPreparedTaskResult['session'];
      readonly repositoryId: string;
      readonly scriptName: string;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<KandevStartedProcessResult>;
  getProcess(
    sessionId: string,
    processId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<KandevProcess | null>;
  stopProcess(
    sessionId: string,
    processId: string,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<KandevStoppedProcessResult>;
}

export interface KandevProviderCheckResultV1 {
  readonly schemaVersion: typeof KANDEV_PROVIDER_CHECK_RESULT_SCHEMA;
  readonly artifactKind: 'provider-compatibility-check';
  readonly result: 'compatible';
  readonly evidenceLevel: 'local-real-runtime';
  readonly provider: {
    readonly name: 'kandev';
    readonly api: 'public-http-v1';
    readonly expectedVersion: typeof KANDEV_VERSION;
    readonly expectedReleaseCommit: typeof KANDEV_COMMIT;
    readonly observedVersion: typeof KANDEV_VERSION;
    readonly observedCommit: string;
    readonly observedCommitKind: 'prefix' | 'full';
  };
  readonly binding: {
    readonly externalId: string;
    readonly taskId: string;
    readonly taskDeduplicated: boolean;
    readonly sessionReconciled: boolean;
    readonly sessionId: string;
    readonly repositoryId: string;
    readonly worktreeId: string;
    readonly worktreePath: string;
    readonly workspacePath: string;
    readonly branch: string;
  };
  readonly process: {
    readonly processId: string;
    readonly scriptName: string;
    readonly acquisition: 'started' | 'reconciled-after-unknown-start' | 'recovered-existing';
    readonly statusObserved: string;
    readonly workingDirectory: string;
    readonly workingDirectoryMatched: true;
    readonly stopAccepted: true;
    readonly customProcessRetired: true;
    readonly absentFromPublicGet: true;
    readonly absentFromPublicList: true;
    readonly startIdempotency: 'unavailable';
    readonly automaticStartRetries: 0;
  };
  readonly claimBoundary: {
    readonly missionExecutionObserved: false;
    readonly sessionLifecycleObserved: false;
    readonly outcomeReceiptIssued: false;
    readonly providerSupportEstablished: false;
    readonly productionReadinessEstablished: false;
  };
  readonly observedAt: string;
  readonly contentSha256: string;
}

export interface RunKandevProviderCheckOptions {
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly clock?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly cleanupTimeoutMs?: number;
}

export class KandevProviderCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function parseKandevProviderCheckConfig(value: unknown): KandevProviderCheckConfigV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KandevProviderCheckError('Kandev provider-check config must be a JSON object.');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'baseUrl',
    'workspaceId',
    'workflowId',
    'repositoryId',
    'baseBranch',
    'agentProfileId',
    'executorId',
    'executorProfileId',
    'scriptName',
    'externalId',
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new KandevProviderCheckError(
      `Unknown Kandev provider-check config field: ${unknown.sort()[0]}.`,
    );
  }
  if (input.schemaVersion !== KANDEV_PROVIDER_CHECK_CONFIG_SCHEMA) {
    throw new KandevProviderCheckError('Unsupported Kandev provider-check config schema.');
  }
  const baseUrl = requireBaseUrl(input.baseUrl);
  const externalId = requireText(input.externalId, 'externalId');
  if (
    !externalId.startsWith(EXTERNAL_ID_PREFIX) ||
    !/^[a-zA-Z0-9._-]+$/.test(externalId) ||
    externalId.length > 160
  ) {
    throw new KandevProviderCheckError(
      `externalId must use the ${EXTERNAL_ID_PREFIX} prefix and contain only safe identifier characters.`,
    );
  }
  return {
    schemaVersion: KANDEV_PROVIDER_CHECK_CONFIG_SCHEMA,
    baseUrl,
    workspaceId: requireText(input.workspaceId, 'workspaceId'),
    workflowId: requireText(input.workflowId, 'workflowId'),
    repositoryId: requireText(input.repositoryId, 'repositoryId'),
    baseBranch: requireText(input.baseBranch, 'baseBranch'),
    agentProfileId: requireText(input.agentProfileId, 'agentProfileId'),
    executorId: requireText(input.executorId, 'executorId'),
    executorProfileId: requireText(input.executorProfileId, 'executorProfileId'),
    scriptName: requireText(input.scriptName, 'scriptName'),
    externalId,
  };
}

export async function runKandevProviderCheck(
  config: KandevProviderCheckConfigV1,
  client: KandevProviderCheckClient,
  options: RunKandevProviderCheckOptions = {},
): Promise<KandevProviderCheckResultV1> {
  const detection = await client.detect(signalOptions(options.signal));
  const task = await client.createPreparedTask(
    {
      externalId: config.externalId,
      workspaceId: config.workspaceId,
      workflowId: config.workflowId,
      title: `MissionBraid Kandev compatibility check ${config.externalId.slice(EXTERNAL_ID_PREFIX.length)}`,
      description:
        'Disposable public-API workspace and process-lifecycle compatibility check; no Mission execution.',
      repository: {
        repositoryId: config.repositoryId,
        baseBranch: config.baseBranch,
      },
      profiles: {
        agentProfileId: config.agentProfileId,
        executorId: config.executorId,
        executorProfileId: config.executorProfileId,
      },
    },
    signalOptions(options.signal),
  );

  assertPreparedBinding(config, task);
  const preflight = await client.listProcesses(task.session.id, signalOptions(options.signal));
  const existing = matchingProcesses(preflight, task, config);
  if (preflight.length !== existing.length || existing.length > 1) {
    throw new KandevProviderCheckError(
      'Kandev prepared session contains ambiguous or unrelated processes; no process was changed.',
    );
  }

  let process: KandevProcess | undefined;
  let acquisition: KandevProviderCheckResultV1['process']['acquisition'];
  let interruptedAfterStart = false;
  if (existing.length === 1) {
    process = existing[0]!;
    acquisition = 'recovered-existing';
  } else {
    try {
      const started = await client.startPreconfiguredCustomProcess(
        {
          session: task.session,
          repositoryId: config.repositoryId,
          scriptName: config.scriptName,
        },
        signalOptions(options.signal),
      );
      const observed = await client.getProcess(
        task.session.id,
        started.processId,
        signalOptions(options.signal),
      );
      if (observed === null) {
        throw new KandevProviderCheckError(
          'Kandev process disappeared before its working directory could be verified.',
        );
      }
      process = observed;
      acquisition = 'started';
    } catch (error) {
      interruptedAfterStart = options.signal?.aborted === true;
      process = await reconcileUnknownProcessStart(client, task, config, options);
      acquisition = 'reconciled-after-unknown-start';
    }
  }

  if (process === undefined) {
    throw new KandevProviderCheckError('Kandev process acquisition produced no process binding.');
  }
  const acquiredProcess = process;

  let stopped: KandevStoppedProcessResult | undefined;
  try {
    assertProcessBinding(acquiredProcess, task, config);
  } catch (error) {
    try {
      stopped = await client.stopProcess(task.session.id, acquiredProcess.id, {
        timeoutMs: options.cleanupTimeoutMs ?? 15_000,
      });
    } catch {
      throw new KandevProviderCheckError(
        'Kandev process binding was invalid and cleanup could not be verified.',
      );
    }
    throw error;
  }

  try {
    stopped = await client.stopProcess(task.session.id, acquiredProcess.id, {
      timeoutMs: options.cleanupTimeoutMs ?? 15_000,
    });
  } catch (error) {
    throw new KandevProviderCheckError('Kandev process cleanup did not converge.');
  }
  if (stopped.stopStatus !== 204) {
    throw new KandevProviderCheckError(
      'Kandev process was already absent; this run did not observe an accepted stop request.',
    );
  }

  if (interruptedAfterStart) {
    throw new KandevProviderCheckError(
      'Kandev provider check was interrupted after process start; cleanup converged.',
    );
  }

  const withoutHash = {
    schemaVersion: KANDEV_PROVIDER_CHECK_RESULT_SCHEMA,
    artifactKind: 'provider-compatibility-check' as const,
    result: 'compatible' as const,
    evidenceLevel: 'local-real-runtime' as const,
    provider: {
      name: 'kandev' as const,
      api: 'public-http-v1' as const,
      expectedVersion: KANDEV_VERSION,
      expectedReleaseCommit: KANDEV_COMMIT,
      observedVersion: detection.version,
      observedCommit: detection.commit,
      observedCommitKind: detection.commitKind,
    },
    binding: {
      externalId: task.externalId,
      taskId: task.taskId,
      taskDeduplicated: task.deduplicated,
      sessionReconciled: task.sessionReconciled,
      sessionId: task.session.id,
      repositoryId: task.session.repositoryId,
      worktreeId: task.session.worktreeId,
      worktreePath: task.session.worktreePath,
      workspacePath: task.session.workspacePath,
      branch: task.session.worktreeBranch,
    },
    process: {
      processId: acquiredProcess.id,
      scriptName: acquiredProcess.scriptName,
      acquisition,
      statusObserved: acquiredProcess.status,
      workingDirectory: acquiredProcess.workingDirectory,
      workingDirectoryMatched: true as const,
      stopAccepted: true as const,
      customProcessRetired: true as const,
      absentFromPublicGet: stopped.absentFromGet,
      absentFromPublicList: stopped.absentFromList,
      startIdempotency: 'unavailable' as const,
      automaticStartRetries: 0 as const,
    },
    claimBoundary: {
      missionExecutionObserved: false as const,
      sessionLifecycleObserved: false as const,
      outcomeReceiptIssued: false as const,
      providerSupportEstablished: false as const,
      productionReadinessEstablished: false as const,
    },
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  return {
    ...withoutHash,
    contentSha256: createHash('sha256').update(canonicalJson(withoutHash), 'utf8').digest('hex'),
  };
}

export function verifyKandevProviderCheckResult(result: KandevProviderCheckResultV1): boolean {
  const { contentSha256, ...withoutHash } = result;
  return (
    /^[0-9a-f]{64}$/.test(contentSha256) &&
    createHash('sha256').update(canonicalJson(withoutHash), 'utf8').digest('hex') === contentSha256
  );
}

function assertPreparedBinding(
  config: KandevProviderCheckConfigV1,
  task: KandevPreparedTaskResult,
): void {
  if (
    task.externalId !== config.externalId ||
    task.session.repositoryId !== config.repositoryId ||
    task.session.agentProfileId !== config.agentProfileId ||
    task.session.executorId !== config.executorId ||
    task.session.executorProfileId !== config.executorProfileId ||
    task.session.workspacePath !== task.session.worktreePath
  ) {
    throw new KandevProviderCheckError(
      'Kandev prepared task does not match the requested binding.',
    );
  }
}

function matchingProcesses(
  processes: readonly KandevProcess[],
  task: KandevPreparedTaskResult,
  config: KandevProviderCheckConfigV1,
): readonly KandevProcess[] {
  return processes.filter(
    (process) =>
      process.sessionId === task.session.id &&
      process.kind === 'custom' &&
      process.scriptName === config.scriptName &&
      process.workingDirectory === task.session.worktreePath,
  );
}

function ownedProcesses(
  processes: readonly KandevProcess[],
  task: KandevPreparedTaskResult,
  config: KandevProviderCheckConfigV1,
): readonly KandevProcess[] {
  return processes.filter(
    (process) =>
      process.sessionId === task.session.id &&
      process.kind === 'custom' &&
      process.scriptName === config.scriptName,
  );
}

async function reconcileUnknownProcessStart(
  client: KandevProviderCheckClient,
  task: KandevPreparedTaskResult,
  config: KandevProviderCheckConfigV1,
  options: RunKandevProviderCheckOptions,
): Promise<KandevProcess> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.cleanupTimeoutMs ?? 15_000;
  const deadline = clock() + timeoutMs;
  for (;;) {
    const remaining = deadline - clock();
    if (remaining <= 0) {
      throw new KandevProviderCheckError(
        'Kandev process start outcome is unknown; it was not retried automatically.',
      );
    }
    const processes = await client.listProcesses(task.session.id, {
      timeoutMs: Math.min(remaining, 1_000),
    });
    const candidates = ownedProcesses(processes, task, config);
    if (processes.length === 1 && candidates.length === 1) return candidates[0]!;
    if (processes.length > 0) {
      throw new KandevProviderCheckError(
        'Kandev process start reconciliation found ambiguous or unrelated processes.',
      );
    }
    await sleep(Math.min(100, Math.max(1, deadline - clock())));
  }
}

function assertProcessBinding(
  process: KandevProcess,
  task: KandevPreparedTaskResult,
  config: KandevProviderCheckConfigV1,
): void {
  const matches = matchingProcesses([process], task, config).length === 1;
  if (!matches || process.status !== 'running') {
    throw new KandevProviderCheckError(
      'Kandev process does not match the prepared worktree or is not running.',
    );
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KandevProviderCheckError(`Kandev provider-check config field ${field} is required.`);
  }
  return value;
}

function requireBaseUrl(value: unknown): string {
  const raw = requireText(value, 'baseUrl');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KandevProviderCheckError('baseUrl must be a valid HTTP(S) origin.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new KandevProviderCheckError(
      'baseUrl must be an HTTP(S) origin without credentials, path, query, or fragment.',
    );
  }
  return url.origin;
}

function signalOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
