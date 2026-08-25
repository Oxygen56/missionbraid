import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

import { CodexAdapter, type CodexSandbox } from './adapters/codex.js';
import { ClaudeAdapter, type ClaudePermissionMode } from './adapters/claude.js';
import { QoderAdapter, type QoderPermissionMode } from './adapters/qoder.js';
import type { RuntimeDetection, RuntimeOutputLine, RuntimeRunResult } from './adapters/types.js';
import {
  createCanonicalCapsule,
  extractAndValidateAcknowledgement,
  projectCanonicalCapsule,
  type CanonicalCapsuleV1,
} from './capsule.js';
import { deriveContextGraph, type ContextGraphV1 } from './context-graph.js';
import {
  createCompositeCheckpoint,
  type CheckpointInterventionV1,
  type CompositeCheckpointManifestV1,
} from './composite-checkpoint.js';
import {
  CheckpointReplayService,
  FileCheckpointReplayJournal,
  type CheckpointPlaybackResultV1,
  type CheckpointReplayRecordV1,
  type ModelOnlyResamplePortV1,
} from './checkpoint-replay.js';
import {
  cachedContextFromMission,
  cachedReplaySourceFromMission,
  confirmedEffectNoRepeatDecisions,
  replayKernelEvents,
  type MissionCheckpointReplayRequestV1,
} from './mission-checkpoint-replay.js';
import {
  ClaudeModelOnlyResamplePort,
  NativeArtifactReplayResolver,
} from './model-only-resample.js';
import { createClaudeToolGateBinding, type ClaudeToolGateBindingV1 } from './claude-tool-gate.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type ContractV1,
  type AdapterCapabilitiesV1,
  type AttemptBindingV1,
  type AttemptV1,
  type BranchV1,
  type EffectV1,
  type EventV1,
  type JsonValue,
  type MissionProjectionV1,
  type MissionV1,
  type MissionCommandActionV1,
  type MissionCommandV1,
  type ProfileV1,
  type ReceiptEffectResultV1,
  type ReceiptV1,
  type RuntimeCatalogObservationV1,
  type RuntimeProfileDefinitionV1,
  type StoredEventV1,
  type WorkspaceFenceV1,
} from './domain.js';
import {
  NativeArtifactStore,
  sanitizeNativeArtifact,
  type NativeArtifactContent,
} from './artifact-store.js';
import {
  PROVENANCE_SCHEMA_VERSION,
  type ProvenanceManifestV1,
  type ProvenanceStageV1,
  writeProvenanceManifest,
} from './provenance.js';
import {
  createMissionSpecSnapshot,
  loadMissionSpec,
  restoreMissionSpecSnapshot,
  type AttemptStageSpecV1,
  type MissionSpecV1,
  type SupportedHarnessV1,
} from './spec.js';
import { hashPayload, MissionStore } from './store.js';
import {
  nativeToolRequestName,
  nativeEventIdentityIds,
  nativeParentCorrelationIds,
  normalizeRuntimeOutput,
  resolveCooperativeHandoffOrdering,
  type RuntimeSourcePosition,
} from './runtime-events.js';
import { extractRuntimeSemanticFacts } from './runtime-semantics.js';
import {
  ExternalEffectCoordinator,
  type ExternalEffectEvent,
  type ExternalEffectOutcome,
  type ExternalEffectRequest,
  type QueryableEffectTarget,
} from './external-effect.js';
import {
  externalEffectEventToMissionEvents,
  rebuildExternalEffectStateFromMissionEvents,
} from './mission-external-effect.js';
import {
  ExecutionForkService,
  FileExecutionForkEvidenceJournal,
  projectExecutionFork,
  type ExecutionForkEvidenceJournalV1,
  type ExecutionForkEventDraftV1,
  type ExecutionForkEventV1,
  type ExecutionForkRecordV1,
} from './execution-fork.js';
import { executionForkEventToMissionEvents } from './mission-execution-fork.js';
import { NativeAdapterRuntimeContinuationPort } from './runtime-continuation.js';
import {
  EXECUTION_PLANNER_POLICY_VERSION,
  planExecution,
  type CandidateHandoffStateV1,
  type ExecutionPlannerInputV1,
  type FrozenMissionCapabilityRequirementsV1,
  type PlannerObservationV1,
  type PlannerProfileCandidateV1,
} from './execution-planner.js';
import { runCommandVerifier, type CommandVerificationResultV1 } from './verifier.js';
import {
  ToolGateway,
  type ToolDecisionIntentDraft,
  type ToolDecisionIntentV1,
  type ToolGateRequestV1,
} from './tool-gateway.js';
import {
  createStageWorkspaceDelta,
  snapshotGitWorkspace,
  type GitWorkspaceSnapshotV1,
  type StageWorkspaceDeltaV1,
} from './workspace.js';

const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;

export interface MissionEngineOptions {
  readonly stateDir: string;
  readonly codexAdapter?: CodexAdapter;
  readonly qoderAdapter?: QoderAdapter;
  readonly claudeAdapter?: ClaudeAdapter;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly externalEffectTargets?: readonly QueryableEffectTarget<JsonValue, JsonValue>[];
  readonly beforeExternalEffectAppend?: (
    event: ExternalEffectEvent<JsonValue>,
  ) => void | Promise<void>;
  readonly modelOnlyResamplePort?: ModelOnlyResamplePortV1;
}

export interface ExecuteMissionOptions {
  readonly workspace?: string;
  readonly signal?: AbortSignal;
}

export interface MissionExecutionResult {
  readonly missionId: string;
  readonly status: MissionProjectionV1['status'];
  readonly receipt?: ReceiptV1;
  readonly waitingReason?: string;
  readonly verificationResults?: readonly CommandVerificationResultV1[];
}

export interface MissionCreationResult {
  readonly missionId: string;
  readonly status: Extract<MissionProjectionV1['status'], 'pending'>;
}

export interface MissionStatusView {
  readonly mission: MissionProjectionV1;
  readonly chainValid: boolean;
  readonly eventCount: number;
  readonly activeProcess?: {
    readonly attemptId: string;
    readonly stageId: string;
    readonly harness: string;
    readonly pid: number;
  };
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly stageId: string;
    readonly harness: string;
    readonly status: 'running' | 'succeeded' | 'failed' | 'abandoned';
  }[];
}

export interface MissionToolGateView extends ToolGateRequestV1 {
  readonly controlLevel: 'enforced';
  readonly scope: 'branch_local_workspace' | 'shared_resource' | 'mission_global_external';
}

export interface MissionExternalEffectRequestV1 extends ExternalEffectRequest<JsonValue> {
  readonly attemptId: string;
}

export interface MissionExecutionPlannerOverrideRequestV1 {
  /** The immutable Mission plan stage whose Runtime Profile should be selected if fallback occurs. */
  readonly stageId: string;
  readonly reason: string;
}

export interface MissionExecutionPlannerOverrideV1 {
  readonly overrideId: string;
  readonly missionId: string;
  readonly stageId: string;
  readonly profileDefinitionId: string;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface MissionExecutionPlannerCandidateV1 {
  readonly stageId: string;
  readonly profileDefinition: RuntimeProfileDefinitionV1;
}

export interface MissionExecutionForkRequestV1 {
  readonly checkpointId: string;
  readonly intervention: CheckpointInterventionV1;
  /** I5 keeps the source Runtime Profile; I6 may explicitly select another eligible stage. */
  readonly stageId?: string;
  readonly childBranchId?: string;
}

export interface MissionExecutionForkResultV1 {
  readonly record: ExecutionForkRecordV1;
  readonly receipt: ReceiptV1;
}

export type MissionCheckpointReplayResultV1 = CheckpointPlaybackResultV1 | CheckpointReplayRecordV1;

export interface MissionTimelineEntry {
  readonly seq: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly category:
    | 'mission'
    | 'profile'
    | 'attempt'
    | 'checkpoint'
    | 'handoff'
    | 'effect'
    | 'verification'
    | 'receipt'
    | 'failure'
    | 'runtime';
  readonly kind: string;
  readonly label: string;
  readonly attemptId?: string;
  readonly harness?: string;
  readonly data?: JsonValue;
}

export interface RuntimeFailureObservation {
  readonly classification: 'observed';
  readonly layer: 'runtime-account';
  readonly code: 'CREDIT_LIMIT';
  readonly runtime: 'qoder';
  readonly providerCode: number;
}

interface SpecSnapshotProvenance {
  readonly sourceFile: string;
}

interface AttemptPlanRecord {
  readonly attemptId: string;
  readonly stageId: string;
  readonly harness: SupportedHarnessV1;
  readonly profileId: string;
  readonly branchId: string;
  readonly bindingId: string;
}

interface AttemptBaselineRecord {
  readonly attemptId: string;
  readonly stageId: string;
  readonly harness: SupportedHarnessV1;
  readonly profileId: string;
  readonly branchId: string;
  readonly bindingId: string;
  readonly snapshot: GitWorkspaceSnapshotV1;
}

interface CheckpointRecord {
  readonly checkpointId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly stageId: string;
  readonly harness: SupportedHarnessV1;
  readonly profileId: string;
  readonly branchId: string;
  readonly bindingId: string;
  readonly status: 'succeeded' | 'handed_off' | 'failed';
  readonly delta: StageWorkspaceDeltaV1;
  readonly origin?: 'runtime-completion' | 'controller-recovery';
}

interface ExecutionState {
  readonly plans: ReadonlyMap<string, AttemptPlanRecord>;
  readonly baselines: ReadonlyMap<string, AttemptBaselineRecord>;
  readonly finished: ReadonlyMap<string, 'succeeded' | 'failed' | 'abandoned'>;
  readonly checkpoints: readonly CheckpointRecord[];
  readonly doNotRepeatEffectIds: readonly string[];
  readonly effects: readonly ReceiptEffectResultV1[];
  readonly effectsByAttempt: ReadonlyMap<string, ReceiptEffectResultV1>;
  readonly handoffIds: readonly string[];
  readonly processByAttempt: ReadonlyMap<string, number>;
}

interface PlannedRuntimeCandidate {
  readonly stage: AttemptStageSpecV1;
  readonly detection: RuntimeDetection;
  readonly profile: ProfileV1;
}

interface PlannerTrigger {
  readonly code:
    | 'DECLARED_HANDOFF_FAILURE'
    | 'CREDIT_LIMIT'
    | 'RUNTIME_UNAVAILABLE'
    | 'CAPABILITY_REQUIREMENT_UNMET';
  readonly sourceStageId: string;
  readonly sourceProfileId: string;
  readonly detail: string;
}

type StageExecutionOutcome =
  | { readonly status: 'succeeded' }
  | { readonly status: 'waiting' }
  | {
      readonly status: 'handoff';
      readonly trigger: PlannerTrigger;
    };

export class MissionExecutionError extends Error {}

export class MissionEngine {
  readonly #stateDir: string;
  readonly #store: MissionStore;
  readonly #codex: CodexAdapter;
  readonly #qoder: QoderAdapter;
  readonly #claude: ClaudeAdapter;
  readonly #artifacts: NativeArtifactStore;
  readonly #externalEffectTargets: ReadonlyMap<string, QueryableEffectTarget<JsonValue, JsonValue>>;
  readonly #beforeExternalEffectAppend:
    | ((event: ExternalEffectEvent<JsonValue>) => void | Promise<void>)
    | undefined;
  readonly #modelOnlyResample: ModelOnlyResamplePortV1;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: MissionEngineOptions) {
    this.#stateDir = resolve(options.stateDir);
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#codex = options.codexAdapter ?? new CodexAdapter();
    this.#qoder = options.qoderAdapter ?? new QoderAdapter();
    this.#claude = options.claudeAdapter ?? new ClaudeAdapter();
    this.#artifacts = new NativeArtifactStore(this.#stateDir);
    this.#externalEffectTargets = indexExternalEffectTargets(options.externalEffectTargets ?? []);
    this.#beforeExternalEffectAppend = options.beforeExternalEffectAppend;
    this.#modelOnlyResample =
      options.modelOnlyResamplePort ??
      new ClaudeModelOnlyResamplePort({
        adapter: this.#claude,
        artifacts: this.#artifacts,
        sandboxDirectory: join(this.#stateDir, 'model-only-sandbox'),
        now: this.#now,
      });
    this.#store = new MissionStore(join(this.#stateDir, 'kernel.sqlite'), { now: this.#now });
  }

  close(): void {
    this.#store.close();
  }

  async run(
    missionFile: string,
    options: ExecuteMissionOptions = {},
  ): Promise<MissionExecutionResult> {
    const created = await this.create(
      missionFile,
      options.workspace === undefined ? {} : { workspace: options.workspace },
    );
    return await this.#submitAndExecute(created.missionId, 'resume', options.signal);
  }

  async create(
    missionFile: string,
    options: Omit<ExecuteMissionOptions, 'signal'> = {},
  ): Promise<MissionCreationResult> {
    await mkdir(this.#stateDir, { recursive: true });
    const spec = loadMissionSpec(
      missionFile,
      options.workspace === undefined ? {} : { workspace: options.workspace },
    );
    assertControlStateIsolation(this.#stateDir, spec.workspace);
    const specSnapshot = createMissionSpecSnapshot(spec);
    const missionId = `mission-${this.#id()}`;
    const rootBranchId = `branch-root-${this.#id()}`;
    const workspaceKey = `workspace-${hashPayload(spec.workspace).slice(0, 32)}`;
    const ownerId = `runner-${this.#id()}`;
    return await this.#withLease(workspaceKey, ownerId, async (fence) => {
      const contract = createContract(spec, this.#now());
      const detection = await this.#detect(spec.attemptPlan[0]?.profile.harness ?? 'codex');
      const profile = createProfile(spec.attemptPlan[0]!, detection, spec.workspace);
      const createdAt = this.#now().toISOString();
      const createdEvent: EventV1 = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: createdAt,
        type: 'mission.created',
        payload: {
          mission: {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            missionId,
            title: spec.title,
            workspaceKey,
            contractId: contract.contractId,
            initialProfileId: profile.profileId,
            rootBranchId,
            status: 'pending',
            createdAt,
          },
          contract,
          profile,
        },
      };
      const branchEvent: EventV1 = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: createdAt,
        type: 'branch.created',
        payload: {
          branch: {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            branchId: rootBranchId,
            missionId,
            status: 'active',
            createdAt,
          },
        },
      };
      const catalogEvent: EventV1 = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: detection.checkedAt,
        type: 'runtime.catalog_observed',
        payload: { observation: requireCatalogObservation(profile) },
      };
      const definitionEvents = uniqueProfileDefinitions(spec).map(
        (definition): EventV1 => ({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: createdAt,
          type: 'profile.definition_recorded',
          payload: { definition },
        }),
      );
      const specSnapshotEvent: EventV1 = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: this.#now().toISOString(),
        type: 'runtime.observation',
        payload: {
          kind: 'mission.spec_snapshot',
          data: {
            snapshot: specSnapshot,
            snapshotHash: hashPayload(specSnapshot),
            provenance: { sourceFile: spec.sourceFile },
          } as unknown as JsonValue,
        },
      };
      this.#store.appendEvents(
        [createdEvent, branchEvent, catalogEvent, ...definitionEvents, specSnapshotEvent],
        fence,
      );
      return { missionId, status: 'pending' };
    });
  }

  async resume(
    missionId: string,
    options: Omit<ExecuteMissionOptions, 'workspace'> = {},
  ): Promise<MissionExecutionResult> {
    return await this.#submitAndExecute(missionId, 'resume', options.signal);
  }

  async verify(
    missionId: string,
    options: Omit<ExecuteMissionOptions, 'workspace'> = {},
  ): Promise<MissionExecutionResult> {
    return await this.#submitAndExecute(missionId, 'verify', options.signal);
  }

  async #submitAndExecute(
    missionId: string,
    action: MissionCommandActionV1,
    signal?: AbortSignal,
  ): Promise<MissionExecutionResult> {
    this.#requireMission(missionId);
    const active = this.#store
      .listCommands(missionId)
      .find((command) => command.status === 'pending' || command.status === 'dispatching');
    if (active !== undefined && active.action !== action) {
      throw new MissionExecutionError(
        `Mission ${missionId} already has pending ${active.action} command ${active.commandId}`,
      );
    }
    const command =
      active ?? (await this.acceptCommand(missionId, action, `engine:${action}:${this.#id()}`));
    this.#store.claimCommand(command.commandId, `direct-${this.#id()}`);
    return await this.executeCommand(command.commandId, signal);
  }

  async acceptCommand(
    missionId: string,
    action: MissionCommandActionV1,
    idempotencyKey = `command-${this.#id()}`,
  ): Promise<MissionCommandV1> {
    const mission = this.#requireMission(missionId);
    const ownerId = `command-acceptor-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      const current = this.#requireMission(missionId);
      const commandId = `command-${this.#id()}`;
      return this.#store.acceptCommand(
        {
          commandId,
          eventId: `event-${this.#id()}`,
          missionId,
          action,
          idempotencyKey,
          expectedHeadHash: current.headHash,
          occurredAt: this.#now().toISOString(),
        },
        fence,
      );
    });
  }

  claimNextCommand(ownerId: string): MissionCommandV1 | undefined {
    return this.#store.claimNextCommand(ownerId);
  }

  claimCommand(commandId: string, ownerId: string): MissionCommandV1 {
    return this.#store.claimCommand(commandId, ownerId);
  }

  renewCommandClaim(commandId: string, ownerId: string): MissionCommandV1 {
    return this.#store.renewCommandClaim(commandId, ownerId);
  }

  command(commandId: string): MissionCommandV1 | undefined {
    return this.#store.getCommand(commandId);
  }

  commands(missionId?: string): MissionCommandV1[] {
    return this.#store.listCommands(missionId);
  }

  async artifact(artifactId: string): Promise<NativeArtifactContent | undefined> {
    return await this.#artifacts.get(artifactId);
  }

  async contextGraph(missionId: string): Promise<ContextGraphV1> {
    const timeline = this.timeline(missionId);
    const artifactIds = new Set<string>();
    for (const entry of timeline) {
      const data = isJsonObject(entry.data) ? entry.data : undefined;
      const artifact = isJsonObject(data?.nativeArtifact) ? data.nativeArtifact : undefined;
      if (typeof artifact?.artifactId === 'string') artifactIds.add(artifact.artifactId);
    }
    const nativeArtifacts = (
      await Promise.all(
        [...artifactIds].map(async (artifactId) => await this.#artifacts.get(artifactId)),
      )
    ).filter((artifact): artifact is NativeArtifactContent => artifact !== undefined);
    return deriveContextGraph({ timeline, nativeArtifacts });
  }

  compositeCheckpoints(missionId: string): readonly CompositeCheckpointManifestV1[] {
    this.#requireMission(missionId);
    return this.#store.listEvents(missionId).flatMap((event): CompositeCheckpointManifestV1[] => {
      if (
        event.type !== 'runtime.observation' ||
        event.payload.kind !== 'composite-checkpoint.created' ||
        !isJsonObject(event.payload.data) ||
        !isJsonObject(event.payload.data.manifest)
      ) {
        return [];
      }
      return [event.payload.data.manifest as unknown as CompositeCheckpointManifestV1];
    });
  }

  branches(missionId: string): readonly BranchV1[] {
    this.#requireMission(missionId);
    return this.#store.listBranches(missionId);
  }

  async createCompositeCheckpoint(
    missionId: string,
    requestedAttemptId?: string,
  ): Promise<CompositeCheckpointManifestV1> {
    const mission = this.#requireMission(missionId);
    const spec = this.#requireSpecSnapshot(missionId);
    const ownerId = `checkpoint-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      const events = this.#store.listEvents(missionId);
      const started = events.filter(
        (event): event is Extract<StoredEventV1, { type: 'attempt.started' }> =>
          event.type === 'attempt.started',
      );
      const startedEvent =
        requestedAttemptId === undefined
          ? [...started]
              .reverse()
              .find((candidate) =>
                events.some(
                  (event) =>
                    event.type === 'attempt.finished' &&
                    event.payload.attemptId === candidate.payload.attempt.attemptId,
                ),
              )
          : started.find((candidate) => candidate.payload.attempt.attemptId === requestedAttemptId);
      if (startedEvent === undefined) {
        throw new MissionExecutionError(
          requestedAttemptId === undefined
            ? `Mission ${missionId} has no finished Attempt to checkpoint`
            : `Attempt ${requestedAttemptId} does not belong to Mission ${missionId}`,
        );
      }
      const sourceAttempt = startedEvent.payload.attempt;
      const finishedEvent = events.find(
        (event): event is Extract<StoredEventV1, { type: 'attempt.finished' }> =>
          event.type === 'attempt.finished' && event.payload.attemptId === sourceAttempt.attemptId,
      );
      if (finishedEvent === undefined) {
        throw new MissionExecutionError(
          `Attempt ${sourceAttempt.attemptId} is still running and has no safe Checkpoint boundary`,
        );
      }
      const processStarted = events.find(
        (event) =>
          event.type === 'runtime.observation' &&
          event.payload.kind === 'runtime.process_started' &&
          event.attemptId === sourceAttempt.attemptId,
      );
      const processFinished = events.find(
        (event) =>
          event.type === 'runtime.observation' &&
          event.payload.kind === 'runtime.process_finished' &&
          event.attemptId === sourceAttempt.attemptId,
      );
      if (processStarted !== undefined && processFinished === undefined) {
        throw new MissionExecutionError(
          `Attempt ${sourceAttempt.attemptId} has no durable stopped-process evidence`,
        );
      }

      const createdEvent = events.find(
        (event): event is Extract<StoredEventV1, { type: 'mission.created' }> =>
          event.type === 'mission.created',
      );
      if (createdEvent === undefined) {
        throw new MissionExecutionError(`Mission ${missionId} has no creation event`);
      }
      const branch = this.#store.getBranch(missionId, sourceAttempt.branchId);
      if (branch === undefined) {
        throw new MissionExecutionError(
          `Branch ${sourceAttempt.branchId} is not persisted for Mission ${missionId}`,
        );
      }
      const profile = profileForAttempt(events, sourceAttempt, createdEvent.payload.profile);
      const workspace = snapshotGitWorkspace(spec.workspace);
      if (workspace.head === null || workspace.status.length > 0) {
        throw new MissionExecutionError(
          'Executable Fork requires a clean Git Checkpoint; commit or discard the current workspace delta first',
        );
      }
      const commit = gitObject(spec.workspace, 'HEAD^{commit}');
      const tree = gitObject(spec.workspace, `${commit}^{tree}`);
      const context = await this.contextGraph(missionId);
      const contextDigest = `sha256:${hashPayload(context)}`;
      const contextEvidenceRefs = uniqueStrings([
        `context-graph:${contextDigest}`,
        ...context.nodes.flatMap((node) => node.evidenceRefs),
      ]);
      const processStartedData = runtimeObservationData(processStarted);
      const processFinishedData = runtimeObservationData(processFinished);
      const projection = this.#requireMission(missionId);
      const attempt: AttemptV1 = {
        ...sourceAttempt,
        status: finishedEvent.payload.status,
        endedAt: finishedEvent.payload.endedAt,
      };
      const checkpoint = createCompositeCheckpoint({
        mission: createdEvent.payload.mission,
        branch,
        attempt,
        contract: projection.contract,
        profile,
        eventPrefix: {
          throughSeq: projection.lastSeq,
          headHash: projection.headHash,
          evidenceRefs: [`kernel-head:${projection.headHash}`],
        },
        visibleContext: {
          status: 'captured',
          contextDigest,
          artifactRefs: contextEvidenceRefs,
          evidenceRefs: contextEvidenceRefs,
        },
        workspace: {
          kind: 'restorable-artifact',
          workspaceKey: projection.workspaceKey,
          workspaceDigest: workspace.workspaceDigest,
          artifactRef: `git-commit:${commit}`,
          artifactDigest: `git-tree:${tree}`,
          evidenceRefs: [
            `git-commit:${commit}`,
            `git-tree:${tree}`,
            `workspace:${workspace.workspaceDigest}`,
          ],
        },
        permissions: {
          permissionMode: profile.permissionMode ?? 'unknown',
          evidenceRefs: [`profile:${profile.profileId}`],
        },
        effects: projectMissionEffects(events),
        process: {
          status: 'stopped',
          stoppedAt: finishedEvent.payload.endedAt,
          ...(typeof processStartedData?.pid === 'number'
            ? { processRef: `pid:${String(processStartedData.pid)}` }
            : {}),
          ...(typeof processFinishedData?.exitCode === 'number' ||
          processFinishedData?.exitCode === null
            ? { exitCode: processFinishedData.exitCode }
            : {}),
          evidenceRefs: [`event:${finishedEvent.eventId}`],
        },
        nativeSession: {
          status: 'unavailable',
          harness: profile.harness,
          reason:
            'The Adapter did not expose a resumable native session at this stopped boundary; the workspace and visible context remain reconstructable.',
          evidenceRefs: [`attempt:${sourceAttempt.attemptId}`],
        },
        capturedAt: this.#now().toISOString(),
      });
      this.#store.appendEvent(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-composite-checkpoint-${checkpoint.manifestHash.slice('sha256:'.length)}`,
          missionId,
          attemptId: sourceAttempt.attemptId,
          occurredAt: checkpoint.capturedAt,
          type: 'runtime.observation',
          payload: {
            kind: 'composite-checkpoint.created',
            data: {
              checkpointId: checkpoint.checkpointId,
              branchId: checkpoint.source.branchId,
              manifest: checkpoint as unknown as JsonValue,
            },
          },
        },
        fence,
      );
      return checkpoint;
    });
  }

  async executionForks(missionId: string): Promise<readonly ExecutionForkRecordV1[]> {
    this.#requireMission(missionId);
    const forkIds = uniqueStrings(
      this.#store.listEvents(missionId).flatMap((event) => {
        if (
          event.type !== 'runtime.observation' ||
          event.payload.kind !== 'execution-fork.transition' ||
          !isJsonObject(event.payload.data) ||
          typeof event.payload.data.forkId !== 'string'
        ) {
          return [];
        }
        return [event.payload.data.forkId];
      }),
    );
    const journal = new FileExecutionForkEvidenceJournal(join(this.#stateDir, 'execution-forks'));
    const records: ExecutionForkRecordV1[] = [];
    for (const forkId of forkIds) {
      const events = await journal.load(forkId);
      if (events.length === 0) {
        throw new MissionExecutionError(
          `Execution Fork ${forkId} is authoritative in the Mission Kernel but its evidence journal is unavailable`,
        );
      }
      records.push(projectExecutionFork(events));
    }
    return records;
  }

  async checkpointReplays(missionId: string): Promise<readonly CheckpointReplayRecordV1[]> {
    this.#requireMission(missionId);
    const directory = join(this.#stateDir, 'checkpoint-replays');
    if (!existsSync(directory)) return [];
    const service = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(directory),
      now: this.#now,
    });
    const records: CheckpointReplayRecordV1[] = [];
    for (const file of readdirSync(directory).sort()) {
      const match = file.match(/^(checkpoint-[A-Za-z0-9_-]+)\.jsonl$/);
      if (match?.[1] === undefined) continue;
      const record = await service.inspect(match[1]);
      if (record?.lineage.missionId === missionId) records.push(record);
    }
    return records.sort((left, right) => left.replayId.localeCompare(right.replayId));
  }

  async replayCheckpoint(
    missionId: string,
    checkpointId: string,
    request: MissionCheckpointReplayRequestV1,
  ): Promise<MissionCheckpointReplayResultV1> {
    const mission = this.#requireMission(missionId);
    const checkpoint = this.compositeCheckpoints(missionId).find(
      (candidate) => candidate.checkpointId === checkpointId,
    );
    if (checkpoint === undefined) {
      throw new MissionExecutionError(
        `Composite Checkpoint ${checkpointId} does not belong to Mission ${missionId}`,
      );
    }
    if (checkpoint.source.missionId !== missionId) {
      throw new MissionExecutionError('Checkpoint replay cannot cross Mission identity');
    }
    const events = this.#store.listEvents(missionId);
    const service = new CheckpointReplayService({
      journal: new FileCheckpointReplayJournal(join(this.#stateDir, 'checkpoint-replays')),
      now: this.#now,
    });
    if (request.mode === 'playback') {
      return await service.playback({
        mode: 'playback',
        checkpoint,
        history: events.filter((event) => event.seq <= checkpoint.eventPrefix.throughSeq),
      });
    }
    if (request.intervention === undefined) {
      throw new MissionExecutionError(`${request.mode} requires one declared Intervention`);
    }
    const replacement = await this.#artifacts.putLine(request.intervention.replacement);
    const intervention: CheckpointInterventionV1 = {
      interventionId: `intervention-replay-${this.#id()}`,
      kind: request.intervention.kind,
      targetRef: request.intervention.targetRef,
      ...(request.intervention.beforeDigest === undefined
        ? {}
        : { beforeDigest: request.intervention.beforeDigest }),
      afterDigest: `sha256:${replacement.sha256}`,
      description: request.intervention.description,
      authorityChange: request.intervention.authorityChange ?? 'unchanged',
    };
    const interventionArtifact = {
      artifactId: replacement.artifactId,
      contentDigest: intervention.afterDigest,
      fidelity: 'exact-replay-safe' as const,
      evidenceRefs: [`native-artifact:${replacement.artifactId}`],
      targetRef: intervention.targetRef,
    };
    const childBranchId = request.childBranchId ?? `branch-replay-${this.#id()}`;
    const childWorkspaceKey = `workspace-replay-${hashPayload({
      missionId,
      checkpointId,
      childBranchId,
      mode: request.mode,
    }).slice(0, 32)}`;
    const externalEffectDecisions = confirmedEffectNoRepeatDecisions(checkpoint);
    const resolver = new NativeArtifactReplayResolver(this.#artifacts);
    const record =
      request.mode === 'cached-replay'
        ? await service.cachedReplay(
            {
              mode: 'cached-replay',
              checkpoint,
              childBranchId,
              childWorkspaceKey,
              intervention,
              interventionArtifact,
              externalEffectDecisions,
              sourceFuture: cachedReplaySourceFromMission(checkpoint, events),
            },
            resolver,
          )
        : await service.counterfactualResample(
            {
              mode: 'counterfactual-resample',
              checkpoint,
              childBranchId,
              childWorkspaceKey,
              intervention,
              interventionArtifact,
              externalEffectDecisions,
              cachedContext: cachedContextFromMission(checkpoint, events),
            },
            resolver,
            this.#modelOnlyResample,
          );
    await this.#persistCheckpointReplay(record);
    return record;
  }

  async #persistCheckpointReplay(record: CheckpointReplayRecordV1): Promise<void> {
    const mission = this.#requireMission(record.lineage.missionId);
    const ownerId = `checkpoint-replay-${this.#id()}`;
    await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      const events = this.#store.listEvents(mission.missionId);
      const alreadyRecorded = events.some(
        (event) =>
          event.type === 'runtime.observation' &&
          event.payload.kind === 'checkpoint-replay.recorded' &&
          isJsonObject(event.payload.data) &&
          event.payload.data.replayId === record.replayId &&
          event.payload.data.phase === record.phase,
      );
      if (alreadyRecorded) return;
      const childBranchId =
        record.lineage.mode === 'playback' ? undefined : record.lineage.childBranchId;
      const includeBranch =
        childBranchId !== undefined &&
        this.#store.getBranch(mission.missionId, childBranchId) === undefined;
      this.#store.appendEvents(
        replayKernelEvents(record, this.#now().toISOString(), includeBranch),
        fence,
      );
    });
  }

  async executeFork(
    missionId: string,
    request: MissionExecutionForkRequestV1,
    signal?: AbortSignal,
  ): Promise<MissionExecutionForkResultV1> {
    const mission = this.#requireMission(missionId);
    const spec = this.#requireSpecSnapshot(missionId);
    assertControlStateIsolation(this.#stateDir, spec.workspace);
    const events = this.#store.listEvents(missionId);
    const checkpoint = this.compositeCheckpoints(missionId).find(
      (candidate) => candidate.checkpointId === request.checkpointId,
    );
    if (checkpoint === undefined) {
      throw new MissionExecutionError(
        `Composite Checkpoint ${request.checkpointId} does not belong to Mission ${missionId}`,
      );
    }
    if (
      checkpoint.source.missionId !== missionId ||
      checkpoint.source.contractId !== mission.contract.contractId
    ) {
      throw new MissionExecutionError(
        'Execution Fork Checkpoint is bound to another Mission state',
      );
    }

    const created = events.find(
      (event): event is Extract<StoredEventV1, { type: 'mission.created' }> =>
        event.type === 'mission.created',
    );
    const sourceAttemptEvent = events.find(
      (event): event is Extract<StoredEventV1, { type: 'attempt.started' }> =>
        event.type === 'attempt.started' &&
        event.payload.attempt.attemptId === checkpoint.source.attemptId,
    );
    if (created === undefined || sourceAttemptEvent === undefined) {
      throw new MissionExecutionError('Execution Fork source identities are not persisted');
    }
    const sourceAttempt = sourceAttemptEvent.payload.attempt;
    const sourceProfile = profileForAttempt(events, sourceAttempt, created.payload.profile);
    if (sourceProfile.profileId !== checkpoint.source.profileId) {
      throw new MissionExecutionError(
        'Execution Fork Checkpoint Profile no longer matches its source Attempt',
      );
    }
    const sourceStageId = sourceAttempt.stageId;
    const stageId = request.stageId ?? sourceStageId;
    const stage = spec.attemptPlan.find((candidate) => candidate.stageId === stageId);
    if (stage === undefined || !stageMatchesProfile(stage, sourceProfile)) {
      throw new MissionExecutionError(
        'This iteration executes a Fork with the immutable source Runtime Profile; a different Profile requires an eligible Planner decision',
      );
    }

    const childBranchId = request.childBranchId ?? `branch-fork-${this.#id()}`;
    if (this.#store.getBranch(missionId, childBranchId) !== undefined) {
      throw new MissionExecutionError(`Branch ${childBranchId} already exists`);
    }
    const identityDigest = hashPayload({
      missionId,
      checkpointId: checkpoint.checkpointId,
      childBranchId,
      intervention: request.intervention,
    });
    const worktreeParent = join(this.#stateDir, 'worktrees', missionId);
    await mkdir(worktreeParent, { recursive: true });
    const worktreeId = `worktree-${identityDigest.slice(0, 32)}`;
    const childWorkspaceKey = `workspace-fork-${identityDigest.slice(0, 32)}`;
    const isolatedWorktreePath = join(worktreeParent, worktreeId);
    const gitBranchName = `missionbraid/fork-${identityDigest.slice(0, 24)}`;
    const externalEffectDecisions = checkpoint.externalEffectFrontier
      .filter((effect) => effect.status === 'confirmed')
      .map((effect) => ({ effectId: effect.effectId, action: 'inherit-no-repeat' as const }));
    const bindingBoundAt = this.#now().toISOString();
    const ownerId = `execution-fork-${this.#id()}`;

    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      await this.#writeProvenanceProjection(missionId);
      const fileJournal = new FileExecutionForkEvidenceJournal(
        join(this.#stateDir, 'execution-forks'),
      );
      const mirroredJournal: ExecutionForkEvidenceJournalV1 = {
        append: async (draft: ExecutionForkEventDraftV1): Promise<ExecutionForkEventV1> => {
          const sourceEvent = await fileJournal.append(draft);
          const childAttemptId = `fork-attempt-${sourceEvent.forkId}`;
          const binding: AttemptBindingV1 = {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            bindingId: `fork-binding-${sourceEvent.forkId}`,
            missionId,
            attemptId: childAttemptId,
            branchId: childBranchId,
            contractId: mission.contract.contractId,
            profileId: sourceProfile.profileId,
            workspaceKey: childWorkspaceKey,
            planNodeId: stage.stageId,
            authority: 'workspace',
            injectionBudgetTokens: stage.profile.injectionBudgetTokens,
            boundAt: bindingBoundAt,
          };
          const kernelEvents = [
            ...executionForkEventToMissionEvents(
              sourceEvent,
              { missionId, childAttemptId, binding, occurredAt: sourceEvent.occurredAt },
              this.#store.listEvents(missionId),
            ),
          ];
          if (sourceEvent.type === 'fork.planned') {
            kernelEvents.push({
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              eventId: `event-fork-plan-${hashPayload({ sourceEventId: sourceEvent.eventId, binding })}`,
              missionId,
              attemptId: childAttemptId,
              occurredAt: sourceEvent.occurredAt,
              type: 'runtime.observation',
              payload: {
                kind: 'attempt.plan',
                data: {
                  attemptId: childAttemptId,
                  stageId: stage.stageId,
                  harness: stage.profile.harness,
                  profileId: sourceProfile.profileId,
                  branchId: childBranchId,
                  bindingId: binding.bindingId,
                  checkpointId: checkpoint.checkpointId,
                  operation: 'execution-fork',
                },
              },
            });
          }
          this.#store.appendEvents(kernelEvents, fence);
          return sourceEvent;
        },
        load: async (forkId: string) => await fileJournal.load(forkId),
      };
      const service = new ExecutionForkService({ journal: mirroredJournal, now: this.#now });
      const runtime = new NativeAdapterRuntimeContinuationPort({
        missionId,
        acceptedContract: mission.contract,
        acceptedMissionSpec: spec,
        acceptedStage: stage,
        acceptedCheckpoint: {
          checkpointId: checkpoint.checkpointId,
          missionId,
          contractId: checkpoint.source.contractId,
          profileId: checkpoint.source.profileId,
        },
        acceptedProfile: sourceProfile,
        acceptedIntervention: request.intervention,
        controllerStateDir: this.#stateDir,
        provenanceFile: this.#provenanceFile(missionId),
        adapters: { codex: this.#codex, qoder: this.#qoder, claude: this.#claude },
        ...(signal === undefined ? {} : { signal }),
      });
      const record = await service.execute(
        {
          mode: 'execution-fork',
          checkpoint,
          repositoryRoot: spec.workspace,
          childBranchId,
          gitBranchName,
          worktreeId,
          childWorkspaceKey,
          isolatedWorktreePath,
          intervention: request.intervention,
          externalEffectDecisions,
        },
        runtime,
      );
      const receipt = await this.#issueExecutionForkReceipt(
        missionId,
        childBranchId,
        spec,
        record,
        fence,
      );
      return { record, receipt };
    });
  }

  async pendingToolGates(missionId: string): Promise<readonly MissionToolGateView[]> {
    this.#requireMission(missionId);
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    const requests = await Promise.all(
      [...state.plans.values()].map(async (plan) => {
        const gateway = this.#toolGateway(missionId, plan.attemptId);
        return await gateway.listPending();
      }),
    );
    return requests.flat().map((request) => ({
      ...request,
      controlLevel: 'enforced',
      scope: toolEffectScope(request.toolName),
    }));
  }

  async decideToolGate(
    missionId: string,
    attemptId: string,
    draft: ToolDecisionIntentDraft,
  ): Promise<ToolDecisionIntentV1> {
    this.#requireMission(missionId);
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    if (!state.plans.has(attemptId)) {
      throw new MissionExecutionError(
        `Attempt ${attemptId} does not belong to Mission ${missionId}`,
      );
    }
    return await this.#toolGateway(missionId, attemptId).writeDecisionIntent(draft);
  }

  executionPlannerOverride(missionId: string): MissionExecutionPlannerOverrideV1 | undefined {
    this.#requireMission(missionId);
    return activeExecutionPlannerOverride(this.#store.listEvents(missionId));
  }

  executionPlannerCandidates(missionId: string): readonly MissionExecutionPlannerCandidateV1[] {
    this.#requireMission(missionId);
    return this.#requireSpecSnapshot(missionId).attemptPlan.map((stage) => ({
      stageId: stage.stageId,
      profileDefinition: profileDefinition(stage),
    }));
  }

  async setExecutionPlannerOverride(
    missionId: string,
    request: MissionExecutionPlannerOverrideRequestV1,
  ): Promise<MissionExecutionPlannerOverrideV1> {
    const mission = this.#requireMission(missionId);
    const stageId = request.stageId.trim();
    const reason = request.reason.trim();
    if (stageId.length === 0 || reason.length === 0) {
      throw new TypeError('Execution Planner override stageId and reason must not be empty');
    }
    const spec = this.#requireSpecSnapshot(missionId);
    const stage = spec.attemptPlan.find((candidate) => candidate.stageId === stageId);
    if (stage === undefined) {
      throw new MissionExecutionError(
        `Execution Planner override stage ${stageId} is not declared`,
      );
    }
    const override: MissionExecutionPlannerOverrideV1 = {
      overrideId: `planner-override-${this.#id()}`,
      missionId,
      stageId,
      profileDefinitionId: profileDefinition(stage).definitionId,
      reason,
      recordedAt: this.#now().toISOString(),
    };
    const ownerId = `planner-override-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      this.#observe(
        missionId,
        'execution-planner.manual_override_set',
        override as unknown as JsonValue,
        fence,
      );
      return override;
    });
  }

  async clearExecutionPlannerOverride(missionId: string, reason: string): Promise<void> {
    const mission = this.#requireMission(missionId);
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      throw new TypeError('Execution Planner override clear reason must not be empty');
    }
    const active = this.executionPlannerOverride(missionId);
    if (active === undefined) return;
    const ownerId = `planner-override-clear-${this.#id()}`;
    await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      this.#observe(
        missionId,
        'execution-planner.manual_override_cleared',
        {
          overrideId: active.overrideId,
          reason: normalizedReason,
          clearedAt: this.#now().toISOString(),
        },
        fence,
      );
    });
  }

  async coordinateExternalEffect(
    missionId: string,
    input: MissionExternalEffectRequestV1,
  ): Promise<ExternalEffectOutcome<JsonValue>> {
    const mission = this.#requireMission(missionId);
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    if (!state.plans.has(input.attemptId)) {
      throw new MissionExecutionError(
        `Attempt ${input.attemptId} does not belong to Mission ${missionId}`,
      );
    }
    const target = this.#externalEffectTargets.get(input.targetId);
    if (target === undefined) {
      throw new MissionExecutionError(`External Effect target ${input.targetId} is not registered`);
    }
    const request: ExternalEffectRequest<JsonValue> = {
      effectId: input.effectId,
      targetId: input.targetId,
      kind: input.kind,
      resourceKey: input.resourceKey,
      authorityRef: input.authorityRef,
      idempotencyKey: input.idempotencyKey,
      payloadDigest: input.payloadDigest,
      payload: input.payload,
      ...(input.compensatesEffectId === undefined
        ? {}
        : { compensatesEffectId: input.compensatesEffectId }),
    };
    const ownerId = `external-effect-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      const existingEvents = this.#store.listEvents(missionId);
      const persisted = rebuildExternalEffectStateFromMissionEvents(existingEvents, input.effectId);
      if (
        persisted === undefined &&
        existingEvents.some(
          (event) =>
            event.type === 'effect.recorded' && event.payload.effect.effectId === input.effectId,
        )
      ) {
        throw new MissionExecutionError(
          `Effect ${input.effectId} already exists outside the external Effect coordinator`,
        );
      }
      const coordinator = new ExternalEffectCoordinator(target, {
        append: async (event) => {
          await this.#beforeExternalEffectAppend?.(event);
          this.#store.appendEvents(
            externalEffectEventToMissionEvents(event, {
              missionId,
              attemptId: input.attemptId,
              occurredAt: this.#now().toISOString(),
            }),
            fence,
          );
        },
      });
      return await coordinator.coordinate(request, persisted);
    });
  }

  async executeCommand(commandId: string, signal?: AbortSignal): Promise<MissionExecutionResult> {
    const command = this.#store.getCommand(commandId);
    if (command === undefined) throw new MissionExecutionError(`Unknown command ${commandId}`);
    if (command.status === 'completed') {
      const mission = this.#requireMission(command.missionId);
      return {
        missionId: command.missionId,
        status: mission.status,
        ...(mission.receipt === undefined ? {} : { receipt: mission.receipt }),
      };
    }
    if (command.status !== 'dispatching') {
      throw new MissionExecutionError(`Command ${commandId} is not claimed for dispatch`);
    }
    const mission = this.#requireMission(command.missionId);
    const spec = this.#requireSpecSnapshot(command.missionId);
    assertControlStateIsolation(this.#stateDir, spec.workspace);
    const ownerId = `command-runner-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      this.#store.recordCommandStatus(commandId, 'dispatching', `event-${this.#id()}`, fence);
      try {
        const result =
          command.action === 'resume'
            ? await (async () => {
                await this.#closeDanglingAttempts(command.missionId, spec, fence);
                return await this.#execute(command.missionId, spec, fence, signal);
              })()
            : await this.#verifyAndReceipt(command.missionId, spec, fence, signal);
        if (signal?.aborted === true) {
          this.#store.recordCommandStatus(
            commandId,
            'pending',
            `event-${this.#id()}`,
            fence,
            'Controller stopped after preserving the current Attempt evidence',
          );
          return result;
        }
        this.#store.recordCommandStatus(
          commandId,
          'completed',
          `event-${this.#id()}`,
          fence,
          `Mission ${result.status}`,
        );
        return result;
      } catch (error) {
        this.#store.recordCommandStatus(
          commandId,
          signal?.aborted === true ? 'pending' : 'failed',
          `event-${this.#id()}`,
          fence,
          error instanceof MissionExecutionError
            ? error.message
            : `Execution failed with ${error instanceof Error ? error.name : 'unknown error'}`,
        );
        throw error;
      }
    });
  }

  status(missionId: string): MissionStatusView {
    const mission = this.#requireMission(missionId);
    const events = this.#store.listEvents(missionId);
    const state = reconstructExecutionState(events);
    const attempts = [...state.plans.values()].map((plan) => ({
      attemptId: plan.attemptId,
      stageId: plan.stageId,
      harness: plan.harness,
      status: state.finished.get(plan.attemptId) ?? ('running' as const),
    }));
    const active = attempts.find((attempt) => attempt.status === 'running');
    const pid = active === undefined ? undefined : state.processByAttempt.get(active.attemptId);
    const chain = this.#store.verifyEventChain(missionId);
    return {
      mission,
      chainValid: chain.valid,
      eventCount: events.length,
      ...(active === undefined || pid === undefined
        ? {}
        : {
            activeProcess: {
              attemptId: active.attemptId,
              stageId: active.stageId,
              harness: active.harness,
              pid,
            },
          }),
      attempts,
    };
  }

  list(): MissionProjectionV1[] {
    return this.#store.listMissions();
  }

  timeline(missionId: string): MissionTimelineEntry[] {
    this.#requireMission(missionId);
    const events = this.#store.listEvents(missionId);
    const state = reconstructExecutionState(events);
    const harnessByAttempt = new Map(
      [...state.plans.values()].map((plan) => [plan.attemptId, plan.harness]),
    );
    return events.flatMap((event) => {
      const entry = timelineEntry(event, harnessByAttempt.get(event.attemptId ?? ''));
      return entry === undefined ? [] : [entry];
    });
  }

  async #execute(
    missionId: string,
    spec: MissionSpecV1,
    fence: WorkspaceFenceV1,
    signal?: AbortSignal,
  ): Promise<MissionExecutionResult> {
    const existing = this.#requireMission(missionId);
    if (existing.status === 'succeeded') {
      return {
        missionId,
        status: 'succeeded',
        ...(existing.receipt ? { receipt: existing.receipt } : {}),
      };
    }

    const persistedState = reconstructExecutionState(this.#store.listEvents(missionId));
    let index = nextStageIndex(spec, persistedState);
    let selected: PlannedRuntimeCandidate | undefined;
    const persistedBoundary = persistedState.checkpoints.at(-1);
    if (
      persistedBoundary?.status === 'handed_off' &&
      index < spec.attemptPlan.length &&
      persistedBoundary.stageId !== spec.attemptPlan[index]?.stageId
    ) {
      const sourceStage = spec.attemptPlan.find(
        (candidate) => candidate.stageId === persistedBoundary.stageId,
      );
      if (sourceStage === undefined) {
        throw new MissionExecutionError(
          `Persisted Handoff source ${persistedBoundary.stageId} is absent from the Mission plan`,
        );
      }
      selected = await this.#planHandoff(
        missionId,
        spec,
        sourceStage,
        index,
        {
          code: 'DECLARED_HANDOFF_FAILURE',
          sourceStageId: persistedBoundary.stageId,
          sourceProfileId: persistedBoundary.profileId,
          detail: 'Resume from a persisted handed-off Checkpoint frontier',
        },
        fence,
      );
      if (selected === undefined) {
        const reason = 'No eligible Runtime Profile remains for the persisted Handoff frontier';
        this.#setWaiting(missionId, reason, fence);
        return { missionId, status: 'waiting', waitingReason: reason };
      }
      index = spec.attemptPlan.indexOf(selected.stage);
    }
    while (index < spec.attemptPlan.length) {
      const stage = selected?.stage ?? spec.attemptPlan[index]!;
      const result = await this.#executeStage(missionId, spec, stage, fence, signal, selected);
      selected = undefined;
      if (result.status === 'succeeded') {
        return await this.#verifyAndReceipt(missionId, spec, fence, signal);
      }
      if (result.status === 'waiting') {
        const projection = this.#requireMission(missionId);
        const waitingReason = latestWaitingReason(this.#store.listEvents(missionId));
        return {
          missionId,
          status: projection.status,
          ...(waitingReason === undefined ? {} : { waitingReason }),
        };
      }
      const planned = await this.#planHandoff(
        missionId,
        spec,
        stage,
        index + 1,
        result.trigger,
        fence,
      );
      if (planned === undefined) {
        const reason = `No eligible Runtime Profile remains after ${result.trigger.code}`;
        this.#setWaiting(missionId, reason, fence);
        return { missionId, status: 'waiting', waitingReason: reason };
      }
      selected = planned;
      index = spec.attemptPlan.indexOf(planned.stage);
    }
    return await this.#verifyAndReceipt(missionId, spec, fence, signal);
  }

  async #planHandoff(
    missionId: string,
    spec: MissionSpecV1,
    sourceStage: AttemptStageSpecV1,
    nextCandidateIndex: number,
    trigger: PlannerTrigger,
    fence: WorkspaceFenceV1,
  ): Promise<PlannedRuntimeCandidate | undefined> {
    const mission = this.#requireMission(missionId);
    const candidateStages = spec.attemptPlan.slice(nextCandidateIndex);
    const candidates = await Promise.all(
      candidateStages.map(async (stage): Promise<PlannedRuntimeCandidate> => {
        const detection = await this.#detect(stage.profile.harness);
        return {
          stage,
          detection,
          profile: createProfile(stage, detection, spec.workspace),
        };
      }),
    );
    const missionEvents = this.#store.listEvents(missionId);
    const state = reconstructExecutionState(missionEvents);
    const manualOverride = activeExecutionPlannerOverride(missionEvents);
    const overrideCandidate =
      manualOverride === undefined
        ? undefined
        : candidates.find(
            (candidate) =>
              candidate.stage.stageId === manualOverride.stageId &&
              profileDefinition(candidate.stage).definitionId ===
                manualOverride.profileDefinitionId,
          );
    const sourceFrontier = state.checkpoints.at(-1);
    let sourceComposite =
      sourceFrontier === undefined
        ? undefined
        : [...this.compositeCheckpoints(missionId)]
            .reverse()
            .find((candidate) => candidate.source.attemptId === sourceFrontier.attemptId);
    if (sourceFrontier?.status === 'handed_off') {
      sourceComposite = await this.#persistHandoffCompositeCheckpoint(
        missionId,
        spec,
        sourceFrontier,
        snapshotGitWorkspace(spec.workspace),
        fence,
      );
    }
    const requirements = plannerRequirements(missionId, mission.contract, sourceStage, candidates);
    const handoffStates = plannerHandoffStates(sourceComposite, mission.contract, sourceFrontier);
    const plannerCandidates = candidates.map(
      (candidate): PlannerProfileCandidateV1 => ({
        profile: candidate.profile,
        observation: plannerObservation(candidate),
        handoffStates,
        wouldRepeatEffectIds: [],
      }),
    );
    const plannerInput: ExecutionPlannerInputV1 = {
      policyVersion: EXECUTION_PLANNER_POLICY_VERSION,
      requirements,
      candidates: plannerCandidates,
      ...(state.checkpoints.length === 0 ? {} : { currentProfileId: trigger.sourceProfileId }),
      effectFrontier: state.effects.map((effect) => ({
        effectId: effect.effectId,
        status: effect.status,
      })),
      ...(manualOverride === undefined
        ? {}
        : {
            manualOverride: {
              profileId:
                overrideCandidate?.profile.profileId ??
                `profile-override-unresolved-${hashPayload({
                  overrideId: manualOverride.overrideId,
                  stageId: manualOverride.stageId,
                  profileDefinitionId: manualOverride.profileDefinitionId,
                }).slice(0, 28)}`,
              reason: manualOverride.reason,
            },
          }),
    };
    const decision = planExecution(plannerInput);
    const events: EventV1[] = candidates.map((candidate) => ({
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      eventId: `event-${this.#id()}`,
      missionId,
      occurredAt: candidate.detection.checkedAt,
      type: 'runtime.catalog_observed',
      payload: { observation: requireCatalogObservation(candidate.profile) },
    }));
    events.push(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: this.#now().toISOString(),
        type: 'runtime.observation',
        payload: {
          kind: 'execution-planner.requirements_frozen',
          data: {
            requirements: requirements as unknown as JsonValue,
            derivationSource: 'accepted-stage-profile-and-adapter-needs',
            trigger: trigger as unknown as JsonValue,
            sourceCompositeCheckpointId: sourceComposite?.checkpointId ?? null,
          },
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: this.#now().toISOString(),
        type: 'runtime.observation',
        payload: {
          kind: 'execution-planner.decision',
          data: {
            trigger: trigger as unknown as JsonValue,
            plannerInput: plannerInput as unknown as JsonValue,
            decision: decision as unknown as JsonValue,
            policyVersion: EXECUTION_PLANNER_POLICY_VERSION,
            decisionHash: decision.decisionHash,
            manualOverrideRequest:
              manualOverride === undefined ? null : (manualOverride as unknown as JsonValue),
            sourceCompositeCheckpoint:
              sourceComposite === undefined
                ? null
                : {
                    checkpointId: sourceComposite.checkpointId,
                    manifestHash: sourceComposite.manifestHash,
                    source: sourceComposite.source as unknown as JsonValue,
                    eventPrefix: sourceComposite.eventPrefix as unknown as JsonValue,
                    workspace: sourceComposite.workspace as unknown as JsonValue,
                    components: sourceComposite.components.map((component) => ({
                      component: component.component,
                      disposition: component.disposition,
                      contentDigest: component.contentDigest,
                    })),
                  },
          },
        },
      },
    );
    const selected =
      decision.binding.selectedProfileId === null
        ? undefined
        : candidates.find(
            (candidate) => candidate.profile.profileId === decision.binding.selectedProfileId,
          );
    if (selected !== undefined) {
      events.push({
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: this.#now().toISOString(),
        type: 'profile.selected',
        payload: {
          profile: selected.profile,
          reason: `Deterministic planner ${decision.decisionHash} after ${trigger.code}`,
        },
      });
    }
    this.#store.appendEvents(events, fence);
    return selected;
  }

  async #executeStage(
    missionId: string,
    spec: MissionSpecV1,
    stage: AttemptStageSpecV1,
    fence: WorkspaceFenceV1,
    signal?: AbortSignal,
    planned?: PlannedRuntimeCandidate,
  ): Promise<StageExecutionOutcome> {
    const detection = planned?.detection ?? (await this.#detect(stage.profile.harness));
    const profile = planned?.profile ?? createProfile(stage, detection, spec.workspace);
    if (planned === undefined) {
      this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: detection.checkedAt,
          type: 'runtime.catalog_observed',
          payload: { observation: requireCatalogObservation(profile) },
        },
        fence,
      );
    }
    if (!detection.available || !detection.responsive || detection.status !== 'ready') {
      const detail = detection.available
        ? `Runtime ${stage.profile.harness} is installed but unavailable`
        : `Runtime ${stage.profile.harness} is not installed`;
      if (stage.onFailure === 'handoff') {
        return {
          status: 'handoff',
          trigger: {
            code: 'RUNTIME_UNAVAILABLE',
            sourceStageId: stage.stageId,
            sourceProfileId: profile.profileId,
            detail,
          },
        };
      }
      this.#setWaiting(missionId, detail, fence);
      return { status: 'waiting' };
    }

    const mission = this.#requireMission(missionId);
    const branchId = requireRootBranch(mission);
    if (mission.activeProfile.profileId !== profile.profileId) {
      this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: this.#now().toISOString(),
          type: 'profile.selected',
          payload: { profile, reason: `Mission attempt plan stage ${stage.stageId}` },
        },
        fence,
      );
    }

    const stateBefore = reconstructExecutionState(this.#store.listEvents(missionId));
    const previousCheckpoint = stateBefore.checkpoints.at(-1);
    const previousComposite =
      previousCheckpoint === undefined
        ? undefined
        : [...this.compositeCheckpoints(missionId)]
            .reverse()
            .find((candidate) => candidate.source.attemptId === previousCheckpoint.attemptId);
    const before = snapshotGitWorkspace(spec.workspace);
    if (
      previousCheckpoint !== undefined &&
      before.workspaceDigest !== previousCheckpoint.delta.afterWorkspaceDigest
    ) {
      this.#observe(
        missionId,
        'failure.observed',
        {
          classification: 'observed',
          layer: 'workspace-continuity',
          code: 'WORKSPACE_DIVERGED',
          checkpointId: previousCheckpoint.checkpointId,
          expectedWorkspaceDigest: previousCheckpoint.delta.afterWorkspaceDigest,
          observedWorkspaceDigest: before.workspaceDigest,
        },
        fence,
      );
      this.#setWaiting(missionId, 'Workspace diverged after the latest checkpoint', fence);
      return { status: 'waiting' };
    }
    const attemptId = `attempt-${this.#id()}`;
    const bindingId = `binding-${this.#id()}`;
    const effectId = `effect-${attemptId}`;
    const plan: AttemptPlanRecord = {
      attemptId,
      stageId: stage.stageId,
      harness: stage.profile.harness,
      profileId: profile.profileId,
      branchId,
      bindingId,
    };

    let capsule: CanonicalCapsuleV1 | undefined;
    let projectedCapsuleText: string | undefined;
    let preparedHandoff: JsonValue | undefined;
    if (previousCheckpoint !== undefined) {
      if (previousCheckpoint.status === 'handed_off' && previousComposite === undefined) {
        this.#setWaiting(
          missionId,
          'The Handoff frontier has no complete Composite Checkpoint manifest',
          fence,
        );
        return { status: 'waiting' };
      }
      if (
        previousComposite !== undefined &&
        (previousComposite.source.missionId !== missionId ||
          previousComposite.source.branchId !== branchId ||
          previousComposite.source.attemptId !== previousCheckpoint.attemptId ||
          previousComposite.source.contractId !== mission.contract.contractId ||
          previousComposite.source.profileId !== previousCheckpoint.profileId ||
          previousComposite.workspace.workspaceDigest !==
            previousCheckpoint.delta.afterWorkspaceDigest)
      ) {
        this.#setWaiting(
          missionId,
          'The Composite Checkpoint no longer matches the persisted Handoff frontier',
          fence,
        );
        return { status: 'waiting' };
      }
      const capsuleCheckpointId =
        previousComposite?.checkpointId ?? previousCheckpoint.checkpointId;
      const capsuleWorkspaceDigest =
        previousComposite?.workspace.workspaceDigest ??
        previousCheckpoint.delta.afterWorkspaceDigest;
      if (capsuleWorkspaceDigest === null) {
        this.#setWaiting(missionId, 'The Handoff Checkpoint has no workspace frontier', fence);
        return { status: 'waiting' };
      }
      capsule = createCanonicalCapsule({
        missionId,
        branchId,
        contractId: mission.contract.contractId,
        contractSummary: mission.contract.objective,
        constraints: spec.constraints,
        source: {
          attemptId: previousCheckpoint.attemptId,
          stageId: previousCheckpoint.stageId,
          profileId: previousCheckpoint.profileId,
          bindingId: previousCheckpoint.bindingId,
        },
        target: { attemptId, stageId: stage.stageId, profileId: profile.profileId, bindingId },
        checkpoint: {
          checkpointId: capsuleCheckpointId,
          workspaceDigest: capsuleWorkspaceDigest,
        },
        remainingCriteria: mission.contract.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          summary: criterion.description,
        })),
        doNotRepeatEffectIds: stateBefore.doNotRepeatEffectIds,
      });
      const projected = projectCanonicalCapsule(capsule, stage.profile.injectionBudgetTokens);
      if (!projected.ok) {
        this.#observe(
          missionId,
          'handoff.rejected',
          {
            code: projected.error.code,
            stageId: stage.stageId,
            budgetTokens: stage.profile.injectionBudgetTokens,
          },
          fence,
          attemptId,
        );
        this.#setWaiting(missionId, projected.error.code, fence);
        return { status: 'waiting' };
      }
      projectedCapsuleText = projected.projection.text;
      preparedHandoff = {
        capsuleId: projected.projection.capsuleId,
        capsuleHash: projected.projection.capsuleHash,
        projectionHash: projected.projection.projectionHash,
        checkpointId: capsuleCheckpointId,
        frontierCheckpointId: previousCheckpoint.checkpointId,
        compositeCheckpointId: previousComposite?.checkpointId ?? null,
        compositeManifestHash: previousComposite?.manifestHash ?? null,
        compositeEventPrefix: previousComposite?.eventPrefix ?? null,
        sourceAttemptId: previousCheckpoint.attemptId,
        targetAttemptId: attemptId,
        budgetTokens: stage.profile.injectionBudgetTokens,
        estimatedTokens: projected.projection.estimatedTokens,
      };
    }

    const baseline: AttemptBaselineRecord = {
      attemptId,
      stageId: stage.stageId,
      harness: stage.profile.harness,
      profileId: profile.profileId,
      branchId,
      bindingId,
      snapshot: before,
    };
    const binding: AttemptBindingV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      bindingId,
      missionId,
      attemptId,
      branchId,
      contractId: mission.contract.contractId,
      profileId: profile.profileId,
      workspaceKey: mission.workspaceKey,
      planNodeId: stage.stageId,
      authority: 'workspace',
      injectionBudgetTokens: stage.profile.injectionBudgetTokens,
      boundAt: this.#now().toISOString(),
    };
    const effect: EffectV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      effectId,
      missionId,
      attemptId,
      kind: 'workspace.stage_mutation',
      resourceKey: `workspace-stage:${stage.stageId}`,
      controlLevel: 'advisory',
      scope: 'branch_local_workspace',
      status: 'intended',
      evidenceRefs: [],
      createdAt: this.#now().toISOString(),
    };
    const preparationEvents: EventV1[] = [
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: binding.boundAt,
        type: 'attempt.bound',
        payload: { binding },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: this.#now().toISOString(),
        type: 'runtime.observation',
        payload: {
          kind: 'attempt.baseline',
          data: baseline as unknown as JsonValue,
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: this.#now().toISOString(),
        type: 'effect.recorded',
        payload: { effect },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: this.#now().toISOString(),
        type: 'runtime.observation',
        payload: {
          kind: 'attempt.plan',
          data: plan as unknown as JsonValue,
        },
      },
    ];
    if (preparedHandoff !== undefined) {
      preparationEvents.push({
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: this.#now().toISOString(),
        type: 'runtime.observation',
        payload: { kind: 'handoff.prepared', data: preparedHandoff },
      });
    }
    this.#store.appendEvents(preparationEvents, fence);
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: this.#now().toISOString(),
        type: 'attempt.started',
        payload: {
          attempt: {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            attemptId,
            missionId,
            branchId,
            profileId: profile.profileId,
            stageId: stage.stageId,
            status: 'running',
            startedAt: this.#now().toISOString(),
            ...(previousCheckpoint === undefined
              ? {}
              : { continuedFromAttemptId: previousCheckpoint.attemptId }),
          },
        },
      },
      fence,
    );

    const outputHash = createHash('sha256');
    let outputLines = 0;
    let acknowledged = capsule === undefined;
    let handoffOrderingEstablished = capsule === undefined;
    let acknowledgementId: string | undefined;
    let acknowledgementPosition: RuntimeSourcePosition | undefined;
    let firstToolRequest: RuntimeSourcePosition | undefined;
    let workspaceUnchangedAtAcknowledgement = capsule === undefined;
    let acknowledgementOrderingEvidence = capsule === undefined ? 'not-required' : 'unknown';
    let runtimeFailure: RuntimeFailureObservation | undefined;
    const runtimeEventIdByNativeIdentity = new Map<string, string>();
    const reportedProfiles = new Set<string>();
    const onOutput = async (line: RuntimeOutputLine): Promise<void> => {
      const sanitized = sanitizeNativeArtifact(line.line);
      const artifact = await this.#artifacts.putLine(line.line);
      const causalParentIds = nativeParentCorrelationIds(line.value).flatMap((parentId) => {
        const runtimeEventId = runtimeEventIdByNativeIdentity.get(parentId);
        return runtimeEventId === undefined ? [] : [runtimeEventId];
      });
      const baseRuntimeEvent = normalizeRuntimeOutput(
        line,
        {
          missionId,
          branchId,
          attemptId,
          bindingId,
          planNodeId: stage.stageId,
          sourceProtocol: runtimeProtocol(stage.profile.harness),
          ...(causalParentIds.length === 0 ? {} : { causalParentIds }),
        },
        artifact,
      );
      const semanticFacts = extractRuntimeSemanticFacts(baseRuntimeEvent, {
        artifactId: artifact.artifactId,
        sha256: artifact.sha256,
        mediaType: artifact.mediaType,
        content: sanitized.content,
      });
      const runtimeEvent = {
        ...baseRuntimeEvent,
        normalized: {
          ...(isJsonObject(baseRuntimeEvent.normalized) ? baseRuntimeEvent.normalized : {}),
          semanticFacts: semanticFacts as unknown as JsonValue,
        },
      };
      this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: runtimeEvent.runtimeEventId,
          missionId,
          attemptId,
          occurredAt: runtimeEvent.observedAt,
          type: 'runtime.event',
          payload: { event: runtimeEvent },
        },
        fence,
      );
      for (const nativeIdentity of nativeEventIdentityIds(line.value)) {
        runtimeEventIdByNativeIdentity.set(nativeIdentity, runtimeEvent.runtimeEventId);
      }
      if (firstToolRequest === undefined && nativeToolRequestName(line.value) !== undefined) {
        firstToolRequest = {
          sourceId: runtimeEvent.sourceId,
          sourceSequence: runtimeEvent.sourceSequence,
          runtimeEventId: runtimeEvent.runtimeEventId,
        };
      }
      outputHash.update(`${line.stream}\0${line.line}\n`, 'utf8');
      outputLines += 1;
      runtimeFailure ??= classifyRuntimeOutputFailure(line);
      const report = reportedEffectiveProfile(line.value, profile);
      if (report !== undefined) {
        const reportDigest = hashPayload(report);
        if (!reportedProfiles.has(reportDigest)) {
          reportedProfiles.add(reportDigest);
          this.#observe(
            missionId,
            'runtime.effective_profile_reported',
            { ...report, sourceRuntimeEventId: runtimeEvent.runtimeEventId },
            fence,
            attemptId,
          );
        }
      }
      if (capsule === undefined || acknowledged) return;
      const candidate = extractAndValidateAcknowledgement(line, capsule);
      if (!candidate.ok) return;
      const atAcknowledgement = snapshotGitWorkspace(spec.workspace);
      acknowledged = true;
      workspaceUnchangedAtAcknowledgement =
        atAcknowledgement.workspaceDigest === before.workspaceDigest;
      acknowledgementId = `ack-${hashPayload(candidate.acknowledgement).slice(0, 24)}`;
      acknowledgementPosition = {
        sourceId: runtimeEvent.sourceId,
        sourceSequence: runtimeEvent.sourceSequence,
        runtimeEventId: runtimeEvent.runtimeEventId,
      };
    };
    const prompt = createAttemptPrompt(spec, stage, mission.contract, projectedCapsuleText);
    const promptArtifact = await this.#artifacts.putLine(prompt);
    const contextSnapshotId = `context-snapshot-${hashPayload({
      attemptId,
      bindingId,
      promptSha256: promptArtifact.sha256,
    }).slice(0, 28)}`;
    this.#observe(
      missionId,
      'context.controller_prompt',
      {
        contextSnapshotId,
        attemptId,
        branchId,
        bindingId,
        stageId: stage.stageId,
        contractId: mission.contract.contractId,
        profileId: profile.profileId,
        source: 'missionbraid-controller',
        adapterBinding: 'native-process-prompt-argument',
        visibility: 'known',
        completeness: 'partial',
        nativeArtifact: promptArtifact as unknown as JsonValue,
        components: [
          'outcome_contract',
          'mission_constraints',
          'acceptance_criteria',
          'stage_instruction',
          ...(capsule === undefined ? [] : ['handoff_capsule']),
          'controller_boundary_instruction',
        ],
        unavailable: [
          'complete_effective_context',
          'hidden_chain_of_thought',
          'kv_cache',
          'signed_or_private_thinking',
        ],
      },
      fence,
      attemptId,
    );
    let toolGateway: ToolGateway | undefined;
    let toolGateBinding: ClaudeToolGateBindingV1 | undefined;
    let toolGatewayError: unknown;
    const toolGatewayController = new AbortController();
    let toolGatewayWatcher: Promise<void> | undefined;
    if (stage.breakpoint === 'mutable-tools') {
      toolGateway = this.#toolGateway(missionId, attemptId);
      await toolGateway.initialize();
      toolGateBinding = await createClaudeToolGateBinding({
        stateDir: this.#stateDir,
        gatewayRoot: this.#toolGatewayRoot(),
        missionId,
        attemptId,
      });
      this.#observe(
        missionId,
        'tool.gateway.armed',
        {
          attemptId,
          matcher: toolGateBinding.matcher,
          tools: [...toolGateBinding.tools],
          settingsSha256: toolGateBinding.settingsSha256,
          controlLevel: 'enforced',
          capabilityFidelity: 'native',
          parentProcess: 'continues-while-hook-blocks-tool-dispatch',
          childProcesses: 'covered-only-when-dispatched-through-matched-Claude-tool',
          inFlightRequests: 'not-revoked',
          pendingTools: 'blocked-until-persisted-release',
        },
        fence,
        attemptId,
      );
      toolGatewayWatcher = this.#watchToolGateway(
        missionId,
        attemptId,
        toolGateway,
        fence,
        toolGatewayController.signal,
      ).catch((error: unknown) => {
        toolGatewayError = error;
        toolGatewayController.abort();
      });
    }
    const runtimeSignal =
      signal === undefined
        ? toolGatewayController.signal
        : AbortSignal.any([signal, toolGatewayController.signal]);
    const runtimeResult = await this.#runRuntime(stage, profile, {
      workspace: spec.workspace,
      prompt,
      signal: runtimeSignal,
      ...(toolGateBinding === undefined ? {} : { toolGateBinding }),
      onStart: (pid) => {
        this.#observe(
          missionId,
          'runtime.process_started',
          { attemptId, stageId: stage.stageId, harness: stage.profile.harness, pid },
          fence,
          attemptId,
        );
      },
      onOutput,
    });
    if (toolGateway !== undefined) {
      await this.#drainToolGateway(missionId, attemptId, toolGateway, fence);
      toolGatewayController.abort();
      await toolGatewayWatcher;
      if (toolGatewayError !== undefined) {
        throw new MissionExecutionError(
          'The native Tool Gateway stopped before it could release a decision',
          {
            cause: toolGatewayError,
          },
        );
      }
    }

    if (capsule !== undefined) {
      const ordering = resolveCooperativeHandoffOrdering(
        acknowledgementPosition,
        firstToolRequest,
        workspaceUnchangedAtAcknowledgement,
      );
      handoffOrderingEstablished = ordering.accepted;
      acknowledgementOrderingEvidence = ordering.evidence;
      if (
        acknowledged &&
        acknowledgementId !== undefined &&
        acknowledgementPosition !== undefined
      ) {
        this.#observe(
          missionId,
          'handoff.acknowledged',
          {
            acknowledgementId,
            capsuleId: capsule.capsuleId,
            checkpointId: capsule.checkpoint.checkpointId,
            handoffOrderingEstablished,
            workspaceUnchangedAtObservation: workspaceUnchangedAtAcknowledgement,
            orderingEvidence: acknowledgementOrderingEvidence,
            acknowledgementRuntimeEventId: acknowledgementPosition.runtimeEventId,
            firstToolRequestRuntimeEventId: firstToolRequest?.runtimeEventId ?? null,
          },
          fence,
          attemptId,
        );
      }
    }

    const after = snapshotGitWorkspace(spec.workspace);
    const delta = createStageWorkspaceDelta(before, after);
    const processSucceeded = processResultSucceeded(runtimeResult);
    const handoffAccepted = capsule === undefined || (acknowledged && handoffOrderingEstablished);
    const attemptSucceeded = processSucceeded && handoffAccepted;
    const canHandOff =
      !runtimeResult.process.aborted &&
      !attemptSucceeded &&
      stage.onFailure === 'handoff' &&
      delta.changedPaths.length > 0;
    const checkpointStatus: CheckpointRecord['status'] = attemptSucceeded
      ? 'succeeded'
      : canHandOff
        ? 'handed_off'
        : 'failed';
    const checkpointId = checkpointIdentity(attemptId, delta);
    const checkpoint: CheckpointRecord = {
      checkpointId,
      missionId,
      attemptId,
      stageId: stage.stageId,
      harness: stage.profile.harness,
      profileId: profile.profileId,
      branchId,
      bindingId,
      status: checkpointStatus,
      delta,
      origin: 'runtime-completion',
    };
    this.#observe(
      missionId,
      'checkpoint.created',
      checkpoint as unknown as JsonValue,
      fence,
      attemptId,
    );
    if (runtimeFailure !== undefined) {
      this.#observe(
        missionId,
        'failure.observed',
        runtimeFailure as unknown as JsonValue,
        fence,
        attemptId,
      );
    }
    this.#observe(
      missionId,
      'runtime.process_finished',
      {
        attemptId,
        stageId: stage.stageId,
        harness: stage.profile.harness,
        exitCode: runtimeResult.process.exitCode,
        signal: runtimeResult.process.signal,
        aborted: runtimeResult.process.aborted,
        outputSha256: outputHash.digest('hex'),
        outputLines,
        acknowledged,
        handoffOrderingEstablished,
        workspaceUnchangedAtAcknowledgement,
        acknowledgementOrderingEvidence,
        acknowledgementId: acknowledgementId ?? null,
        acknowledgementRuntimeEventId: acknowledgementPosition?.runtimeEventId ?? null,
        firstToolRequestRuntimeEventId: firstToolRequest?.runtimeEventId ?? null,
      },
      fence,
      attemptId,
    );
    const effectStatus =
      delta.changedPaths.length > 0 ? 'confirmed' : attemptSucceeded ? 'skipped' : 'failed';
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: this.#now().toISOString(),
        type: 'effect.status_changed',
        payload: {
          effectId,
          status: effectStatus,
          evidenceRefs: [`checkpoint:${checkpointId}`],
        },
      },
      fence,
    );
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        attemptId,
        occurredAt: this.#now().toISOString(),
        type: 'attempt.finished',
        payload: {
          attemptId,
          status: attemptSucceeded ? 'succeeded' : 'failed',
          endedAt: this.#now().toISOString(),
          summary: attemptSucceeded
            ? 'Runtime exited successfully and continuity acknowledgement passed'
            : failureSummary(
                runtimeResult,
                capsule !== undefined,
                acknowledged,
                handoffOrderingEstablished,
                runtimeFailure,
              ),
        },
      },
      fence,
    );
    if (canHandOff) {
      await this.#persistHandoffCompositeCheckpoint(missionId, spec, checkpoint, after, fence);
    }
    await this.#writeProvenanceProjection(missionId);

    if (attemptSucceeded) return { status: 'succeeded' };
    if (canHandOff) {
      return {
        status: 'handoff',
        trigger: {
          code:
            runtimeFailure?.code === 'CREDIT_LIMIT' ? 'CREDIT_LIMIT' : 'DECLARED_HANDOFF_FAILURE',
          sourceStageId: stage.stageId,
          sourceProfileId: profile.profileId,
          detail: failureSummary(
            runtimeResult,
            capsule !== undefined,
            acknowledged,
            handoffOrderingEstablished,
            runtimeFailure,
          ),
        },
      };
    }
    this.#setWaiting(
      missionId,
      failureSummary(
        runtimeResult,
        capsule !== undefined,
        acknowledged,
        handoffOrderingEstablished,
        runtimeFailure,
      ),
      fence,
    );
    return { status: 'waiting' };
  }

  async #verifyAndReceipt(
    missionId: string,
    spec: MissionSpecV1,
    fence: WorkspaceFenceV1,
    signal?: AbortSignal,
  ): Promise<MissionExecutionResult> {
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: this.#now().toISOString(),
        type: 'mission.status_changed',
        payload: { status: 'verifying' },
      },
      fence,
    );
    const provenanceFile = this.#provenanceFile(missionId);
    await this.#writeProvenanceProjection(missionId);
    const results: CommandVerificationResultV1[] = [];
    for (const criterion of spec.acceptanceCriteria) {
      const result = await runCommandVerifier(criterion.verifier, {
        workspace: spec.workspace,
        missionSourceDir: spec.missionSourceDir,
        controllerStateDir: this.#stateDir,
        provenanceFile,
        ...(signal === undefined ? {} : { signal }),
      });
      results.push(result);
      this.#observe(
        missionId,
        'verification.completed',
        {
          criterionId: criterion.id,
          passed: result.passed,
          invocationDigest: result.invocationDigest,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdoutSha256: result.stdout.sha256,
          stdoutBytes: result.stdout.byteCount,
          stderrSha256: result.stderr.sha256,
          stderrBytes: result.stderr.byteCount,
        },
        fence,
      );
    }
    const chain = this.#store.verifyEventChain(missionId);
    if (!chain.valid) {
      throw new MissionExecutionError(
        `Mission event chain is invalid${chain.error === undefined ? '' : `: ${chain.error}`}`,
      );
    }
    const projection = this.#requireMission(missionId);
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    const allPassed = results.every((result) => result.passed);
    const unresolvedEffects = state.effects.filter((effect) =>
      ['intended', 'dispatch_started', 'executed', 'ambiguous', 'conflict'].includes(effect.status),
    );
    const failedCriteria = spec.acceptanceCriteria
      .filter((_criterion, index) => !results[index]!.passed)
      .map((criterion) => criterion.id);
    const verifiedOutcome = allPassed && unresolvedEffects.length === 0;
    const receipt: ReceiptV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      receiptId: `receipt-${this.#id()}`,
      missionId,
      contractId: projection.contract.contractId,
      ...(projection.rootBranchId === undefined
        ? {}
        : { branchId: projection.rootBranchId, rootBranchId: projection.rootBranchId }),
      outcome: verifiedOutcome ? 'verified' : 'rejected',
      verifications: spec.acceptanceCriteria.map((criterion, index) => {
        const result = results[index]!;
        return {
          criterionId: criterion.id,
          status: result.passed ? 'passed' : 'failed',
          evidenceRefs: [
            `verifier:${result.invocationDigest}`,
            `stdout:sha256:${result.stdout.sha256}`,
            `stderr:sha256:${result.stderr.sha256}`,
          ],
        };
      }),
      verifiedHeadHash: projection.headHash,
      verifiedThroughSeq: projection.lastSeq,
      attemptIds: [...state.plans.keys()],
      handoffIds: state.handoffIds,
      effectIds: state.effects.map((effect) => effect.effectId),
      effects: state.effects,
      unresolvedItems: [
        ...failedCriteria.map((criterionId) => `criterion:${criterionId}`),
        ...unresolvedEffects.map((effect) => `effect:${effect.effectId}:${effect.status}`),
      ],
      issuedAt: this.#now().toISOString(),
    };
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: this.#now().toISOString(),
        type: 'receipt.issued',
        payload: { receipt },
      },
      fence,
    );
    await mkdir(dirname(this.#receiptFile(missionId)), { recursive: true });
    await writeFile(this.#receiptFile(missionId), `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return {
      missionId,
      status: verifiedOutcome ? 'succeeded' : 'failed',
      receipt,
      verificationResults: results,
    };
  }

  async #issueExecutionForkReceipt(
    missionId: string,
    childBranchId: string,
    spec: MissionSpecV1,
    record: ExecutionForkRecordV1,
    fence: WorkspaceFenceV1,
  ): Promise<ReceiptV1> {
    if (
      record.phase !== 'finished' ||
      record.runtimeResult?.status !== 'completed' ||
      record.receiptInput === undefined ||
      record.runtimeResult.unresolvedItems.length > 0
    ) {
      throw new MissionExecutionError(
        'Execution Fork ' + record.forkId + ' did not produce a completed, resolved Runtime result',
      );
    }
    if (
      record.lineage.missionId !== missionId ||
      record.lineage.childBranchId !== childBranchId ||
      record.receiptInput.childBranchId !== childBranchId
    ) {
      throw new MissionExecutionError('Execution Fork Receipt input conflicts with its Branch');
    }

    const verifications = spec.acceptanceCriteria.map((criterion) => {
      const evidence = record.runtimeEvidence.find(
        (candidate) =>
          candidate.kind === 'verification' &&
          candidate.evidenceRefs.includes('criterion:' + criterion.id) &&
          candidate.evidenceRefs.includes('verification:passed'),
      );
      if (evidence === undefined) {
        throw new MissionExecutionError(
          'Execution Fork ' + record.forkId + ' lacks passing evidence for ' + criterion.id,
        );
      }
      return {
        criterionId: criterion.id,
        status: 'passed' as const,
        evidenceRefs: uniqueStrings(['evidence:' + evidence.evidenceId, ...evidence.evidenceRefs]),
      };
    });
    const chain = this.#store.verifyEventChain(missionId);
    if (!chain.valid) {
      throw new MissionExecutionError(
        'Mission ' +
          missionId +
          ' has an invalid event chain' +
          (chain.error === undefined ? '' : ': ' + chain.error),
      );
    }
    const projection = this.#requireMission(missionId);
    const effects = reconstructExecutionState(this.#store.listEvents(missionId)).effects;
    const unresolvedEffects = effects.filter((effect) =>
      ['intended', 'dispatch_started', 'executed', 'ambiguous', 'conflict'].includes(effect.status),
    );
    if (unresolvedEffects.length > 0) {
      throw new MissionExecutionError(
        'Execution Fork ' +
          record.forkId +
          ' still has unresolved Effects: ' +
          unresolvedEffects.map((effect) => effect.effectId).join(', '),
      );
    }
    const childAttemptId = 'fork-attempt-' + record.forkId;
    const receipt: ReceiptV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      receiptId: 'receipt-' + this.#id(),
      missionId,
      contractId: projection.contract.contractId,
      branchId: childBranchId,
      outcome: 'verified',
      verifications,
      verifiedHeadHash: projection.headHash,
      verifiedThroughSeq: projection.lastSeq,
      attemptIds: [childAttemptId],
      handoffIds: [],
      effectIds: effects.map((effect) => effect.effectId),
      effects,
      unresolvedItems: [],
      issuedAt: this.#now().toISOString(),
    };
    this.#store.appendEvent(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: 'event-' + this.#id(),
        missionId,
        occurredAt: receipt.issuedAt,
        type: 'receipt.issued',
        payload: { receipt },
      },
      fence,
    );
    await Promise.all(
      [this.#receiptFile(missionId), this.#branchReceiptFile(missionId, childBranchId)].map(
        async (path) => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', {
            encoding: 'utf8',
            mode: 0o600,
          });
        },
      ),
    );
    return receipt;
  }

  async #runRuntime(
    stage: AttemptStageSpecV1,
    profile: ProfileV1,
    request: {
      readonly workspace: string;
      readonly prompt: string;
      readonly signal?: AbortSignal;
      readonly toolGateBinding?: ClaudeToolGateBindingV1;
      readonly onStart: (pid: number) => void;
      readonly onOutput: (line: RuntimeOutputLine) => Promise<void>;
    },
  ): Promise<RuntimeRunResult> {
    const model = profile.model === 'default' ? undefined : profile.model;
    if (stage.profile.harness === 'codex') {
      return await this.#codex.run({
        ...request,
        ...(model === undefined ? {} : { model }),
        ...(profile.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: profile.reasoningEffort }),
        sandbox: codexSandbox(profile.permissionMode),
        ephemeral: true,
      });
    }
    if (stage.profile.harness === 'qoder') {
      return await this.#qoder.run({
        ...request,
        ...(model === undefined ? {} : { model }),
        ...(profile.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: profile.reasoningEffort }),
        permissionMode: qoderPermission(profile.permissionMode),
        maxTurns: 80,
        noSessionPersistence: true,
      });
    }
    return await this.#claude.run({
      ...request,
      ...(model === undefined ? {} : { model }),
      ...(profile.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: profile.reasoningEffort }),
      permissionMode: claudePermission(profile.permissionMode),
      maxTurns: 80,
      noSessionPersistence: true,
      includeHookEvents: true,
      ...(request.toolGateBinding === undefined
        ? {}
        : {
            settingsFile: request.toolGateBinding.settingsFile,
            tools: request.toolGateBinding.tools,
            verifiedHookGate: true,
          }),
    });
  }

  #toolGatewayRoot(): string {
    return join(this.#stateDir, 'tool-gateway');
  }

  #toolGateway(missionId: string, attemptId: string): ToolGateway {
    return new ToolGateway({
      rootDir: this.#toolGatewayRoot(),
      missionId,
      attemptId,
      now: this.#now,
    });
  }

  async #watchToolGateway(
    missionId: string,
    attemptId: string,
    gateway: ToolGateway,
    fence: WorkspaceFenceV1,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await this.#drainToolGateway(missionId, attemptId, gateway, fence);
      await waitForGatewayPoll(signal, 25);
    }
  }

  async #drainToolGateway(
    missionId: string,
    attemptId: string,
    gateway: ToolGateway,
    fence: WorkspaceFenceV1,
  ): Promise<void> {
    const existingEvents = this.#store.listEvents(missionId);
    const requestedGateIds = observationIds(existingEvents, 'tool.gate.requested', 'gateId');
    const decidedIntentIds = observationIds(
      existingEvents,
      'tool.gate.decided',
      'decisionIntentId',
    );
    const observedResultIds = observationIds(existingEvents, 'tool.gate.result', 'resultId');
    const recordedEffectIds = new Set(
      existingEvents.flatMap((event) =>
        event.type === 'effect.recorded' ? [event.payload.effect.effectId] : [],
      ),
    );
    const pending = await gateway.listPending();
    const requestByGateId = new Map(pending.map((request) => [request.gateId, request]));

    for (const request of pending) {
      if (requestedGateIds.has(request.gateId)) continue;
      const scope = toolEffectScope(request.toolName);
      const effect: EffectV1 = {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        effectId: request.effectId,
        missionId,
        attemptId,
        kind: `tool.${request.toolName}`,
        resourceKey: `tool-request:${request.requestSha256}`,
        controlLevel: 'enforced',
        scope,
        status: 'intended',
        evidenceRefs: [`tool-gate:${request.gateId}`],
        createdAt: request.requestedAt,
      };
      const events: EventV1[] = [];
      if (!recordedEffectIds.has(request.effectId)) {
        events.push({
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-tool-effect-${request.gateId.slice('gate-'.length)}`,
          missionId,
          attemptId,
          occurredAt: request.requestedAt,
          type: 'effect.recorded',
          payload: { effect },
        });
      }
      events.push({
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-tool-request-${request.gateId.slice('gate-'.length)}`,
        missionId,
        attemptId,
        occurredAt: request.requestedAt,
        type: 'runtime.observation',
        payload: {
          kind: 'tool.gate.requested',
          data: {
            ...request,
            controlLevel: 'enforced',
            scope,
            dispatchState: 'blocked-before-dispatch',
          } as unknown as JsonValue,
        },
      });
      this.#store.appendEvents(events, fence);
    }

    for (const intent of await gateway.readDecisionIntents()) {
      if (decidedIntentIds.has(intent.decisionIntentId)) continue;
      const request = requestByGateId.get(intent.gateId);
      if (request === undefined) {
        if ((await gateway.readRelease(intent.gateId)) !== undefined) continue;
        throw new MissionExecutionError(
          `Tool decision ${intent.decisionIntentId} has no pending request`,
        );
      }
      const decisionEvent = this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-tool-decision-${intent.decisionIntentId.slice('decision-intent-'.length)}`,
          missionId,
          attemptId,
          occurredAt: intent.createdAt,
          type: 'runtime.observation',
          payload: {
            kind: 'tool.gate.decided',
            data: {
              ...intent,
              controlLevel: 'enforced',
              dispatchState:
                intent.decision === 'reject' ? 'blocked-and-skipped' : 'released-after-persist',
            } as unknown as JsonValue,
          },
        },
        fence,
      );
      this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-tool-effect-decision-${intent.decisionIntentId.slice('decision-intent-'.length)}`,
          missionId,
          attemptId,
          occurredAt: intent.createdAt,
          type: 'effect.status_changed',
          payload: {
            effectId: intent.effectId,
            status: intent.decision === 'reject' ? 'skipped' : 'dispatch_started',
            evidenceRefs: [`event:${decisionEvent.eventId}`],
          },
        },
        fence,
      );
      await gateway.writeRelease({
        decisionIntentId: intent.decisionIntentId,
        kernelDecisionEvent: {
          eventId: decisionEvent.eventId,
          seq: decisionEvent.seq,
          hash: decisionEvent.hash,
          recordedAt: decisionEvent.recordedAt,
        },
      });
    }

    for (const result of await gateway.listResults()) {
      if (observedResultIds.has(result.resultId)) continue;
      const resultEvent = this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${result.resultId}`,
          missionId,
          attemptId,
          occurredAt: result.observedAt,
          type: 'runtime.observation',
          payload: {
            kind: 'tool.gate.result',
            data: result as unknown as JsonValue,
          },
        },
        fence,
      );
      this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-tool-effect-result-${result.resultId.slice('tool-result-'.length)}`,
          missionId,
          attemptId,
          occurredAt: result.observedAt,
          type: 'effect.status_changed',
          payload: {
            effectId: result.effectId,
            status: result.outcome === 'succeeded' ? 'confirmed' : 'failed',
            evidenceRefs: [`event:${resultEvent.eventId}`, `tool-result:${result.resultSha256}`],
          },
        },
        fence,
      );
    }
  }

  async #detect(harness: SupportedHarnessV1): Promise<RuntimeDetection> {
    if (harness === 'codex') return await this.#codex.detect();
    if (harness === 'qoder') return await this.#qoder.detect();
    return await this.#claude.detect();
  }

  async #closeDanglingAttempts(
    missionId: string,
    spec: MissionSpecV1,
    fence: WorkspaceFenceV1,
  ): Promise<void> {
    const chain = this.#store.verifyEventChain(missionId);
    if (!chain.valid) {
      throw new MissionExecutionError(
        `Cannot recover a dangling Attempt from an invalid event chain${
          chain.error === undefined ? '' : `: ${chain.error}`
        }`,
      );
    }
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    const danglingPlans = [...state.plans.values()].filter(
      (plan) => !state.finished.has(plan.attemptId),
    );
    if (danglingPlans.length > 1) {
      throw new MissionExecutionError(
        `Cannot recover ${String(danglingPlans.length)} concurrent dangling Attempts`,
      );
    }

    for (const plan of danglingPlans) {
      const pid = state.processByAttempt.get(plan.attemptId);
      if (pid !== undefined && processExists(pid)) {
        throw new MissionExecutionError(
          `Attempt ${plan.attemptId} still owns a live runtime process (${String(pid)})`,
        );
      }
      const stage = spec.attemptPlan.find((candidate) => candidate.stageId === plan.stageId);
      if (stage === undefined || stage.profile.harness !== plan.harness) {
        throw new MissionExecutionError(
          `Cannot recover Attempt ${plan.attemptId}: its persisted plan no longer matches the Mission specification`,
        );
      }
      const effect = state.effectsByAttempt.get(plan.attemptId);
      if (effect === undefined) {
        throw new MissionExecutionError(
          `Cannot recover Attempt ${plan.attemptId}: its Effect record is missing`,
        );
      }

      let checkpoint = state.checkpoints.find(
        (candidate) => candidate.attemptId === plan.attemptId,
      );
      if (checkpoint === undefined) {
        const baseline = state.baselines.get(plan.attemptId);
        if (baseline === undefined) {
          throw new MissionExecutionError(
            `Cannot recover Attempt ${plan.attemptId}: its persisted before snapshot is missing`,
          );
        }
        assertRecoveryBaseline(baseline, plan);
        const after = snapshotGitWorkspace(spec.workspace);
        const delta = createStageWorkspaceDelta(baseline.snapshot, after);
        const checkpointId = checkpointIdentity(plan.attemptId, delta);
        checkpoint = {
          checkpointId,
          missionId,
          attemptId: plan.attemptId,
          stageId: plan.stageId,
          harness: plan.harness,
          profileId: plan.profileId,
          branchId: plan.branchId,
          bindingId: plan.bindingId,
          status:
            delta.changedPaths.length > 0 && stage.onFailure === 'handoff'
              ? 'handed_off'
              : 'failed',
          delta,
          origin: 'controller-recovery',
        };
        this.#observe(
          missionId,
          'checkpoint.created',
          checkpoint as unknown as JsonValue,
          fence,
          plan.attemptId,
        );
      } else {
        const current = snapshotGitWorkspace(spec.workspace);
        if (current.workspaceDigest !== checkpoint.delta.afterWorkspaceDigest) {
          throw new MissionExecutionError(
            `Cannot recover Attempt ${plan.attemptId}: workspace diverged after its persisted checkpoint`,
          );
        }
      }

      if (['intended', 'dispatch_started', 'executed'].includes(effect.status)) {
        this.#append(
          {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            eventId: `event-${this.#id()}`,
            missionId,
            attemptId: plan.attemptId,
            occurredAt: this.#now().toISOString(),
            type: 'effect.status_changed',
            payload: {
              effectId: effect.effectId,
              status: checkpoint.delta.changedPaths.length > 0 ? 'confirmed' : 'failed',
              evidenceRefs: [`checkpoint:${checkpoint.checkpointId}`],
            },
          },
          fence,
        );
      }
      this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          attemptId: plan.attemptId,
          occurredAt: this.#now().toISOString(),
          type: 'attempt.finished',
          payload: {
            attemptId: plan.attemptId,
            status: 'abandoned',
            endedAt: this.#now().toISOString(),
            summary: 'Controller restarted after the runtime process ended',
          },
        },
        fence,
      );
      if (checkpoint.status === 'handed_off') {
        await this.#persistHandoffCompositeCheckpoint(
          missionId,
          spec,
          checkpoint,
          snapshotGitWorkspace(spec.workspace),
          fence,
        );
      }
    }
    if (danglingPlans.length > 0) await this.#writeProvenanceProjection(missionId);
  }

  async #persistHandoffCompositeCheckpoint(
    missionId: string,
    spec: MissionSpecV1,
    frontier: CheckpointRecord,
    workspace: GitWorkspaceSnapshotV1,
    fence: WorkspaceFenceV1,
  ): Promise<CompositeCheckpointManifestV1> {
    const events = this.#store.listEvents(missionId);
    const effects = projectMissionEffects(events);
    const existing = [...this.compositeCheckpoints(missionId)]
      .reverse()
      .find((candidate) => candidate.source.attemptId === frontier.attemptId);
    if (
      existing !== undefined &&
      compositeCoversHandoffFrontier(existing, frontier, workspace, effects)
    ) {
      return existing;
    }
    const created = events.find(
      (event): event is Extract<StoredEventV1, { type: 'mission.created' }> =>
        event.type === 'mission.created',
    );
    const started = events.find(
      (event): event is Extract<StoredEventV1, { type: 'attempt.started' }> =>
        event.type === 'attempt.started' && event.payload.attempt.attemptId === frontier.attemptId,
    );
    const finished = [...events]
      .reverse()
      .find(
        (event): event is Extract<StoredEventV1, { type: 'attempt.finished' }> =>
          event.type === 'attempt.finished' && event.payload.attemptId === frontier.attemptId,
      );
    if (created === undefined || started === undefined || finished === undefined) {
      throw new MissionExecutionError(
        `Handoff frontier ${frontier.checkpointId} lacks complete Attempt boundary evidence`,
      );
    }
    const branch = this.#store.getBranch(missionId, frontier.branchId);
    if (branch === undefined) {
      throw new MissionExecutionError(
        `Handoff frontier ${frontier.checkpointId} references an unknown Branch`,
      );
    }
    const profile = profileForAttempt(events, started.payload.attempt, created.payload.profile);
    if (
      profile.profileId !== frontier.profileId ||
      started.payload.attempt.branchId !== frontier.branchId ||
      started.payload.attempt.stageId !== frontier.stageId
    ) {
      throw new MissionExecutionError(
        `Handoff frontier ${frontier.checkpointId} no longer matches its Profile or Attempt`,
      );
    }
    if (workspace.workspaceDigest !== frontier.delta.afterWorkspaceDigest) {
      throw new MissionExecutionError(
        `Handoff frontier ${frontier.checkpointId} no longer matches the workspace`,
      );
    }

    const context = await this.contextGraph(missionId);
    const contextDigest = `sha256:${hashPayload(context)}`;
    const contextEvidenceRefs = uniqueStrings([
      `context-graph:${contextDigest}`,
      ...context.nodes.flatMap((node) => node.evidenceRefs),
    ]);
    const processStarted = events.find(
      (event) =>
        event.type === 'runtime.observation' &&
        event.payload.kind === 'runtime.process_started' &&
        event.attemptId === frontier.attemptId,
    );
    const processFinished = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'runtime.observation' &&
          event.payload.kind === 'runtime.process_finished' &&
          event.attemptId === frontier.attemptId,
      );
    const processStartedData = runtimeObservationData(processStarted);
    const processFinishedData = runtimeObservationData(processFinished);
    const projection = this.#requireMission(missionId);
    const checkpoint = createCompositeCheckpoint({
      mission: created.payload.mission,
      branch,
      attempt: {
        ...started.payload.attempt,
        status: finished.payload.status,
        endedAt: finished.payload.endedAt,
      },
      contract: projection.contract,
      profile,
      eventPrefix: {
        throughSeq: projection.lastSeq,
        headHash: projection.headHash,
        evidenceRefs: [`kernel-head:${projection.headHash}`],
      },
      visibleContext: {
        status: 'captured',
        contextDigest,
        artifactRefs: contextEvidenceRefs,
        evidenceRefs: contextEvidenceRefs,
      },
      workspace: {
        kind: 'git-digest',
        workspaceKey: projection.workspaceKey,
        snapshot: workspace,
        evidenceRefs: [
          `workspace:${workspace.workspaceDigest}`,
          `frontier:${frontier.checkpointId}`,
        ],
      },
      permissions: {
        permissionMode: profile.permissionMode ?? 'unknown',
        evidenceRefs: [`profile:${profile.profileId}`],
      },
      effects,
      process: {
        status: 'stopped',
        stoppedAt: finished.payload.endedAt,
        ...(typeof processStartedData?.pid === 'number'
          ? { processRef: `pid:${String(processStartedData.pid)}` }
          : {}),
        ...(typeof processFinishedData?.exitCode === 'number' ||
        processFinishedData?.exitCode === null
          ? { exitCode: processFinishedData.exitCode }
          : {}),
        evidenceRefs: uniqueStrings([
          `event:${finished.eventId}`,
          ...(processFinished === undefined ? [] : [`event:${processFinished.eventId}`]),
        ]),
      },
      nativeSession: {
        status: 'unavailable',
        harness: profile.harness,
        reason:
          'The stopped native process has no Adapter-exposed resumable session; Handoff reconstructs from the same workspace frontier and captured visible context.',
        evidenceRefs: [`attempt:${frontier.attemptId}`],
      },
      capturedAt: this.#now().toISOString(),
    });
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-composite-checkpoint-${checkpoint.manifestHash.slice('sha256:'.length)}`,
        missionId,
        attemptId: frontier.attemptId,
        occurredAt: checkpoint.capturedAt,
        type: 'runtime.observation',
        payload: {
          kind: 'composite-checkpoint.created',
          data: {
            checkpointId: checkpoint.checkpointId,
            frontierCheckpointId: frontier.checkpointId,
            branchId: checkpoint.source.branchId,
            purpose: 'cross-harness-handoff',
            manifest: checkpoint as unknown as JsonValue,
          },
        },
      },
      fence,
    );
    return checkpoint;
  }

  async #writeProvenanceProjection(missionId: string): Promise<void> {
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    const stages: ProvenanceStageV1[] = state.checkpoints.map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      stageId: checkpoint.stageId,
      harness: checkpoint.harness,
      attemptId: checkpoint.attemptId,
      branchId: checkpoint.branchId,
      bindingId: checkpoint.bindingId,
      profileId: checkpoint.profileId,
      status: checkpoint.status,
      origin: checkpoint.origin ?? 'runtime-completion',
      beforeWorkspaceDigest: checkpoint.delta.beforeWorkspaceDigest,
      afterWorkspaceDigest: checkpoint.delta.afterWorkspaceDigest,
      changedPaths: checkpoint.delta.changedPaths.map((path) => ({
        path: path.path,
        beforeSha256: path.beforeSha256,
        afterSha256: path.afterSha256,
      })),
    }));
    const manifest: ProvenanceManifestV1 = {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      missionId,
      rootBranchId: requireRootBranch(this.#requireMission(missionId)),
      stages,
    };
    await writeProvenanceManifest(this.#provenanceFile(missionId), manifest);
  }

  #append(event: EventV1, fence: WorkspaceFenceV1): StoredEventV1 {
    return this.#store.appendEvent(event, fence).event;
  }

  #observe(
    missionId: string,
    kind: string,
    data: JsonValue,
    fence: WorkspaceFenceV1,
    attemptId?: string,
  ): StoredEventV1 {
    return this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        ...(attemptId === undefined ? {} : { attemptId }),
        occurredAt: this.#now().toISOString(),
        type: 'runtime.observation',
        payload: { kind, data },
      },
      fence,
    );
  }

  #setWaiting(missionId: string, reason: string, fence: WorkspaceFenceV1): void {
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId,
        occurredAt: this.#now().toISOString(),
        type: 'mission.status_changed',
        payload: { status: 'waiting', reason },
      },
      fence,
    );
  }

  #requireMission(missionId: string): MissionProjectionV1 {
    const mission = this.#store.getMission(missionId);
    if (mission === undefined) throw new MissionExecutionError(`Unknown Mission ${missionId}`);
    return mission;
  }

  #requireSpecSnapshot(missionId: string): MissionSpecV1 {
    const chain = this.#store.verifyEventChain(missionId);
    if (!chain.valid) {
      throw new MissionExecutionError(
        `Mission ${missionId} has an invalid event chain${
          chain.error === undefined ? '' : `: ${chain.error}`
        }`,
      );
    }
    const event = this.#store
      .listEvents(missionId)
      .find(
        (candidate) =>
          candidate.type === 'runtime.observation' &&
          candidate.payload.kind === 'mission.spec_snapshot',
      );
    if (event === undefined || event.type !== 'runtime.observation') {
      throw new MissionExecutionError(`Mission ${missionId} has no specification snapshot`);
    }
    const data = event.payload.data as unknown as Record<string, unknown>;
    const provenance = data.provenance as Partial<SpecSnapshotProvenance> | undefined;
    if (
      data.snapshot === undefined ||
      typeof data.snapshotHash !== 'string' ||
      provenance === undefined ||
      typeof provenance.sourceFile !== 'string'
    ) {
      throw new MissionExecutionError(`Mission ${missionId} has an invalid specification snapshot`);
    }
    if (hashPayload(data.snapshot) !== data.snapshotHash) {
      throw new MissionExecutionError(`Mission ${missionId} specification snapshot hash mismatch`);
    }
    try {
      return restoreMissionSpecSnapshot(data.snapshot, provenance.sourceFile);
    } catch (error) {
      throw new MissionExecutionError(
        `Mission ${missionId} has an invalid specification snapshot`,
        { cause: error },
      );
    }
  }

  async #withLease<T>(
    workspaceKey: string,
    ownerId: string,
    operation: (fence: WorkspaceFenceV1) => Promise<T>,
  ): Promise<T> {
    const lease = this.#store.acquireWorkspaceLease(workspaceKey, ownerId, {
      ttlMs: LEASE_TTL_MS,
    });
    const fence: WorkspaceFenceV1 = {
      workspaceKey,
      ownerId,
      fencingToken: lease.fencingToken,
    };
    const renewal = setInterval(() => {
      this.#store.renewWorkspaceLease(fence, { ttlMs: LEASE_TTL_MS });
    }, LEASE_RENEW_MS);
    renewal.unref();
    try {
      return await operation(fence);
    } finally {
      clearInterval(renewal);
      try {
        this.#store.releaseWorkspaceLease(fence);
      } catch {
        // A stale owner must not mutate state merely to clean up a lease.
      }
    }
  }

  #provenanceFile(missionId: string): string {
    return join(this.#stateDir, 'missions', missionId, 'provenance.json');
  }

  #receiptFile(missionId: string): string {
    return join(this.#stateDir, 'missions', missionId, 'receipt.json');
  }

  #branchReceiptFile(missionId: string, branchId: string): string {
    return join(this.#stateDir, 'missions', missionId, 'branches', branchId, 'receipt.json');
  }
}

function createContract(spec: MissionSpecV1, now: Date): ContractV1 {
  const contractBody = {
    objective: spec.objective,
    constraints: spec.constraints,
    acceptanceCriteria: spec.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      description: criterion.description,
      verifier: {
        kind: criterion.verifier.kind,
        configuration: {
          executable: criterion.verifier.executable,
          timeoutMs: criterion.verifier.timeoutMs,
          environmentKeys: Object.keys(criterion.verifier.env).sort(),
          configurationDigest: hashPayload(criterion.verifier),
        },
      },
    })),
  };
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    contractId: `contract-${hashPayload(contractBody).slice(0, 28)}`,
    ...contractBody,
    createdAt: now.toISOString(),
  };
}

function timelineEntry(
  event: StoredEventV1,
  attemptHarness?: string,
): MissionTimelineEntry | undefined {
  const base = {
    seq: event.seq,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    ...(attemptHarness === undefined ? {} : { harness: attemptHarness }),
  };
  switch (event.type) {
    case 'mission.created':
      return {
        ...base,
        category: 'mission',
        kind: event.type,
        label: 'Mission created',
        data: {
          title: event.payload.mission.title,
          contractId: event.payload.contract.contractId,
          profile: event.payload.profile as unknown as JsonValue,
        },
      };
    case 'mission.status_changed':
      return {
        ...base,
        category: 'mission',
        kind: event.type,
        label: `Mission ${event.payload.status}`,
        data: {
          status: event.payload.status,
          ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
        },
      };
    case 'branch.created':
      return {
        ...base,
        category: 'mission',
        kind: event.type,
        label: 'Root Branch created',
        data: {
          branchId: event.payload.branch.branchId,
          parentBranchId: event.payload.branch.parentBranchId ?? null,
        },
      };
    case 'runtime.catalog_observed':
      return {
        ...base,
        category: 'profile',
        kind: event.type,
        label: `${event.payload.observation.harness} Runtime observed`,
        harness: event.payload.observation.harness,
        data: event.payload.observation as unknown as JsonValue,
      };
    case 'profile.definition_recorded':
      return {
        ...base,
        category: 'profile',
        kind: event.type,
        label: `${event.payload.definition.harness} Profile Definition recorded`,
        harness: event.payload.definition.harness,
        data: event.payload.definition as unknown as JsonValue,
      };
    case 'profile.selected':
      return {
        ...base,
        category: 'profile',
        kind: event.type,
        label: `${event.payload.profile.harness} profile selected`,
        harness: event.payload.profile.harness,
        data: {
          profileId: event.payload.profile.profileId,
          model: event.payload.profile.model,
          reason: event.payload.reason,
          profile: event.payload.profile as unknown as JsonValue,
        },
      };
    case 'attempt.started':
      return {
        ...base,
        category: 'attempt',
        kind: event.type,
        label: `${attemptHarness ?? 'Runtime'} attempt started`,
        data: {
          attemptId: event.payload.attempt.attemptId,
          stageId: event.payload.attempt.stageId ?? null,
          profileId: event.payload.attempt.profileId,
        },
      };
    case 'attempt.bound':
      return {
        ...base,
        category: 'attempt',
        kind: event.type,
        label: 'Attempt bound to Runtime Profile',
        data: event.payload.binding as unknown as JsonValue,
      };
    case 'attempt.finished':
      return {
        ...base,
        category: 'attempt',
        kind: event.type,
        label: `${attemptHarness ?? 'Runtime'} attempt ${event.payload.status}`,
        data: {
          status: event.payload.status,
          summary: event.payload.summary ?? null,
        },
      };
    case 'effect.recorded':
      return {
        ...base,
        category: 'effect',
        kind: event.type,
        label: 'Workspace effect registered',
        data: {
          effectId: event.payload.effect.effectId,
          status: event.payload.effect.status,
          controlLevel: event.payload.effect.controlLevel ?? 'advisory',
        },
      };
    case 'effect.status_changed':
      return {
        ...base,
        category: 'effect',
        kind: event.type,
        label: `Workspace effect ${event.payload.status}`,
        data: {
          effectId: event.payload.effectId,
          status: event.payload.status,
          evidenceRefs: [...event.payload.evidenceRefs],
        },
      };
    case 'receipt.issued':
      return {
        ...base,
        category: 'receipt',
        kind: event.type,
        label: `Outcome ${event.payload.receipt.outcome}`,
        data: {
          receiptId: event.payload.receipt.receiptId,
          outcome: event.payload.receipt.outcome,
          unresolvedItems: [...(event.payload.receipt.unresolvedItems ?? [])],
        },
      };
    case 'runtime.event':
      return {
        ...base,
        category: 'runtime',
        kind: event.type,
        label: `${event.payload.event.sourceHarness} · ${event.payload.event.semanticKind} · source #${String(event.payload.event.sourceSequence)}`,
        harness: event.payload.event.sourceHarness,
        data: event.payload.event as unknown as JsonValue,
      };
    case 'command.accepted':
      return {
        ...base,
        category: 'mission',
        kind: event.type,
        label: `Command ${event.payload.command.action} accepted`,
        data: event.payload.command as unknown as JsonValue,
      };
    case 'command.status_changed':
      return {
        ...base,
        category: 'mission',
        kind: event.type,
        label: `Command ${event.payload.status}`,
        data: event.payload as unknown as JsonValue,
      };
    case 'runtime.observation': {
      if (event.payload.kind === 'mission.spec_snapshot' || event.payload.kind === 'attempt.plan') {
        return undefined;
      }
      const category = observationCategory(event.payload.kind);
      return {
        ...base,
        category,
        kind: event.payload.kind,
        label: observationLabel(event.payload.kind),
        data: event.payload.data,
      };
    }
  }
}

function observationCategory(kind: string): MissionTimelineEntry['category'] {
  if (kind.startsWith('checkpoint.')) return 'checkpoint';
  if (kind.startsWith('handoff.')) return 'handoff';
  if (kind.startsWith('verification.')) return 'verification';
  if (kind.startsWith('failure.')) return 'failure';
  return 'runtime';
}

function observationLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    'attempt.baseline': 'Workspace baseline recorded',
    'checkpoint.created': 'Checkpoint created',
    'handoff.prepared': 'Handoff Capsule prepared',
    'handoff.acknowledged': 'Handoff Capsule acknowledged',
    'handoff.rejected': 'Handoff rejected',
    'runtime.process_started': 'Runtime process started',
    'runtime.process_finished': 'Runtime process finished',
    'context.controller_prompt': 'Observable controller context recorded',
    'verification.completed': 'Acceptance criterion verified',
    'failure.observed': 'Failure observed',
  };
  return labels[kind] ?? kind;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runtimeObservationData(
  event: StoredEventV1 | undefined,
): Record<string, JsonValue> | undefined {
  return event?.type === 'runtime.observation' && isJsonObject(event.payload.data)
    ? event.payload.data
    : undefined;
}

function indexExternalEffectTargets(
  targets: readonly QueryableEffectTarget<JsonValue, JsonValue>[],
): ReadonlyMap<string, QueryableEffectTarget<JsonValue, JsonValue>> {
  const indexed = new Map<string, QueryableEffectTarget<JsonValue, JsonValue>>();
  for (const target of targets) {
    if (target.targetId.trim().length === 0) {
      throw new TypeError('External Effect targetId must not be empty');
    }
    if (indexed.has(target.targetId)) {
      throw new TypeError(`Duplicate external Effect target ${target.targetId}`);
    }
    indexed.set(target.targetId, target);
  }
  return indexed;
}

function profileForAttempt(
  events: readonly StoredEventV1[],
  attempt: AttemptV1,
  initialProfile: ProfileV1,
): ProfileV1 {
  if (initialProfile.profileId === attempt.profileId) return initialProfile;
  const selected = [...events]
    .reverse()
    .find(
      (event): event is Extract<StoredEventV1, { type: 'profile.selected' }> =>
        event.type === 'profile.selected' && event.payload.profile.profileId === attempt.profileId,
    );
  if (selected === undefined) {
    throw new MissionExecutionError(
      `Attempt ${attempt.attemptId} references unknown Profile ${attempt.profileId}`,
    );
  }
  return selected.payload.profile;
}

function projectMissionEffects(events: readonly StoredEventV1[]): EffectV1[] {
  const effects = new Map<string, EffectV1>();
  for (const event of events) {
    if (event.type === 'effect.recorded') {
      if (effects.has(event.payload.effect.effectId)) {
        throw new MissionExecutionError(
          `Effect ${event.payload.effect.effectId} has duplicate immutable records`,
        );
      }
      effects.set(event.payload.effect.effectId, event.payload.effect);
      continue;
    }
    if (event.type !== 'effect.status_changed') continue;
    const effect = effects.get(event.payload.effectId);
    if (effect === undefined) {
      throw new MissionExecutionError(
        `Effect ${event.payload.effectId} changed status before it was recorded`,
      );
    }
    effects.set(effect.effectId, {
      ...effect,
      status: event.payload.status,
      evidenceRefs: uniqueStrings([...effect.evidenceRefs, ...event.payload.evidenceRefs]),
    });
  }
  return [...effects.values()].sort((left, right) => left.effectId.localeCompare(right.effectId));
}

function gitObject(workspace: string, revision: string): string {
  let value: string;
  try {
    value = execFileSync('git', ['-C', workspace, 'rev-parse', '--verify', revision], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new MissionExecutionError(`Git Checkpoint object ${revision} is unavailable`, {
      cause: error,
    });
  }
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new MissionExecutionError(`Git returned an invalid object identity for ${revision}`);
  }
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function profileDefinition(stage: AttemptStageSpecV1): RuntimeProfileDefinitionV1 {
  const configuration = {
    harness: stage.profile.harness,
    requestedModel: stage.profile.model,
    requestedReasoningEffort: stage.profile.reasoningEffort ?? null,
    permissionCeiling: stage.profile.permissionMode ?? null,
    injectionBudgetTokens: stage.profile.injectionBudgetTokens,
  };
  return {
    definitionId: `profile-definition-${hashPayload(configuration).slice(0, 28)}`,
    harness: stage.profile.harness,
    requestedModel: stage.profile.model,
    ...(stage.profile.reasoningEffort === undefined
      ? {}
      : { requestedReasoningEffort: stage.profile.reasoningEffort }),
    ...(stage.profile.permissionMode === undefined
      ? {}
      : { permissionCeiling: stage.profile.permissionMode }),
    injectionBudgetTokens: stage.profile.injectionBudgetTokens,
  };
}

function uniqueProfileDefinitions(spec: MissionSpecV1): RuntimeProfileDefinitionV1[] {
  const definitions = new Map<string, RuntimeProfileDefinitionV1>();
  for (const stage of spec.attemptPlan) {
    const definition = profileDefinition(stage);
    definitions.set(definition.definitionId, definition);
  }
  return [...definitions.values()];
}

function createProfile(
  stage: AttemptStageSpecV1,
  detection: RuntimeDetection,
  workspace: string,
): ProfileV1 {
  const definition = profileDefinition(stage);
  const permissionMode = resolvedPermission(stage.profile.harness, stage.profile.permissionMode);
  const catalogObservation: RuntimeCatalogObservationV1 = {
    observationId: `catalog-${hashPayload({ ...detection, checkedAt: detection.checkedAt }).slice(0, 28)}`,
    harness: stage.profile.harness,
    executablePath: detection.executablePath,
    availability:
      detection.status === 'ready' ? 'ready' : detection.available ? 'unavailable' : 'missing',
    version: detection.version,
    authentication: {
      status: 'unknown',
      reason: 'A version probe does not prove authenticated model access',
    },
    quota: { status: 'unknown', reason: 'Harness did not expose quota during inventory' },
    cost: { status: 'unknown', reason: 'Harness did not expose price during inventory' },
    observedAt: detection.checkedAt,
  };
  const instructions = discoverFiles(workspace, [
    'AGENTS.md',
    'AGENTS.override.md',
    'CLAUDE.md',
    '.claude/CLAUDE.md',
  ]);
  const skillManifests = discoverSkillManifests(workspace, stage.profile.harness);
  const mcpFiles = discoverPresence(workspace, ['.mcp.json', '.claude/mcp.json', 'opencode.json']);
  const effective = {
    model:
      stage.profile.model === 'default'
        ? ({
            status: 'unknown',
            reason: 'Harness resolves its configured default at launch',
          } as const)
        : ({ status: 'known', value: stage.profile.model, source: 'Profile Definition' } as const),
    reasoningEffort:
      stage.profile.reasoningEffort === undefined
        ? ({ status: 'unknown', reason: 'Harness default reasoning was requested' } as const)
        : ({
            status: 'known',
            value: stage.profile.reasoningEffort,
            source: 'Profile Definition',
          } as const),
    instructions:
      instructions.length === 0
        ? ({
            status: 'unknown',
            reason: 'No project instruction file was discovered before launch',
          } as const)
        : ({
            status: 'partial',
            value: instructions,
            source: 'workspace instruction discovery',
            reason:
              'Discovered files are evidence, but the Harness may merge user or nested instructions',
          } as const),
    skills:
      skillManifests.length === 0
        ? ({
            status: 'unknown',
            reason: 'No configured Skill directory was exposed before launch',
          } as const)
        : ({
            status: 'partial',
            value: skillManifests,
            source: 'non-secret Skill directory discovery',
            reason: 'Discovery does not prove which Skills the Harness activates for this turn',
          } as const),
    mcpServers:
      mcpFiles.length === 0
        ? ({ status: 'unknown', reason: 'No project MCP manifest was discovered' } as const)
        : ({
            status: 'partial',
            value: mcpFiles,
            source: 'workspace MCP manifest presence',
            reason: 'Manifest presence does not prove connection or expose secret configuration',
          } as const),
    tools: {
      status: 'unknown',
      reason: 'Native init events may expose tools after launch; the snapshot does not guess',
    } as const,
    permissions: { status: 'known', value: permissionMode, source: 'resolved invocation' } as const,
    contextWindowTokens: {
      status: 'unknown',
      reason: 'Harness did not expose an effective context limit before launch',
    } as const,
    session: { status: 'unknown', reason: 'Native session is created at dispatch time' } as const,
    availability: {
      status: 'known',
      value: catalogObservation.availability,
      source: catalogObservation.observationId,
    } as const,
    quota: catalogObservation.quota,
    cost: catalogObservation.cost,
  };
  const snapshotConfiguration = {
    definition,
    catalogObservation,
    effective,
    adapterCapabilities: adapterCapabilities(stage),
  };
  const digest = hashPayload(snapshotConfiguration);
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: `profile-snapshot-${digest.slice(0, 28)}`,
    harness: stage.profile.harness,
    model: stage.profile.model,
    ...(stage.profile.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: stage.profile.reasoningEffort }),
    ...(detection.version === null ? {} : { runtimeVersion: detection.version }),
    injectionBudgetTokens: stage.profile.injectionBudgetTokens,
    permissionMode,
    capabilities: resolvedProfileCapabilities(stage, permissionMode),
    configurationDigest: digest,
    definition,
    catalogObservation,
    effective,
    adapterCapabilities: adapterCapabilities(stage),
    resolvedAt: detection.checkedAt,
  };
}

function plannerRequirements(
  missionId: string,
  contract: ContractV1,
  sourceStage: AttemptStageSpecV1,
  candidates: readonly PlannedRuntimeCandidate[],
): FrozenMissionCapabilityRequirementsV1 {
  const requiredProfileCapabilities = uniqueStrings(
    resolvedProfileCapabilities(
      sourceStage,
      resolvedPermission(sourceStage.profile.harness, sourceStage.profile.permissionMode),
    ),
  );
  const minimumAdapterCapabilities: NonNullable<
    FrozenMissionCapabilityRequirementsV1['minimumAdapterCapabilities']
  > = {
    observe: 'native',
    interrupt: 'process-only',
    ...(sourceStage.breakpoint === 'mutable-tools' ? { preToolGate: 'native' as const } : {}),
  };
  const allowedHarnesses = uniqueStrings([
    sourceStage.profile.harness,
    ...candidates.map((candidate) => candidate.stage.profile.harness),
  ]);
  const handoffStates = [
    { stateId: 'outcome-contract', required: true },
    { stateId: 'workspace', required: true },
    { stateId: 'visible-context', required: true },
    { stateId: 'effect-frontier', required: true },
  ] as const;
  const frozen = {
    missionId,
    contractId: contract.contractId,
    planNodeId: sourceStage.stageId,
    source: 'contract' as const,
    requiredProfileCapabilities,
    minimumAdapterCapabilities,
    allowedHarnesses,
    handoffStates,
  };
  return {
    requirementsId: `requirements-${hashPayload(frozen).slice(0, 28)}`,
    ...frozen,
  };
}

function plannerObservation(candidate: PlannedRuntimeCandidate): PlannerObservationV1 {
  const observation = requireCatalogObservation(candidate.profile);
  return {
    observationId: observation.observationId,
    observedAt: candidate.detection.checkedAt,
    source: 'local-cli',
    freshness: 'fresh',
    availability:
      candidate.detection.available &&
      candidate.detection.responsive &&
      candidate.detection.status === 'ready'
        ? 'ready'
        : candidate.detection.available
          ? 'unavailable'
          : 'missing',
  };
}

function plannerHandoffState(
  stateId: string,
  classification: CandidateHandoffStateV1['classification'],
  source: CandidateHandoffStateV1['source'] = 'derived',
  freshness: CandidateHandoffStateV1['freshness'] = 'fresh',
): CandidateHandoffStateV1 {
  return {
    stateId,
    classification,
    source,
    freshness,
  };
}

function plannerHandoffStates(
  checkpoint: CompositeCheckpointManifestV1 | undefined,
  contract: ContractV1,
  frontier: CheckpointRecord | undefined,
): readonly CandidateHandoffStateV1[] {
  if (frontier === undefined) {
    return [
      plannerHandoffState('outcome-contract', 'exact'),
      plannerHandoffState('workspace', 'exact'),
      plannerHandoffState('visible-context', 'exact'),
      plannerHandoffState('effect-frontier', 'exact'),
    ];
  }
  if (checkpoint === undefined) {
    return [
      plannerHandoffState('outcome-contract', 'unavailable', 'unknown', 'unknown'),
      plannerHandoffState('workspace', 'unavailable', 'unknown', 'unknown'),
      plannerHandoffState('visible-context', 'unavailable', 'unknown', 'unknown'),
      plannerHandoffState('effect-frontier', 'unavailable', 'unknown', 'unknown'),
    ];
  }
  const visibleContext = checkpoint.components.find(
    (component) => component.component === 'visible-context',
  );
  const effectFrontier = checkpoint.components.find(
    (component) => component.component === 'effect-frontier',
  );
  return [
    plannerHandoffState(
      'outcome-contract',
      checkpoint.source.contractId === contract.contractId ? 'exact' : 'blocking',
    ),
    plannerHandoffState(
      'workspace',
      checkpoint.workspace.workspaceDigest === frontier.delta.afterWorkspaceDigest
        ? 'exact'
        : 'blocking',
    ),
    plannerHandoffState(
      'visible-context',
      visibleContext?.disposition === 'portable' || visibleContext?.disposition === 'recoverable'
        ? 'summarized'
        : 'unavailable',
    ),
    plannerHandoffState('effect-frontier', effectFrontier === undefined ? 'unavailable' : 'exact'),
  ];
}

function compositeCoversHandoffFrontier(
  checkpoint: CompositeCheckpointManifestV1,
  frontier: CheckpointRecord,
  workspace: GitWorkspaceSnapshotV1,
  effects: readonly EffectV1[],
): boolean {
  if (
    checkpoint.source.missionId !== frontier.missionId ||
    checkpoint.source.branchId !== frontier.branchId ||
    checkpoint.source.attemptId !== frontier.attemptId ||
    checkpoint.source.profileId !== frontier.profileId ||
    checkpoint.workspace.workspaceDigest !== workspace.workspaceDigest ||
    workspace.workspaceDigest !== frontier.delta.afterWorkspaceDigest
  ) {
    return false;
  }
  const expected = effects
    .filter((effect) => effect.scope !== 'branch_local_workspace')
    .map((effect) => ({
      effectId: effect.effectId,
      attemptId: effect.attemptId,
      kind: effect.kind,
      resourceKey: effect.resourceKey,
      scope: effect.scope ?? 'unknown',
      status: effect.status,
      controlLevel: effect.controlLevel ?? 'unknown',
      authorityRef: effect.authorityRef ?? null,
      idempotencyKey: effect.idempotencyKey ?? null,
      evidenceRefs: uniqueStrings(effect.evidenceRefs),
    }))
    .sort((left, right) => left.effectId.localeCompare(right.effectId, 'en'));
  const observed = checkpoint.externalEffectFrontier
    .map((effect) => ({
      effectId: effect.effectId,
      attemptId: effect.attemptId,
      kind: effect.kind,
      resourceKey: effect.resourceKey,
      scope: effect.scope,
      status: effect.status,
      controlLevel: effect.controlLevel,
      authorityRef: effect.authorityRef ?? null,
      idempotencyKey: effect.idempotencyKey ?? null,
      evidenceRefs: uniqueStrings(effect.evidenceRefs),
    }))
    .sort((left, right) => left.effectId.localeCompare(right.effectId, 'en'));
  return hashPayload(expected) === hashPayload(observed);
}

function stageMatchesProfile(stage: AttemptStageSpecV1, profile: ProfileV1): boolean {
  if (stage.profile.harness !== profile.harness || stage.profile.model !== profile.model) {
    return false;
  }
  if (
    (stage.profile.reasoningEffort ?? null) !== (profile.reasoningEffort ?? null) ||
    stage.profile.injectionBudgetTokens !== profile.injectionBudgetTokens
  ) {
    return false;
  }
  const definition = profileDefinition(stage);
  return (
    profile.definition === undefined || profile.definition.definitionId === definition.definitionId
  );
}

function discoverFiles(workspace: string, candidates: readonly string[]): JsonValue[] {
  const discovered: JsonValue[] = [];
  for (const candidate of candidates) {
    const file = resolve(workspace, candidate);
    if (!existsSync(file)) continue;
    try {
      const content = readFileSync(file);
      discovered.push({
        path: candidate,
        sha256: createHash('sha256').update(content).digest('hex'),
        byteLength: content.byteLength,
      });
    } catch {
      discovered.push({ path: candidate, status: 'unreadable' });
    }
  }
  return discovered;
}

function discoverPresence(workspace: string, candidates: readonly string[]): JsonValue[] {
  return candidates
    .filter((candidate) => existsSync(resolve(workspace, candidate)))
    .map((candidate) => ({ path: candidate, present: true }));
}

function discoverSkillManifests(workspace: string, harness: SupportedHarnessV1): JsonValue[] {
  const projectCandidates = ['.agents/skills', '.codex/skills', '.claude/skills'];
  const userCandidates = [
    resolve(homedir(), '.agents/skills'),
    ...(harness === 'codex' ? [resolve(homedir(), '.codex/skills')] : []),
    ...(harness === 'claude' ? [resolve(homedir(), '.claude/skills')] : []),
    ...(harness === 'qoder' ? [resolve(homedir(), '.qoder/skills')] : []),
  ];
  const directories = [
    ...projectCandidates.map((path) => ({
      scope: 'project',
      path,
      absolute: resolve(workspace, path),
    })),
    ...userCandidates.map((absolute) => ({ scope: 'user', path: absolute, absolute })),
  ];
  return directories.flatMap((directory) => {
    try {
      const names = readdirSync(directory.absolute, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort();
      return names.length === 0
        ? []
        : [{ scope: directory.scope, path: directory.path, names } as JsonValue];
    } catch {
      return [];
    }
  });
}

function adapterCapabilities(stage: AttemptStageSpecV1): AdapterCapabilitiesV1 {
  return {
    observe: 'native',
    contextCapture: 'unknown',
    steer: 'unsupported',
    interrupt: 'process-only',
    preToolGate: stage.breakpoint === 'mutable-tools' ? 'native' : 'unsupported',
    resume: 'unsupported',
    nativeFork: 'unsupported',
    workspaceRestore: 'unsupported',
    externalEffectControl: 'unknown',
  };
}

function resolvedProfileCapabilities(stage: AttemptStageSpecV1, permissionMode: string): string[] {
  const harness = stage.profile.harness;
  const capabilities = ['workspace-read', 'command-execution'];
  const workspaceWrite =
    (harness === 'codex' &&
      (permissionMode === 'workspace-write' || permissionMode === 'danger-full-access')) ||
    (harness === 'qoder' &&
      ['auto', 'bypass_permissions', 'accept_edits'].includes(permissionMode)) ||
    (harness === 'claude' && ['acceptEdits', 'auto', 'bypassPermissions'].includes(permissionMode));
  if (workspaceWrite) capabilities.push('workspace-write');
  if (stage.breakpoint === 'mutable-tools') capabilities.push('pre-tool-gate:native');
  return capabilities;
}

function requireCatalogObservation(profile: ProfileV1): RuntimeCatalogObservationV1 {
  if (profile.catalogObservation === undefined) {
    throw new MissionExecutionError(`Profile ${profile.profileId} has no Catalog Observation`);
  }
  return profile.catalogObservation;
}

function createAttemptPrompt(
  spec: MissionSpecV1,
  stage: AttemptStageSpecV1,
  contract: ContractV1,
  capsuleText?: string,
): string {
  const criteria = contract.acceptanceCriteria
    .map((criterion) => `- ${criterion.criterionId}: ${criterion.description}`)
    .join('\n');
  const constraints = spec.constraints.map((constraint) => `- ${constraint}`).join('\n');
  return [
    `MissionBraid Mission ${contract.contractId}`,
    `Objective: ${contract.objective}`,
    constraints.length === 0 ? 'Constraints: none declared' : `Constraints:\n${constraints}`,
    `Original acceptance criteria:\n${criteria}`,
    capsuleText === undefined ? '' : capsuleText,
    `Current stage (${stage.stageId}): ${stage.instruction}`,
    'Stay inside the provided workspace. Obey its AGENTS.md. Do not push, publish, deploy, install dependencies, access the network, or modify tests unless the Mission explicitly requires it.',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function processResultSucceeded(result: RuntimeRunResult): boolean {
  return (
    result.process.exitCode === 0 &&
    result.process.signal === null &&
    !result.process.aborted &&
    result.process.spawnError === undefined &&
    result.process.startError === undefined &&
    result.process.observerError === undefined
  );
}

function failureSummary(
  result: RuntimeRunResult,
  acknowledgementRequired: boolean,
  acknowledged: boolean,
  handoffOrderingEstablished: boolean,
  runtimeFailure?: RuntimeFailureObservation,
): string {
  if (runtimeFailure?.code === 'CREDIT_LIMIT') return 'Qoder account credit limit reached';
  if (result.process.aborted) return 'Runtime was interrupted by the MissionBraid controller';
  if (result.process.spawnError !== undefined) return 'Runtime process could not be started';
  if (result.process.startError !== undefined) return 'Runtime PID could not be persisted';
  if (result.process.observerError !== undefined) return 'Runtime output could not be observed';
  if (result.process.signal !== null) return `Runtime process ended from ${result.process.signal}`;
  if (result.process.exitCode !== 0)
    return `Runtime process exited with ${String(result.process.exitCode)}`;
  if (acknowledgementRequired && !acknowledged)
    return 'Target runtime did not acknowledge the Handoff Capsule';
  if (acknowledgementRequired && !handoffOrderingEstablished)
    return 'Target runtime did not establish cooperative Handoff Capsule acknowledgement ordering';
  return 'Runtime attempt did not satisfy the execution contract';
}

export function classifyRuntimeOutputFailure(
  line: RuntimeOutputLine,
): RuntimeFailureObservation | undefined {
  if (line.runtime !== 'qoder' || line.value === undefined) return undefined;
  return findQoderFailure(line.value, new WeakSet<object>(), 0);
}

function findQoderFailure(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): RuntimeFailureObservation | undefined {
  if (depth > 20 || value === null || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.error_code === 118) {
      return {
        classification: 'observed',
        layer: 'runtime-account',
        code: 'CREDIT_LIMIT',
        runtime: 'qoder',
        providerCode: 118,
      };
    }
  }
  const members = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const member of members) {
    const result = findQoderFailure(member, seen, depth + 1);
    if (result !== undefined) return result;
  }
  return undefined;
}

function reconstructExecutionState(events: readonly StoredEventV1[]): ExecutionState {
  const plans = new Map<string, AttemptPlanRecord>();
  const baselines = new Map<string, AttemptBaselineRecord>();
  const finished = new Map<string, 'succeeded' | 'failed' | 'abandoned'>();
  const checkpoints: CheckpointRecord[] = [];
  const effects = new Map<string, ReceiptEffectResultV1>();
  const effectIdsByAttempt = new Map<string, string>();
  const handoffIds: string[] = [];
  const processByAttempt = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'attempt.finished') {
      finished.set(event.payload.attemptId, event.payload.status);
      continue;
    }
    if (event.type === 'effect.recorded') {
      const effect = event.payload.effect;
      if (effect.kind === 'workspace.stage_mutation') {
        effectIdsByAttempt.set(effect.attemptId, effect.effectId);
      }
      effects.set(effect.effectId, {
        effectId: effect.effectId,
        status: effect.status,
        controlLevel: effect.controlLevel ?? 'advisory',
        kind: effect.kind,
        resourceKey: effect.resourceKey,
        evidenceRefs: effect.evidenceRefs,
      });
      continue;
    }
    if (event.type === 'effect.status_changed') {
      const effect = effects.get(event.payload.effectId);
      if (effect !== undefined) {
        effects.set(event.payload.effectId, {
          ...effect,
          status: event.payload.status,
          evidenceRefs: event.payload.evidenceRefs,
        });
      }
      continue;
    }
    if (event.type !== 'runtime.observation') continue;
    const data = event.payload.data as unknown as Record<string, unknown>;
    if (event.payload.kind === 'attempt.plan') {
      if (
        typeof data.attemptId === 'string' &&
        typeof data.stageId === 'string' &&
        (data.harness === 'codex' || data.harness === 'qoder' || data.harness === 'claude') &&
        typeof data.profileId === 'string' &&
        ((typeof data.branchId === 'string' && typeof data.bindingId === 'string') ||
          (data.branchId === undefined && data.bindingId === undefined))
      ) {
        plans.set(data.attemptId, data as unknown as AttemptPlanRecord);
      }
    } else if (event.payload.kind === 'attempt.baseline' && typeof data.attemptId === 'string') {
      baselines.set(data.attemptId, data as unknown as AttemptBaselineRecord);
    } else if (event.payload.kind === 'checkpoint.created') {
      checkpoints.push(data as unknown as CheckpointRecord);
    } else if (event.payload.kind === 'handoff.prepared' && typeof data.capsuleId === 'string') {
      handoffIds.push(data.capsuleId);
    } else if (
      event.payload.kind === 'runtime.process_started' &&
      typeof data.attemptId === 'string' &&
      typeof data.pid === 'number'
    ) {
      processByAttempt.set(data.attemptId, data.pid);
    }
  }
  return {
    plans,
    baselines,
    finished,
    checkpoints,
    doNotRepeatEffectIds: [...effects.values()]
      .filter((effect) => effect.status === 'confirmed' || effect.status === 'ambiguous')
      .map((effect) => effect.effectId)
      .sort((left, right) => left.localeCompare(right, 'en')),
    effects: [...effects.values()],
    effectsByAttempt: new Map(
      [...effectIdsByAttempt].flatMap(([attemptId, effectId]) => {
        const effect = effects.get(effectId);
        return effect === undefined ? [] : [[attemptId, effect] as const];
      }),
    ),
    handoffIds,
    processByAttempt,
  };
}

function activeExecutionPlannerOverride(
  events: readonly StoredEventV1[],
): MissionExecutionPlannerOverrideV1 | undefined {
  let active: MissionExecutionPlannerOverrideV1 | undefined;
  for (const event of events) {
    if (event.type !== 'runtime.observation' || !isJsonObject(event.payload.data)) continue;
    const data = event.payload.data;
    if (event.payload.kind === 'execution-planner.manual_override_set') {
      if (
        typeof data.overrideId === 'string' &&
        typeof data.missionId === 'string' &&
        typeof data.stageId === 'string' &&
        typeof data.profileDefinitionId === 'string' &&
        typeof data.reason === 'string' &&
        typeof data.recordedAt === 'string'
      ) {
        active = data as unknown as MissionExecutionPlannerOverrideV1;
      }
      continue;
    }
    if (
      event.payload.kind === 'execution-planner.manual_override_cleared' &&
      typeof data.overrideId === 'string' &&
      data.overrideId === active?.overrideId
    ) {
      active = undefined;
    }
  }
  return active;
}

function observationIds(
  events: readonly StoredEventV1[],
  kind: string,
  field: string,
): Set<string> {
  return new Set(
    events.flatMap((event) => {
      if (event.type !== 'runtime.observation' || event.payload.kind !== kind) return [];
      const data = isJsonObject(event.payload.data) ? event.payload.data : undefined;
      const value = data?.[field];
      return typeof value === 'string' ? [value] : [];
    }),
  );
}

function toolEffectScope(
  toolName: string,
): 'branch_local_workspace' | 'shared_resource' | 'mission_global_external' {
  if (/^mcp__/i.test(toolName)) return 'mission_global_external';
  if (/^(Write|Edit|NotebookEdit)$/i.test(toolName)) return 'branch_local_workspace';
  return 'shared_resource';
}

async function waitForGatewayPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      resolveWait();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function checkpointIdentity(attemptId: string, delta: StageWorkspaceDeltaV1): string {
  return `checkpoint-${hashPayload({
    attemptId,
    afterWorkspaceDigest: delta.afterWorkspaceDigest,
    changedPaths: delta.changedPaths,
  }).slice(0, 28)}`;
}

function assertRecoveryBaseline(baseline: AttemptBaselineRecord, plan: AttemptPlanRecord): void {
  const snapshot = baseline.snapshot as Partial<GitWorkspaceSnapshotV1> | undefined;
  if (
    baseline.attemptId !== plan.attemptId ||
    baseline.stageId !== plan.stageId ||
    baseline.harness !== plan.harness ||
    baseline.profileId !== plan.profileId ||
    snapshot === undefined ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.workspaceRoot !== 'string' ||
    typeof snapshot.workspaceDigest !== 'string' ||
    typeof snapshot.statusDigest !== 'string' ||
    !Array.isArray(snapshot.status) ||
    !Array.isArray(snapshot.paths)
  ) {
    throw new MissionExecutionError(
      `Cannot recover Attempt ${plan.attemptId}: its persisted before snapshot is invalid`,
    );
  }
}

function nextStageIndex(spec: MissionSpecV1, state: ExecutionState): number {
  for (let index = 0; index < spec.attemptPlan.length; index += 1) {
    const stage = spec.attemptPlan[index]!;
    const progressed = state.checkpoints.some(
      (checkpoint) =>
        checkpoint.stageId === stage.stageId &&
        (checkpoint.status === 'succeeded' || checkpoint.status === 'handed_off'),
    );
    if (!progressed) return index;
  }
  return spec.attemptPlan.length;
}

function latestWaitingReason(events: readonly StoredEventV1[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'mission.status_changed' && event.payload.status === 'waiting') {
      return event.payload.reason;
    }
  }
  return undefined;
}

function codexSandbox(value: string | undefined): CodexSandbox {
  if (value === undefined) return 'workspace-write';
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  throw new MissionExecutionError(`Unsupported Codex permission mode ${value}`);
}

function resolvedPermission(harness: SupportedHarnessV1, value: string | undefined): string {
  if (harness === 'codex') return codexSandbox(value);
  if (harness === 'qoder') return qoderPermission(value);
  return claudePermission(value);
}

function qoderPermission(value: string | undefined): QoderPermissionMode {
  if (value === undefined) return 'dont_ask';
  if (
    value === 'default' ||
    value === 'plan' ||
    value === 'auto' ||
    value === 'bypass_permissions' ||
    value === 'accept_edits' ||
    value === 'dont_ask'
  ) {
    return value;
  }
  throw new MissionExecutionError(`Unsupported Qoder permission mode ${value}`);
}

function claudePermission(value: string | undefined): ClaudePermissionMode {
  if (value === undefined || value === 'default') return 'dontAsk';
  if (
    value === 'acceptEdits' ||
    value === 'auto' ||
    value === 'bypassPermissions' ||
    value === 'manual' ||
    value === 'dontAsk' ||
    value === 'plan'
  ) {
    return value;
  }
  throw new MissionExecutionError(`Unsupported Claude permission mode ${value}`);
}

function runtimeProtocol(harness: SupportedHarnessV1): RuntimeRunResult['outputProtocol'] {
  if (harness === 'codex') return 'codex-jsonl';
  if (harness === 'qoder') return 'qoder-stream-json';
  return 'claude-stream-json';
}

function requireRootBranch(mission: MissionProjectionV1): string {
  if (mission.rootBranchId === undefined) {
    throw new MissionExecutionError(
      `Mission ${mission.missionId} predates Branch identity and cannot execute as Iteration 2`,
    );
  }
  return mission.rootBranchId;
}

function reportedEffectiveProfile(
  value: unknown,
  profile: ProfileV1,
): Record<string, JsonValue> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const message =
    record.message !== null && typeof record.message === 'object' && !Array.isArray(record.message)
      ? (record.message as Record<string, unknown>)
      : undefined;
  const observedModel = firstString(record.model, message?.model);
  const permissionMode = firstString(record.permissionMode, record.permission_mode);
  const sessionId = firstString(record.session_id, record.sessionId);
  const tools = namedRuntimeMembers(record.tools);
  const skills = namedRuntimeMembers(record.skills);
  const slashCommands = namedRuntimeMembers(record.slash_commands, record.slashCommands);
  const mcpServers = namedRuntimeMembers(record.mcp_servers, record.mcpServers);
  const runtimeVersion = firstString(
    record.claude_code_version,
    record.runtime_version,
    record.runtimeVersion,
  );
  const contextWindowTokens = reportedContextWindow(record, observedModel);
  const costUsd = typeof record.total_cost_usd === 'number' ? record.total_cost_usd : undefined;
  if (
    observedModel === undefined &&
    permissionMode === undefined &&
    sessionId === undefined &&
    tools === undefined &&
    skills === undefined &&
    slashCommands === undefined &&
    mcpServers === undefined &&
    runtimeVersion === undefined &&
    contextWindowTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }
  return {
    requestedModel: profile.model,
    observedModel: observedModel ?? null,
    modelOverride:
      observedModel === undefined || profile.model === 'default'
        ? false
        : observedModel !== profile.model,
    permissionMode: permissionMode ?? null,
    sessionId: sessionId ?? null,
    tools: tools ?? null,
    skills: skills ?? null,
    slashCommands: slashCommands ?? null,
    mcpServers: mcpServers ?? null,
    runtimeVersion: runtimeVersion ?? null,
    contextWindowTokens: contextWindowTokens ?? null,
    costUsd: costUsd ?? null,
  };
}

function namedRuntimeMembers(...values: readonly unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const names = value.flatMap((member) => {
      if (typeof member === 'string' && member.length > 0) return [member];
      if (member === null || typeof member !== 'object' || Array.isArray(member)) return [];
      const record = member as Record<string, unknown>;
      const name = firstString(record.name, record.id, record.command);
      const status = firstString(record.status, record.state);
      return name === undefined ? [] : [status === undefined ? name : `${name} (${status})`];
    });
    return [...new Set(names)].sort();
  }
  return undefined;
}

function reportedContextWindow(
  record: Record<string, unknown>,
  observedModel: string | undefined,
): number | undefined {
  const direct = firstFiniteNumber(
    record.context_window,
    record.contextWindow,
    record.context_window_tokens,
    record.contextWindowTokens,
  );
  if (direct !== undefined) return direct;
  if (
    record.modelUsage === null ||
    typeof record.modelUsage !== 'object' ||
    Array.isArray(record.modelUsage)
  ) {
    return undefined;
  }
  const usages = record.modelUsage as Record<string, unknown>;
  const candidates = [
    ...(observedModel === undefined ? [] : [usages[observedModel]]),
    ...Object.values(usages),
  ];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const usage = candidate as Record<string, unknown>;
    const contextWindow = firstFiniteNumber(
      usage.contextWindow,
      usage.context_window,
      usage.contextWindowTokens,
      usage.context_window_tokens,
    );
    if (contextWindow !== undefined) return contextWindow;
  }
  return undefined;
}

function firstFiniteNumber(...values: readonly unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

function assertControlStateIsolation(stateDir: string, workspace: string): void {
  const canonicalStateDir = realpathSync(stateDir);
  const canonicalWorkspace = realpathSync(workspace);
  if (
    isPathInside(canonicalWorkspace, canonicalStateDir) ||
    isPathInside(canonicalStateDir, canonicalWorkspace)
  ) {
    throw new MissionExecutionError(
      'Controller state directory and target workspace must be disjoint; choose --state-dir outside the target workspace',
    );
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
