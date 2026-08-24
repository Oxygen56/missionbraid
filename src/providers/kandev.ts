export const KANDEV_VERSION = 'v0.91.0' as const;
export const KANDEV_COMMIT = 'e04428fa363ecc14b4731269630e7c5a7e579d6f' as const;

const MIN_COMMIT_PREFIX_LENGTH = 7;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export type KandevFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type KandevClock = () => number;

export type KandevSleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export interface KandevClientOptions {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly fetch?: KandevFetch;
  readonly clock?: KandevClock;
  readonly sleep?: KandevSleep;
  readonly requestTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface KandevOperationOptions {
  /** Overall timeout for a multi-request operation, or request timeout for a single GET/list. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal | undefined;
}

export interface KandevDetectionResult {
  readonly provider: 'kandev';
  readonly compatible: true;
  readonly version: typeof KANDEV_VERSION;
  readonly commit: string;
  readonly commitKind: 'prefix' | 'full';
  readonly bootId: string;
}

export interface KandevRepositorySelection {
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly checkoutBranch?: string;
}

export interface KandevProfileSelection {
  readonly agentProfileId: string;
  readonly executorProfileId: string;
  readonly executorId?: string;
}

export interface CreateKandevPreparedTaskRequest {
  readonly externalId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly title: string;
  readonly description?: string;
  readonly repository: KandevRepositorySelection;
  readonly profiles: KandevProfileSelection;
}

export interface KandevTaskSession {
  readonly id: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly agentProfileId: string;
  readonly executorId: string;
  readonly executorProfileId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly worktreeBranch: string;
  readonly workspacePath: string;
  readonly isPrimary: boolean;
}

export interface KandevReadyTaskSession extends KandevTaskSession {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly worktreeBranch: string;
  readonly workspacePath: string;
}

export interface KandevPreparedTaskResult {
  readonly provider: 'kandev';
  readonly detection: KandevDetectionResult;
  readonly taskId: string;
  readonly externalId: string;
  readonly deduplicated: boolean;
  readonly creationComplete: boolean;
  readonly sessionReconciled: boolean;
  readonly session: KandevReadyTaskSession;
}

export interface KandevProcess {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly scriptName: string;
  readonly workingDirectory: string;
  readonly status: string;
}

export interface StartKandevCustomProcessRequest {
  readonly session: KandevReadyTaskSession;
  readonly repositoryId: string;
  readonly scriptName: string;
}

export interface KandevStartedProcessResult {
  readonly provider: 'kandev';
  readonly detection: KandevDetectionResult;
  readonly sessionId: string;
  readonly processId: string;
  readonly repositoryId: string;
  readonly scriptName: string;
  readonly workingDirectory: string;
  readonly status: string;
}

export interface KandevStoppedProcessResult {
  readonly provider: 'kandev';
  readonly detection: KandevDetectionResult;
  readonly sessionId: string;
  readonly processId: string;
  readonly stopStatus: 204 | 404;
  readonly absentFromGet: true;
  readonly absentFromList: true;
}

export class KandevClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class KandevHttpError extends KandevClientError {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
  ) {
    super(`Kandev ${method} ${path} failed with HTTP ${status}.`);
  }
}

export class KandevProtocolError extends KandevClientError {}

export class KandevCompatibilityError extends KandevClientError {}

export class KandevTimeoutError extends KandevClientError {}

export class KandevAbortError extends KandevClientError {}

interface RequestOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

interface WireResponse {
  readonly status: number;
  readonly value?: unknown;
}

interface CreateTaskWireResult {
  readonly taskId: string;
  readonly sessionId: string;
  readonly externalId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly title: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly agentProfileId: string;
  readonly executorProfileId: string;
  readonly executorId: string;
  readonly deduplicated: boolean;
  readonly creationComplete: boolean;
}

export class KandevClient {
  readonly #baseUrl: URL;
  readonly #bearerToken: string | undefined;
  readonly #fetch: KandevFetch;
  readonly #clock: KandevClock;
  readonly #sleep: KandevSleep;
  readonly #requestTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #pollIntervalMs: number;
  #detection: KandevDetectionResult | undefined;

  constructor(options: KandevClientOptions) {
    this.#baseUrl = parseBaseUrl(options.baseUrl);
    this.#bearerToken = optionalNonEmpty(options.bearerToken, 'Kandev bearer token');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#requestTimeoutMs = positiveFinite(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'Kandev requestTimeoutMs',
    );
    this.#operationTimeoutMs = positiveFinite(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      'Kandev operationTimeoutMs',
    );
    this.#pollIntervalMs = positiveFinite(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'Kandev pollIntervalMs',
    );
  }

  async detect(options: KandevOperationOptions = {}): Promise<KandevDetectionResult> {
    const deadline = this.#deadline(options.timeoutMs);
    this.#detection = undefined;
    const healthPath = '/health';
    const healthResponse = await this.#request('GET', healthPath, undefined, [200], {
      signal: options.signal,
      timeoutMs: this.#requestBudget(deadline),
    });
    const health = record(healthResponse.value, `Kandev GET ${healthPath}`);

    const infoPath = '/api/v1/system/info';
    const infoResponse = await this.#request('GET', infoPath, undefined, [200], {
      signal: options.signal,
      timeoutMs: this.#requestBudget(deadline),
    });
    const info = record(infoResponse.value, `Kandev GET ${infoPath}`);

    const healthStatus = requiredString(health, 'status', healthPath);
    const service = requiredString(health, 'service', healthPath);
    const healthVersion = requiredString(health, 'version', healthPath);
    const infoVersion = requiredString(info, 'version', infoPath);
    const commit = requiredString(info, 'commit', infoPath).toLowerCase();
    const bootId = requiredString(info, 'boot_id', infoPath);

    if (healthStatus !== 'ok' || service !== 'kandev') {
      throw new KandevCompatibilityError('Kandev health response is not a ready Kandev service.');
    }
    if (healthVersion !== KANDEV_VERSION || infoVersion !== KANDEV_VERSION) {
      throw new KandevCompatibilityError(`Kandev version mismatch; expected ${KANDEV_VERSION}.`);
    }
    if (!isPinnedCommit(commit)) {
      throw new KandevCompatibilityError('Kandev commit does not match the pinned build.');
    }

    const result: KandevDetectionResult = {
      provider: 'kandev',
      compatible: true,
      version: KANDEV_VERSION,
      commit,
      commitKind: commit === KANDEV_COMMIT ? 'full' : 'prefix',
      bootId,
    };
    this.#detection = result;
    return result;
  }

  async createPreparedTask(
    request: CreateKandevPreparedTaskRequest,
    options: KandevOperationOptions = {},
  ): Promise<KandevPreparedTaskResult> {
    validatePreparedTaskRequest(request);
    const deadline = this.#deadline(options.timeoutMs);
    const detection = await this.#ensureCompatible(deadline, options.signal);
    const createPath = '/api/v1/tasks';
    const repository = {
      repository_id: request.repository.repositoryId,
      base_branch: request.repository.baseBranch,
      ...(request.repository.checkoutBranch === undefined
        ? {}
        : { checkout_branch: request.repository.checkoutBranch }),
    };
    const body = {
      external_id: request.externalId,
      workspace_id: request.workspaceId,
      workflow_id: request.workflowId,
      title: request.title,
      ...(request.description === undefined ? {} : { description: request.description }),
      repositories: [repository],
      prepare_session: true,
      start_agent: false,
      agent_profile_id: request.profiles.agentProfileId,
      executor_profile_id: request.profiles.executorProfileId,
      ...(request.profiles.executorId === undefined
        ? {}
        : { executor_id: request.profiles.executorId }),
    };
    const createResponse = await this.#request('POST', createPath, body, [200], {
      signal: options.signal,
      timeoutMs: this.#requestBudget(deadline),
    });
    const created = parseCreateTask(createResponse.value, createPath);
    if (
      created.externalId !== request.externalId ||
      created.workspaceId !== request.workspaceId ||
      created.workflowId !== request.workflowId ||
      created.title !== request.title ||
      created.repositoryId !== request.repository.repositoryId ||
      created.baseBranch !== request.repository.baseBranch ||
      created.agentProfileId !== request.profiles.agentProfileId ||
      created.executorProfileId !== request.profiles.executorProfileId ||
      (request.profiles.executorId !== undefined &&
        created.executorId !== '' &&
        created.executorId !== request.profiles.executorId)
    ) {
      throw new KandevProtocolError(
        'Kandev task create or deduplication returned a different task binding.',
      );
    }
    if (!created.creationComplete) {
      throw new KandevProtocolError('Kandev task creation did not report synchronous completion.');
    }

    let sessionId = created.sessionId;
    let sessionReconciled = false;
    if (sessionId === '') {
      sessionId = (await this.#reconcileTaskSession(created.taskId, request, deadline, options)).id;
      sessionReconciled = true;
    }
    const session = await this.#waitForReadySession(
      created.taskId,
      sessionId,
      request,
      deadline,
      options,
    );

    return {
      provider: 'kandev',
      detection,
      taskId: created.taskId,
      externalId: request.externalId,
      deduplicated: created.deduplicated,
      creationComplete: created.creationComplete,
      sessionReconciled,
      session,
    };
  }

  async getTaskSession(
    sessionId: string,
    options: KandevOperationOptions = {},
  ): Promise<KandevTaskSession | null> {
    nonEmpty(sessionId, 'Kandev session id');
    const deadline = this.#deadline(options.timeoutMs ?? this.#requestTimeoutMs);
    await this.#ensureCompatible(deadline, options.signal);
    return await this.#getTaskSessionRaw(sessionId, deadline, options.signal);
  }

  async listTaskSessions(
    taskId: string,
    options: KandevOperationOptions = {},
  ): Promise<readonly KandevTaskSession[]> {
    nonEmpty(taskId, 'Kandev task id');
    const deadline = this.#deadline(options.timeoutMs ?? this.#requestTimeoutMs);
    await this.#ensureCompatible(deadline, options.signal);
    return await this.#listTaskSessionsRaw(taskId, deadline, options.signal);
  }

  async startPreconfiguredCustomProcess(
    request: StartKandevCustomProcessRequest,
    options: KandevOperationOptions = {},
  ): Promise<KandevStartedProcessResult> {
    validateReadySession(request.session);
    nonEmpty(request.repositoryId, 'Kandev repository id');
    nonEmpty(request.scriptName, 'Kandev script name');
    if (request.repositoryId !== request.session.repositoryId) {
      throw new TypeError('Kandev process repository must match the prepared session repository.');
    }
    const deadline = this.#deadline(options.timeoutMs);
    const detection = await this.#ensureCompatible(deadline, options.signal);
    const path = processCollectionPath(request.session.id) + '/start';
    const response = await this.#request(
      'POST',
      path,
      {
        kind: 'custom',
        script_name: request.scriptName,
        repo_id: request.repositoryId,
      },
      [200],
      { signal: options.signal, timeoutMs: this.#requestBudget(deadline) },
    );
    const envelope = record(response.value, `Kandev POST ${path}`);
    const process = parseProcess(envelope.process, path);
    if (
      process.sessionId !== request.session.id ||
      process.kind !== 'custom' ||
      process.scriptName !== request.scriptName
    ) {
      throw new KandevProtocolError('Kandev custom process response does not match the request.');
    }
    if (process.workingDirectory !== request.session.worktreePath) {
      throw new KandevProtocolError(
        'Kandev custom process working_dir does not match the prepared worktree path.',
      );
    }
    return {
      provider: 'kandev',
      detection,
      sessionId: process.sessionId,
      processId: process.id,
      repositoryId: request.repositoryId,
      scriptName: process.scriptName,
      workingDirectory: process.workingDirectory,
      status: process.status,
    };
  }

  async getProcess(
    sessionId: string,
    processId: string,
    options: KandevOperationOptions = {},
  ): Promise<KandevProcess | null> {
    nonEmpty(sessionId, 'Kandev session id');
    nonEmpty(processId, 'Kandev process id');
    const deadline = this.#deadline(options.timeoutMs ?? this.#requestTimeoutMs);
    await this.#ensureCompatible(deadline, options.signal);
    return await this.#getProcessRaw(sessionId, processId, deadline, options.signal);
  }

  async listProcesses(
    sessionId: string,
    options: KandevOperationOptions = {},
  ): Promise<readonly KandevProcess[]> {
    nonEmpty(sessionId, 'Kandev session id');
    const deadline = this.#deadline(options.timeoutMs ?? this.#requestTimeoutMs);
    await this.#ensureCompatible(deadline, options.signal);
    return await this.#listProcessesRaw(sessionId, deadline, options.signal);
  }

  async stopProcess(
    sessionId: string,
    processId: string,
    options: KandevOperationOptions = {},
  ): Promise<KandevStoppedProcessResult> {
    nonEmpty(sessionId, 'Kandev session id');
    nonEmpty(processId, 'Kandev process id');
    const deadline = this.#deadline(options.timeoutMs);
    const detection = await this.#ensureCompatible(deadline, options.signal);
    const path = `${processCollectionPath(sessionId)}/${segment(processId)}/stop`;
    const response = await this.#request('POST', path, undefined, [204, 404], {
      signal: options.signal,
      timeoutMs: this.#requestBudget(deadline),
    });

    for (;;) {
      const process = await this.#getProcessRaw(sessionId, processId, deadline, options.signal);
      const processes = await this.#listProcessesRaw(sessionId, deadline, options.signal);
      if (process === null && !processes.some((candidate) => candidate.id === processId)) {
        return {
          provider: 'kandev',
          detection,
          sessionId,
          processId,
          stopStatus: response.status as 204 | 404,
          absentFromGet: true,
          absentFromList: true,
        };
      }
      await this.#pollDelay(deadline, options);
    }
  }

  async #ensureCompatible(
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<KandevDetectionResult> {
    if (this.#detection !== undefined) return this.#detection;
    return await this.detect({ signal, timeoutMs: this.#remaining(deadline) });
  }

  async #reconcileTaskSession(
    taskId: string,
    request: CreateKandevPreparedTaskRequest,
    deadline: number,
    options: KandevOperationOptions,
  ): Promise<KandevTaskSession> {
    for (;;) {
      const sessions = await this.#listTaskSessionsRaw(taskId, deadline, options.signal);
      const candidates = sessions.filter(
        (session) =>
          session.taskId === taskId &&
          (session.repositoryId === '' ||
            session.repositoryId === request.repository.repositoryId) &&
          (session.agentProfileId === '' ||
            session.agentProfileId === request.profiles.agentProfileId) &&
          (request.profiles.executorId === undefined ||
            session.executorId === '' ||
            session.executorId === request.profiles.executorId) &&
          (session.executorProfileId === '' ||
            session.executorProfileId === request.profiles.executorProfileId),
      );
      const primaries = candidates.filter((session) => session.isPrimary);
      if (primaries.length === 1) return primaries[0]!;
      if (candidates.length === 1) return candidates[0]!;
      if (candidates.length > 1) {
        throw new KandevProtocolError(
          'Kandev task session reconciliation is ambiguous for the prepared task.',
        );
      }
      await this.#pollDelay(deadline, options);
    }
  }

  async #waitForReadySession(
    taskId: string,
    sessionId: string,
    request: CreateKandevPreparedTaskRequest,
    deadline: number,
    options: KandevOperationOptions,
  ): Promise<KandevReadyTaskSession> {
    for (;;) {
      const session = await this.#getTaskSessionRaw(sessionId, deadline, options.signal);
      if (session !== null) {
        if (session.taskId !== taskId) {
          throw new KandevProtocolError('Kandev prepared session belongs to a different task.');
        }
        if (
          session.repositoryId !== '' &&
          session.repositoryId !== request.repository.repositoryId
        ) {
          throw new KandevProtocolError(
            'Kandev prepared session belongs to a different repository.',
          );
        }
        if (
          session.agentProfileId !== '' &&
          session.agentProfileId !== request.profiles.agentProfileId
        ) {
          throw new KandevProtocolError(
            'Kandev prepared session belongs to a different agent profile.',
          );
        }
        if (
          request.profiles.executorId !== undefined &&
          session.executorId !== '' &&
          session.executorId !== request.profiles.executorId
        ) {
          throw new KandevProtocolError('Kandev prepared session uses a different executor.');
        }
        if (
          session.executorProfileId !== '' &&
          session.executorProfileId !== request.profiles.executorProfileId
        ) {
          throw new KandevProtocolError(
            'Kandev prepared session belongs to a different executor profile.',
          );
        }
        if (isReadySession(session)) return session;
      }
      await this.#pollDelay(deadline, options);
    }
  }

  async #getTaskSessionRaw(
    sessionId: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<KandevTaskSession | null> {
    const path = `/api/v1/task-sessions/${segment(sessionId)}`;
    const response = await this.#request('GET', path, undefined, [200, 404], {
      signal,
      timeoutMs: this.#requestBudget(deadline),
    });
    if (response.status === 404) return null;
    const envelope = record(response.value, `Kandev GET ${path}`);
    return parseSession(envelope.session, path);
  }

  async #listTaskSessionsRaw(
    taskId: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly KandevTaskSession[]> {
    const path = `/api/v1/tasks/${segment(taskId)}/sessions`;
    const response = await this.#request('GET', path, undefined, [200], {
      signal,
      timeoutMs: this.#requestBudget(deadline),
    });
    const envelope = record(response.value, `Kandev GET ${path}`);
    if (!Array.isArray(envelope.sessions)) {
      throw new KandevProtocolError(`Kandev GET ${path} returned malformed sessions.`);
    }
    return envelope.sessions.map((session) => parseSession(session, path));
  }

  async #getProcessRaw(
    sessionId: string,
    processId: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<KandevProcess | null> {
    const path = `${processCollectionPath(sessionId)}/${segment(processId)}`;
    const response = await this.#request('GET', path, undefined, [200, 404], {
      signal,
      timeoutMs: this.#requestBudget(deadline),
    });
    return response.status === 404 ? null : parseProcess(response.value, path);
  }

  async #listProcessesRaw(
    sessionId: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly KandevProcess[]> {
    const path = processCollectionPath(sessionId);
    const response = await this.#request('GET', path, undefined, [200], {
      signal,
      timeoutMs: this.#requestBudget(deadline),
    });
    if (!Array.isArray(response.value)) {
      throw new KandevProtocolError(`Kandev GET ${path} returned a malformed process list.`);
    }
    return response.value.map((process) => parseProcess(process, path));
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    acceptedStatuses: readonly number[],
    options: RequestOptions,
  ): Promise<WireResponse> {
    assertNotAborted(options.signal);
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      positiveFinite(options.timeoutMs, 'Kandev request timeout'),
    );
    timer.unref();

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.#bearerToken !== undefined) {
      headers.Authorization = `Bearer ${this.#bearerToken}`;
    }
    try {
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (!acceptedStatuses.includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new KandevHttpError(method, path, response.status);
      }
      if (response.status === 204 || response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status };
      }
      try {
        return { status: response.status, value: await response.json() };
      } catch {
        if (timedOut) throw new KandevTimeoutError(`Kandev ${method} ${path} timed out.`);
        if (options.signal?.aborted === true) {
          throw new KandevAbortError(`Kandev ${method} ${path} was aborted.`);
        }
        throw new KandevProtocolError(`Kandev ${method} ${path} returned malformed JSON.`);
      }
    } catch (error) {
      if (error instanceof KandevClientError) throw error;
      if (timedOut) throw new KandevTimeoutError(`Kandev ${method} ${path} timed out.`);
      if (options.signal?.aborted === true) {
        throw new KandevAbortError(`Kandev ${method} ${path} was aborted.`);
      }
      throw new KandevClientError(
        `Kandev ${method} ${path} failed before receiving an HTTP response.`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async #pollDelay(deadline: number, options: KandevOperationOptions): Promise<void> {
    assertNotAborted(options.signal);
    const remaining = this.#remaining(deadline);
    const interval = positiveFinite(
      options.pollIntervalMs ?? this.#pollIntervalMs,
      'Kandev poll interval',
    );
    await this.#sleep(Math.min(interval, remaining), options.signal);
    assertNotAborted(options.signal);
    this.#remaining(deadline);
  }

  #deadline(timeoutMs: number | undefined): number {
    const now = this.#now();
    return now + positiveFinite(timeoutMs ?? this.#operationTimeoutMs, 'Kandev operation timeout');
  }

  #remaining(deadline: number): number {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new KandevTimeoutError('Kandev operation timed out.');
    return remaining;
  }

  #requestBudget(deadline: number): number {
    return Math.min(this.#requestTimeoutMs, this.#remaining(deadline));
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value)) throw new TypeError('Kandev clock must return a finite number.');
    return value;
  }
}

function parseCreateTask(value: unknown, path: string): CreateTaskWireResult {
  const payload = record(value, `Kandev POST ${path}`);
  if (!Array.isArray(payload.repositories) || payload.repositories.length !== 1) {
    throw new KandevProtocolError(
      `Kandev response from ${path} has an invalid repository binding.`,
    );
  }
  const repository = record(payload.repositories[0], `Kandev repository from ${path}`);
  const metadata = record(payload.metadata, `Kandev metadata from ${path}`);
  return {
    taskId: requiredString(payload, 'id', path),
    sessionId: optionalString(payload, 'session_id', path),
    externalId: requiredString(payload, 'external_id', path),
    workspaceId: requiredString(payload, 'workspace_id', path),
    workflowId: requiredString(payload, 'workflow_id', path),
    title: requiredString(payload, 'title', path),
    repositoryId: requiredString(repository, 'repository_id', path),
    baseBranch: requiredString(repository, 'base_branch', path),
    agentProfileId: requiredString(metadata, 'agent_profile_id', path),
    executorProfileId: requiredString(metadata, 'executor_profile_id', path),
    executorId: optionalString(payload, 'primary_executor_id', path),
    deduplicated: requiredBoolean(payload, 'deduplicated', path),
    creationComplete: requiredBoolean(payload, 'creation_complete', path),
  };
}

function parseSession(value: unknown, path: string): KandevTaskSession {
  const payload = record(value, `Kandev session from ${path}`);
  return {
    id: requiredString(payload, 'id', path),
    taskId: requiredString(payload, 'task_id', path),
    repositoryId: optionalString(payload, 'repository_id', path),
    agentProfileId: optionalString(payload, 'agent_profile_id', path),
    executorId: optionalString(payload, 'executor_id', path),
    executorProfileId: optionalString(payload, 'executor_profile_id', path),
    worktreeId: optionalString(payload, 'worktree_id', path),
    worktreePath: optionalString(payload, 'worktree_path', path),
    worktreeBranch: optionalString(payload, 'worktree_branch', path),
    workspacePath: optionalString(payload, 'workspace_path', path),
    isPrimary: optionalBoolean(payload, 'is_primary', path),
  };
}

function parseProcess(value: unknown, path: string): KandevProcess {
  const payload = record(value, `Kandev process from ${path}`);
  return {
    id: requiredString(payload, 'id', path),
    sessionId: requiredString(payload, 'session_id', path),
    kind: requiredString(payload, 'kind', path),
    scriptName: optionalString(payload, 'script_name', path),
    workingDirectory: requiredString(payload, 'working_dir', path),
    status: requiredString(payload, 'status', path),
  };
}

function isReadySession(session: KandevTaskSession): session is KandevReadyTaskSession {
  return (
    session.repositoryId.trim() !== '' &&
    session.agentProfileId.trim() !== '' &&
    session.executorId.trim() !== '' &&
    session.executorProfileId.trim() !== '' &&
    session.worktreeId.trim() !== '' &&
    session.worktreePath.trim() !== '' &&
    session.worktreeBranch.trim() !== '' &&
    session.workspacePath.trim() !== ''
  );
}

function validateReadySession(session: KandevReadyTaskSession): void {
  nonEmpty(session.id, 'Kandev session id');
  nonEmpty(session.repositoryId, 'Kandev session repository id');
  nonEmpty(session.agentProfileId, 'Kandev session agent profile id');
  nonEmpty(session.executorId, 'Kandev session executor id');
  nonEmpty(session.executorProfileId, 'Kandev session executor profile id');
  nonEmpty(session.worktreeId, 'Kandev worktree id');
  nonEmpty(session.worktreePath, 'Kandev worktree path');
  nonEmpty(session.worktreeBranch, 'Kandev worktree branch');
  nonEmpty(session.workspacePath, 'Kandev workspace path');
}

function validatePreparedTaskRequest(request: CreateKandevPreparedTaskRequest): void {
  nonEmpty(request.externalId, 'Kandev external id');
  nonEmpty(request.workspaceId, 'Kandev workspace id');
  nonEmpty(request.workflowId, 'Kandev workflow id');
  nonEmpty(request.title, 'Kandev task title');
  if (request.description !== undefined) nonEmpty(request.description, 'Kandev task description');
  nonEmpty(request.repository.repositoryId, 'Kandev repository id');
  nonEmpty(request.repository.baseBranch, 'Kandev base branch');
  if (request.repository.checkoutBranch !== undefined) {
    nonEmpty(request.repository.checkoutBranch, 'Kandev checkout branch');
  }
  nonEmpty(request.profiles.agentProfileId, 'Kandev agent profile id');
  nonEmpty(request.profiles.executorProfileId, 'Kandev executor profile id');
  if (request.profiles.executorId !== undefined) {
    nonEmpty(request.profiles.executorId, 'Kandev executor id');
  }
}

function isPinnedCommit(commit: string): boolean {
  return (
    /^[0-9a-f]{7,40}$/.test(commit) &&
    commit.length >= MIN_COMMIT_PREFIX_LENGTH &&
    KANDEV_COMMIT.startsWith(commit)
  );
}

function processCollectionPath(sessionId: string): string {
  return `/api/v1/task-sessions/${segment(sessionId)}/processes`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KandevProtocolError(`${context} returned a malformed object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, field: string, path: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KandevProtocolError(`Kandev response from ${path} has invalid ${field}.`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, field: string, path: string): string {
  const value = payload[field];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new KandevProtocolError(`Kandev response from ${path} has invalid ${field}.`);
  }
  return value;
}

function requiredBoolean(payload: Record<string, unknown>, field: string, path: string): boolean {
  const value = payload[field];
  if (typeof value !== 'boolean') {
    throw new KandevProtocolError(`Kandev response from ${path} has invalid ${field}.`);
  }
  return value;
}

function optionalBoolean(payload: Record<string, unknown>, field: string, path: string): boolean {
  const value = payload[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new KandevProtocolError(`Kandev response from ${path} has invalid ${field}.`);
  }
  return value;
}

function parseBaseUrl(value: string): URL {
  nonEmpty(value, 'Kandev base URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Kandev base URL must be a valid URL.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('Kandev base URL must be an HTTP(S) URL without embedded credentials.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function nonEmpty(value: string, label: string): string {
  if (value.trim() === '') throw new TypeError(`${label} must not be empty.`);
  return value;
}

function optionalNonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value, label);
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive.`);
  return value;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new KandevAbortError('Kandev operation was aborted.');
}

async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new KandevAbortError('Kandev operation was aborted.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
