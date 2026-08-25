import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { APP_CSS, APP_HTML, APP_JAVASCRIPT } from './app-page.js';
import type { NativeArtifactContent } from './artifact-store.js';
import type { CompositeCheckpointManifestV1 } from './composite-checkpoint.js';
import type { ContextGraphV1 } from './context-graph.js';
import {
  MissionEngine,
  type ExecuteMissionOptions,
  type MissionCreationResult,
  type MissionExecutionResult,
  type MissionStatusView,
  type MissionTimelineEntry,
  type MissionToolGateView,
  type MissionExternalEffectRequestV1,
  type MissionExecutionPlannerCandidateV1,
  type MissionExecutionPlannerOverrideRequestV1,
  type MissionExecutionPlannerOverrideV1,
  type MissionExecutionForkRequestV1,
  type MissionDiagnosticForkRequestV1,
  type MissionExecutionForkResultV1,
  type MissionCheckpointReplayResultV1,
  type MissionPlanView,
  type MissionPlanRuntimeProjectionV1,
  type ReviseMissionContractInputV1,
  type ReviseMissionContractResultV1,
  type MissionOutcomeStudioScenarioCollectionV1,
} from './engine.js';
import type { MissionFailureIntelligenceProjectionV1 } from './mission-failure-intelligence.js';
import type { MissionOutcomeStudioViewV1 } from './mission-outcome-studio.js';
import type { CheckpointReplayRecordV1 } from './checkpoint-replay.js';
import type { MissionCheckpointReplayRequestV1 } from './mission-checkpoint-replay.js';
import { createMissionDraft, MissionDraftError } from './mission-draft.js';
import { discoverRuntimeCatalog, type RuntimeCatalogEntry } from './runtime-catalog.js';
import type {
  BranchV1,
  JsonValue,
  MissionCommandActionV1,
  MissionCommandV1,
  MissionProjectionV1,
} from './domain.js';
import type { ExternalEffectOutcome } from './external-effect.js';
import type { ExecutionForkRecordV1 } from './execution-fork.js';
import type { ToolDecisionIntentDraft, ToolDecisionIntentV1 } from './tool-gateway.js';
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
  branches?(missionId: string): readonly BranchV1[];
  compositeCheckpoints?(missionId: string): readonly CompositeCheckpointManifestV1[];
  executionForks?(missionId: string): Promise<readonly ExecutionForkRecordV1[]>;
  checkpointReplays?(missionId: string): Promise<readonly CheckpointReplayRecordV1[]>;
  missionPlan?(missionId: string): MissionPlanView;
  missionPlanRuntime?(missionId: string): MissionPlanRuntimeProjectionV1;
  reviseMissionContract?(
    missionId: string,
    input: ReviseMissionContractInputV1,
  ): Promise<ReviseMissionContractResultV1>;
  createCompositeCheckpoint?(
    missionId: string,
    requestedAttemptId?: string,
  ): Promise<CompositeCheckpointManifestV1>;
  executeFork?(
    missionId: string,
    input: MissionExecutionForkRequestV1,
  ): Promise<MissionExecutionForkResultV1>;
  executeDiagnosticFork?(
    missionId: string,
    input: MissionDiagnosticForkRequestV1,
  ): Promise<MissionExecutionForkResultV1>;
  failureIntelligence?(
    missionId: string,
    branchId?: string,
  ): Promise<MissionFailureIntelligenceProjectionV1>;
  outcomeStudio?(missionId: string, branchId?: string): Promise<MissionOutcomeStudioViewV1>;
  outcomeStudioScenarios?(missionId: string): MissionOutcomeStudioScenarioCollectionV1;
  saveOutcomeStudioScenario?(
    missionId: string,
    branchId?: string,
  ): Promise<MissionOutcomeStudioScenarioCollectionV1>;
  exportOutcomeStudioScenarios?(missionId: string): Promise<string>;
  replayCheckpoint?(
    missionId: string,
    checkpointId: string,
    input: MissionCheckpointReplayRequestV1,
  ): Promise<MissionCheckpointReplayResultV1>;
  executionPlannerCandidates?(missionId: string): readonly MissionExecutionPlannerCandidateV1[];
  executionPlannerOverride?(missionId: string): MissionExecutionPlannerOverrideV1 | undefined;
  setExecutionPlannerOverride?(
    missionId: string,
    request: MissionExecutionPlannerOverrideRequestV1,
  ): Promise<MissionExecutionPlannerOverrideV1>;
  clearExecutionPlannerOverride?(missionId: string, reason: string): Promise<void>;
  pendingToolGates?(missionId: string): Promise<readonly MissionToolGateView[]>;
  decideToolGate?(
    missionId: string,
    attemptId: string,
    draft: ToolDecisionIntentDraft,
  ): Promise<ToolDecisionIntentV1>;
  coordinateExternalEffect?(
    missionId: string,
    input: MissionExternalEffectRequestV1,
  ): Promise<ExternalEffectOutcome<JsonValue>>;
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
    const missionPlanId = matchMissionPlan(url.pathname);
    if (missionPlanId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.missionPlan === undefined)
          throw new AppHttpError(501, 'MISSION_PLAN_UNAVAILABLE');
        sendJson(response, 200, engine.missionPlan(missionPlanId));
      } finally {
        engine.close();
      }
      return;
    }
    const missionPlanRuntimeId = matchMissionPlanRuntime(url.pathname);
    if (missionPlanRuntimeId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.missionPlanRuntime === undefined)
          throw new AppHttpError(501, 'MISSION_PLAN_RUNTIME_UNAVAILABLE');
        sendJson(response, 200, engine.missionPlanRuntime(missionPlanRuntimeId));
      } finally {
        engine.close();
      }
      return;
    }
    const reviseMissionId = matchMissionContractRevision(url.pathname);
    if (reviseMissionId !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.reviseMissionContract === undefined)
          throw new AppHttpError(501, 'MISSION_PLAN_UNAVAILABLE');
        const body = requireJsonRecord(await readJson(request));
        const result = await engine.reviseMissionContract(reviseMissionId, {
          contract: body.contract as ReviseMissionContractInputV1['contract'],
          requirements: body.requirements as ReviseMissionContractInputV1['requirements'],
          reason: requireJsonString(body.reason, 'reason'),
          evidenceRefs: body.evidenceRefs === undefined ? [] : (body.evidenceRefs as string[]),
          authorityChanges:
            body.authorityChanges as ReviseMissionContractInputV1['authorityChanges'],
        });
        sendJson(response, 201, result);
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
    const toolGateDecision = matchToolGateDecision(url.pathname);
    if (toolGateDecision !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.decideToolGate === undefined) {
          throw new AppHttpError(
            501,
            'TOOL_GATE_UNAVAILABLE',
            'Tool Gate decisions are unavailable.',
          );
        }
        const body = requireJsonRecord(await readJson(request));
        const intent = await engine.decideToolGate(
          toolGateDecision.missionId,
          toolGateDecision.attemptId,
          {
            gateId: toolGateDecision.gateId,
            expectedRequestSha256: requireJsonString(
              body.expectedRequestSha256,
              'expectedRequestSha256',
            ),
            decision: requireToolDecision(body.decision),
            ...(body.reason === undefined
              ? {}
              : { reason: requireJsonString(body.reason, 'reason') }),
            ...(body.updatedInput === undefined
              ? {}
              : { updatedInput: requireJsonObject(body.updatedInput, 'updatedInput') }),
          },
        );
        sendJson(response, 202, { intent });
      } finally {
        engine.close();
      }
      return;
    }
    const externalEffectAction = matchExternalEffectAction(url.pathname);
    if (externalEffectAction !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.coordinateExternalEffect === undefined) {
          throw new AppHttpError(
            501,
            'EXTERNAL_EFFECT_UNAVAILABLE',
            'External Effect coordination is unavailable.',
          );
        }
        const body = requireExternalEffectBody(await readJson(request));
        const outcome = await engine.coordinateExternalEffect(externalEffectAction.missionId, {
          effectId: externalEffectAction.effectId,
          attemptId: body.attemptId,
          targetId: body.targetId,
          kind: body.kind,
          resourceKey: body.resourceKey,
          authorityRef: body.authorityRef,
          idempotencyKey: body.idempotencyKey,
          payloadDigest: body.payloadDigest,
          payload: body.payload,
          ...(body.compensatesEffectId === undefined
            ? {}
            : { compensatesEffectId: body.compensatesEffectId }),
        });
        sendJson(response, 200, { outcome });
      } finally {
        engine.close();
      }
      return;
    }
    const checkpointMissionId = matchCheckpointCollection(url.pathname);
    if (checkpointMissionId !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.createCompositeCheckpoint === undefined) {
          throw new AppHttpError(
            501,
            'COMPOSITE_CHECKPOINT_UNAVAILABLE',
            'Composite Checkpoint creation is unavailable.',
          );
        }
        const body = requireJsonRecord(await readJson(request));
        const attemptId =
          body.attemptId === undefined ? undefined : requireJsonString(body.attemptId, 'attemptId');
        const checkpoint = await engine.createCompositeCheckpoint(checkpointMissionId, attemptId);
        sendJson(response, 201, { checkpoint });
      } finally {
        engine.close();
      }
      return;
    }
    const diagnosticFork = matchDiagnosticForkCollection(url.pathname);
    if (diagnosticFork !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.executeDiagnosticFork === undefined) {
          throw new AppHttpError(
            501,
            'DIAGNOSTIC_FORK_UNAVAILABLE',
            'Failure Intelligence diagnostic Fork is unavailable.',
          );
        }
        const raw = requireJsonRecord(await readJson(request));
        const body = requireExecutionForkBody(raw);
        const result = await engine.executeDiagnosticFork(diagnosticFork.missionId, {
          candidateId: diagnosticFork.candidateId,
          checkpointId: requireExecutionForkString(raw.checkpointId, 'checkpointId'),
          intervention: body.intervention,
          ...(body.stageId === undefined ? {} : { stageId: body.stageId }),
          ...(body.childBranchId === undefined ? {} : { childBranchId: body.childBranchId }),
        });
        sendJson(response, 201, { executionFork: result.record, receipt: result.receipt });
      } finally {
        engine.close();
      }
      return;
    }
    const checkpointFork = matchCheckpointForkCollection(url.pathname);
    if (checkpointFork !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.executeFork === undefined) {
          throw new AppHttpError(
            501,
            'EXECUTION_FORK_UNAVAILABLE',
            'Execution Fork is unavailable.',
          );
        }
        const body = requireExecutionForkBody(await readJson(request));
        const result = await engine.executeFork(checkpointFork.missionId, {
          checkpointId: checkpointFork.checkpointId,
          intervention: body.intervention,
          ...(body.stageId === undefined ? {} : { stageId: body.stageId }),
          ...(body.childBranchId === undefined ? {} : { childBranchId: body.childBranchId }),
        });
        sendJson(response, 201, { executionFork: result.record, receipt: result.receipt });
      } finally {
        engine.close();
      }
      return;
    }
    const failureIntelligenceMissionId = matchMissionFailureIntelligence(url.pathname);
    if (failureIntelligenceMissionId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.failureIntelligence === undefined) {
          throw new AppHttpError(
            501,
            'FAILURE_INTELLIGENCE_UNAVAILABLE',
            'Failure Intelligence is unavailable.',
          );
        }
        const branchId = url.searchParams.get('branchId') ?? undefined;
        sendJson(
          response,
          200,
          await engine.failureIntelligence(failureIntelligenceMissionId, branchId),
        );
      } finally {
        engine.close();
      }
      return;
    }
    const outcomeStudioMissionId = matchMissionOutcomeStudio(url.pathname);
    const outcomeStudioScenarioExportMissionId = matchMissionOutcomeStudioScenarioExport(
      url.pathname,
    );
    if (outcomeStudioScenarioExportMissionId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.exportOutcomeStudioScenarios === undefined) {
          throw new AppHttpError(
            501,
            'OUTCOME_STUDIO_UNAVAILABLE',
            'Outcome Studio is unavailable.',
          );
        }
        const payload = await engine.exportOutcomeStudioScenarios(
          outcomeStudioScenarioExportMissionId,
        );
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader(
          'Content-Disposition',
          'attachment; filename="outcome-studio-scenarios.json"',
        );
        response.end(payload);
      } finally {
        engine.close();
      }
      return;
    }
    const outcomeStudioScenariosMissionId = matchMissionOutcomeStudioScenarios(url.pathname);
    if (
      outcomeStudioScenariosMissionId !== undefined &&
      (request.method === 'GET' || request.method === 'POST')
    ) {
      const engine = engineFactory(stateDir);
      try {
        if (request.method === 'GET') {
          if (engine.outcomeStudioScenarios === undefined) {
            throw new AppHttpError(
              501,
              'OUTCOME_STUDIO_UNAVAILABLE',
              'Outcome Studio is unavailable.',
            );
          }
          sendJson(response, 200, engine.outcomeStudioScenarios(outcomeStudioScenariosMissionId));
        } else {
          if (engine.saveOutcomeStudioScenario === undefined) {
            throw new AppHttpError(
              501,
              'OUTCOME_STUDIO_UNAVAILABLE',
              'Outcome Studio is unavailable.',
            );
          }
          const body = await readJson(request);
          const branchId =
            body !== null &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            typeof (body as Record<string, unknown>).branchId === 'string'
              ? ((body as Record<string, unknown>).branchId as string)
              : undefined;
          sendJson(
            response,
            201,
            await engine.saveOutcomeStudioScenario(outcomeStudioScenariosMissionId, branchId),
          );
        }
      } finally {
        engine.close();
      }
      return;
    }
    if (outcomeStudioMissionId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.outcomeStudio === undefined) {
          throw new AppHttpError(
            501,
            'OUTCOME_STUDIO_UNAVAILABLE',
            'Outcome Studio is unavailable.',
          );
        }
        const branchId = url.searchParams.get('branchId') ?? undefined;
        sendJson(response, 200, await engine.outcomeStudio(outcomeStudioMissionId, branchId));
      } finally {
        engine.close();
      }
      return;
    }
    const checkpointReplay = matchCheckpointReplayCollection(url.pathname);
    if (checkpointReplay !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.replayCheckpoint === undefined) {
          throw new AppHttpError(
            501,
            'CHECKPOINT_REPLAY_UNAVAILABLE',
            'Checkpoint Replay is unavailable.',
          );
        }
        const body = requireCheckpointReplayBody(await readJson(request));
        const result = await engine.replayCheckpoint(
          checkpointReplay.missionId,
          checkpointReplay.checkpointId,
          body,
        );
        sendJson(response, body.mode === 'playback' ? 200 : 201, {
          checkpointReplay: result,
        });
      } finally {
        engine.close();
      }
      return;
    }
    const plannerOverrideMissionId = matchExecutionPlannerOverride(url.pathname);
    if (plannerOverrideMissionId !== undefined && request.method === 'POST') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.setExecutionPlannerOverride === undefined) {
          throw new AppHttpError(
            501,
            'EXECUTION_PLANNER_OVERRIDE_UNAVAILABLE',
            'Execution Planner override is unavailable.',
          );
        }
        const body = requireJsonRecord(await readJson(request));
        const override = await engine.setExecutionPlannerOverride(plannerOverrideMissionId, {
          stageId: requireJsonString(body.stageId, 'stageId'),
          reason: requireJsonString(body.reason, 'reason'),
        });
        sendJson(response, 201, { override });
      } finally {
        engine.close();
      }
      return;
    }
    if (plannerOverrideMissionId !== undefined && request.method === 'DELETE') {
      const engine = engineFactory(stateDir);
      try {
        if (engine.clearExecutionPlannerOverride === undefined) {
          throw new AppHttpError(
            501,
            'EXECUTION_PLANNER_OVERRIDE_UNAVAILABLE',
            'Execution Planner override is unavailable.',
          );
        }
        const body = requireJsonRecord(await readJson(request));
        await engine.clearExecutionPlannerOverride(
          plannerOverrideMissionId,
          requireJsonString(body.reason, 'reason'),
        );
        sendJson(response, 200, { cleared: true });
      } finally {
        engine.close();
      }
      return;
    }
    const missionId = matchMissionId(url.pathname);
    if (missionId !== undefined && request.method === 'GET') {
      const engine = engineFactory(stateDir);
      try {
        const status = engine.status(missionId);
        const toolGates =
          engine.pendingToolGates === undefined ? [] : await engine.pendingToolGates(missionId);
        let failureIntelligence: MissionFailureIntelligenceProjectionV1 | null = null;
        if (engine.failureIntelligence !== undefined) {
          try {
            failureIntelligence = await engine.failureIntelligence(missionId);
          } catch {
            // The detail page remains useful when a branch has no complete
            // evidence projection yet; the dedicated route remains strict.
            failureIntelligence = null;
          }
        }
        let missionPlan: unknown = null;
        if (engine.missionPlan !== undefined) {
          try {
            missionPlan = engine.missionPlan(missionId);
          } catch {
            missionPlan = null;
          }
        }
        let missionPlanRuntime: MissionPlanRuntimeProjectionV1 | null = null;
        if (engine.missionPlanRuntime !== undefined) {
          try {
            missionPlanRuntime = engine.missionPlanRuntime(missionId);
          } catch {
            missionPlanRuntime = null;
          }
        }
        let outcomeStudio: MissionOutcomeStudioViewV1 | null = null;
        if (engine.outcomeStudio !== undefined) {
          try {
            outcomeStudio = await engine.outcomeStudio(missionId);
          } catch {
            // Outcome Studio is an evidence projection; absence of a complete
            // Checkpoint/Receipt must not hide the authoritative Mission view.
            outcomeStudio = null;
          }
        }
        sendJson(response, 200, {
          ...status,
          timeline: engine.timeline(missionId),
          contextGraph: await engine.contextGraph(missionId),
          failureIntelligence,
          toolGates,
          branches: engine.branches?.(missionId) ?? [],
          compositeCheckpoints: engine.compositeCheckpoints?.(missionId) ?? [],
          executionForks:
            engine.executionForks === undefined ? [] : await engine.executionForks(missionId),
          checkpointReplays:
            engine.checkpointReplays === undefined ? [] : await engine.checkpointReplays(missionId),
          missionPlan,
          missionPlanRuntime,
          outcomeStudio,
          executionPlanner: {
            candidates: engine.executionPlannerCandidates?.(missionId) ?? [],
            override: engine.executionPlannerOverride?.(missionId) ?? null,
          },
          capabilities: {
            createCompositeCheckpoint: engine.createCompositeCheckpoint !== undefined,
            executeFork: engine.executeFork !== undefined,
            executeDiagnosticFork: engine.executeDiagnosticFork !== undefined,
            failureIntelligence: engine.failureIntelligence !== undefined,
            outcomeStudio: engine.outcomeStudio !== undefined,
            missionPlanRuntime: engine.missionPlanRuntime !== undefined,
            replayCheckpoint: engine.replayCheckpoint !== undefined,
            setExecutionPlannerOverride: engine.setExecutionPlannerOverride !== undefined,
            clearExecutionPlannerOverride: engine.clearExecutionPlannerOverride !== undefined,
          },
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

function matchMissionPlan(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/plan$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionPlanRuntime(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/plan\/runtime$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionContractRevision(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/contract-revisions$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionFailureIntelligence(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/failure-intelligence$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionOutcomeStudio(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/outcome-studio$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionOutcomeStudioScenarios(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/outcome-studio\/scenarios$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchMissionOutcomeStudioScenarioExport(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/outcome-studio\/scenarios\/export$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchExecutionPlannerOverride(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/execution-planner\/override$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchCheckpointReplayCollection(
  pathname: string,
): { readonly missionId: string; readonly checkpointId: string } | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/checkpoints\/([^/]+)\/replays$/);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    missionId: decodeURIComponent(match[1]),
    checkpointId: decodeURIComponent(match[2]),
  };
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

function matchToolGateDecision(
  pathname: string,
): { readonly missionId: string; readonly attemptId: string; readonly gateId: string } | undefined {
  const match = pathname.match(
    /^\/api\/v1\/missions\/([^/]+)\/attempts\/([^/]+)\/tool-gates\/(gate-[a-f0-9]{32})\/decision$/,
  );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
    return undefined;
  return {
    missionId: decodeURIComponent(match[1]),
    attemptId: decodeURIComponent(match[2]),
    gateId: match[3],
  };
}

function matchExternalEffectAction(
  pathname: string,
): { readonly missionId: string; readonly effectId: string } | undefined {
  const match = pathname.match(
    /^\/api\/v1\/missions\/([^/]+)\/external-effects\/([^/]+)\/coordinate$/,
  );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { missionId: decodeURIComponent(match[1]), effectId: decodeURIComponent(match[2]) };
}

function matchCheckpointCollection(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/checkpoints$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function matchCheckpointForkCollection(
  pathname: string,
): { readonly missionId: string; readonly checkpointId: string } | undefined {
  const match = pathname.match(/^\/api\/v1\/missions\/([^/]+)\/checkpoints\/([^/]+)\/forks$/);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    missionId: decodeURIComponent(match[1]),
    checkpointId: decodeURIComponent(match[2]),
  };
}

function matchDiagnosticForkCollection(
  pathname: string,
): { readonly missionId: string; readonly candidateId: string } | undefined {
  const match = pathname.match(
    /^\/api\/v1\/missions\/([^/]+)\/failure-intelligence\/([^/]+)\/forks$/,
  );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    missionId: decodeURIComponent(match[1]),
    candidateId: decodeURIComponent(match[2]),
  };
}

function requireCheckpointReplayBody(value: unknown): MissionCheckpointReplayRequestV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppHttpError(
      400,
      'INVALID_CHECKPOINT_REPLAY',
      'Checkpoint Replay body must be an object.',
    );
  }
  const body = value as Record<string, unknown>;
  if (body.mode === 'playback') return { mode: 'playback' };
  if (body.mode !== 'cached-replay' && body.mode !== 'counterfactual-resample') {
    throw new AppHttpError(
      400,
      'INVALID_CHECKPOINT_REPLAY',
      'mode must be playback, cached-replay, or counterfactual-resample.',
    );
  }
  if (
    body.intervention === null ||
    typeof body.intervention !== 'object' ||
    Array.isArray(body.intervention)
  ) {
    throw new AppHttpError(400, 'INVALID_CHECKPOINT_REPLAY', 'intervention must be an object.');
  }
  const input = body.intervention as Record<string, unknown>;
  const authorityChange =
    input.authorityChange === undefined
      ? undefined
      : requireExecutionForkAuthorityChange(input.authorityChange);
  return {
    mode: body.mode,
    intervention: {
      kind: requireExecutionForkKind(input.kind),
      targetRef: requireCheckpointReplayString(input.targetRef, 'intervention.targetRef'),
      replacement: requireCheckpointReplayString(
        input.replacement,
        'intervention.replacement',
        64 * 1024,
      ),
      description: requireCheckpointReplayString(
        input.description,
        'intervention.description',
        4_096,
      ),
      ...(authorityChange === undefined ? {} : { authorityChange }),
      ...(input.beforeDigest === undefined
        ? {}
        : {
            beforeDigest: requireCheckpointReplayString(
              input.beforeDigest,
              'intervention.beforeDigest',
            ),
          }),
    },
    ...(body.childBranchId === undefined
      ? {}
      : {
          childBranchId: requireCheckpointReplayString(body.childBranchId, 'childBranchId'),
        }),
  };
}

function requireCheckpointReplayString(value: unknown, field: string, limit = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new AppHttpError(
      400,
      'INVALID_CHECKPOINT_REPLAY',
      `${field} must be a non-empty bounded string.`,
    );
  }
  return value.trim();
}

function requireExecutionForkBody(value: unknown): {
  readonly intervention: MissionExecutionForkRequestV1['intervention'];
  readonly stageId?: string;
  readonly childBranchId?: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppHttpError(400, 'INVALID_EXECUTION_FORK', 'Execution Fork body must be an object.');
  }
  const body = value as Record<string, unknown>;
  if (
    body.intervention === null ||
    typeof body.intervention !== 'object' ||
    Array.isArray(body.intervention)
  ) {
    throw new AppHttpError(400, 'INVALID_EXECUTION_FORK', 'intervention must be an object.');
  }
  const intervention = body.intervention as Record<string, unknown>;
  const kind = requireExecutionForkKind(intervention.kind);
  const authorityChange = requireExecutionForkAuthorityChange(intervention.authorityChange);
  return {
    intervention: {
      interventionId: requireExecutionForkString(
        intervention.interventionId,
        'intervention.interventionId',
      ),
      kind,
      targetRef: requireExecutionForkString(intervention.targetRef, 'intervention.targetRef'),
      ...(intervention.beforeDigest === undefined
        ? {}
        : {
            beforeDigest: requireExecutionForkString(
              intervention.beforeDigest,
              'intervention.beforeDigest',
            ),
          }),
      afterDigest: requireExecutionForkString(intervention.afterDigest, 'intervention.afterDigest'),
      description: requireExecutionForkString(
        intervention.description,
        'intervention.description',
        4_096,
      ),
      authorityChange,
    },
    ...(body.stageId === undefined
      ? {}
      : { stageId: requireExecutionForkString(body.stageId, 'stageId') }),
    ...(body.childBranchId === undefined
      ? {}
      : { childBranchId: requireExecutionForkString(body.childBranchId, 'childBranchId') }),
  };
}

function requireExecutionForkKind(
  value: unknown,
): MissionExecutionForkRequestV1['intervention']['kind'] {
  if (
    value !== 'context' &&
    value !== 'tool-result' &&
    value !== 'permission-narrowing' &&
    value !== 'profile' &&
    value !== 'workspace' &&
    value !== 'guidance'
  ) {
    throw new AppHttpError(400, 'INVALID_EXECUTION_FORK', 'intervention.kind is not supported.');
  }
  return value;
}

function requireExecutionForkAuthorityChange(
  value: unknown,
): MissionExecutionForkRequestV1['intervention']['authorityChange'] {
  if (value !== 'unchanged' && value !== 'narrowed') {
    throw new AppHttpError(
      400,
      'INVALID_EXECUTION_FORK',
      'intervention.authorityChange must be unchanged or narrowed.',
    );
  }
  return value;
}

function requireExecutionForkString(value: unknown, field: string, limit = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new AppHttpError(
      400,
      'INVALID_EXECUTION_FORK',
      `${field} must be a non-empty bounded string.`,
    );
  }
  return value.trim();
}

function requireExternalEffectBody(
  value: unknown,
): Omit<MissionExternalEffectRequestV1, 'effectId'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppHttpError(
      400,
      'INVALID_EXTERNAL_EFFECT',
      'External Effect body must be an object.',
    );
  }
  const body = value as Record<string, unknown>;
  const payload = requireJsonValue(body.payload, 'payload');
  return {
    attemptId: requireExternalEffectString(body.attemptId, 'attemptId'),
    targetId: requireExternalEffectString(body.targetId, 'targetId'),
    kind: requireExternalEffectString(body.kind, 'kind'),
    resourceKey: requireExternalEffectString(body.resourceKey, 'resourceKey'),
    authorityRef: requireExternalEffectString(body.authorityRef, 'authorityRef'),
    idempotencyKey: requireExternalEffectString(body.idempotencyKey, 'idempotencyKey'),
    payloadDigest: requireExternalEffectString(body.payloadDigest, 'payloadDigest'),
    payload,
    ...(body.compensatesEffectId === undefined
      ? {}
      : {
          compensatesEffectId: requireExternalEffectString(
            body.compensatesEffectId,
            'compensatesEffectId',
          ),
        }),
  };
}

function requireExternalEffectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_096) {
    throw new AppHttpError(
      400,
      'INVALID_EXTERNAL_EFFECT',
      `${field} must be a non-empty bounded string.`,
    );
  }
  return value.trim();
}

function requireJsonValue(value: unknown, field: string, depth = 0): JsonValue {
  if (depth > 50) {
    throw new AppHttpError(400, 'INVALID_EXTERNAL_EFFECT', `${field} is too deeply nested.`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((member) => requireJsonValue(member, field, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, member]) => [
        key,
        requireJsonValue(member, field, depth + 1),
      ]),
    );
  }
  throw new AppHttpError(400, 'INVALID_EXTERNAL_EFFECT', `${field} must be JSON-compatible.`);
}

function requireJsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppHttpError(400, 'INVALID_TOOL_DECISION', 'Tool decision body must be an object.');
  }
  return value as Record<string, unknown>;
}

function requireJsonString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppHttpError(400, 'INVALID_TOOL_DECISION', `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireJsonObject(
  value: unknown,
  field: string,
): { readonly [key: string]: import('./domain.js').JsonValue } {
  const record = requireJsonRecord(value);
  try {
    JSON.stringify(record);
  } catch {
    throw new AppHttpError(400, 'INVALID_TOOL_DECISION', `${field} must be JSON-compatible.`);
  }
  return record as { readonly [key: string]: import('./domain.js').JsonValue };
}

function requireToolDecision(value: unknown): 'approve' | 'reject' | 'modify' {
  if (value !== 'approve' && value !== 'reject' && value !== 'modify') {
    throw new AppHttpError(
      400,
      'INVALID_TOOL_DECISION',
      'decision must be approve, reject, or modify.',
    );
  }
  return value;
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
