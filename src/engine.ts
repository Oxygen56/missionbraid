import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

import { CodexAdapter, type CodexSandbox } from './adapters/codex.js';
import { ClaudeAdapter, type ClaudePermissionMode } from './adapters/claude.js';
import { QoderAdapter, type QoderPermissionMode } from './adapters/qoder.js';
import type { RuntimeDetection, RuntimeOutputLine, RuntimeRunResult } from './adapters/types.js';
import { AdapterHostV1 } from './adapter-host.js';
import { AdapterRegistryV1, type AdapterManifestV1 } from './adapter-sdk.js';
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
  type RuntimeAdapterIdentityV1,
  type RuntimeBindingV1,
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
  isSupportedHarnessV1,
  loadMissionSpec,
  restoreMissionSpecSnapshot,
  type AttemptStageSpecV1,
  type CommandVerifierSpecV1,
  type MissionPlanNodeSpecV1,
  type MissionSpecV1,
  type SupportedHarnessV1,
} from './spec.js';
import {
  contextPrompt,
  readContextBinding,
  type ContextBindingMaterialV1,
} from './context-binding.js';
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
  type ExecutionForkProfileSelectionV1,
  type ExecutionForkRecordV1,
  type RuntimeContinuationPortV1,
} from './execution-fork.js';
import { executionForkEventToMissionEvents } from './mission-execution-fork.js';
import {
  NativeAdapterRuntimeContinuationPort,
  executionForkProfileAuthorityChange,
} from './runtime-continuation.js';
import {
  deriveMissionFailureIntelligence,
  type DiagnosticForkProjectionInputV1,
  type MissionFailureIntelligenceProjectionV1,
} from './mission-failure-intelligence.js';
import {
  createMissionOutcomeStudioView,
  type MissionOutcomeStudioInputV1,
  type MissionOutcomeStudioViewV1,
} from './mission-outcome-studio.js';
import {
  OutcomeStudioRegistry,
  rerunIncidentScenario,
  selectVerifiedOutcomeBranch,
  verifyOutcomeBranchSelection,
  verifyOutcomeCiResult,
  verifyIncidentScenario,
  verifyStudioOutcomeReceipt,
  type BranchEvaluationV1,
  type IncidentScenarioV1,
  type OutcomeBranchSelectionV1,
  type OutcomeCiResultV1,
  type StudioOutcomeReceiptV1,
} from './outcome-studio.js';
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
import {
  analyzeSelectiveInvalidation,
  createContractRevision,
  createMissionPlanRevision,
  planConsolidationAttempt,
  recordPlanArtifact,
  recordWorkspaceIntegrationOutcome,
  type ActivePlanAttemptV1,
  type ConsolidationAttemptPlanV1,
  type ContractRequirementV1,
  type ContractRevisionV1,
  type DeterministicVerifierEvidenceV1,
  type MissionPlanRevisionV1,
  type PlanArtifactV1,
  type SelectiveInvalidationV1,
  type StaleAttemptFenceV1,
  type WorkspaceIntegrationOutcomeV1,
} from './mission-plan.js';
import {
  projectMissionPlanRuntime,
  type MissionPlanRuntimeProjectionV1,
} from './mission-plan-runtime.js';

export type { MissionPlanRuntimeProjectionV1 } from './mission-plan-runtime.js';

const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;

export interface MissionEngineOptions {
  readonly stateDir: string;
  readonly codexAdapter?: CodexAdapter;
  readonly qoderAdapter?: QoderAdapter;
  readonly claudeAdapter?: ClaudeAdapter;
  /** Public SDK Adapters; they submit evidence/outcome through AdapterHostV1 only. */
  readonly adapterRegistry?: AdapterRegistryV1;
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly externalEffectTargets?: readonly QueryableEffectTarget<JsonValue, JsonValue>[];
  readonly beforeExternalEffectAppend?: (
    event: ExternalEffectEvent<JsonValue>,
  ) => void | Promise<void>;
  readonly modelOnlyResamplePort?: ModelOnlyResamplePortV1;
}

export interface MissionOutcomeStudioScenarioCollectionV1 {
  readonly missionId: string;
  readonly scenarios: readonly IncidentScenarioV1[];
  readonly ciResults: readonly OutcomeCiResultV1[];
}

export interface MissionOutcomeStudioKernelTrialV1 {
  readonly trialIndex: number;
  readonly sourceProfileId: string;
  readonly targetProfileId: string;
  readonly targetStageId: string;
  readonly profileSelectionId: string;
  readonly plannerDecisionHash: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly bindingId: string;
  readonly runtimeRunId: string;
  readonly receiptId: string;
  readonly receiptOutcome: ReceiptV1['outcome'];
  readonly eventHeadHash: string;
  readonly eventThroughSeq: number;
  readonly criterionEvidenceRefs: readonly string[];
  readonly runtimeEvidenceRefs: readonly string[];
  readonly retainedArtifactRefs: readonly string[];
}

interface MissionOutcomeStudioRerunCoreV1 {
  readonly schemaVersion: 'missionbraid.dev/outcome-kernel-rerun/v1';
  readonly missionId: string;
  readonly scenarioId: string;
  readonly contractId: string;
  readonly sourceCheckpointId: string;
  readonly sourceProfileId: string;
  readonly executionKey: string;
  readonly trialCount: number;
  readonly trials: readonly MissionOutcomeStudioKernelTrialV1[];
  readonly targetBranchId: string;
  readonly targetAgentRevisionId: string;
  readonly targetProfileId: string;
  readonly targetStageId: string;
  readonly targetProfileDefinitionId: string;
  readonly profileSelectionId: string;
  readonly evaluation: BranchEvaluationV1;
  readonly receipt: StudioOutcomeReceiptV1;
  readonly ciResult: OutcomeCiResultV1;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface MissionOutcomeStudioRerunV1 extends MissionOutcomeStudioRerunCoreV1 {
  readonly runId: string;
  readonly runHash: string;
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

export interface MissionPlanView {
  readonly contractRevision: ContractRevisionV1;
  readonly planRevision: MissionPlanRevisionV1;
  readonly invalidations: readonly SelectiveInvalidationV1[];
  readonly execution: MissionPlanExecutionViewV1;
}

export interface MissionPlanAttemptViewV1 {
  readonly attemptId: string;
  readonly nodeId: string;
  readonly harness: string;
  readonly branchId: string;
  readonly workspaceKey: string;
  readonly planRevisionId: string;
  readonly contractRevisionId: string;
  readonly nodeVersion: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'abandoned';
  readonly fence: StaleAttemptFenceV1 | null;
}

export interface MissionPlanArtifactRecordV1 {
  readonly recordId: string;
  readonly artifact: PlanArtifactV1;
  readonly attemptId: string;
  readonly branchId: string;
  readonly workspaceKey: string;
  readonly workspacePath: string;
  readonly sourceCommit: string;
  readonly changedPaths: readonly string[];
  readonly recordedAt: string;
  readonly reusedFromArtifactId?: string;
  readonly invalidationId?: string;
}

export interface MissionPlanConsolidationRecordV1 {
  readonly plan: ConsolidationAttemptPlanV1;
  readonly outcome?: WorkspaceIntegrationOutcomeV1;
  readonly sourceArtifactIds: readonly string[];
  readonly workspacePath: string;
  readonly sourceCommitsBefore: Readonly<Record<string, string>>;
  readonly sourceCommitsAfter?: Readonly<Record<string, string>>;
  readonly recordedAt: string;
}

export interface MissionPlanExecutionViewV1 {
  readonly attempts: readonly MissionPlanAttemptViewV1[];
  readonly artifacts: readonly MissionPlanArtifactRecordV1[];
  readonly fences: readonly StaleAttemptFenceV1[];
  readonly consolidations: readonly MissionPlanConsolidationRecordV1[];
}

export interface MissionPlanExecutionResultV1 {
  readonly missionId: string;
  readonly status: 'succeeded' | 'waiting' | 'failed';
  readonly receipt?: ReceiptV1;
  readonly waitingReason?: string;
}

export interface ReviseMissionContractInputV1 {
  readonly contract: ContractV1;
  readonly requirements: readonly ContractRequirementV1[];
  readonly reason: string;
  readonly evidenceRefs?: readonly string[];
  readonly authorityChanges?: Parameters<typeof createContractRevision>[0]['authorityChanges'];
}

export interface ReviseMissionContractResultV1 {
  readonly contractRevision: ContractRevisionV1;
  readonly planRevision: MissionPlanRevisionV1;
  readonly invalidation: SelectiveInvalidationV1;
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
  /** Explicit already-declared Runtime Profile Definition selected for a Profile-Rebound Fork. */
  readonly targetProfileDefinitionId?: string;
  readonly childBranchId?: string;
  /** Optional Kernel-bound diagnostic candidate. Generic Forks remain unchanged. */
  readonly diagnosticCandidateId?: string;
}

export interface MissionOutcomeStudioRerunRequestV1 {
  readonly targetStageId: string;
  readonly targetProfileDefinitionId: string;
}

export interface MissionDiagnosticForkRequestV1
  extends Omit<MissionExecutionForkRequestV1, 'diagnosticCandidateId'> {
  readonly candidateId: string;
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
  readonly harness: string;
  readonly profileId: string;
  readonly branchId: string;
  readonly bindingId: string;
  readonly workspaceKey?: string;
  readonly planRevisionId?: string;
  readonly contractRevisionId?: string;
  readonly nodeVersion?: string;
}

interface AttemptBaselineRecord {
  readonly attemptId: string;
  readonly stageId: string;
  readonly harness: string;
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
  readonly harness: string;
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

interface ResolvedExecutionForkRuntime {
  readonly stage: AttemptStageSpecV1;
  readonly sourceProfile: ProfileV1;
  readonly targetProfile: ProfileV1;
  readonly profileSelection?: ExecutionForkProfileSelectionV1;
  readonly selectionEvents: readonly EventV1[];
}

interface ActiveMissionPlanNodeRun {
  readonly attemptId: string;
  readonly nodeId: string;
  readonly nodeVersion: string;
  readonly planRevisionId: string;
  readonly contractRevisionId: string;
  readonly harness: string;
  readonly branchId: string;
  readonly workspaceKey: string;
  readonly workspacePath: string;
  readonly controller: AbortController;
  fence?: StaleAttemptFenceV1;
}

interface ActiveMissionPlanRun {
  readonly missionId: string;
  readonly fence: WorkspaceFenceV1;
  readonly spec: MissionSpecV1;
  readonly baselineCheckpointId: string;
  readonly baselineCommit: string;
  readonly attempts: Map<string, ActiveMissionPlanNodeRun>;
}

interface MissionPlanNodeRunOutcome {
  readonly attemptId: string;
  readonly nodeId: string;
  readonly status: 'succeeded' | 'failed' | 'abandoned';
  readonly artifact?: MissionPlanArtifactRecordV1;
  readonly detail?: string;
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
  readonly #adapterHost: AdapterHostV1;
  readonly #artifacts: NativeArtifactStore;
  readonly #externalEffectTargets: ReadonlyMap<string, QueryableEffectTarget<JsonValue, JsonValue>>;
  readonly #beforeExternalEffectAppend:
    | ((event: ExternalEffectEvent<JsonValue>) => void | Promise<void>)
    | undefined;
  readonly #modelOnlyResample: ModelOnlyResamplePortV1;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #activePlanRuns = new Map<string, ActiveMissionPlanRun>();

  constructor(options: MissionEngineOptions) {
    this.#stateDir = resolve(options.stateDir);
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#codex = options.codexAdapter ?? new CodexAdapter();
    this.#qoder = options.qoderAdapter ?? new QoderAdapter();
    this.#claude = options.claudeAdapter ?? new ClaudeAdapter();
    this.#adapterHost = new AdapterHostV1({
      registry: options.adapterRegistry ?? new AdapterRegistryV1(),
      now: this.#now,
    });
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
    assertExecutablePlanTerminalJoin(spec);
    const specSnapshot = createMissionSpecSnapshot(spec);
    const missionId = `mission-${this.#id()}`;
    const rootBranchId = `branch-root-${this.#id()}`;
    const workspaceKey = `workspace-${hashPayload(spec.workspace).slice(0, 32)}`;
    const ownerId = `runner-${this.#id()}`;
    return await this.#withLease(workspaceKey, ownerId, async (fence) => {
      const contract = createContract(spec, this.#now());
      const initialStage = spec.attemptPlan[0]!;
      const detection = await this.#detectStage(initialStage);
      const profile = createProfile(
        initialStage,
        detection,
        spec.workspace,
        this.#adapterManifest(initialStage),
      );
      const createdAt = this.#now().toISOString();
      const contractRevision = createContractRevision({
        missionId,
        contract,
        requirements: requirementsFromSpec(spec),
        provenance: { reason: 'Initial Mission Contract', evidenceRefs: [`mission:${missionId}`] },
        createdAt,
      });
      const planRevision = createMissionPlanRevision({
        planId: `plan-${missionId}`,
        missionId,
        contractRevision,
        nodes:
          spec.plan === undefined
            ? spec.attemptPlan.map((stage) => ({
                nodeId: stage.stageId,
                kind: 'task' as const,
                title: stage.stageId,
                requirementIds: requirementsFromSpec(spec).map((r) => r.requirementId),
                inputArtifactIds: [],
                declaredOutputKeys: [`stage:${stage.stageId}`],
                requiredAuthorityScopes: ['workspace'],
                // Legacy attemptPlan is a fallback route, not a parallel DAG.
                workspace: {
                  access: 'read-only' as const,
                  workspaceKey,
                  sharedResourceKeys: [],
                },
                provenanceEvidenceRefs: [`mission:${missionId}:stage:${stage.stageId}`],
              }))
            : spec.plan.nodes.map((node) => ({
                nodeId: node.nodeId,
                kind: node.kind,
                title: node.title,
                requirementIds: node.requirementIds,
                inputArtifactIds: [],
                declaredOutputKeys: node.declaredOutputKeys,
                requiredAuthorityScopes: node.requiredAuthorityScopes,
                workspace: {
                  access: 'isolated-writable' as const,
                  workspaceKey: `workspace-plan-${hashPayload({ missionId, nodeId: node.nodeId }).slice(0, 28)}`,
                  sharedResourceKeys: [],
                },
                provenanceEvidenceRefs: [
                  `mission:${missionId}:plan-node:${node.nodeId}`,
                  `stage:${node.stageId}`,
                ],
              })),
        edges:
          spec.plan === undefined
            ? spec.attemptPlan.slice(1).map((stage, index) => ({
                fromNodeId: spec.attemptPlan[index]!.stageId,
                toNodeId: stage.stageId,
                relation: 'depends-on' as const,
                evidenceRefs: [`mission:${missionId}`],
              }))
            : spec.plan.edges,
        provenance: { source: 'deterministic-planner', evidenceRefs: [`mission:${missionId}`] },
        createdAt,
      });
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
      const definitionEvents = uniqueProfileDefinitions(spec, (stage) =>
        this.#adapterManifest(stage),
      ).map(
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
      const planEvents: EventV1[] = [
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: createdAt,
          type: 'runtime.observation',
          payload: {
            kind: 'mission.contract_revision.created',
            data: contractRevision as unknown as JsonValue,
          },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: createdAt,
          type: 'runtime.observation',
          payload: {
            kind: 'mission.plan_revision.created',
            data: planRevision as unknown as JsonValue,
          },
        },
      ];
      this.#store.appendEvents(
        [
          createdEvent,
          branchEvent,
          catalogEvent,
          ...definitionEvents,
          specSnapshotEvent,
          ...planEvents,
        ],
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

  /** Rebuilds branch-scoped Failure Intelligence from the persisted Kernel chain. */
  async failureIntelligence(
    missionId: string,
    branchId?: string,
  ): Promise<MissionFailureIntelligenceProjectionV1> {
    const mission = this.#requireMission(missionId);
    const selectedBranchId = branchId ?? mission.rootBranchId;
    if (
      selectedBranchId === undefined ||
      this.#store.getBranch(missionId, selectedBranchId) === undefined
    ) {
      throw new MissionExecutionError(
        `Branch ${selectedBranchId ?? 'unknown'} does not belong to Mission ${missionId}`,
      );
    }
    const events = this.#store.listEvents(missionId);
    const contextGraph = await this.contextGraph(missionId);
    const checkpoints = this.compositeCheckpoints(missionId)
      .filter((checkpoint) => checkpoint.source.branchId === selectedBranchId)
      .sort((left, right) => left.eventPrefix.throughSeq - right.eventPrefix.throughSeq);
    const checkpoint = checkpoints.at(-1);
    const diagnosticForks: DiagnosticForkProjectionInputV1[] = [];
    if (checkpoint !== undefined) {
      const requests = events.flatMap((event) => {
        if (
          event.type !== 'runtime.observation' ||
          event.payload.kind !== 'failure.diagnostic_requested' ||
          !isJsonObject(event.payload.data) ||
          event.payload.data.branchId !== selectedBranchId ||
          event.payload.data.checkpointId !== checkpoint.checkpointId ||
          typeof event.payload.data.candidateId !== 'string' ||
          !isJsonObject(event.payload.data.changedVariable) ||
          typeof event.payload.data.interventionId !== 'string'
        ) {
          return [];
        }
        return [
          {
            candidateId: event.payload.data.candidateId,
            changedVariable: event.payload.data.changedVariable,
            interventionId: event.payload.data.interventionId,
            childBranchId:
              typeof event.payload.data.childBranchId === 'string'
                ? event.payload.data.childBranchId
                : undefined,
          },
        ];
      });
      if (requests.length > 0) {
        const forks = await this.executionForks(missionId);
        for (const request of requests) {
          const fork = forks.find(
            (candidate) =>
              candidate.lineage.parentCheckpointId === checkpoint.checkpointId &&
              candidate.lineage.parentBranchId === selectedBranchId &&
              candidate.lineage.intervention.interventionId === request.interventionId &&
              (request.childBranchId === undefined ||
                candidate.lineage.childBranchId === request.childBranchId),
          );
          if (fork === undefined) continue;
          const receiptEvent = events.find(
            (event) =>
              event.type === 'receipt.issued' &&
              (event.payload.receipt.branchId ?? event.payload.receipt.rootBranchId) ===
                fork.lineage.childBranchId,
          );
          const verificationRefs = fork.runtimeResult?.verificationEvidenceRefs ?? [];
          diagnosticForks.push({
            candidateId: request.candidateId,
            changedVariable:
              request.changedVariable as unknown as DiagnosticForkProjectionInputV1['changedVariable'],
            fork,
            evaluation: 'deterministic',
            ...(receiptEvent === undefined ? {} : { receiptEventId: receiptEvent.eventId }),
            ...(verificationRefs.length === 0 ? {} : { evaluationEvidenceRefs: verificationRefs }),
          });
        }
      }
    }
    return deriveMissionFailureIntelligence({
      missionId,
      branchId: selectedBranchId,
      events,
      contextGraph,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(diagnosticForks.length === 0 ? {} : { diagnosticForks }),
    });
  }

  /**
   * Rebuild the Outcome/Eval/Incident Studio projection from immutable Mission
   * evidence.  This is intentionally a read-only projection: the Studio
   * never changes Kernel state, accepts a Branch, or signs the Kernel Receipt.
   */
  async outcomeStudio(missionId: string, branchId?: string): Promise<MissionOutcomeStudioViewV1> {
    const mission = this.#requireMission(missionId);
    const events = this.#store.listEvents(missionId);
    const created = events.find(
      (event): event is Extract<StoredEventV1, { type: 'mission.created' }> =>
        event.type === 'mission.created',
    );
    if (created === undefined) {
      throw new MissionExecutionError(`Mission ${missionId} has no creation event`);
    }
    const branches = this.#store.listBranches(missionId);
    const receipts = events
      .filter(
        (event): event is Extract<StoredEventV1, { type: 'receipt.issued' }> =>
          event.type === 'receipt.issued',
      )
      .map((event) => event.payload.receipt);
    const contractRevisions = events
      .filter(
        (event): event is Extract<StoredEventV1, { type: 'runtime.observation' }> =>
          event.type === 'runtime.observation' &&
          event.payload.kind === 'mission.contract_revision.created' &&
          isJsonObject(event.payload.data),
      )
      .map((event) => event.payload.data as unknown as ContractRevisionV1)
      .filter((revision) => revision.contract !== undefined)
      .sort((left, right) => left.revisionNumber - right.revisionNumber);
    const latestContract = contractRevisions.at(-1)?.contract ?? created.payload.contract;
    const latestReceipt = [...receipts].at(-1);
    const selectedBranchId =
      branchId ?? latestReceipt?.branchId ?? latestReceipt?.rootBranchId ?? mission.rootBranchId;
    if (selectedBranchId === undefined) {
      throw new MissionExecutionError(`Mission ${missionId} has no Branch identity`);
    }
    const selected = branches.find((candidate) => candidate.branchId === selectedBranchId);
    if (selected === undefined) {
      throw new MissionExecutionError(
        `Branch ${selectedBranchId} is not persisted for Mission ${missionId}`,
      );
    }

    const checkpoints = this.compositeCheckpoints(missionId);
    const forkRecords = await this.executionForks(missionId);
    const effects = projectMissionEffects(events);

    const build = (
      branch: BranchV1,
    ): {
      readonly input: MissionOutcomeStudioInputV1;
      readonly view: MissionOutcomeStudioViewV1;
    } => {
      const directCheckpoint = [...checkpoints]
        .filter((checkpoint) => checkpoint.source.branchId === branch.branchId)
        .sort((left, right) => left.eventPrefix.throughSeq - right.eventPrefix.throughSeq)
        .at(-1);
      const baseCheckpoint =
        directCheckpoint ??
        (branch.baseCheckpointId === undefined
          ? undefined
          : checkpoints.find((checkpoint) => checkpoint.checkpointId === branch.baseCheckpointId));
      const startedAttempts = events
        .filter(
          (event): event is Extract<StoredEventV1, { type: 'attempt.started' }> =>
            event.type === 'attempt.started' && event.payload.attempt.branchId === branch.branchId,
        )
        .map((event) => event.payload.attempt);
      const bindings = events
        .filter(
          (event): event is Extract<StoredEventV1, { type: 'attempt.bound' }> =>
            event.type === 'attempt.bound' && event.payload.binding.branchId === branch.branchId,
        )
        .map((event) => event.payload.binding);
      const binding =
        [...bindings]
          .reverse()
          .find((candidate) => candidate.attemptId === baseCheckpoint?.source.attemptId) ??
        bindings.at(-1);
      const attempt =
        (binding === undefined
          ? undefined
          : startedAttempts.find((candidate) => candidate.attemptId === binding.attemptId)) ??
        (baseCheckpoint === undefined
          ? undefined
          : events
              .filter(
                (event): event is Extract<StoredEventV1, { type: 'attempt.started' }> =>
                  event.type === 'attempt.started' &&
                  event.payload.attempt.attemptId === baseCheckpoint.source.attemptId,
              )
              .map((event) => event.payload.attempt)
              .at(-1));
      const profile =
        attempt === undefined
          ? created.payload.profile
          : profileForAttempt(events, attempt, created.payload.profile);
      const receipt = [...receipts]
        .reverse()
        .find((candidate) => (candidate.branchId ?? candidate.rootBranchId) === branch.branchId);
      const branchContract =
        (receipt === undefined
          ? undefined
          : [...contractRevisions]
              .reverse()
              .find((revision) => revision.contract.contractId === receipt.contractId)?.contract) ??
        latestContract;
      const fork = forkRecords.find(
        (candidate) => candidate.lineage.childBranchId === branch.branchId,
      );
      const createdAt =
        receipt?.issuedAt ?? baseCheckpoint?.capturedAt ?? branch.createdAt ?? mission.createdAt;
      const input: MissionOutcomeStudioInputV1 = {
        mission: created.payload.mission,
        contract: branchContract,
        profile,
        branch,
        ...(binding === undefined ? {} : { attemptBinding: binding }),
        ...(baseCheckpoint === undefined ? {} : { checkpoint: baseCheckpoint }),
        ...(fork === undefined ? {} : { intervention: fork.lineage.intervention }),
        events,
        effects,
        ...(receipt === undefined ? {} : { receipt }),
        createdAt,
      };
      return { input, view: createMissionOutcomeStudioView(input) };
    };

    const initial = build(selected);
    const siblingBranches = branches
      .filter((candidate) => candidate.branchId !== selected.branchId)
      .map((candidate) => build(candidate).view.branch)
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    if (initial.view.branch === null || siblingBranches.length === 0) return initial.view;
    return createMissionOutcomeStudioView({ ...initial.input, siblingBranches });
  }

  /** Persist the sanitized Studio scenario and CI projection as observations.
   * Kernel events and receipts remain authoritative; these records are an
   * evidence export that can be reopened or downloaded by the Workbench.
   */
  async saveOutcomeStudioScenario(
    missionId: string,
    branchId?: string,
  ): Promise<MissionOutcomeStudioScenarioCollectionV1> {
    const mission = this.#requireMission(missionId);
    const view = await this.outcomeStudio(missionId, branchId);
    if (view.incidentScenario === null) {
      throw new MissionExecutionError(
        `Mission ${missionId} has no complete Outcome Studio scenario`,
      );
    }
    verifyIncidentScenario(view.incidentScenario);
    const ownerId = `outcome-studio-save-${this.#id()}`;
    await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      const existing = this.outcomeStudioScenarios(missionId);
      if (
        !existing.scenarios.some(
          (scenario) => scenario.scenarioId === view.incidentScenario!.scenarioId,
        )
      ) {
        this.#observe(
          missionId,
          'outcome-studio.incident-scenario.saved',
          view.incidentScenario as unknown as JsonValue,
          fence,
        );
      }
      if (
        view.ciResult !== null &&
        !existing.ciResults.some((result) => result.resultId === view.ciResult!.resultId)
      ) {
        this.#observe(
          missionId,
          'outcome-studio.ci-result.saved',
          view.ciResult as unknown as JsonValue,
          fence,
        );
      }
    });
    return this.outcomeStudioScenarios(missionId);
  }

  async selectOutcomeStudioBranch(
    missionId: string,
    branchId: string,
    authorityRef: string,
    authorityKind: 'human' | 'external-authority' = 'human',
  ): Promise<OutcomeBranchSelectionV1> {
    const mission = this.#requireMission(missionId);
    const view = await this.outcomeStudio(missionId, branchId);
    if (view.comparison === null || view.studioReceipt === null) {
      throw new MissionExecutionError(
        `Mission ${missionId} has no verified compared Branch ready for selection`,
      );
    }
    const selection = selectVerifiedOutcomeBranch({
      comparison: view.comparison,
      receipt: view.studioReceipt,
      authorityKind,
      authorityRef,
      decidedAt: this.#now().toISOString(),
    });
    const ownerId = `outcome-selection-${this.#id()}`;
    await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      if (
        this.outcomeStudioSelections(missionId).some(
          (existing) => existing.selectionId === selection.selectionId,
        )
      ) {
        return;
      }
      this.#observe(
        missionId,
        'outcome-studio.branch-selection.saved',
        selection as unknown as JsonValue,
        fence,
      );
    });
    return selection;
  }

  outcomeStudioSelections(missionId: string): readonly OutcomeBranchSelectionV1[] {
    this.#requireMission(missionId);
    const selections: OutcomeBranchSelectionV1[] = [];
    for (const event of this.#store.listEvents(missionId)) {
      if (
        event.type !== 'runtime.observation' ||
        event.payload.kind !== 'outcome-studio.branch-selection.saved' ||
        !isJsonObject(event.payload.data)
      ) {
        continue;
      }
      try {
        const selection = event.payload.data as unknown as OutcomeBranchSelectionV1;
        verifyOutcomeBranchSelection(selection);
        selections.push(selection);
      } catch {
        // Historical malformed evidence never becomes an accepted selection.
      }
    }
    return selections;
  }

  async rerunOutcomeStudioScenario(
    missionId: string,
    scenarioId: string,
    request: MissionOutcomeStudioRerunRequestV1,
    signal?: AbortSignal,
  ): Promise<MissionOutcomeStudioRerunV1> {
    const mission = this.#requireMission(missionId);
    const scenario = this.outcomeStudioScenarios(missionId).scenarios.find(
      (candidate) => candidate.scenarioId === scenarioId,
    );
    if (scenario === undefined) {
      throw new MissionExecutionError(
        `Outcome Studio scenario ${scenarioId} is not saved for Mission ${missionId}`,
      );
    }
    verifyIncidentScenario(scenario);
    if (scenario.contractId !== mission.contract.contractId || scenario.executionPlan === null) {
      throw new MissionExecutionError('Outcome Studio scenario is not executable by this Mission');
    }
    const executionPlan = scenario.executionPlan;
    const suite = executionPlan.evaluationSuite;
    const trialCounts = uniqueStrings(
      suite.criteria.map((criterion) => String(criterion.trialCount)),
    );
    if (
      trialCounts.length !== 1 ||
      suite.criteria.some(
        (criterion) =>
          criterion.mode !== 'stochastic-model' ||
          criterion.threshold === null ||
          criterion.threshold.minimumKnownTrials > criterion.trialCount,
      )
    ) {
      throw new MissionExecutionError(
        'Kernel scenario reruns require one predeclared stochastic trial count and threshold',
      );
    }
    const trialCount = Number(trialCounts[0]);
    const intervention = incidentScenarioIntervention(scenario);
    const executionKey = `outcome-kernel-run-${this.#id()}`;
    const startedAt = this.#now().toISOString();
    const runSeed = hashPayload({
      missionId,
      scenarioId,
      executionKey,
      startedAt,
      targetStageId: request.targetStageId,
      targetProfileDefinitionId: request.targetProfileDefinitionId,
    });
    await this.#withLease(
      mission.workspaceKey,
      `outcome-rerun-start-${this.#id()}`,
      async (fence) => {
        this.#observe(
          missionId,
          'outcome-studio.incident-rerun.started',
          {
            executionKey,
            scenarioId,
            suiteId: suite.suiteId,
            suiteHash: suite.suiteHash,
            sourceCheckpointId: scenario.sourceCheckpointId,
            sourceProfileId: executionPlan.sourceProfileId,
            targetStageId: request.targetStageId,
            targetProfileDefinitionId: request.targetProfileDefinitionId,
            trialCount,
            thresholds: suite.criteria.map((criterion) => ({
              criterionId: criterion.criterionId,
              threshold: criterion.threshold,
            })),
            startedAt,
          } as unknown as JsonValue,
          fence,
        );
      },
    );

    const persistedTrials: Array<{
      readonly trial: MissionOutcomeStudioKernelTrialV1;
      readonly view: MissionOutcomeStudioViewV1;
      readonly profileSelection: ExecutionForkProfileSelectionV1;
    }> = [];
    for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
      const childBranchId = `branch-outcome-trial-${runSeed.slice(0, 20)}-${String(trialIndex + 1)}`;
      let record: ExecutionForkRecordV1;
      let receipt: ReceiptV1;
      try {
        const executed = await this.executeFork(
          missionId,
          {
            checkpointId: scenario.sourceCheckpointId,
            childBranchId,
            intervention,
            stageId: request.targetStageId,
            targetProfileDefinitionId: request.targetProfileDefinitionId,
          },
          signal,
        );
        record = executed.record;
        receipt = executed.receipt;
      } catch (error) {
        const failedRecord = (await this.executionForks(missionId)).find(
          (candidate) => candidate.lineage.childBranchId === childBranchId,
        );
        if (failedRecord === undefined) throw error;
        record = failedRecord;
        receipt = await this.#issueOutcomeRegressionRejectedReceipt(
          missionId,
          childBranchId,
          failedRecord,
        );
      }
      const events = this.#store.listEvents(missionId);
      const attempt = events.find(
        (event): event is Extract<StoredEventV1, { type: 'attempt.started' }> =>
          event.type === 'attempt.started' && event.payload.attempt.branchId === childBranchId,
      )?.payload.attempt;
      const binding = events.find(
        (event): event is Extract<StoredEventV1, { type: 'attempt.bound' }> =>
          event.type === 'attempt.bound' && event.payload.binding.branchId === childBranchId,
      )?.payload.binding;
      const runtimeRunId = record.runtimeResult?.runtimeRunId;
      const profileSelection = record.lineage.profileSelection;
      const view = await this.outcomeStudio(missionId, childBranchId);
      if (
        attempt === undefined ||
        binding === undefined ||
        runtimeRunId === undefined ||
        profileSelection === undefined ||
        view.branch === null ||
        view.agentRevision === null
      ) {
        throw new MissionExecutionError(
          `Kernel trial ${String(trialIndex + 1)} lacks a persisted Branch, Attempt, Binding, Runtime, or evaluation`,
        );
      }
      persistedTrials.push({
        view,
        profileSelection,
        trial: {
          trialIndex,
          sourceProfileId: profileSelection.sourceProfileId,
          targetProfileId: profileSelection.targetProfileId,
          targetStageId: profileSelection.targetStageId,
          profileSelectionId: profileSelection.selectionId,
          plannerDecisionHash: profileSelection.plannerDecisionHash,
          branchId: childBranchId,
          attemptId: attempt.attemptId,
          bindingId: binding.bindingId,
          runtimeRunId,
          receiptId: receipt.receiptId,
          receiptOutcome: receipt.outcome,
          eventHeadHash: receipt.verifiedHeadHash,
          eventThroughSeq: receipt.verifiedThroughSeq,
          criterionEvidenceRefs: uniqueStrings(
            view.branch.evaluation.criteria.flatMap((criterion) => criterion.evidenceRefs),
          ),
          runtimeEvidenceRefs: uniqueStrings([
            ...record.runtimeEvidence.map((evidence) => `evidence:${evidence.evidenceId}`),
            ...(record.runtimeResult?.verificationEvidenceRefs ?? []),
            ...(record.runtimeResult?.toolExecutionEvidenceRefs ?? []),
          ]),
          retainedArtifactRefs: uniqueStrings([
            `branch:${childBranchId}`,
            `attempt:${attempt.attemptId}`,
            `binding:${binding.bindingId}`,
            `runtime:${runtimeRunId}`,
            `receipt:${receipt.receiptId}`,
            ...(record.futureSnapshot === undefined
              ? []
              : [`workspace:${record.futureSnapshot.workspaceDigest}`]),
          ]),
        },
      });
    }

    const targetRevisionIds = uniqueStrings(
      persistedTrials.map((entry) => entry.view.agentRevision!.revisionId),
    );
    const sourceProfileIds = uniqueStrings(
      persistedTrials.map((entry) => entry.trial.sourceProfileId),
    );
    const targetProfileIds = uniqueStrings(
      persistedTrials.map((entry) => entry.trial.targetProfileId),
    );
    const targetStageIds = uniqueStrings(persistedTrials.map((entry) => entry.trial.targetStageId));
    const profileSelectionIds = uniqueStrings(
      persistedTrials.map((entry) => entry.trial.profileSelectionId),
    );
    if (targetRevisionIds.length !== 1) {
      throw new MissionExecutionError(
        'Kernel trials did not use one content-identical Agent Revision',
      );
    }
    if (
      sourceProfileIds.length !== 1 ||
      targetProfileIds.length !== 1 ||
      targetStageIds.length !== 1 ||
      profileSelectionIds.length !== 1 ||
      sourceProfileIds[0] !== executionPlan.sourceProfileId ||
      sourceProfileIds[0] === targetProfileIds[0] ||
      targetStageIds[0] !== request.targetStageId
    ) {
      throw new MissionExecutionError(
        'Kernel trials did not preserve one source Checkpoint and one distinct Planner-selected target Profile',
      );
    }
    const registry = new OutcomeStudioRegistry();
    for (const criterion of suite.criteria) {
      if (
        suite.criteria.some(
          (candidate) =>
            candidate.runner.kind === criterion.runner.kind &&
            candidate.runner.version === criterion.runner.version &&
            candidate.mode !== criterion.mode,
        )
      ) {
        throw new MissionExecutionError(
          'One criterion runner cannot declare multiple execution modes',
        );
      }
      if (
        suite.criteria.findIndex(
          (candidate) =>
            candidate.runner.kind === criterion.runner.kind &&
            candidate.runner.version === criterion.runner.version,
        ) !== suite.criteria.indexOf(criterion)
      ) {
        continue;
      }
      registry.registerRunner({
        ...criterion.runner,
        mode: criterion.mode,
        run: async ({ criterion: runningCriterion, trialIndex }) => {
          const persisted = persistedTrials[trialIndex];
          const observed = persisted?.view.branch?.evaluation.criteria.find(
            (candidate) => candidate.criterionId === runningCriterion.criterionId,
          );
          if (persisted === undefined || observed === undefined) {
            return { outcome: 'unknown', evidenceRefs: [], retainedArtifactRefs: [] };
          }
          return {
            outcome: observed.status,
            ...(observed.status === 'passed'
              ? { score: 1 }
              : observed.status === 'failed'
                ? { score: 0 }
                : {}),
            evidenceRefs: uniqueStrings([
              ...persisted.trial.criterionEvidenceRefs,
              ...persisted.trial.runtimeEvidenceRefs,
              `branch:${persisted.trial.branchId}`,
              `attempt:${persisted.trial.attemptId}`,
              `binding:${persisted.trial.bindingId}`,
              `runtime:${persisted.trial.runtimeRunId}`,
              `receipt:${persisted.trial.receiptId}`,
            ]),
            retainedArtifactRefs: persisted.trial.retainedArtifactRefs,
          };
        },
      });
    }
    const evaluatorBindings = suite.criteria.flatMap((criterion) => criterion.evaluators);
    for (const evaluator of evaluatorBindings) {
      if (
        evaluatorBindings.findIndex(
          (candidate) =>
            candidate.kind === evaluator.kind && candidate.version === evaluator.version,
        ) !== evaluatorBindings.indexOf(evaluator)
      ) {
        continue;
      }
      registry.registerEvaluator({
        kind: evaluator.kind,
        version: evaluator.version,
        basis: 'deterministic',
        evaluate: async ({ trials }) => ({
          status:
            trials.length === trialCount &&
            trials.every(
              (trial) =>
                trial.evidenceRefs.some((reference) => reference.startsWith('branch:')) &&
                trial.evidenceRefs.some((reference) => reference.startsWith('attempt:')) &&
                trial.evidenceRefs.some((reference) => reference.startsWith('binding:')) &&
                trial.evidenceRefs.some((reference) => reference.startsWith('runtime:')) &&
                trial.evidenceRefs.some((reference) => reference.startsWith('receipt:')) &&
                trial.retainedArtifactRefs.length > 0,
            )
              ? 'passed'
              : 'unknown',
          evidenceRefs: persistedTrials.flatMap((entry) => [
            `branch:${entry.trial.branchId}`,
            `receipt:${entry.trial.receiptId}`,
          ]),
        }),
      });
    }
    const terminal = persistedTrials.at(-1)!;
    const selectedProfile = persistedTrials[0]!.profileSelection;
    const runtimeProfileBinding = {
      sourceProfileId: selectedProfile.sourceProfileId,
      targetProfileId: selectedProfile.targetProfileId,
      targetStageId: selectedProfile.targetStageId,
      targetProfileDefinitionId: selectedProfile.targetProfileDefinitionId,
      profileSelectionId: selectedProfile.selectionId,
      plannerDecisionHash: selectedProfile.plannerDecisionHash,
      authorityChange: selectedProfile.authorityChange,
      evidenceRefs: selectedProfile.evidenceRefs,
    };
    const terminalBranch = terminal.view.branch!;
    const terminalRevision = terminal.view.agentRevision!;
    const rerun = await rerunIncidentScenario({
      scenario,
      registry,
      target: {
        branchId: terminalBranch.branchId,
        contractId: terminalBranch.contractId,
        agentRevision: terminalRevision,
        checkpointId: terminalBranch.checkpointId,
        eventHeadHash: terminal.trial.eventHeadHash,
        eventThroughSeq: terminal.trial.eventThroughSeq,
        scenarioId,
      },
      lineageBranchIds: [
        ...uniqueStrings(
          persistedTrials
            .flatMap((entry) => entry.view.branch!.lineageBranchIds)
            .filter((branchId) => branchId !== terminalBranch.branchId),
        ),
        terminalBranch.branchId,
      ],
      dimensions: terminalBranch.dimensions,
      agentReported: {
        status: persistedTrials.every(
          (entry) => entry.view.branch!.agentReported.status === 'reported-success',
        )
          ? 'reported-success'
          : persistedTrials.some(
                (entry) => entry.view.branch!.agentReported.status === 'reported-failure',
              )
            ? 'reported-failure'
            : 'not-reported',
        evidenceRefs: uniqueStrings(
          persistedTrials.flatMap((entry) => entry.view.branch!.agentReported.evidenceRefs),
        ),
      },
      effects: [],
      runtimeProfileBinding,
      outcomePolicyVersion: suite.outcomePolicyVersion,
      issuedAt: this.#now().toISOString(),
    });
    const core: MissionOutcomeStudioRerunCoreV1 = {
      schemaVersion: 'missionbraid.dev/outcome-kernel-rerun/v1',
      missionId,
      scenarioId,
      contractId: scenario.contractId,
      sourceCheckpointId: scenario.sourceCheckpointId,
      sourceProfileId: sourceProfileIds[0]!,
      executionKey,
      trialCount,
      trials: persistedTrials.map((entry) => entry.trial),
      targetBranchId: terminalBranch.branchId,
      targetAgentRevisionId: rerun.targetAgentRevisionId,
      targetProfileId: rerun.targetProfileId,
      targetStageId: targetStageIds[0]!,
      targetProfileDefinitionId: request.targetProfileDefinitionId,
      profileSelectionId: profileSelectionIds[0]!,
      evaluation: rerun.evaluation,
      receipt: rerun.receipt,
      ciResult: rerun.ciResult,
      startedAt,
      completedAt: this.#now().toISOString(),
    };
    const runHash = hashPayload(core);
    const completed: MissionOutcomeStudioRerunV1 = {
      ...core,
      runId: `outcome-kernel-rerun-${runHash.slice(0, 32)}`,
      runHash,
    };
    verifyMissionOutcomeStudioRerun(completed);
    await this.#withLease(
      mission.workspaceKey,
      `outcome-rerun-complete-${this.#id()}`,
      async (fence) => {
        this.#observe(
          missionId,
          'outcome-studio.incident-rerun.saved',
          completed as unknown as JsonValue,
          fence,
        );
        if (
          !this.outcomeStudioScenarios(missionId).ciResults.some(
            (result) => result.resultId === completed.ciResult.resultId,
          )
        ) {
          this.#observe(
            missionId,
            'outcome-studio.ci-result.saved',
            completed.ciResult as unknown as JsonValue,
            fence,
          );
        }
      },
    );
    return completed;
  }

  outcomeStudioReruns(missionId: string): readonly MissionOutcomeStudioRerunV1[] {
    this.#requireMission(missionId);
    return this.#store.listEvents(missionId).flatMap((event): MissionOutcomeStudioRerunV1[] => {
      if (
        event.type !== 'runtime.observation' ||
        event.payload.kind !== 'outcome-studio.incident-rerun.saved' ||
        !isJsonObject(event.payload.data)
      ) {
        return [];
      }
      try {
        const run = event.payload.data as unknown as MissionOutcomeStudioRerunV1;
        verifyMissionOutcomeStudioRerun(run);
        return [run];
      } catch {
        return [];
      }
    });
  }

  outcomeStudioScenarios(missionId: string): MissionOutcomeStudioScenarioCollectionV1 {
    this.#requireMission(missionId);
    const scenarios: IncidentScenarioV1[] = [];
    const ciResults: OutcomeCiResultV1[] = [];
    for (const event of this.#store.listEvents(missionId)) {
      if (event.type !== 'runtime.observation' || !isJsonObject(event.payload.data)) continue;
      if (event.payload.kind === 'outcome-studio.incident-scenario.saved') {
        try {
          const value = event.payload.data as unknown as IncidentScenarioV1;
          verifyIncidentScenario(value);
          scenarios.push(value);
        } catch {
          // Ignore malformed historical exports; the Kernel remains readable.
        }
      } else if (event.payload.kind === 'outcome-studio.ci-result.saved') {
        try {
          const value = event.payload.data as unknown as OutcomeCiResultV1;
          verifyOutcomeCiResult(value);
          ciResults.push(value);
        } catch {
          // A malformed or policy-inconsistent CI export is never surfaced.
        }
      }
    }
    return { missionId, scenarios, ciResults };
  }

  async exportOutcomeStudioScenarios(missionId: string): Promise<string> {
    return JSON.stringify(this.outcomeStudioScenarios(missionId), null, 2);
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

  async #resolveExecutionForkRuntime(
    missionId: string,
    spec: MissionSpecV1,
    checkpoint: CompositeCheckpointManifestV1,
    sourceStage: AttemptStageSpecV1,
    sourceProfile: ProfileV1,
    request: MissionExecutionForkRequestV1,
  ): Promise<ResolvedExecutionForkRuntime> {
    if (request.targetProfileDefinitionId === undefined) {
      const stageId = request.stageId ?? sourceStage.stageId;
      const stage = spec.attemptPlan.find((candidate) => candidate.stageId === stageId);
      if (stage === undefined || !stageMatchesProfile(stage, sourceProfile)) {
        throw new MissionExecutionError(
          'A different Runtime Profile requires an explicit eligible target stage and Profile Definition',
        );
      }
      return {
        stage,
        sourceProfile,
        targetProfile: sourceProfile,
        selectionEvents: [],
      };
    }
    if (request.stageId === undefined) {
      throw new MissionExecutionError(
        'Profile-Rebound Fork requires an explicit target stage from this Mission',
      );
    }
    const targetStage = spec.attemptPlan.find((candidate) => candidate.stageId === request.stageId);
    if (targetStage === undefined) {
      throw new MissionExecutionError(
        `Profile-Rebound target stage ${request.stageId} is not declared by Mission ${missionId}`,
      );
    }
    const targetDefinition = profileDefinition(targetStage, this.#adapterManifest(targetStage));
    if (targetDefinition.definitionId !== request.targetProfileDefinitionId) {
      throw new MissionExecutionError(
        'Profile-Rebound target Profile Definition does not match the declared Mission stage',
      );
    }

    const missionEvents = this.#store.listEvents(missionId);
    for (let index = missionEvents.length - 1; index >= 0; index -= 1) {
      const event = missionEvents[index];
      if (
        event?.type !== 'runtime.observation' ||
        event.payload.kind !== 'execution-fork.profile-rebound.selected' ||
        !isJsonObject(event.payload.data)
      ) {
        continue;
      }
      const data = event.payload.data;
      if (
        data.checkpointId !== checkpoint.checkpointId ||
        data.sourceProfileId !== sourceProfile.profileId ||
        data.targetStageId !== targetStage.stageId ||
        data.targetProfileDefinitionId !== targetDefinition.definitionId ||
        !isJsonObject(data.selection) ||
        !isJsonObject(data.targetProfile)
      ) {
        continue;
      }
      const selection = data.selection as unknown as ExecutionForkProfileSelectionV1;
      const targetProfile = data.targetProfile as unknown as ProfileV1;
      if (
        selection.sourceProfileId !== sourceProfile.profileId ||
        selection.targetProfileId !== targetProfile.profileId ||
        selection.targetStageId !== targetStage.stageId ||
        selection.targetProfileDefinitionId !== targetDefinition.definitionId ||
        targetProfile.definition?.definitionId !== targetDefinition.definitionId ||
        !stageMatchesProfile(targetStage, targetProfile) ||
        executionForkProfileAuthorityChange(sourceProfile, targetProfile) !==
          selection.authorityChange
      ) {
        throw new MissionExecutionError(
          'Persisted Profile-Rebound selection conflicts with its source or declared target',
        );
      }
      return {
        stage: targetStage,
        sourceProfile,
        targetProfile,
        profileSelection: selection,
        selectionEvents: [],
      };
    }

    const detection = await this.#detectStage(targetStage);
    const targetProfile = createProfile(
      targetStage,
      detection,
      spec.workspace,
      this.#adapterManifest(targetStage),
    );
    if (targetProfile.profileId === sourceProfile.profileId) {
      throw new MissionExecutionError(
        'Profile-Rebound target resolves to the immutable source Runtime Profile',
      );
    }
    const authorityChange = executionForkProfileAuthorityChange(sourceProfile, targetProfile);
    if (authorityChange === 'expanded') {
      throw new MissionExecutionError(
        'Profile-Rebound target may only keep or narrow source Runtime authority',
      );
    }
    const mission = this.#requireMission(missionId);
    const state = reconstructExecutionState(missionEvents);
    const candidate: PlannedRuntimeCandidate = {
      stage: targetStage,
      detection,
      profile: targetProfile,
    };
    const requirements = plannerRequirements(missionId, mission.contract, sourceStage, [candidate]);
    const plannerInput: ExecutionPlannerInputV1 = {
      policyVersion: EXECUTION_PLANNER_POLICY_VERSION,
      requirements,
      candidates: [
        {
          profile: targetProfile,
          observation: plannerObservation(candidate),
          handoffStates: plannerProfileReboundStates(checkpoint, mission.contract),
          wouldRepeatEffectIds: [],
        },
      ],
      currentProfileId: sourceProfile.profileId,
      effectFrontier: state.effects.map((effect) => ({
        effectId: effect.effectId,
        status: effect.status,
      })),
    };
    const decision = planExecution(plannerInput);
    if (decision.binding.selectedProfileId !== targetProfile.profileId) {
      const rejection = decision.filter.candidates
        .find((item) => item.profileId === targetProfile.profileId)
        ?.rejectionReasons.map((reason) => reason.code)
        .join(', ');
      throw new MissionExecutionError(
        `Profile-Rebound target is not eligible under the frozen Planner requirements${
          rejection === undefined || rejection.length === 0 ? '' : `: ${rejection}`
        }`,
      );
    }
    const selectedAt = this.#now().toISOString();
    const identity = hashPayload({
      missionId,
      checkpointId: checkpoint.checkpointId,
      sourceProfileId: sourceProfile.profileId,
      targetProfileId: targetProfile.profileId,
      targetStageId: targetStage.stageId,
      targetProfileDefinitionId: targetDefinition.definitionId,
      plannerDecisionHash: decision.decisionHash,
    }).slice(0, 32);
    const catalogEventId = `event-profile-rebound-catalog-${identity}`;
    const requirementsEventId = `event-profile-rebound-requirements-${identity}`;
    const decisionEventId = `event-profile-rebound-decision-${identity}`;
    const profileEventId = `event-profile-rebound-profile-${identity}`;
    const selectionEventId = `event-profile-rebound-selection-${identity}`;
    const selection: ExecutionForkProfileSelectionV1 = {
      selectionId: `profile-rebound-selection-${identity}`,
      sourceProfileId: sourceProfile.profileId,
      targetProfileId: targetProfile.profileId,
      targetStageId: targetStage.stageId,
      targetProfileDefinitionId: targetDefinition.definitionId,
      plannerDecisionHash: decision.decisionHash,
      authorityChange,
      evidenceRefs: [`event:${decisionEventId}`, `event:${profileEventId}`],
      selectedAt,
    };
    const trigger = {
      code: 'OUTCOME_REGRESSION_PROFILE_REBOUND',
      sourceStageId: sourceStage.stageId,
      sourceProfileId: sourceProfile.profileId,
      sourceCheckpointId: checkpoint.checkpointId,
      targetStageId: targetStage.stageId,
      targetProfileDefinitionId: targetDefinition.definitionId,
    };
    const selectionEvents: EventV1[] = [
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: catalogEventId,
        missionId,
        occurredAt: detection.checkedAt,
        type: 'runtime.catalog_observed',
        payload: { observation: requireCatalogObservation(targetProfile) },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: requirementsEventId,
        missionId,
        occurredAt: selectedAt,
        type: 'runtime.observation',
        payload: {
          kind: 'execution-planner.requirements_frozen',
          data: {
            requirements: requirements as unknown as JsonValue,
            derivationSource: 'accepted-profile-rebound-source-and-target',
            trigger: trigger as unknown as JsonValue,
            sourceCompositeCheckpointId: checkpoint.checkpointId,
          },
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: decisionEventId,
        missionId,
        occurredAt: selectedAt,
        type: 'runtime.observation',
        payload: {
          kind: 'execution-planner.decision',
          data: {
            trigger: trigger as unknown as JsonValue,
            plannerInput: plannerInput as unknown as JsonValue,
            decision: decision as unknown as JsonValue,
            policyVersion: EXECUTION_PLANNER_POLICY_VERSION,
            decisionHash: decision.decisionHash,
            sourceCompositeCheckpoint: {
              checkpointId: checkpoint.checkpointId,
              manifestHash: checkpoint.manifestHash,
              source: checkpoint.source as unknown as JsonValue,
              eventPrefix: checkpoint.eventPrefix as unknown as JsonValue,
            },
          },
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: profileEventId,
        missionId,
        occurredAt: selectedAt,
        type: 'profile.selected',
        payload: {
          profile: targetProfile,
          reason: `Deterministic Profile-Rebound Planner ${decision.decisionHash}`,
        },
      },
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: selectionEventId,
        missionId,
        occurredAt: selectedAt,
        type: 'runtime.observation',
        payload: {
          kind: 'execution-fork.profile-rebound.selected',
          data: {
            checkpointId: checkpoint.checkpointId,
            sourceProfileId: sourceProfile.profileId,
            targetProfileId: targetProfile.profileId,
            targetStageId: targetStage.stageId,
            targetProfileDefinitionId: targetDefinition.definitionId,
            selection: selection as unknown as JsonValue,
            targetProfile: targetProfile as unknown as JsonValue,
          },
        },
      },
    ];
    return {
      stage: targetStage,
      sourceProfile,
      targetProfile,
      profileSelection: selection,
      selectionEvents,
    };
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

    let diagnosticVariable: unknown;
    if (request.diagnosticCandidateId !== undefined) {
      const intelligence = await this.failureIntelligence(missionId, checkpoint.source.branchId);
      const candidate = intelligence.graph.candidates.find(
        (item) => item.candidateId === request.diagnosticCandidateId,
      );
      const proposal = intelligence.graph.diagnosticBranchProposals.find(
        (item) => item.candidateId === request.diagnosticCandidateId,
      );
      if (
        candidate === undefined ||
        proposal === undefined ||
        !proposal.ready ||
        proposal.baseCheckpointId !== checkpoint.checkpointId ||
        proposal.baseCheckpointDigest !== checkpoint.manifestHash
      ) {
        throw new MissionExecutionError(
          'Diagnostic Fork candidate is not ready on the supplied Composite Checkpoint',
        );
      }
      await assertDiagnosticInterventionMatchesContext(
        spec,
        checkpoint,
        candidate,
        intelligence.failureIntelligenceInput,
        request.intervention,
      );
      diagnosticVariable = proposal.changedVariable;
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
    const sourceStage = spec.attemptPlan.find(
      (candidate) => candidate.stageId === sourceAttempt.stageId,
    );
    if (sourceStage === undefined || !stageMatchesProfile(sourceStage, sourceProfile)) {
      throw new MissionExecutionError(
        'Execution Fork source stage no longer matches its immutable source Runtime Profile',
      );
    }
    const resolvedRuntime = await this.#resolveExecutionForkRuntime(
      missionId,
      spec,
      checkpoint,
      sourceStage,
      sourceProfile,
      request,
    );
    const stage = resolvedRuntime.stage;
    const targetProfile = resolvedRuntime.targetProfile;
    if (
      stage.breakpoint === 'mutable-tools' &&
      (stage.profile.harness !== 'claude' || stage.profile.adapterId !== undefined)
    ) {
      throw new MissionExecutionError(
        'Execution Fork mutable-tools enforcement is currently supported only for the native Claude Harness',
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
      targetProfileId: targetProfile.profileId,
      profileSelectionId: resolvedRuntime.profileSelection?.selectionId ?? null,
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
      if (resolvedRuntime.selectionEvents.length > 0) {
        this.#store.appendEvents(resolvedRuntime.selectionEvents, fence);
      }
      if (request.diagnosticCandidateId !== undefined && isJsonObject(diagnosticVariable)) {
        this.#store.appendEvent(
          {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            eventId: `event-diagnostic-request-${identityDigest}`,
            missionId,
            occurredAt: bindingBoundAt,
            type: 'runtime.observation',
            payload: {
              kind: 'failure.diagnostic_requested',
              data: {
                branchId: checkpoint.source.branchId,
                checkpointId: checkpoint.checkpointId,
                candidateId: request.diagnosticCandidateId,
                changedVariable: diagnosticVariable,
                interventionId: request.intervention.interventionId,
                childBranchId,
              } as unknown as JsonValue,
            },
          },
          fence,
        );
      }
      await this.#writeProvenanceProjection(missionId);
      const fileJournal = new FileExecutionForkEvidenceJournal(
        join(this.#stateDir, 'execution-forks'),
      );
      let forkToolGateway: ToolGateway | undefined;
      let forkToolGateBinding: ClaudeToolGateBindingV1 | undefined;
      let forkToolGatewayError: unknown;
      let forkToolGatewayWatcher: Promise<void> | undefined;
      const forkToolGatewayController = new AbortController();
      const executionForkMissionHistory = [...this.#store.listEvents(missionId)];
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
            profileId: targetProfile.profileId,
            workspaceKey: childWorkspaceKey,
            planNodeId: stage.stageId,
            authority: 'workspace',
            injectionBudgetTokens: stage.profile.injectionBudgetTokens,
            boundAt: bindingBoundAt,
            runtimeBinding: runtimeBinding(childAttemptId, targetProfile),
          };
          const kernelEvents = [
            ...executionForkEventToMissionEvents(
              sourceEvent,
              { missionId, childAttemptId, binding, occurredAt: sourceEvent.occurredAt },
              executionForkMissionHistory,
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
                  profileId: targetProfile.profileId,
                  branchId: childBranchId,
                  bindingId: binding.bindingId,
                  checkpointId: checkpoint.checkpointId,
                  operation: 'execution-fork',
                },
              },
            });
          }
          const appended = this.#store.appendEvents(kernelEvents, fence);
          executionForkMissionHistory.push(...appended.map((result) => result.event));
          if (sourceEvent.type === 'fork.planned' && stage.breakpoint === 'mutable-tools') {
            try {
              if (forkToolGateway !== undefined || forkToolGateBinding !== undefined) {
                throw new MissionExecutionError(
                  'Execution Fork native Tool Gateway was armed more than once',
                );
              }
              forkToolGateway = this.#toolGateway(missionId, childAttemptId);
              await forkToolGateway.initialize();
              forkToolGateBinding = await createClaudeToolGateBinding({
                stateDir: this.#stateDir,
                gatewayRoot: this.#toolGatewayRoot(),
                missionId,
                attemptId: childAttemptId,
              });
              this.#observe(
                missionId,
                'tool.gateway.armed',
                {
                  attemptId: childAttemptId,
                  operation: 'execution-fork',
                  matcher: forkToolGateBinding.matcher,
                  tools: [...forkToolGateBinding.tools],
                  settingsSha256: forkToolGateBinding.settingsSha256,
                  controlLevel: 'enforced',
                  capabilityFidelity: 'native',
                  parentProcess: 'continues-while-hook-blocks-tool-dispatch',
                  childProcesses: 'covered-only-when-dispatched-through-matched-Claude-tool',
                  inFlightRequests: 'not-revoked',
                  pendingTools: 'blocked-until-persisted-release',
                },
                fence,
                childAttemptId,
              );
              forkToolGatewayWatcher = this.#watchToolGateway(
                missionId,
                childAttemptId,
                forkToolGateway,
                fence,
                forkToolGatewayController.signal,
              ).catch((error: unknown) => {
                forkToolGatewayError = error;
                forkToolGatewayController.abort();
              });
            } catch (error) {
              // The durable fork.planned event already exists. Preserve that
              // journal boundary and let the Runtime fail closed so the
              // ExecutionForkService can append a durable fork.failed event.
              forkToolGatewayError = error;
              forkToolGatewayController.abort();
            }
          }
          return sourceEvent;
        },
        load: async (forkId: string) => await fileJournal.load(forkId),
      };
      const service = new ExecutionForkService({ journal: mirroredJournal, now: this.#now });
      const runtime: RuntimeContinuationPortV1 = {
        continueFromCheckpoint: async (input) => {
          if (forkToolGatewayError !== undefined) {
            throw new MissionExecutionError(
              'Execution Fork native Tool Gateway could not be armed',
              { cause: forkToolGatewayError },
            );
          }
          if (stage.breakpoint === 'mutable-tools' && forkToolGateBinding === undefined) {
            throw new MissionExecutionError(
              'Execution Fork reached Runtime dispatch without its native Tool Gateway binding',
            );
          }
          const runtimeSignal =
            stage.breakpoint !== 'mutable-tools'
              ? signal
              : signal === undefined
                ? forkToolGatewayController.signal
                : AbortSignal.any([signal, forkToolGatewayController.signal]);
          const port = new NativeAdapterRuntimeContinuationPort({
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
            acceptedSourceProfile: sourceProfile,
            acceptedProfile: targetProfile,
            ...(resolvedRuntime.profileSelection === undefined
              ? {}
              : { acceptedProfileSelection: resolvedRuntime.profileSelection }),
            acceptedIntervention: request.intervention,
            ...(spec.context === undefined ? {} : { acceptedContext: spec.context }),
            controllerStateDir: this.#stateDir,
            provenanceFile: this.#provenanceFile(missionId),
            adapters: { codex: this.#codex, qoder: this.#qoder, claude: this.#claude },
            adapterHost: this.#adapterHost,
            ...(forkToolGateBinding === undefined
              ? {}
              : { acceptedToolGateBinding: forkToolGateBinding }),
            ...(runtimeSignal === undefined ? {} : { signal: runtimeSignal }),
          });
          return await port.continueFromCheckpoint(input);
        },
      };
      try {
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
            runtimeBinding: runtimeBinding(
              `fork-attempt-${checkpoint.checkpointId}`,
              targetProfile,
            ),
            ...(resolvedRuntime.profileSelection === undefined
              ? {}
              : { profileSelection: resolvedRuntime.profileSelection }),
          },
          runtime,
        );
        if (forkToolGateway !== undefined) {
          await this.#drainToolGateway(
            missionId,
            `fork-attempt-${record.forkId}`,
            forkToolGateway,
            fence,
          );
          forkToolGatewayController.abort();
          await forkToolGatewayWatcher;
          if (forkToolGatewayError !== undefined) {
            throw new MissionExecutionError(
              'The Execution Fork native Tool Gateway stopped before it could release a decision',
              { cause: forkToolGatewayError },
            );
          }
        }
        const receipt = await this.#issueExecutionForkReceipt(
          missionId,
          childBranchId,
          spec,
          record,
          fence,
        );
        return { record, receipt };
      } finally {
        forkToolGatewayController.abort();
        await forkToolGatewayWatcher?.catch(() => undefined);
      }
    });
  }

  async executeDiagnosticFork(
    missionId: string,
    request: MissionDiagnosticForkRequestV1,
    signal?: AbortSignal,
  ): Promise<MissionExecutionForkResultV1> {
    return await this.executeFork(
      missionId,
      {
        checkpointId: request.checkpointId,
        intervention: request.intervention,
        ...(request.stageId === undefined ? {} : { stageId: request.stageId }),
        ...(request.childBranchId === undefined ? {} : { childBranchId: request.childBranchId }),
        diagnosticCandidateId: request.candidateId,
      },
      signal,
    );
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
      profileDefinition: profileDefinition(stage, this.#adapterManifest(stage)),
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
      profileDefinitionId: profileDefinition(stage, this.#adapterManifest(stage)).definitionId,
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

  missionPlan(missionId: string): MissionPlanView {
    this.#requireMission(missionId);
    const observations = this.#store
      .listEvents(missionId)
      .filter(
        (event): event is Extract<StoredEventV1, { type: 'runtime.observation' }> =>
          event.type === 'runtime.observation',
      );
    const revisions = observations.filter(
      (event) => event.payload.kind === 'mission.contract_revision.created',
    );
    const plans = observations.filter(
      (event) => event.payload.kind === 'mission.plan_revision.created',
    );
    const contractRevision = revisions.at(-1)?.payload.data as unknown as
      | ContractRevisionV1
      | undefined;
    const planRevision = plans.at(-1)?.payload.data as unknown as MissionPlanRevisionV1 | undefined;
    if (contractRevision === undefined || planRevision === undefined) {
      throw new MissionExecutionError(`Mission ${missionId} has no Mission Plan revision`);
    }
    const invalidations = observations
      .filter((event) => event.payload.kind === 'mission.selective_invalidation.created')
      .map((event) => event.payload.data as unknown as SelectiveInvalidationV1);
    return {
      contractRevision,
      planRevision,
      invalidations,
      execution: this.#missionPlanExecutionView(missionId, observations),
    };
  }

  #missionPlanExecutionView(
    missionId: string,
    observations?: readonly Extract<StoredEventV1, { type: 'runtime.observation' }>[],
  ): MissionPlanExecutionViewV1 {
    const events = this.#store.listEvents(missionId);
    const runtimeObservations =
      observations ??
      events.filter(
        (event): event is Extract<StoredEventV1, { type: 'runtime.observation' }> =>
          event.type === 'runtime.observation',
      );
    const state = reconstructExecutionState(events);
    const artifacts = runtimeObservations.flatMap((event): MissionPlanArtifactRecordV1[] => {
      if (
        event.payload.kind !== 'mission.plan_artifact.recorded' &&
        event.payload.kind !== 'mission.plan_artifact.reused'
      ) {
        return [];
      }
      if (!isJsonObject(event.payload.data) || !isJsonObject(event.payload.data.record)) return [];
      return [event.payload.data.record as unknown as MissionPlanArtifactRecordV1];
    });
    const invalidationFences = runtimeObservations.flatMap((event): StaleAttemptFenceV1[] => {
      if (
        event.payload.kind !== 'mission.selective_invalidation.created' ||
        !isJsonObject(event.payload.data) ||
        !Array.isArray(event.payload.data.staleAttemptFences)
      ) {
        return [];
      }
      return event.payload.data.staleAttemptFences as unknown as StaleAttemptFenceV1[];
    });
    const fenceByAttempt = new Map(invalidationFences.map((fence) => [fence.attemptId, fence]));
    const attempts = [...state.plans.values()]
      .filter(
        (plan) =>
          plan.planRevisionId !== undefined &&
          plan.contractRevisionId !== undefined &&
          plan.nodeVersion !== undefined &&
          plan.workspaceKey !== undefined,
      )
      .map(
        (plan): MissionPlanAttemptViewV1 => ({
          attemptId: plan.attemptId,
          nodeId: plan.stageId,
          harness: plan.harness,
          branchId: plan.branchId,
          workspaceKey: plan.workspaceKey!,
          planRevisionId: plan.planRevisionId!,
          contractRevisionId: plan.contractRevisionId!,
          nodeVersion: plan.nodeVersion!,
          status: state.finished.get(plan.attemptId) ?? 'running',
          fence: fenceByAttempt.get(plan.attemptId) ?? null,
        }),
      )
      .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
    const consolidationPlans = runtimeObservations.flatMap(
      (event): MissionPlanConsolidationRecordV1[] => {
        if (
          event.payload.kind !== 'mission.consolidation.planned' ||
          !isJsonObject(event.payload.data) ||
          !isJsonObject(event.payload.data.record)
        ) {
          return [];
        }
        return [event.payload.data.record as unknown as MissionPlanConsolidationRecordV1];
      },
    );
    const outcomes = new Map<string, WorkspaceIntegrationOutcomeV1>();
    const afterById = new Map<string, Readonly<Record<string, string>>>();
    for (const event of runtimeObservations) {
      if (
        event.payload.kind !== 'mission.consolidation.completed' ||
        !isJsonObject(event.payload.data) ||
        !isJsonObject(event.payload.data.outcome) ||
        typeof event.payload.data.consolidationId !== 'string'
      ) {
        continue;
      }
      outcomes.set(
        event.payload.data.consolidationId,
        event.payload.data.outcome as unknown as WorkspaceIntegrationOutcomeV1,
      );
      if (isJsonObject(event.payload.data.sourceCommitsAfter)) {
        afterById.set(
          event.payload.data.consolidationId,
          event.payload.data.sourceCommitsAfter as Readonly<Record<string, string>>,
        );
      }
    }
    const consolidations = consolidationPlans.map((record) => ({
      ...record,
      ...(outcomes.has(record.plan.consolidationId)
        ? { outcome: outcomes.get(record.plan.consolidationId)! }
        : {}),
      ...(afterById.has(record.plan.consolidationId)
        ? { sourceCommitsAfter: afterById.get(record.plan.consolidationId)! }
        : {}),
    }));
    return {
      attempts,
      artifacts,
      fences: invalidationFences,
      consolidations,
    };
  }

  /**
   * Rebuilds the live Mission Plan graph from persisted Attempt and revision
   * evidence. This is a projection only: it never starts, stops, or rebinds an
   * Agent. A node is `succeeded` only when a verifier-backed PlanArtifact is
   * available; a finished Attempt without that artifact remains unknown.
   */
  missionPlanRuntime(missionId: string): MissionPlanRuntimeProjectionV1 {
    this.#requireMission(missionId);
    const planView = this.missionPlan(missionId);
    const events = this.#store.listEvents(missionId);
    const state = reconstructExecutionState(events);
    const verifiedReceipts = events
      .filter(
        (event): event is Extract<StoredEventV1, { type: 'receipt.issued' }> =>
          event.type === 'receipt.issued' && event.payload.receipt.outcome === 'verified',
      )
      .map((event) => event.payload.receipt);
    const receiptByAttemptId = new Map<string, ReceiptV1>();
    for (const receipt of verifiedReceipts) {
      for (const attemptId of receipt.attemptIds ?? []) {
        if (!receiptByAttemptId.has(attemptId)) receiptByAttemptId.set(attemptId, receipt);
      }
    }
    const checkpointStatusByAttemptId = new Map(
      state.checkpoints.map((checkpoint) => [checkpoint.attemptId, checkpoint.status] as const),
    );
    const activeAttempts: ActivePlanAttemptV1[] = [];
    const finishedAttempts: ActivePlanAttemptV1[] = [];
    for (const plan of state.plans.values()) {
      const terminalStatus =
        checkpointStatusByAttemptId.get(plan.attemptId) === 'handed_off'
          ? 'handed_off'
          : state.finished.get(plan.attemptId);
      const attempt = {
        attemptId: plan.attemptId,
        agentId: plan.harness,
        nodeId: plan.stageId,
        nodeVersion:
          plan.nodeVersion ??
          planView.planRevision.nodes.find((node) => node.nodeId === plan.stageId)?.nodeVersion ??
          `unknown:${plan.stageId}`,
        planRevisionId: plan.planRevisionId ?? planView.planRevision.planRevisionId,
        contractRevisionId: plan.contractRevisionId ?? planView.contractRevision.contractRevisionId,
        status: terminalStatus === undefined ? ('running' as const) : ('finished' as const),
        ...(terminalStatus === undefined ? {} : { terminalStatus }),
        authorityRefs: ['workspace'],
        evidenceRefs: [`attempt:${plan.attemptId}`],
      } satisfies ActivePlanAttemptV1;
      if (terminalStatus === undefined) activeAttempts.push(attempt);
      else finishedAttempts.push(attempt);
    }
    const legacyArtifacts: PlanArtifactV1[] = state.checkpoints.flatMap((checkpoint) => {
      if (checkpoint.status !== 'succeeded' && checkpoint.status !== 'handed_off') return [];
      const receipt = receiptByAttemptId.get(checkpoint.attemptId);
      // A checkpoint is a workspace boundary, not proof that a plan node
      // succeeded.  Only a verified Branch-bound Receipt can promote it to a
      // PlanArtifact; otherwise the runtime projection stays `unknown`.
      if (receipt === undefined) return [];
      const node = planView.planRevision.nodes.find(
        (candidate) => candidate.nodeId === checkpoint.stageId,
      );
      const artifactId = `plan-artifact:${checkpoint.checkpointId}`;
      return [
        {
          schemaVersion: 'missionbraid.dev/plan-artifact/v1',
          artifactId,
          artifactDigest: checkpoint.delta.afterWorkspaceDigest,
          missionId,
          planId: planView.planRevision.planId,
          planRevisionId: planView.planRevision.planRevisionId,
          contractRevisionId: planView.contractRevision.contractRevisionId,
          producedByNodeId: checkpoint.stageId,
          producerNodeVersion: node?.nodeVersion ?? `unknown:${checkpoint.stageId}`,
          requirementIds: node?.requirementIds ?? [],
          sourceArtifactIds: [],
          verifierEvidence: receipt.verifications.map((verification) => ({
            evidenceId: `receipt:${receipt.receiptId}:criterion:${verification.criterionId}`,
            evaluator: 'deterministic' as const,
            verifierId: `receipt:${receipt.receiptId}`,
            subjectId: artifactId,
            subjectDigest: checkpoint.delta.afterWorkspaceDigest ?? checkpoint.checkpointId,
            result: {
              criterionId: verification.criterionId,
              status: verification.status,
              evidenceRefs: verification.evidenceRefs,
            },
            evidenceRefs: [`receipt:${receipt.receiptId}`, ...verification.evidenceRefs],
          })),
          evidenceRefs: [
            `checkpoint:${checkpoint.checkpointId}`,
            `attempt:${checkpoint.attemptId}`,
            `receipt:${receipt.receiptId}`,
          ],
        },
      ];
    });
    const artifacts = [
      ...planView.execution.artifacts.map((record) => record.artifact),
      ...legacyArtifacts.filter(
        (artifact) =>
          !planView.execution.artifacts.some(
            (record) => record.artifact.artifactId === artifact.artifactId,
          ),
      ),
    ];
    return projectMissionPlanRuntime({
      plan: planView.planRevision,
      activeAttempts,
      finishedAttempts,
      artifacts,
      invalidations: planView.invalidations,
    });
  }

  async reviseMissionContract(
    missionId: string,
    input: ReviseMissionContractInputV1,
  ): Promise<ReviseMissionContractResultV1> {
    const mission = this.#requireMission(missionId);
    const activeRun = this.#activePlanRuns.get(missionId);
    if (activeRun !== undefined) {
      return this.#reviseMissionContractUnderFence(missionId, input, activeRun.fence, activeRun);
    }
    const ownerId = `contract-revision-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) =>
      this.#reviseMissionContractUnderFence(missionId, input, fence),
    );
  }

  #reviseMissionContractUnderFence(
    missionId: string,
    input: ReviseMissionContractInputV1,
    fence: WorkspaceFenceV1,
    activeRun?: ActiveMissionPlanRun,
  ): ReviseMissionContractResultV1 {
    const current = this.missionPlan(missionId);
    assertSupportedExecutableContractRevision(current.contractRevision.contract, input.contract);
    const createdAt = this.#now().toISOString();
    const next = createContractRevision({
      missionId,
      contract: input.contract,
      requirements: input.requirements,
      ...(input.authorityChanges === undefined ? {} : { authorityChanges: input.authorityChanges }),
      previousRevision: current.contractRevision,
      provenance: { reason: input.reason, evidenceRefs: input.evidenceRefs ?? [] },
      createdAt,
    });
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    const activeAttempts: ActivePlanAttemptV1[] = (
      activeRun === undefined
        ? [...state.plans.values()].flatMap((plan) => {
            if (
              state.finished.has(plan.attemptId) ||
              plan.planRevisionId === undefined ||
              plan.contractRevisionId === undefined ||
              plan.nodeVersion === undefined
            ) {
              return [];
            }
            return [
              {
                attemptId: plan.attemptId,
                agentId: plan.harness,
                nodeId: plan.stageId,
                nodeVersion: plan.nodeVersion,
                planRevisionId: plan.planRevisionId,
                contractRevisionId: plan.contractRevisionId,
                status: 'running' as const,
                authorityRefs: ['workspace'],
                evidenceRefs: [`attempt:${plan.attemptId}`],
              },
            ];
          })
        : [...activeRun.attempts.values()].map((attempt) => ({
            attemptId: attempt.attemptId,
            agentId: attempt.harness,
            nodeId: attempt.nodeId,
            nodeVersion: attempt.nodeVersion,
            planRevisionId: attempt.planRevisionId,
            contractRevisionId: attempt.contractRevisionId,
            status: 'running' as const,
            authorityRefs: ['workspace'],
            evidenceRefs: [`attempt:${attempt.attemptId}`, `branch:${attempt.branchId}`],
          }))
    ).filter((attempt) => attempt.planRevisionId === current.planRevision.planRevisionId);
    const artifacts = current.execution.artifacts.map((record) => record.artifact);
    const invalidation = analyzeSelectiveInvalidation({
      plan: current.planRevision,
      previousContractRevision: current.contractRevision,
      nextContractRevision: next,
      artifacts,
      activeAttempts,
    });
    const nextRequirementIds = new Set(next.requirements.map((item) => item.requirementId));
    const nextPlan = createMissionPlanRevision({
      planId: current.planRevision.planId,
      missionId,
      contractRevision: next,
      parentRevision: current.planRevision,
      nodes: current.planRevision.nodes.map((node) => ({
        nodeId: node.nodeId,
        kind: node.kind,
        title: node.title,
        requirementIds: node.requirementIds.filter((requirementId) =>
          nextRequirementIds.has(requirementId),
        ),
        inputArtifactIds: node.inputArtifactIds,
        declaredOutputKeys: node.declaredOutputKeys,
        requiredAuthorityScopes: node.requiredAuthorityScopes,
        workspace: node.workspace,
        provenanceEvidenceRefs: node.provenanceEvidenceRefs,
      })),
      edges: current.planRevision.edges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        relation: edge.relation,
        evidenceRefs: edge.evidenceRefs,
      })),
      sharedResources: current.planRevision.sharedResources,
      provenance: {
        source: 'deterministic-planner',
        evidenceRefs: uniqueStrings([
          ...current.planRevision.provenance.evidenceRefs,
          ...next.provenance.evidenceRefs,
        ]),
      },
      createdAt,
    });
    this.#store.appendEvents(
      [
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: createdAt,
          type: 'runtime.observation',
          payload: {
            kind: 'mission.contract_revision.created',
            data: next as unknown as JsonValue,
          },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: createdAt,
          type: 'runtime.observation',
          payload: {
            kind: 'mission.plan_revision.created',
            data: nextPlan as unknown as JsonValue,
          },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: createdAt,
          type: 'runtime.observation',
          payload: {
            kind: 'mission.selective_invalidation.created',
            data: invalidation as unknown as JsonValue,
          },
        },
        ...invalidation.staleAttemptFences.map(
          (attemptFence): EventV1 => ({
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            eventId: `event-${this.#id()}`,
            missionId,
            attemptId: attemptFence.attemptId,
            occurredAt: createdAt,
            type: 'runtime.observation',
            payload: {
              kind: 'mission.attempt_fence.requested',
              data: attemptFence as unknown as JsonValue,
            },
          }),
        ),
      ],
      fence,
    );
    if (activeRun !== undefined) {
      for (const attemptFence of invalidation.staleAttemptFences) {
        const attempt = activeRun.attempts.get(attemptFence.attemptId);
        if (attempt === undefined) continue;
        attempt.fence = attemptFence;
        attempt.controller.abort();
      }
    }
    return { contractRevision: next, planRevision: nextPlan, invalidation };
  }

  /** Execute the optional Mission Plan DAG with one isolated native Agent per ready node. */
  async executeMissionPlan(
    missionId: string,
    signal?: AbortSignal,
  ): Promise<MissionPlanExecutionResultV1> {
    const mission = this.#requireMission(missionId);
    const spec = this.#requireSpecSnapshot(missionId);
    if (spec.plan === undefined) {
      throw new MissionExecutionError(`Mission ${missionId} has no executable Mission Plan`);
    }
    if (this.#activePlanRuns.has(missionId)) {
      throw new MissionExecutionError(`Mission ${missionId} already has an active Plan run`);
    }
    const ownerId = `plan-runner-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      const baselineCommit = gitText(spec.workspace, ['rev-parse', '--verify', 'HEAD']);
      const baselineSnapshot = snapshotGitWorkspace(spec.workspace, { now: this.#now });
      const baselineCheckpointId = `plan-baseline-${hashPayload({
        missionId,
        baselineCommit,
        workspaceDigest: baselineSnapshot.workspaceDigest,
      }).slice(0, 28)}`;
      if (
        !this.#store
          .listEvents(missionId)
          .some(
            (event) =>
              event.type === 'runtime.observation' &&
              event.payload.kind === 'mission.plan_base_checkpoint.created' &&
              isJsonObject(event.payload.data) &&
              event.payload.data.checkpointId === baselineCheckpointId,
          )
      ) {
        this.#observe(
          missionId,
          'mission.plan_base_checkpoint.created',
          {
            checkpointId: baselineCheckpointId,
            branchId: requireRootBranch(mission),
            baselineCommit,
            workspaceDigest: baselineSnapshot.workspaceDigest,
          },
          fence,
        );
      }
      const run: ActiveMissionPlanRun = {
        missionId,
        fence,
        spec,
        baselineCheckpointId,
        baselineCommit,
        attempts: new Map(),
      };
      this.#activePlanRuns.set(missionId, run);
      this.#append(
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId,
          occurredAt: this.#now().toISOString(),
          type: 'mission.status_changed',
          payload: { status: 'running' },
        },
        fence,
      );
      await this.#writeProvenanceProjection(missionId);
      try {
        while (signal?.aborted !== true) {
          const pendingView = this.missionPlan(missionId);
          const unplannedRequirementIds = activeUnplannedRequirementIds(pendingView);
          if (unplannedRequirementIds.length > 0) {
            const reason = `Mission Plan has unplanned requirements: ${unplannedRequirementIds.join(', ')}`;
            this.#setWaiting(missionId, reason, fence);
            return { missionId, status: 'waiting', waitingReason: reason };
          }
          this.#adoptReusablePlanArtifacts(run);
          const view = this.missionPlan(missionId);
          const artifactByNode = currentPlanArtifactByNode(view);
          const nonJoinNodes = view.planRevision.nodes.filter((node) => node.kind !== 'join');
          const incomplete = nonJoinNodes.filter((node) => !artifactByNode.has(node.nodeId));
          if (incomplete.length > 0) {
            const ready = incomplete.filter((node) => {
              if (
                [...run.attempts.values()].some(
                  (attempt) =>
                    attempt.nodeId === node.nodeId &&
                    attempt.planRevisionId === view.planRevision.planRevisionId,
                )
              ) {
                return false;
              }
              const predecessors = view.planRevision.edges
                .filter((edge) => edge.toNodeId === node.nodeId)
                .map((edge) => edge.fromNodeId);
              return predecessors.every((predecessor) => artifactByNode.has(predecessor));
            });
            if (ready.length === 0) {
              const reason =
                'No executable Plan node is ready from the persisted artifact frontier';
              this.#setWaiting(missionId, reason, fence);
              return { missionId, status: 'waiting', waitingReason: reason };
            }
            const outcomes = await Promise.all(
              ready.map(
                async (node) => await this.#executeMissionPlanNode(run, view, node.nodeId, signal),
              ),
            );
            const latest = this.missionPlan(missionId);
            const revisionChanged =
              latest.planRevision.planRevisionId !== view.planRevision.planRevisionId;
            const hardFailure = outcomes.find(
              (outcome) => outcome.status === 'failed' || outcome.status === 'abandoned',
            );
            if (hardFailure !== undefined && !revisionChanged) {
              const reason =
                hardFailure.detail ?? `Plan node ${hardFailure.nodeId} did not produce an artifact`;
              this.#setWaiting(missionId, reason, fence);
              return { missionId, status: 'waiting', waitingReason: reason };
            }
            continue;
          }

          const joinNode = view.planRevision.nodes.find((node) => node.kind === 'join');
          if (joinNode === undefined) {
            const reason = 'Mission Plan has no consolidation join node';
            this.#setWaiting(missionId, reason, fence);
            return { missionId, status: 'waiting', waitingReason: reason };
          }
          const receipt = await this.#executeMissionPlanConsolidation(
            run,
            view,
            joinNode.nodeId,
            signal,
          );
          if (receipt === undefined) continue;
          return { missionId, status: 'succeeded', receipt };
        }
        const reason = 'Mission Plan execution was interrupted';
        this.#setWaiting(missionId, reason, fence);
        return { missionId, status: 'waiting', waitingReason: reason };
      } finally {
        for (const attempt of run.attempts.values()) attempt.controller.abort();
        this.#activePlanRuns.delete(missionId);
      }
    });
  }

  #adoptReusablePlanArtifacts(run: ActiveMissionPlanRun): void {
    const view = this.missionPlan(run.missionId);
    const invalidation = [...view.invalidations]
      .reverse()
      .find(
        (candidate) =>
          candidate.targetContractRevisionId === view.contractRevision.contractRevisionId &&
          candidate.sourcePlanRevisionId === view.planRevision.parentPlanRevisionId,
      );
    if (invalidation === undefined) return;
    const existingIds = new Set(
      view.execution.artifacts.map((record) => record.artifact.artifactId),
    );
    const currentNodes = new Map(view.planRevision.nodes.map((node) => [node.nodeId, node]));
    for (const source of view.execution.artifacts) {
      if (
        source.artifact.planRevisionId !== invalidation.sourcePlanRevisionId ||
        !invalidation.reusableNodeIds.includes(source.artifact.producedByNodeId) ||
        !planArtifactHasPassingEvidence(source.artifact)
      ) {
        continue;
      }
      const node = currentNodes.get(source.artifact.producedByNodeId);
      if (node === undefined || node.nodeVersion !== source.artifact.producerNodeVersion) continue;
      const artifactId = `plan-artifact-reuse-${hashPayload({
        sourceArtifactId: source.artifact.artifactId,
        targetPlanRevisionId: view.planRevision.planRevisionId,
      }).slice(0, 28)}`;
      if (existingIds.has(artifactId)) continue;
      const evidence: DeterministicVerifierEvidenceV1 = {
        evidenceId: `reuse-evidence-${hashPayload({ artifactId, invalidation: invalidation.invalidationId }).slice(0, 28)}`,
        evaluator: 'deterministic',
        verifierId: 'missionbraid-selective-reuse',
        subjectId: artifactId,
        subjectDigest: source.artifact.artifactDigest,
        result: {
          criterionId: `reuse-${node.nodeId}`,
          status: 'passed',
          evidenceRefs: [
            `invalidation:${invalidation.invalidationId}`,
            `source-artifact:${source.artifact.artifactId}`,
          ],
        },
        evidenceRefs: [
          `invalidation:${invalidation.invalidationId}`,
          `source-artifact:${source.artifact.artifactId}`,
        ],
      };
      const artifact = recordPlanArtifact({
        artifactId,
        artifactDigest: source.artifact.artifactDigest,
        plan: view.planRevision,
        producedByNodeId: node.nodeId,
        sourceArtifactIds: [source.artifact.artifactId],
        verifierEvidence: [evidence],
        evidenceRefs: [
          `invalidation:${invalidation.invalidationId}`,
          `source-artifact:${source.artifact.artifactId}`,
        ],
      });
      const record: MissionPlanArtifactRecordV1 = {
        ...source,
        recordId: `artifact-record-${this.#id()}`,
        artifact,
        recordedAt: this.#now().toISOString(),
        reusedFromArtifactId: source.artifact.artifactId,
        invalidationId: invalidation.invalidationId,
      };
      this.#observe(
        run.missionId,
        'mission.plan_artifact.reused',
        { record: record as unknown as JsonValue },
        run.fence,
        source.attemptId,
      );
      existingIds.add(artifactId);
    }
  }

  async #executeMissionPlanNode(
    run: ActiveMissionPlanRun,
    view: MissionPlanView,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<MissionPlanNodeRunOutcome> {
    const node = view.planRevision.nodes.find((candidate) => candidate.nodeId === nodeId);
    const nodeSpec = run.spec.plan?.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node === undefined || nodeSpec === undefined) {
      throw new MissionExecutionError(`Plan node ${nodeId} is not executable`);
    }
    const stage = run.spec.attemptPlan.find((candidate) => candidate.stageId === nodeSpec.stageId);
    if (stage === undefined) {
      throw new MissionExecutionError(
        `Plan node ${nodeId} references missing stage ${nodeSpec.stageId}`,
      );
    }
    const detection = await this.#detectStage(stage);
    if (!detection.available || !detection.responsive || detection.status !== 'ready') {
      return {
        attemptId: `attempt-unstarted-${this.#id()}`,
        nodeId,
        status: 'failed',
        detail: `Runtime ${stage.profile.harness} is unavailable`,
      };
    }
    const identity = hashPayload({
      missionId: run.missionId,
      nodeId,
      planRevisionId: view.planRevision.planRevisionId,
      nonce: this.#id(),
    }).slice(0, 28);
    const branchId = `branch-plan-${identity}`;
    const attemptId = `attempt-plan-${identity}`;
    const bindingId = `binding-plan-${identity}`;
    const workspaceKey = `workspace-plan-${identity}`;
    const worktreePath = join(this.#stateDir, 'worktrees', run.missionId, `plan-${identity}`);
    const gitBranchName = `missionbraid/plan-${identity}`;
    await mkdir(dirname(worktreePath), { recursive: true });
    gitExec(run.spec.workspace, [
      'worktree',
      'add',
      '-b',
      gitBranchName,
      worktreePath,
      run.baselineCommit,
    ]);
    const before = snapshotGitWorkspace(worktreePath, { now: this.#now });
    const controlDirectory = join(worktreePath, '.missionbraid');
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(
      join(controlDirectory, 'contract-revision.json'),
      `${JSON.stringify(
        {
          contractRevisionId: view.contractRevision.contractRevisionId,
          revisionNumber: view.contractRevision.revisionNumber,
          requirements: view.contractRevision.requirements,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const executionBaseline = snapshotGitWorkspace(worktreePath, { now: this.#now });
    const profile = createProfile(stage, detection, worktreePath, this.#adapterManifest(stage));
    const startedAt = this.#now().toISOString();
    const branch: BranchV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      branchId,
      missionId: run.missionId,
      parentBranchId: requireRootBranch(this.#requireMission(run.missionId)),
      baseCheckpointId: run.baselineCheckpointId,
      status: 'active',
      createdAt: startedAt,
    };
    const binding: AttemptBindingV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      bindingId,
      missionId: run.missionId,
      attemptId,
      branchId,
      contractId: view.contractRevision.contract.contractId,
      profileId: profile.profileId,
      workspaceKey,
      planNodeId: node.nodeId,
      planRevisionId: view.planRevision.planRevisionId,
      contractRevisionId: view.contractRevision.contractRevisionId,
      nodeVersion: node.nodeVersion,
      agentId: stage.profile.harness,
      authorityRefs: ['workspace'],
      fenceGeneration: view.contractRevision.revisionNumber,
      authority: 'workspace',
      injectionBudgetTokens: stage.profile.injectionBudgetTokens,
      boundAt: startedAt,
      runtimeBinding: runtimeBinding(attemptId, profile),
    };
    const effectId = `effect-plan-${identity}`;
    const effect: EffectV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      effectId,
      missionId: run.missionId,
      attemptId,
      kind: 'workspace.plan_node_mutation',
      resourceKey: workspaceKey,
      controlLevel: 'enforced',
      scope: 'branch_local_workspace',
      status: 'intended',
      evidenceRefs: [
        `plan:${view.planRevision.planRevisionId}`,
        `contract:${view.contractRevision.contractRevisionId}`,
      ],
      createdAt: startedAt,
    };
    this.#store.appendEvents(
      [
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          occurredAt: startedAt,
          type: 'branch.created',
          payload: { branch },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          occurredAt: detection.checkedAt,
          type: 'runtime.catalog_observed',
          payload: { observation: requireCatalogObservation(profile) },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          occurredAt: startedAt,
          type: 'profile.selected',
          payload: { profile, reason: `Mission Plan node ${node.nodeId}` },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'attempt.bound',
          payload: { binding },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'effect.recorded',
          payload: { effect },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'runtime.observation',
          payload: {
            kind: 'attempt.plan',
            data: {
              attemptId,
              stageId: node.nodeId,
              sourceStageId: stage.stageId,
              harness: stage.profile.harness,
              profileId: profile.profileId,
              branchId,
              bindingId,
              workspaceKey,
              planRevisionId: view.planRevision.planRevisionId,
              contractRevisionId: view.contractRevision.contractRevisionId,
              nodeVersion: node.nodeVersion,
              operation: 'mission-plan-node',
            },
          },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'attempt.started',
          payload: {
            attempt: {
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              attemptId,
              missionId: run.missionId,
              branchId,
              profileId: profile.profileId,
              stageId: node.nodeId,
              status: 'running',
              startedAt,
            },
          },
        },
      ],
      run.fence,
    );
    const controller = new AbortController();
    const active: ActiveMissionPlanNodeRun = {
      attemptId,
      nodeId,
      nodeVersion: node.nodeVersion,
      planRevisionId: view.planRevision.planRevisionId,
      contractRevisionId: view.contractRevision.contractRevisionId,
      harness: stage.profile.harness,
      branchId,
      workspaceKey,
      workspacePath: worktreePath,
      controller,
    };
    run.attempts.set(attemptId, active);
    const runtimeSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const prompt = createMissionPlanNodePrompt(view, nodeSpec, stage);
    const promptArtifact = await this.#artifacts.putLine(prompt);
    this.#observe(
      run.missionId,
      'context.controller_prompt',
      {
        attemptId,
        branchId,
        bindingId,
        planNodeId: node.nodeId,
        planRevisionId: view.planRevision.planRevisionId,
        contractRevisionId: view.contractRevision.contractRevisionId,
        source: 'missionbraid-plan-coordinator',
        adapterBinding: 'native-process-prompt-argument',
        visibility: 'known',
        completeness: 'partial',
        nativeArtifact: promptArtifact as unknown as JsonValue,
      },
      run.fence,
      attemptId,
    );
    const runtimeEventIdByNativeIdentity = new Map<string, string>();
    const outputHash = createHash('sha256');
    let outputLines = 0;
    let runtimeResult: RuntimeRunResult;
    try {
      runtimeResult = await this.#runRuntime(stage, profile, {
        missionId: run.missionId,
        branchId,
        attemptId,
        bindingId,
        workspaceKey,
        workspace: worktreePath,
        prompt,
        signal: runtimeSignal,
        onStart: (pid) => {
          this.#observe(
            run.missionId,
            'runtime.process_started',
            {
              attemptId,
              nodeId,
              harness: stage.profile.harness,
              pid,
              planRevisionId: view.planRevision.planRevisionId,
              contractRevisionId: view.contractRevision.contractRevisionId,
            },
            run.fence,
            attemptId,
          );
        },
        onOutput: async (line) => {
          const artifact = await this.#artifacts.putLine(line.line);
          const causalParentIds = nativeParentCorrelationIds(line.value).flatMap((parentId) => {
            const parent = runtimeEventIdByNativeIdentity.get(parentId);
            return parent === undefined ? [] : [parent];
          });
          const normalized = normalizeRuntimeOutput(
            line,
            {
              missionId: run.missionId,
              branchId,
              attemptId,
              bindingId,
              planNodeId: node.nodeId,
              sourceProtocol: this.#runtimeProtocol(stage),
              ...(causalParentIds.length === 0 ? {} : { causalParentIds }),
            },
            artifact,
          );
          this.#append(
            {
              schemaVersion: DOMAIN_SCHEMA_VERSION,
              eventId: normalized.runtimeEventId,
              missionId: run.missionId,
              attemptId,
              occurredAt: normalized.observedAt,
              type: 'runtime.event',
              payload: { event: normalized },
            },
            run.fence,
          );
          for (const nativeIdentity of nativeEventIdentityIds(line.value)) {
            runtimeEventIdByNativeIdentity.set(nativeIdentity, normalized.runtimeEventId);
          }
          outputHash.update(`${line.stream}\0${line.line}\n`, 'utf8');
          outputLines += 1;
        },
      });
    } catch (error) {
      runtimeResult = runtimeThrownResult(
        stage.profile.harness,
        this.#runtimeResultProtocol(stage),
        error,
        startedAt,
        this.#now(),
      );
    }
    const afterRuntime = snapshotGitWorkspace(worktreePath, { now: this.#now });
    const runtimeDelta = createStageWorkspaceDelta(executionBaseline, afterRuntime);
    const processSucceeded = processResultSucceeded(runtimeResult);
    this.#observe(
      run.missionId,
      'runtime.process_finished',
      {
        attemptId,
        nodeId,
        harness: stage.profile.harness,
        exitCode: runtimeResult.process.exitCode,
        signal: runtimeResult.process.signal,
        aborted: runtimeResult.process.aborted,
        outputSha256: outputHash.digest('hex'),
        outputLines,
        ...(runtimeResult.outputAccounting === undefined
          ? {}
          : {
              rawOutputSha256: runtimeResult.outputAccounting.rawSha256,
              rawOutputLines: runtimeResult.outputAccounting.rawLineCount,
              retainedOutputLines: runtimeResult.outputAccounting.retainedLineCount,
              droppedOutputLines: runtimeResult.outputAccounting.droppedLineCount,
              outputCompactionStrategy: runtimeResult.outputAccounting.strategy,
            }),
        planRevisionId: view.planRevision.planRevisionId,
        contractRevisionId: view.contractRevision.contractRevisionId,
      },
      run.fence,
      attemptId,
    );
    const postRuntimeFence = this.#missionPlanAttemptFence(run, active, view);
    if (postRuntimeFence !== undefined) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        effectId,
        'abandoned',
        runtimeDelta.changedPaths.length > 0 ? 'confirmed' : 'skipped',
        `Attempt fenced by ${postRuntimeFence.fenceId}`,
      );
      this.#observe(
        run.missionId,
        'mission.attempt_fenced',
        {
          ...postRuntimeFence,
          processAborted: runtimeResult.process.aborted,
          preservedWorkspaceDigest: afterRuntime.workspaceDigest,
        } as unknown as JsonValue,
        run.fence,
        attemptId,
      );
      run.attempts.delete(attemptId);
      return { attemptId, nodeId, status: 'abandoned', detail: 'Obsolete revision was fenced' };
    }
    if (!processSucceeded) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        effectId,
        'failed',
        runtimeDelta.changedPaths.length > 0 ? 'confirmed' : 'failed',
        failureSummary(runtimeResult, false, true, true),
      );
      run.attempts.delete(attemptId);
      return {
        attemptId,
        nodeId,
        status: 'failed',
        detail: failureSummary(runtimeResult, false, true, true),
      };
    }
    const changedPaths = runtimeDelta.changedPaths.map((change) => change.path);
    const undeclared = changedPaths.filter((path) => !node.declaredOutputKeys.includes(path));
    if (undeclared.length > 0 || changedPaths.length === 0) {
      const detail =
        changedPaths.length === 0
          ? 'Agent produced no declared workspace output'
          : `Agent changed undeclared paths: ${undeclared.join(', ')}`;
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        effectId,
        'failed',
        changedPaths.length === 0 ? 'skipped' : 'confirmed',
        detail,
      );
      run.attempts.delete(attemptId);
      return { attemptId, nodeId, status: 'failed', detail };
    }
    const verifications = await this.#verifyPlanNode(
      run,
      nodeSpec,
      worktreePath,
      attemptId,
      signal,
    );
    const afterVerification = snapshotGitWorkspace(worktreePath, { now: this.#now });
    const verifierDelta = createStageWorkspaceDelta(afterRuntime, afterVerification);
    const postVerificationFence = this.#missionPlanAttemptFence(run, active, view);
    if (postVerificationFence !== undefined) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        effectId,
        'abandoned',
        runtimeDelta.changedPaths.length > 0 ? 'confirmed' : 'skipped',
        `Attempt fenced by ${postVerificationFence.fenceId}`,
      );
      this.#observe(
        run.missionId,
        'mission.attempt_fenced',
        {
          ...postVerificationFence,
          processAborted: runtimeResult.process.aborted,
          preservedWorkspaceDigest: snapshotGitWorkspace(worktreePath, { now: this.#now })
            .workspaceDigest,
        } as unknown as JsonValue,
        run.fence,
        attemptId,
      );
      run.attempts.delete(attemptId);
      return { attemptId, nodeId, status: 'abandoned', detail: 'Obsolete revision was fenced' };
    }
    if (verifierDelta.changedPaths.length > 0) {
      const undeclaredVerifierPaths = verifierDelta.changedPaths
        .map((change) => change.path)
        .filter((path) => !node.declaredOutputKeys.includes(path));
      const detail =
        undeclaredVerifierPaths.length > 0
          ? `Verifier changed undeclared paths: ${undeclaredVerifierPaths.join(', ')}`
          : `Verifier changed Agent output paths: ${verifierDelta.changedPaths
              .map((change) => change.path)
              .join(', ')}`;
      this.#appendPlanNodeTerminalEvents(run, attemptId, effectId, 'failed', 'confirmed', detail);
      run.attempts.delete(attemptId);
      return { attemptId, nodeId, status: 'failed', detail };
    }
    if (verifications.some((verification) => !verification.result.passed)) {
      const detail = `Deterministic verifier rejected Plan node ${nodeId}`;
      this.#appendPlanNodeTerminalEvents(run, attemptId, effectId, 'failed', 'confirmed', detail);
      run.attempts.delete(attemptId);
      return { attemptId, nodeId, status: 'failed', detail };
    }
    await rm(controlDirectory, { recursive: true, force: true });
    gitExec(worktreePath, ['add', '--', ...node.declaredOutputKeys.map(assertSafePlanOutputPath)]);
    gitExec(worktreePath, [
      '-c',
      'user.name=MissionBraid',
      '-c',
      'user.email=missionbraid@localhost',
      'commit',
      '--no-gpg-sign',
      '-m',
      `MissionBraid Plan node ${node.nodeId}`,
    ]);
    const sourceCommit = gitText(worktreePath, ['rev-parse', 'HEAD']);
    const sealed = snapshotGitWorkspace(worktreePath, { now: this.#now });
    assertSealedPlanWorkspace(sealed, sourceCommit);
    const sealedDelta = createStageWorkspaceDelta(before, sealed);
    const artifactId = `plan-artifact-${hashPayload({ attemptId, sourceCommit }).slice(0, 28)}`;
    const verifierEvidence: DeterministicVerifierEvidenceV1[] = verifications.map(
      ({ criterionId, result }) => ({
        evidenceId: `plan-verifier-${hashPayload({ artifactId, criterionId, invocation: result.invocationDigest }).slice(0, 28)}`,
        evaluator: 'deterministic',
        verifierId: `command:${result.invocationDigest}`,
        subjectId: artifactId,
        subjectDigest: sealed.workspaceDigest,
        result: {
          criterionId,
          status: 'passed',
          evidenceRefs: [
            `verifier:${result.invocationDigest}`,
            `stdout:sha256:${result.stdout.sha256}`,
            `stderr:sha256:${result.stderr.sha256}`,
          ],
        },
        evidenceRefs: [
          `verifier:${result.invocationDigest}`,
          `stdout:sha256:${result.stdout.sha256}`,
          `stderr:sha256:${result.stderr.sha256}`,
        ],
      }),
    );
    const artifact = recordPlanArtifact({
      artifactId,
      artifactDigest: sealed.workspaceDigest,
      plan: view.planRevision,
      producedByNodeId: node.nodeId,
      verifierEvidence,
      evidenceRefs: [`attempt:${attemptId}`, `branch:${branchId}`, `commit:${sourceCommit}`],
    });
    const record: MissionPlanArtifactRecordV1 = {
      recordId: `artifact-record-${this.#id()}`,
      artifact,
      attemptId,
      branchId,
      workspaceKey,
      workspacePath: worktreePath,
      sourceCommit,
      changedPaths: sealedDelta.changedPaths.map((change) => change.path),
      recordedAt: this.#now().toISOString(),
    };
    const checkpointId = `checkpoint-plan-${hashPayload({ attemptId, sourceCommit }).slice(0, 28)}`;
    this.#observe(
      run.missionId,
      'checkpoint.created',
      {
        checkpointId,
        missionId: run.missionId,
        attemptId,
        stageId: node.nodeId,
        harness: stage.profile.harness,
        profileId: profile.profileId,
        branchId,
        bindingId,
        status: 'succeeded',
        delta: sealedDelta,
        origin: 'runtime-completion',
      } as unknown as JsonValue,
      run.fence,
      attemptId,
    );
    this.#appendPlanNodeTerminalEvents(
      run,
      attemptId,
      effectId,
      'succeeded',
      'confirmed',
      `Plan node ${node.nodeId} passed deterministic verification`,
    );
    this.#observe(
      run.missionId,
      'mission.plan_artifact.recorded',
      { record: record as unknown as JsonValue },
      run.fence,
      attemptId,
    );
    run.attempts.delete(attemptId);
    return { attemptId, nodeId, status: 'succeeded', artifact: record };
  }

  #missionPlanAttemptFence(
    run: ActiveMissionPlanRun,
    attempt: ActiveMissionPlanNodeRun,
    observedView: MissionPlanView,
  ): StaleAttemptFenceV1 | undefined {
    const requested = planAttemptFence(attempt);
    if (requested !== undefined) return requested;
    const latest = this.missionPlan(run.missionId);
    if (
      latest.planRevision.planRevisionId === observedView.planRevision.planRevisionId &&
      latest.contractRevision.contractRevisionId ===
        observedView.contractRevision.contractRevisionId
    ) {
      return undefined;
    }
    const stale: StaleAttemptFenceV1 = {
      fenceId: `attempt-fence-${hashPayload({
        attemptId: attempt.attemptId,
        observedPlanRevisionId: attempt.planRevisionId,
        observedContractRevisionId: attempt.contractRevisionId,
        targetContractRevisionId: latest.contractRevision.contractRevisionId,
      }).slice(0, 28)}`,
      attemptId: attempt.attemptId,
      agentId: attempt.harness,
      nodeId: attempt.nodeId,
      reason: 'obsolete-contract-revision',
      action: 'interrupt-and-preserve-evidence',
      acceptsFurtherEffects: false,
      observedPlanRevisionId: attempt.planRevisionId,
      observedContractRevisionId: attempt.contractRevisionId,
      targetContractRevisionId: latest.contractRevision.contractRevisionId,
      evidenceRefs: [
        `plan:${attempt.planRevisionId}`,
        `contract:${attempt.contractRevisionId}`,
        `target-contract:${latest.contractRevision.contractRevisionId}`,
      ],
    };
    attempt.fence = stale;
    attempt.controller.abort();
    return stale;
  }

  #appendPlanNodeTerminalEvents(
    run: ActiveMissionPlanRun,
    attemptId: string,
    effectId: string,
    attemptStatus: 'succeeded' | 'failed' | 'abandoned',
    effectStatus: EffectV1['status'],
    summary: string,
  ): void {
    const endedAt = this.#now().toISOString();
    this.#store.appendEvents(
      [
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: endedAt,
          type: 'effect.status_changed',
          payload: {
            effectId,
            status: effectStatus,
            evidenceRefs: [`attempt:${attemptId}`, `summary:${hashPayload(summary)}`],
          },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: endedAt,
          type: 'attempt.finished',
          payload: { attemptId, status: attemptStatus, endedAt, summary },
        },
      ],
      run.fence,
    );
  }

  async #verifyPlanNode(
    run: ActiveMissionPlanRun,
    nodeSpec: MissionPlanNodeSpecV1,
    workspacePath: string,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<readonly { criterionId: string; result: CommandVerificationResultV1 }[]> {
    const selected = nodeSpec.acceptanceCriterionIds.map((criterionId) => {
      const criterion = run.spec.acceptanceCriteria.find(
        (candidate) => candidate.id === criterionId,
      );
      if (criterion === undefined) {
        throw new MissionExecutionError(
          `Plan node ${nodeSpec.nodeId} references unknown criterion ${criterionId}`,
        );
      }
      return criterion;
    });
    const results: { criterionId: string; result: CommandVerificationResultV1 }[] = [];
    for (const criterion of selected) {
      const verifier = remapVerifierWorkspace(
        criterion.verifier,
        run.spec.workspace,
        workspacePath,
      );
      const result = await runCommandVerifier(verifier, {
        workspace: workspacePath,
        missionSourceDir: run.spec.missionSourceDir,
        controllerStateDir: this.#stateDir,
        provenanceFile: this.#provenanceFile(run.missionId),
        ...(signal === undefined ? {} : { signal }),
      });
      results.push({ criterionId: criterion.id, result });
      this.#observe(
        run.missionId,
        'verification.completed',
        {
          attemptId,
          nodeId: nodeSpec.nodeId,
          criterionId: criterion.id,
          passed: result.passed,
          invocationDigest: result.invocationDigest,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdoutSha256: result.stdout.sha256,
          stderrSha256: result.stderr.sha256,
        },
        run.fence,
        attemptId,
      );
    }
    return results;
  }

  async #executeMissionPlanConsolidation(
    run: ActiveMissionPlanRun,
    view: MissionPlanView,
    joinNodeId: string,
    signal?: AbortSignal,
  ): Promise<ReceiptV1 | undefined> {
    const joinNode = view.planRevision.nodes.find((node) => node.nodeId === joinNodeId);
    const joinSpec = run.spec.plan?.nodes.find((node) => node.nodeId === joinNodeId);
    if (joinNode === undefined || joinSpec === undefined || joinNode.kind !== 'join') {
      throw new MissionExecutionError(`Join node ${joinNodeId} is not executable`);
    }
    const stage = run.spec.attemptPlan.find((candidate) => candidate.stageId === joinSpec.stageId);
    if (stage === undefined) {
      throw new MissionExecutionError(`Join node ${joinNodeId} has no Runtime stage`);
    }
    const incomingNodeIds = view.planRevision.edges
      .filter((edge) => edge.toNodeId === joinNodeId)
      .map((edge) => edge.fromNodeId)
      .sort();
    const artifactByNode = currentPlanArtifactByNode(view);
    const sources = incomingNodeIds.map((nodeId) => {
      const record = artifactByNode.get(nodeId);
      if (record === undefined) {
        throw new MissionExecutionError(`Join input ${nodeId} has no current verified artifact`);
      }
      return record;
    });
    const sourceSnapshotsBefore = new Map(
      sources.map((source) => {
        const snapshot = snapshotGitWorkspace(source.workspacePath, { now: this.#now });
        if (
          snapshot.head !== source.sourceCommit ||
          snapshot.status.length > 0 ||
          snapshot.workspaceDigest !== source.artifact.artifactDigest
        ) {
          throw new MissionExecutionError(
            `Join input ${source.artifact.artifactId} no longer matches its immutable artifact`,
          );
        }
        return [source.artifact.artifactId, snapshot] as const;
      }),
    );
    const selectedPaths = new Map<string, string>();
    for (const source of sources) {
      for (const path of source.changedPaths) {
        const owner = selectedPaths.get(path);
        if (owner !== undefined && owner !== source.artifact.artifactId) {
          throw new MissionExecutionError(`Join input conflict on ${path}`);
        }
        selectedPaths.set(path, source.artifact.artifactId);
      }
    }
    const identity = hashPayload({
      missionId: run.missionId,
      joinNodeId,
      planRevisionId: view.planRevision.planRevisionId,
      sourceArtifactIds: sources.map((source) => source.artifact.artifactId),
      nonce: this.#id(),
    }).slice(0, 28);
    const branchId = `branch-consolidation-${identity}`;
    const attemptId = `attempt-consolidation-${identity}`;
    const bindingId = `binding-consolidation-${identity}`;
    const workspaceKey = `workspace-consolidation-${identity}`;
    const workspacePath = join(
      this.#stateDir,
      'worktrees',
      run.missionId,
      `consolidation-${identity}`,
    );
    const controller = new AbortController();
    const active: ActiveMissionPlanNodeRun = {
      attemptId,
      nodeId: joinNode.nodeId,
      nodeVersion: joinNode.nodeVersion,
      planRevisionId: view.planRevision.planRevisionId,
      contractRevisionId: view.contractRevision.contractRevisionId,
      harness: stage.profile.harness,
      branchId,
      workspaceKey,
      workspacePath,
      controller,
    };
    run.attempts.set(attemptId, active);
    const runtimeSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    let detection: RuntimeDetection;
    try {
      detection = await this.#detectStage(stage);
    } catch (error) {
      run.attempts.delete(attemptId);
      throw error;
    }
    if (this.#missionPlanAttemptFence(run, active, view) !== undefined) {
      run.attempts.delete(attemptId);
      return undefined;
    }
    if (!detection.available || !detection.responsive || detection.status !== 'ready') {
      run.attempts.delete(attemptId);
      throw new MissionExecutionError(
        `Consolidation Runtime ${stage.profile.harness} is unavailable`,
      );
    }
    const profile = createProfile(
      stage,
      detection,
      run.spec.workspace,
      this.#adapterManifest(stage),
    );
    const startedAt = this.#now().toISOString();
    const planned = planConsolidationAttempt({
      plan: view.planRevision,
      contractRevision: view.contractRevision,
      joinNodeId,
      sources: sources.map((source) => ({
        kind: 'artifact' as const,
        selectionId: `selection-${source.artifact.artifactId}`,
        branchId: source.branchId,
        attemptId: source.attemptId,
        nodeId: source.artifact.producedByNodeId,
        workspaceKey: source.workspaceKey,
        artifact: source.artifact,
        sourceAuthorityRefs: [],
      })),
      newBranchId: branchId,
      newAttemptId: attemptId,
      profileId: profile.profileId,
      targetWorkspaceKey: workspaceKey,
      explicitAuthorityBindings: joinNode.requiredAuthorityScopes.map((scope, index) => ({
        source: 'authorized-grant' as const,
        grantId: `grant-local-plan-integration-${index + 1}`,
        authorityRef: `mission:${run.missionId}:local-workspace`,
        scope,
        evidenceRefs: [
          `user-request:mission-plan-execution`,
          `plan:${view.planRevision.planRevisionId}`,
        ],
      })),
      conflicts: [],
      startedAt,
    });
    if (!planned.ok) {
      throw new MissionExecutionError(
        `Consolidation blocked by ${planned.blocker.code}: ${planned.blocker.detail}`,
      );
    }
    const branch: BranchV1 = {
      ...planned.plan.branch,
      parentBranchId: requireRootBranch(this.#requireMission(run.missionId)),
      baseCheckpointId: run.baselineCheckpointId,
    };
    const consolidationPlan: ConsolidationAttemptPlanV1 = {
      ...planned.plan,
      branch,
    };
    const sourceCommitsBefore = Object.fromEntries(
      sources.map((source) => [source.artifact.artifactId, source.sourceCommit]),
    );
    const record: MissionPlanConsolidationRecordV1 = {
      plan: consolidationPlan,
      sourceArtifactIds: sources.map((source) => source.artifact.artifactId),
      workspacePath,
      sourceCommitsBefore,
      recordedAt: startedAt,
    };
    const binding: AttemptBindingV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      bindingId,
      missionId: run.missionId,
      attemptId,
      branchId,
      contractId: view.contractRevision.contract.contractId,
      profileId: profile.profileId,
      workspaceKey,
      planNodeId: joinNode.nodeId,
      planRevisionId: view.planRevision.planRevisionId,
      contractRevisionId: view.contractRevision.contractRevisionId,
      nodeVersion: joinNode.nodeVersion,
      agentId: stage.profile.harness,
      authorityRefs: consolidationPlan.authority.explicitBindings.map(
        (authority) => authority.authorityRef,
      ),
      fenceGeneration: view.contractRevision.revisionNumber,
      authority: 'workspace',
      injectionBudgetTokens: stage.profile.injectionBudgetTokens,
      boundAt: startedAt,
      runtimeBinding: runtimeBinding(attemptId, profile),
    };
    this.#store.appendEvents(
      [
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          occurredAt: startedAt,
          type: 'runtime.observation',
          payload: {
            kind: 'mission.consolidation.planned',
            data: { record: record as unknown as JsonValue },
          },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          occurredAt: startedAt,
          type: 'branch.created',
          payload: { branch },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          occurredAt: detection.checkedAt,
          type: 'runtime.catalog_observed',
          payload: { observation: requireCatalogObservation(profile) },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          occurredAt: startedAt,
          type: 'profile.selected',
          payload: { profile, reason: `Mission Plan consolidation ${joinNode.nodeId}` },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'attempt.bound',
          payload: { binding },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'effect.recorded',
          payload: { effect: consolidationPlan.workspaceIntegration.effect },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'runtime.observation',
          payload: {
            kind: 'attempt.plan',
            data: {
              attemptId,
              stageId: joinNode.nodeId,
              sourceStageId: stage.stageId,
              harness: stage.profile.harness,
              profileId: profile.profileId,
              branchId,
              bindingId,
              workspaceKey,
              planRevisionId: view.planRevision.planRevisionId,
              contractRevisionId: view.contractRevision.contractRevisionId,
              nodeVersion: joinNode.nodeVersion,
              operation: 'mission-plan-consolidation',
            },
          },
        },
        {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          eventId: `event-${this.#id()}`,
          missionId: run.missionId,
          attemptId,
          occurredAt: startedAt,
          type: 'attempt.started',
          payload: { attempt: consolidationPlan.attempt },
        },
      ],
      run.fence,
    );
    await mkdir(dirname(workspacePath), { recursive: true });
    gitExec(run.spec.workspace, [
      'worktree',
      'add',
      '-b',
      `missionbraid/consolidation-${identity}`,
      workspacePath,
      run.baselineCommit,
    ]);
    const before = snapshotGitWorkspace(workspacePath, { now: this.#now });
    const controlDirectory = join(workspacePath, '.missionbraid');
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(
      join(controlDirectory, 'contract-revision.json'),
      `${JSON.stringify(
        {
          contractRevisionId: view.contractRevision.contractRevisionId,
          revisionNumber: view.contractRevision.revisionNumber,
          requirements: view.contractRevision.requirements,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await writeFile(
      join(controlDirectory, 'selection-manifest.json'),
      `${JSON.stringify(
        {
          consolidationId: consolidationPlan.consolidationId,
          planRevisionId: view.planRevision.planRevisionId,
          contractRevisionId: view.contractRevision.contractRevisionId,
          sources: sources.map((source) => ({
            artifactId: source.artifact.artifactId,
            artifactDigest: source.artifact.artifactDigest,
            sourceCommit: source.sourceCommit,
            paths: source.changedPaths,
          })),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    for (const source of sources) {
      if (source.changedPaths.length === 0) continue;
      gitExec(workspacePath, ['checkout', source.sourceCommit, '--', ...source.changedPaths]);
    }
    const materializedSources = snapshotGitWorkspace(workspacePath, { now: this.#now });
    const integratedSourceDigests = new Map(
      [...selectedPaths.keys()].map((path) => [
        path,
        workspacePathState(materializedSources, path),
      ]),
    );
    const preConsolidationRuntimeFence = this.#missionPlanAttemptFence(run, active, view);
    if (preConsolidationRuntimeFence !== undefined) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'abandoned',
        'confirmed',
        `Consolidation fenced by ${preConsolidationRuntimeFence.fenceId}`,
      );
      this.#observe(
        run.missionId,
        'mission.attempt_fenced',
        {
          ...preConsolidationRuntimeFence,
          processAborted: false,
          preservedWorkspaceDigest: snapshotGitWorkspace(workspacePath, { now: this.#now })
            .workspaceDigest,
        } as unknown as JsonValue,
        run.fence,
        attemptId,
      );
      run.attempts.delete(attemptId);
      return undefined;
    }
    const prompt = createMissionPlanConsolidationPrompt(view, joinSpec, stage, sources);
    const outputHash = createHash('sha256');
    let outputLines = 0;
    const runtimeResult = await this.#runRuntime(stage, profile, {
      missionId: run.missionId,
      branchId,
      attemptId,
      bindingId,
      workspaceKey,
      workspace: workspacePath,
      prompt,
      signal: runtimeSignal,
      onStart: (pid) => {
        this.#observe(
          run.missionId,
          'runtime.process_started',
          {
            attemptId,
            nodeId: joinNode.nodeId,
            harness: stage.profile.harness,
            pid,
            planRevisionId: view.planRevision.planRevisionId,
            contractRevisionId: view.contractRevision.contractRevisionId,
          },
          run.fence,
          attemptId,
        );
      },
      onOutput: async (line) => {
        const nativeArtifact = await this.#artifacts.putLine(line.line);
        const normalized = normalizeRuntimeOutput(
          line,
          {
            missionId: run.missionId,
            branchId,
            attemptId,
            bindingId,
            planNodeId: joinNode.nodeId,
            sourceProtocol: this.#runtimeProtocol(stage),
          },
          nativeArtifact,
        );
        this.#append(
          {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            eventId: normalized.runtimeEventId,
            missionId: run.missionId,
            attemptId,
            occurredAt: normalized.observedAt,
            type: 'runtime.event',
            payload: { event: normalized },
          },
          run.fence,
        );
        outputHash.update(`${line.stream}\0${line.line}\n`, 'utf8');
        outputLines += 1;
      },
    });
    this.#observe(
      run.missionId,
      'runtime.process_finished',
      {
        attemptId,
        nodeId: joinNode.nodeId,
        harness: stage.profile.harness,
        exitCode: runtimeResult.process.exitCode,
        signal: runtimeResult.process.signal,
        aborted: runtimeResult.process.aborted,
        outputSha256: outputHash.digest('hex'),
        outputLines,
        ...(runtimeResult.outputAccounting === undefined
          ? {}
          : {
              rawOutputSha256: runtimeResult.outputAccounting.rawSha256,
              rawOutputLines: runtimeResult.outputAccounting.rawLineCount,
              retainedOutputLines: runtimeResult.outputAccounting.retainedLineCount,
              droppedOutputLines: runtimeResult.outputAccounting.droppedLineCount,
              outputCompactionStrategy: runtimeResult.outputAccounting.strategy,
            }),
      },
      run.fence,
      attemptId,
    );
    const postConsolidationRuntimeFence = this.#missionPlanAttemptFence(run, active, view);
    if (postConsolidationRuntimeFence !== undefined) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'abandoned',
        'confirmed',
        `Consolidation fenced by ${postConsolidationRuntimeFence.fenceId}`,
      );
      this.#observe(
        run.missionId,
        'mission.attempt_fenced',
        {
          ...postConsolidationRuntimeFence,
          processAborted: runtimeResult.process.aborted,
          preservedWorkspaceDigest: snapshotGitWorkspace(workspacePath, { now: this.#now })
            .workspaceDigest,
        } as unknown as JsonValue,
        run.fence,
        attemptId,
      );
      run.attempts.delete(attemptId);
      return undefined;
    }
    if (!processResultSucceeded(runtimeResult)) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'failed',
        'failed',
        failureSummary(runtimeResult, false, true, true),
      );
      run.attempts.delete(attemptId);
      throw new MissionExecutionError('Consolidation Agent failed');
    }
    const afterConsolidationRuntime = snapshotGitWorkspace(workspacePath, { now: this.#now });
    const changedIntegratedSources = [...integratedSourceDigests].flatMap(
      ([path, expectedDigest]) =>
        workspacePathState(afterConsolidationRuntime, path) === expectedDigest ? [] : [path],
    );
    if (changedIntegratedSources.length > 0) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'failed',
        'failed',
        `Consolidation Agent changed immutable source paths: ${changedIntegratedSources.join(', ')}`,
      );
      run.attempts.delete(attemptId);
      throw new MissionExecutionError('Consolidation Agent changed immutable source artifacts');
    }
    const consolidationAgentDelta = createStageWorkspaceDelta(
      materializedSources,
      afterConsolidationRuntime,
    );
    const undeclaredAgentPaths = consolidationAgentDelta.changedPaths
      .map((change) => change.path)
      .filter((path) => !joinNode.declaredOutputKeys.includes(path));
    if (undeclaredAgentPaths.length > 0) {
      const detail = `Consolidation Agent changed undeclared paths: ${undeclaredAgentPaths.join(', ')}`;
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'failed',
        'failed',
        detail,
      );
      run.attempts.delete(attemptId);
      throw new MissionExecutionError(detail);
    }
    const verifications: { criterionId: string; result: CommandVerificationResultV1 }[] = [];
    for (const criterion of run.spec.acceptanceCriteria) {
      const result = await runCommandVerifier(
        remapVerifierWorkspace(criterion.verifier, run.spec.workspace, workspacePath),
        {
          workspace: workspacePath,
          missionSourceDir: run.spec.missionSourceDir,
          controllerStateDir: this.#stateDir,
          provenanceFile: this.#provenanceFile(run.missionId),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      verifications.push({ criterionId: criterion.id, result });
      this.#observe(
        run.missionId,
        'verification.completed',
        {
          attemptId,
          nodeId: joinNode.nodeId,
          criterionId: criterion.id,
          passed: result.passed,
          invocationDigest: result.invocationDigest,
          exitCode: result.exitCode,
          stdoutSha256: result.stdout.sha256,
          stderrSha256: result.stderr.sha256,
        },
        run.fence,
        attemptId,
      );
    }
    const afterConsolidationVerification = snapshotGitWorkspace(workspacePath, {
      now: this.#now,
    });
    const postConsolidationVerificationFence = this.#missionPlanAttemptFence(run, active, view);
    if (postConsolidationVerificationFence !== undefined) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'abandoned',
        'confirmed',
        `Consolidation fenced by ${postConsolidationVerificationFence.fenceId}`,
      );
      this.#observe(
        run.missionId,
        'mission.attempt_fenced',
        {
          ...postConsolidationVerificationFence,
          processAborted: runtimeResult.process.aborted,
          preservedWorkspaceDigest: snapshotGitWorkspace(workspacePath, { now: this.#now })
            .workspaceDigest,
        } as unknown as JsonValue,
        run.fence,
        attemptId,
      );
      run.attempts.delete(attemptId);
      return undefined;
    }
    const verifierChangedSources = [...integratedSourceDigests].flatMap(([path, expectedDigest]) =>
      workspacePathState(afterConsolidationVerification, path) === expectedDigest ? [] : [path],
    );
    if (verifierChangedSources.length > 0) {
      const detail = `Verifier changed immutable source paths: ${verifierChangedSources.join(', ')}`;
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'failed',
        'failed',
        detail,
      );
      run.attempts.delete(attemptId);
      throw new MissionExecutionError(detail);
    }
    const consolidationVerifierDelta = createStageWorkspaceDelta(
      afterConsolidationRuntime,
      afterConsolidationVerification,
    );
    if (consolidationVerifierDelta.changedPaths.length > 0) {
      const verifierPaths = consolidationVerifierDelta.changedPaths.map((change) => change.path);
      const undeclaredVerifierPaths = verifierPaths.filter(
        (path) => !joinNode.declaredOutputKeys.includes(path),
      );
      const detail =
        undeclaredVerifierPaths.length > 0
          ? `Verifier changed undeclared paths: ${undeclaredVerifierPaths.join(', ')}`
          : `Verifier changed consolidation output paths: ${verifierPaths.join(', ')}`;
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'failed',
        'failed',
        detail,
      );
      run.attempts.delete(attemptId);
      throw new MissionExecutionError(detail);
    }
    if (verifications.some(({ result }) => !result.passed)) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'failed',
        'failed',
        'Revised Outcome Contract verifier rejected the consolidation workspace',
      );
      run.attempts.delete(attemptId);
      throw new MissionExecutionError('Revised Outcome Contract verification failed');
    }
    await rm(controlDirectory, { recursive: true, force: true });
    gitExec(workspacePath, [
      'add',
      '--',
      ...uniqueStrings([
        ...selectedPaths.keys(),
        ...joinNode.declaredOutputKeys.map(assertSafePlanOutputPath),
      ]),
    ]);
    gitExec(workspacePath, [
      '-c',
      'user.name=MissionBraid',
      '-c',
      'user.email=missionbraid@localhost',
      'commit',
      '--no-gpg-sign',
      '-m',
      `MissionBraid consolidation ${joinNode.nodeId}`,
    ]);
    const sourceCommit = gitText(workspacePath, ['rev-parse', 'HEAD']);
    const sealed = snapshotGitWorkspace(workspacePath, { now: this.#now });
    assertSealedPlanWorkspace(sealed, sourceCommit);
    const delta = createStageWorkspaceDelta(before, sealed);
    const workspaceEvidence: DeterministicVerifierEvidenceV1[] = verifications.map(
      ({ criterionId, result }) => ({
        evidenceId: `integration-verifier-${hashPayload({ identity, criterionId, invocation: result.invocationDigest }).slice(0, 28)}`,
        evaluator: 'deterministic',
        verifierId: `command:${result.invocationDigest}`,
        subjectId: consolidationPlan.workspaceIntegration.outputVerificationSubjectId,
        subjectDigest: sealed.workspaceDigest,
        result: {
          criterionId,
          status: 'passed',
          evidenceRefs: [`verifier:${result.invocationDigest}`],
        },
        evidenceRefs: [
          `verifier:${result.invocationDigest}`,
          `stdout:sha256:${result.stdout.sha256}`,
          `stderr:sha256:${result.stderr.sha256}`,
        ],
      }),
    );
    const integrationOutcome = recordWorkspaceIntegrationOutcome({
      plan: consolidationPlan,
      outputWorkspaceDigest: sealed.workspaceDigest,
      verifierEvidence: workspaceEvidence,
    });
    const joinArtifactId = `plan-artifact-${hashPayload({ attemptId, sourceCommit }).slice(0, 28)}`;
    const joinArtifactEvidence: DeterministicVerifierEvidenceV1[] = workspaceEvidence.map(
      (evidence) => ({
        ...evidence,
        evidenceId: `join-${evidence.evidenceId}`,
        subjectId: joinArtifactId,
      }),
    );
    const joinArtifact = recordPlanArtifact({
      artifactId: joinArtifactId,
      artifactDigest: sealed.workspaceDigest,
      plan: view.planRevision,
      producedByNodeId: joinNode.nodeId,
      sourceArtifactIds: sources.map((source) => source.artifact.artifactId),
      verifierEvidence: joinArtifactEvidence,
      evidenceRefs: [
        `consolidation:${consolidationPlan.consolidationId}`,
        `commit:${sourceCommit}`,
      ],
    });
    const joinRecord: MissionPlanArtifactRecordV1 = {
      recordId: `artifact-record-${this.#id()}`,
      artifact: joinArtifact,
      attemptId,
      branchId,
      workspaceKey,
      workspacePath,
      sourceCommit,
      changedPaths: delta.changedPaths.map((change) => change.path),
      recordedAt: this.#now().toISOString(),
    };
    const sourceSnapshotsAfter = new Map(
      sources.map((source) => [
        source.artifact.artifactId,
        snapshotGitWorkspace(source.workspacePath, { now: this.#now }),
      ]),
    );
    const sourceCommitsAfter = Object.fromEntries(
      sources.map((source) => [
        source.artifact.artifactId,
        sourceSnapshotsAfter.get(source.artifact.artifactId)?.head ?? '',
      ]),
    );
    const changedSourceArtifacts = sources.filter((source) => {
      const beforeSource = sourceSnapshotsBefore.get(source.artifact.artifactId);
      const afterSource = sourceSnapshotsAfter.get(source.artifact.artifactId);
      return (
        beforeSource === undefined ||
        afterSource === undefined ||
        beforeSource.workspaceDigest !== afterSource.workspaceDigest ||
        afterSource.status.length > 0 ||
        afterSource.head !== source.sourceCommit
      );
    });
    if (changedSourceArtifacts.length > 0) {
      const detail = 'An immutable source Branch changed during consolidation';
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'failed',
        'failed',
        detail,
      );
      run.attempts.delete(attemptId);
      throw new MissionExecutionError(detail);
    }
    const preSuccessFence = this.#missionPlanAttemptFence(run, active, view);
    if (preSuccessFence !== undefined) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'abandoned',
        'confirmed',
        `Consolidation fenced by ${preSuccessFence.fenceId}`,
      );
      this.#observe(
        run.missionId,
        'mission.attempt_fenced',
        {
          ...preSuccessFence,
          processAborted: runtimeResult.process.aborted,
          preservedWorkspaceDigest: sealed.workspaceDigest,
        } as unknown as JsonValue,
        run.fence,
        attemptId,
      );
      run.attempts.delete(attemptId);
      return undefined;
    }
    const preSuccessUnplanned = activeUnplannedRequirementIds(this.missionPlan(run.missionId));
    if (preSuccessUnplanned.length > 0) {
      this.#appendPlanNodeTerminalEvents(
        run,
        attemptId,
        consolidationPlan.workspaceIntegration.effect.effectId,
        'abandoned',
        'confirmed',
        `Consolidation cannot cover unplanned requirements: ${preSuccessUnplanned.join(', ')}`,
      );
      run.attempts.delete(attemptId);
      return undefined;
    }
    const checkpointId = `checkpoint-consolidation-${hashPayload({ attemptId, sourceCommit }).slice(0, 28)}`;
    this.#observe(
      run.missionId,
      'checkpoint.created',
      {
        checkpointId,
        missionId: run.missionId,
        attemptId,
        stageId: joinNode.nodeId,
        harness: stage.profile.harness,
        profileId: profile.profileId,
        branchId,
        bindingId,
        status: 'succeeded',
        delta,
        origin: 'runtime-completion',
      } as unknown as JsonValue,
      run.fence,
      attemptId,
    );
    this.#appendPlanNodeTerminalEvents(
      run,
      attemptId,
      consolidationPlan.workspaceIntegration.effect.effectId,
      'succeeded',
      integrationOutcome.effect.status,
      'Consolidation workspace passed the revised Outcome Contract',
    );
    this.#observe(
      run.missionId,
      'mission.plan_artifact.recorded',
      { record: joinRecord as unknown as JsonValue },
      run.fence,
      attemptId,
    );
    this.#observe(
      run.missionId,
      'mission.consolidation.completed',
      {
        consolidationId: consolidationPlan.consolidationId,
        outcome: integrationOutcome as unknown as JsonValue,
        sourceCommitsAfter: sourceCommitsAfter as unknown as JsonValue,
      },
      run.fence,
      attemptId,
    );
    const receiptTarget = this.missionPlan(run.missionId);
    if (
      receiptTarget.planRevision.planRevisionId !== view.planRevision.planRevisionId ||
      receiptTarget.contractRevision.contractRevisionId !== view.contractRevision.contractRevisionId
    ) {
      run.attempts.delete(attemptId);
      throw new MissionExecutionError('Receipt target is no longer the latest Mission Plan');
    }
    const receiptUnplannedRequirements = activeUnplannedRequirementIds(receiptTarget);
    if (receiptUnplannedRequirements.length > 0) {
      run.attempts.delete(attemptId);
      throw new MissionExecutionError(
        `Receipt cannot cover unplanned requirements: ${receiptUnplannedRequirements.join(', ')}`,
      );
    }
    const projection = this.#requireMission(run.missionId);
    // Receipt disclosures must match the latest persisted status event exactly.
    // The broader projection intentionally accumulates provenance refs, while
    // the Kernel invariant compares the terminal disclosure with the latest
    // status record.
    const effects = reconstructExecutionState(this.#store.listEvents(run.missionId)).effects;
    const receipt: ReceiptV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      receiptId: `receipt-${this.#id()}`,
      missionId: run.missionId,
      contractId: view.contractRevision.contract.contractId,
      contractRevisionId: view.contractRevision.contractRevisionId,
      planRevisionId: view.planRevision.planRevisionId,
      branchId,
      outcome: 'verified',
      verifications: verifications.map(({ criterionId, result }) => ({
        criterionId,
        status: 'passed',
        evidenceRefs: [
          `verifier:${result.invocationDigest}`,
          `stdout:sha256:${result.stdout.sha256}`,
          `stderr:sha256:${result.stderr.sha256}`,
        ],
      })),
      verifiedHeadHash: projection.headHash,
      verifiedThroughSeq: projection.lastSeq,
      attemptIds: [
        ...reconstructExecutionState(this.#store.listEvents(run.missionId)).plans.keys(),
      ],
      handoffIds: [],
      effectIds: effects.map((effect) => effect.effectId),
      effects: effects.map((effect) => ({
        effectId: effect.effectId,
        status: effect.status,
        controlLevel: effect.controlLevel ?? 'advisory',
        kind: effect.kind,
        resourceKey: effect.resourceKey,
        evidenceRefs: effect.evidenceRefs,
      })),
      unresolvedItems: [],
      issuedAt: this.#now().toISOString(),
    };
    this.#append(
      {
        schemaVersion: DOMAIN_SCHEMA_VERSION,
        eventId: `event-${this.#id()}`,
        missionId: run.missionId,
        occurredAt: receipt.issuedAt,
        type: 'receipt.issued',
        payload: { receipt },
      },
      run.fence,
    );
    await mkdir(dirname(this.#branchReceiptFile(run.missionId, branchId)), { recursive: true });
    await writeFile(
      this.#branchReceiptFile(run.missionId, branchId),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await writeFile(this.#receiptFile(run.missionId), `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    run.attempts.delete(attemptId);
    return receipt;
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
        const detection = await this.#detectStage(stage);
        return {
          stage,
          detection,
          profile: createProfile(stage, detection, spec.workspace, this.#adapterManifest(stage)),
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
              profileDefinition(candidate.stage, this.#adapterManifest(candidate.stage))
                .definitionId === manualOverride.profileDefinitionId,
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
    const detection = planned?.detection ?? (await this.#detectStage(stage));
    const profile =
      planned?.profile ??
      createProfile(stage, detection, spec.workspace, this.#adapterManifest(stage));
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
    const contextMaterial: ContextBindingMaterialV1 | undefined =
      spec.context === undefined
        ? undefined
        : await readContextBinding(spec.context, {
            workspacePath: spec.workspace,
            currentWorkspaceDigest: before.workspaceDigest,
            mode: 'cached',
          });
    const contextSnapshotArtifact =
      contextMaterial === undefined
        ? undefined
        : await this.#artifacts.putLine(contextMaterial.boundContent);
    const contextSourceArtifact =
      contextMaterial === undefined
        ? undefined
        : await this.#artifacts.putLine(contextMaterial.currentContent);
    const contextEvidenceRefs =
      contextMaterial === undefined ||
      contextSnapshotArtifact === undefined ||
      contextSourceArtifact === undefined
        ? []
        : [
            `context-snapshot:${contextSnapshotArtifact.artifactId}`,
            `context-source:${contextSourceArtifact.artifactId}`,
            `workspace:${contextMaterial.currentWorkspaceDigest}`,
          ];
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
      runtimeBinding: runtimeBinding(attemptId, profile),
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
          sourceProtocol: this.#runtimeProtocol(stage),
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
    const prompt = createAttemptPrompt(
      spec,
      stage,
      mission.contract,
      projectedCapsuleText,
      contextMaterial === undefined ? undefined : contextPrompt(contextMaterial),
    );
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const promptBudgetBytes = initialPromptByteBudget(stage.profile.injectionBudgetTokens);
    if (promptBytes > promptBudgetBytes) {
      this.#observe(
        missionId,
        'context.prompt_budget_exceeded',
        {
          attemptId,
          stageId: stage.stageId,
          promptBytes,
          promptBudgetBytes,
          contextFactId: contextMaterial?.contextFactId ?? null,
        },
        fence,
        attemptId,
      );
      throw new MissionExecutionError(
        `Controller prompt is ${String(promptBytes)} bytes, above the ${String(promptBudgetBytes)}-byte Runtime Profile budget`,
      );
    }
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
        ...(contextMaterial === undefined
          ? {}
          : {
              contextBinding: {
                contextFactId: contextMaterial.contextFactId,
                mode: contextMaterial.mode,
                boundWorkspaceDigest: contextMaterial.boundWorkspaceDigest,
                currentWorkspaceDigest: contextMaterial.currentWorkspaceDigest,
                boundContextDigest: contextMaterial.boundContextDigest,
                currentContextDigest: contextMaterial.currentContextDigest,
                sourceRef: contextMaterial.sourceRef,
                snapshotRef: contextMaterial.snapshotRef,
                artifactRefs: contextEvidenceRefs,
              },
            }),
        components: [
          'outcome_contract',
          'mission_constraints',
          'acceptance_criteria',
          'stage_instruction',
          ...(capsule === undefined ? [] : ['handoff_capsule']),
          ...(contextMaterial === undefined ? [] : ['context_snapshot', 'context_freshness']),
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
    if (contextMaterial !== undefined) {
      this.#observe(
        missionId,
        'context.freshness',
        {
          contextFactId: contextMaterial.contextFactId,
          boundWorkspaceDigest: contextMaterial.boundWorkspaceDigest,
          currentWorkspaceDigest: contextMaterial.currentWorkspaceDigest,
          boundContextDigest: contextMaterial.boundContextDigest,
          currentContextDigest: contextMaterial.currentContextDigest,
          mode: contextMaterial.mode,
          sourceRef: contextMaterial.sourceRef,
          snapshotRef: contextMaterial.snapshotRef,
          evidenceRefs: contextEvidenceRefs,
        },
        fence,
        attemptId,
      );
    }
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
      missionId,
      branchId,
      attemptId,
      bindingId,
      workspaceKey: mission.workspaceKey,
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
        ...(runtimeResult.outputAccounting === undefined
          ? {}
          : {
              rawOutputSha256: runtimeResult.outputAccounting.rawSha256,
              rawOutputLines: runtimeResult.outputAccounting.rawLineCount,
              retainedOutputLines: runtimeResult.outputAccounting.retainedLineCount,
              droppedOutputLines: runtimeResult.outputAccounting.droppedLineCount,
              outputCompactionStrategy: runtimeResult.outputAccounting.strategy,
            }),
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
    const receiptPlan = this.missionPlan(missionId);
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    const allPassed = results.every((result) => result.passed);
    const unresolvedEffects = state.effects.filter((effect) =>
      ['intended', 'dispatch_started', 'executed', 'ambiguous', 'conflict'].includes(effect.status),
    );
    const failedCriteria = spec.acceptanceCriteria
      .filter((_criterion, index) => !results[index]!.passed)
      .map((criterion) => criterion.id);
    const verifiedOutcome = allPassed && unresolvedEffects.length === 0;
    const receiptRuntimeBindings = runtimeBindingsFromEvents(this.#store.listEvents(missionId), [
      ...state.plans.keys(),
    ]);
    const receipt: ReceiptV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      receiptId: `receipt-${this.#id()}`,
      missionId,
      contractId: projection.contract.contractId,
      contractRevisionId: receiptPlan.contractRevision.contractRevisionId,
      planRevisionId: receiptPlan.planRevision.planRevisionId,
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
      ...(receiptRuntimeBindings.length === 0
        ? {}
        : {
            runtimeBindings: receiptRuntimeBindings,
            runtimeBindingsDigest: `sha256:${hashPayload(receiptRuntimeBindings)}`,
          }),
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

  async #issueOutcomeRegressionRejectedReceipt(
    missionId: string,
    childBranchId: string,
    record: ExecutionForkRecordV1,
  ): Promise<ReceiptV1> {
    const existing = this.#store
      .listEvents(missionId)
      .find(
        (event): event is Extract<StoredEventV1, { type: 'receipt.issued' }> =>
          event.type === 'receipt.issued' &&
          (event.payload.receipt.branchId ?? event.payload.receipt.rootBranchId) === childBranchId,
      )?.payload.receipt;
    if (existing !== undefined) return existing;
    const mission = this.#requireMission(missionId);
    const spec = this.#requireSpecSnapshot(missionId);
    return await this.#withLease(
      mission.workspaceKey,
      `outcome-rejected-receipt-${this.#id()}`,
      async (fence) => {
        const chain = this.#store.verifyEventChain(missionId);
        if (!chain.valid) {
          throw new MissionExecutionError(
            'Cannot issue a rejected trial Receipt on an invalid chain',
          );
        }
        const projection = this.#requireMission(missionId);
        const receiptPlan = this.missionPlan(missionId);
        const effects = reconstructExecutionState(this.#store.listEvents(missionId)).effects;
        const verifications = spec.acceptanceCriteria.map((criterion) => {
          const evidence = [...record.runtimeEvidence]
            .reverse()
            .find(
              (candidate) =>
                candidate.kind === 'verification' &&
                candidate.evidenceRefs.includes(`criterion:${criterion.id}`),
            );
          const passed = evidence?.evidenceRefs.includes('verification:passed') ?? false;
          return {
            criterionId: criterion.id,
            status: passed ? ('passed' as const) : ('failed' as const),
            evidenceRefs:
              evidence === undefined
                ? [`runtime:${record.runtimeResult?.runtimeRunId ?? 'missing'}`]
                : uniqueStrings([`evidence:${evidence.evidenceId}`, ...evidence.evidenceRefs]),
          };
        });
        const childAttemptId = `fork-attempt-${record.forkId}`;
        const issuedAt = this.#now().toISOString();
        const receipt: ReceiptV1 = {
          schemaVersion: DOMAIN_SCHEMA_VERSION,
          receiptId: `receipt-${this.#id()}`,
          missionId,
          contractId: projection.contract.contractId,
          contractRevisionId: receiptPlan.contractRevision.contractRevisionId,
          planRevisionId: receiptPlan.planRevision.planRevisionId,
          branchId: childBranchId,
          outcome: 'rejected',
          verifications,
          verifiedHeadHash: projection.headHash,
          verifiedThroughSeq: projection.lastSeq,
          attemptIds: [childAttemptId],
          handoffIds: [],
          effectIds: effects.map((effect) => effect.effectId),
          effects,
          unresolvedItems: uniqueStrings([
            ...(record.runtimeResult?.unresolvedItems ?? ['runtime-result:missing']),
            ...verifications
              .filter((verification) => verification.status !== 'passed')
              .map((verification) => `criterion:${verification.criterionId}`),
          ]),
          issuedAt,
        };
        this.#store.appendEvent(
          {
            schemaVersion: DOMAIN_SCHEMA_VERSION,
            eventId: `event-${this.#id()}`,
            missionId,
            occurredAt: issuedAt,
            type: 'receipt.issued',
            payload: { receipt },
          },
          fence,
        );
        await mkdir(dirname(this.#branchReceiptFile(missionId, childBranchId)), {
          recursive: true,
        });
        await writeFile(
          this.#branchReceiptFile(missionId, childBranchId),
          `${JSON.stringify(receipt, null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
        return receipt;
      },
    );
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
    const receiptPlan = this.missionPlan(missionId);
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
    const receiptRuntimeBindings = runtimeBindingsFromEvents(this.#store.listEvents(missionId), [
      childAttemptId,
    ]);
    const receipt: ReceiptV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      receiptId: 'receipt-' + this.#id(),
      missionId,
      contractId: projection.contract.contractId,
      contractRevisionId: receiptPlan.contractRevision.contractRevisionId,
      planRevisionId: receiptPlan.planRevision.planRevisionId,
      branchId: childBranchId,
      outcome: 'verified',
      verifications,
      verifiedHeadHash: projection.headHash,
      verifiedThroughSeq: projection.lastSeq,
      attemptIds: [childAttemptId],
      ...(receiptRuntimeBindings.length === 0
        ? {}
        : {
            runtimeBindings: receiptRuntimeBindings,
            runtimeBindingsDigest: `sha256:${hashPayload(receiptRuntimeBindings)}`,
          }),
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
      readonly missionId: string;
      readonly branchId: string;
      readonly attemptId: string;
      readonly bindingId: string;
      readonly workspaceKey: string;
      readonly workspace: string;
      readonly prompt: string;
      readonly signal?: AbortSignal;
      readonly toolGateBinding?: ClaudeToolGateBindingV1;
      readonly onStart: (pid: number) => void;
      readonly onOutput: (line: RuntimeOutputLine) => Promise<void>;
    },
  ): Promise<RuntimeRunResult> {
    const model = profile.model === 'default' ? undefined : profile.model;
    if (stage.profile.adapterId !== undefined) {
      return await this.#adapterHost.run({
        identity: {
          executionId: request.attemptId,
          missionId: request.missionId,
          branchId: request.branchId,
          attemptId: request.attemptId,
          bindingId: request.bindingId,
        },
        profile: {
          profileId: profile.profileId,
          adapterId: stage.profile.adapterId,
          harness: stage.profile.harness,
          model: profile.model,
          configurationDigest: profile.configurationDigest,
          ...(profile.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: profile.reasoningEffort }),
          ...(profile.permissionMode === undefined
            ? {}
            : { permissionMode: profile.permissionMode }),
          ...(stage.profile.providerWorkspaceRef === undefined
            ? {}
            : { providerWorkspaceRef: stage.profile.providerWorkspaceRef }),
        },
        workspaceKey: request.workspaceKey,
        localWorkspace: request.workspace,
        instruction: request.prompt,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onStart: request.onStart,
        onOutput: request.onOutput,
      });
    }
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
    if (stage.profile.harness !== 'claude') {
      throw new MissionExecutionError(
        `Harness ${stage.profile.harness} requires a registered Adapter`,
      );
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

  async #detectStage(stage: AttemptStageSpecV1): Promise<RuntimeDetection> {
    if (stage.profile.adapterId !== undefined) {
      return await this.#adapterHost.detect(stage.profile.adapterId, stage.profile.harness);
    }
    if (!isSupportedHarnessV1(stage.profile.harness)) {
      throw new MissionExecutionError(
        `Harness ${stage.profile.harness} requires a registered Adapter`,
      );
    }
    return await this.#detect(stage.profile.harness);
  }

  #adapterManifest(stage: AttemptStageSpecV1): AdapterManifestV1 | undefined {
    return stage.profile.adapterId === undefined
      ? undefined
      : this.#adapterHost.manifest(stage.profile.adapterId);
  }

  #runtimeProtocol(stage: AttemptStageSpecV1): string {
    if (stage.profile.adapterId !== undefined) {
      return this.#adapterHost.nativeProtocol(stage.profile.adapterId);
    }
    if (!isSupportedHarnessV1(stage.profile.harness)) {
      throw new MissionExecutionError(
        `Harness ${stage.profile.harness} requires a registered Adapter`,
      );
    }
    return runtimeProtocol(stage.profile.harness);
  }

  #runtimeResultProtocol(stage: AttemptStageSpecV1): RuntimeRunResult['outputProtocol'] {
    if (stage.profile.adapterId !== undefined) return 'adapter-v1';
    if (!isSupportedHarnessV1(stage.profile.harness)) {
      throw new MissionExecutionError(
        `Harness ${stage.profile.harness} requires a registered Adapter`,
      );
    }
    return runtimeProtocol(stage.profile.harness);
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

function assertExecutablePlanTerminalJoin(spec: MissionSpecV1): void {
  if (spec.plan === undefined) return;
  const joins = spec.plan.nodes.filter((node) => node.kind === 'join');
  const terminalJoins = joins.filter(
    (joinNode) => !spec.plan!.edges.some((edge) => edge.fromNodeId === joinNode.nodeId),
  );
  if (joins.length !== 1 || terminalJoins.length !== 1) {
    throw new MissionExecutionError(
      'An explicit executable Mission Plan must contain exactly one terminal join',
    );
  }
}

function assertSupportedExecutableContractRevision(previous: ContractV1, next: ContractV1): void {
  const previousCriteria = new Map(
    previous.acceptanceCriteria.map((criterion) => [criterion.criterionId, criterion]),
  );
  const nextCriteria = new Map(
    next.acceptanceCriteria.map((criterion) => [criterion.criterionId, criterion]),
  );
  const criterionSetChanged =
    previousCriteria.size !== previous.acceptanceCriteria.length ||
    nextCriteria.size !== next.acceptanceCriteria.length ||
    previousCriteria.size !== nextCriteria.size ||
    [...previousCriteria.keys()].some((criterionId) => !nextCriteria.has(criterionId));
  const verifierChanged = [...previousCriteria].some(([criterionId, criterion]) => {
    const nextCriterion = nextCriteria.get(criterionId);
    return (
      nextCriterion === undefined ||
      nextCriterion.verifier.kind !== criterion.verifier.kind ||
      hashPayload(nextCriterion.verifier.configuration) !==
        hashPayload(criterion.verifier.configuration)
    );
  });
  if (criterionSetChanged || verifierChanged) {
    throw new MissionExecutionError(
      'Executable acceptance criteria cannot be added, removed, or reconfigured by Contract revision',
    );
  }
}

function activeUnplannedRequirementIds(view: MissionPlanView): string[] {
  const currentRequirementIds = new Set(
    view.contractRevision.requirements.map((requirement) => requirement.requirementId),
  );
  const plannedRequirementIds = new Set(
    view.planRevision.nodes.flatMap((node) => node.requirementIds),
  );
  return uniqueStrings(
    view.invalidations.flatMap((invalidation) => invalidation.unplannedRequirementIds),
  ).filter(
    (requirementId) =>
      currentRequirementIds.has(requirementId) && !plannedRequirementIds.has(requirementId),
  );
}

function workspacePathState(snapshot: GitWorkspaceSnapshotV1, path: string): string {
  const entry = snapshot.paths.find((candidate) => candidate.path === path);
  return hashPayload(
    entry === undefined
      ? { path, kind: 'missing', sha256: null }
      : { path: entry.path, kind: entry.kind, sha256: entry.sha256 },
  );
}

function assertSealedPlanWorkspace(snapshot: GitWorkspaceSnapshotV1, commit: string): void {
  const reconstructedDigest = hashPayload({
    head: snapshot.head,
    status: snapshot.status,
    paths: snapshot.paths,
  });
  if (snapshot.head !== commit) {
    throw new MissionExecutionError('Plan workspace HEAD does not match its sealed commit');
  }
  if (snapshot.status.length > 0) {
    throw new MissionExecutionError(
      `Plan workspace commit is not clean: ${snapshot.status
        .map((entry) => `${entry.code} ${entry.path}`)
        .join(', ')}`,
    );
  }
  if (reconstructedDigest !== snapshot.workspaceDigest) {
    throw new MissionExecutionError('Plan workspace digest cannot be reconstructed');
  }
}

function currentPlanArtifactByNode(
  view: MissionPlanView,
): Map<string, MissionPlanArtifactRecordV1> {
  const result = new Map<string, MissionPlanArtifactRecordV1>();
  for (const record of view.execution.artifacts) {
    const artifact = record.artifact;
    const node = view.planRevision.nodes.find(
      (candidate) => candidate.nodeId === artifact.producedByNodeId,
    );
    if (
      node === undefined ||
      artifact.missionId !== view.planRevision.missionId ||
      artifact.planId !== view.planRevision.planId ||
      artifact.planRevisionId !== view.planRevision.planRevisionId ||
      artifact.contractRevisionId !== view.contractRevision.contractRevisionId ||
      artifact.producerNodeVersion !== node.nodeVersion ||
      !planArtifactHasPassingEvidence(artifact)
    ) {
      continue;
    }
    result.set(artifact.producedByNodeId, record);
  }
  return result;
}

function planAttemptFence(attempt: ActiveMissionPlanNodeRun): StaleAttemptFenceV1 | undefined {
  // A live Contract revision may set this property while the caller is
  // awaiting a native Runtime or verifier. Keep the read behind a function so
  // TypeScript does not treat an earlier observation as permanently stable.
  return attempt.fence;
}

function planArtifactHasPassingEvidence(artifact: PlanArtifactV1): boolean {
  return artifact.verifierEvidence.some((evidence) => {
    if (
      evidence.evaluator !== 'deterministic' ||
      evidence.subjectId !== artifact.artifactId ||
      evidence.subjectDigest !== artifact.artifactDigest
    ) {
      return false;
    }
    const result = evidence.result as unknown as Record<string, unknown>;
    return result.passed === true || result.status === 'passed';
  });
}

function createMissionPlanNodePrompt(
  view: MissionPlanView,
  node: MissionPlanNodeSpecV1,
  stage: AttemptStageSpecV1,
): string {
  const requirementById = new Map(
    view.contractRevision.requirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  const requirements = node.requirementIds
    .map((requirementId) => {
      const requirement = requirementById.get(requirementId);
      if (requirement === undefined) {
        throw new MissionExecutionError(
          `Plan node ${node.nodeId} references missing requirement ${requirementId}`,
        );
      }
      return `- ${requirement.requirementId}: ${requirement.statement}`;
    })
    .join('\n');
  const outputs = node.declaredOutputKeys.map(assertSafePlanOutputPath).map((path) => `- ${path}`);
  return [
    `MissionBraid Mission Plan node ${node.nodeId}`,
    `Contract revision: ${view.contractRevision.contractRevisionId} (revision ${String(view.contractRevision.revisionNumber)})`,
    `Plan revision: ${view.planRevision.planRevisionId} (revision ${String(view.planRevision.revisionNumber)})`,
    `Requirements for this node:\n${requirements}`,
    `Current node instruction: ${stage.instruction}`,
    `You may change only these declared output paths:\n${outputs.join('\n')}`,
    'Work only inside the provided isolated Git worktree. Read and obey AGENTS.md. Do not commit, push, publish, deploy, install dependencies, or modify tests. Run the declared local checks when useful, then exit.',
  ].join('\n\n');
}

function createMissionPlanConsolidationPrompt(
  view: MissionPlanView,
  node: MissionPlanNodeSpecV1,
  stage: AttemptStageSpecV1,
  sources: readonly MissionPlanArtifactRecordV1[],
): string {
  const outputs = node.declaredOutputKeys.map(assertSafePlanOutputPath);
  return [
    `MissionBraid consolidation node ${node.nodeId}`,
    `Contract revision: ${view.contractRevision.contractRevisionId} (revision ${String(view.contractRevision.revisionNumber)})`,
    `Plan revision: ${view.planRevision.planRevisionId} (revision ${String(view.planRevision.revisionNumber)})`,
    'The controller has already materialized these verified immutable source artifacts:',
    ...sources.map(
      (source) =>
        `- ${source.artifact.producedByNodeId}: ${source.artifact.artifactId} @ ${source.sourceCommit}`,
    ),
    `Current node instruction: ${stage.instruction}`,
    `You may add or change only the consolidation output paths:\n${outputs.map((path) => `- ${path}`).join('\n')}`,
    'Inspect the integrated result, write the requested audit output, run the local final verifier if useful, and exit. Do not alter the materialized source files. Do not commit, push, publish, deploy, install dependencies, or modify tests.',
  ].join('\n\n');
}

function assertSafePlanOutputPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new MissionExecutionError(`Plan output path ${value} is not workspace-relative`);
  }
  return normalized;
}

function remapVerifierWorkspace(
  verifier: CommandVerifierSpecV1,
  sourceWorkspace: string,
  targetWorkspace: string,
): CommandVerifierSpecV1 {
  const remap = (value: string): string => value.replaceAll(sourceWorkspace, targetWorkspace);
  return {
    ...verifier,
    args: verifier.args.map(remap),
    cwd: remap(verifier.cwd),
  };
}

function gitExec(workspace: string, args: readonly string[]): void {
  try {
    execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw new MissionExecutionError(
      `Git workspace operation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function gitText(workspace: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new MissionExecutionError(
      `Git workspace query failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function runtimeThrownResult(
  runtime: string,
  outputProtocol: RuntimeRunResult['outputProtocol'],
  error: unknown,
  startedAt: string,
  endedAt: Date,
): RuntimeRunResult {
  return {
    runtime,
    outputProtocol,
    process: {
      invocation: { command: runtime, args: [], cwd: process.cwd() },
      pid: null,
      exitCode: null,
      signal: null,
      startedAt,
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - Date.parse(startedAt)),
      aborted: false,
      stdoutLineCount: 0,
      stderrLineCount: 0,
      spawnError: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

async function assertDiagnosticInterventionMatchesContext(
  spec: MissionSpecV1,
  checkpoint: CompositeCheckpointManifestV1,
  candidate: { readonly detector: string; readonly supportingEvidenceRefs: readonly string[] },
  failureInput: MissionFailureIntelligenceProjectionV1['failureIntelligenceInput'],
  intervention: CheckpointInterventionV1,
): Promise<void> {
  if (candidate.detector !== 'stale-context') return;
  if (intervention.kind !== 'context') {
    throw new MissionExecutionError(
      'A stale-context diagnostic candidate requires a Context-only Intervention',
    );
  }
  if (spec.context === undefined) {
    throw new MissionExecutionError(
      'A stale-context diagnostic candidate has no declared Mission Context binding',
    );
  }
  const candidateRefs = new Set(candidate.supportingEvidenceRefs);
  const freshness = (failureInput.contextFreshness ?? []).find((item) =>
    [item.evidenceId, item.contextFactId, ...item.evidenceRefs].some((ref) =>
      candidateRefs.has(ref),
    ),
  );
  if (freshness === undefined || freshness.contextFactId !== spec.context.factId) {
    throw new MissionExecutionError(
      'The stale-context candidate is not bound to the declared Mission Context fact',
    );
  }
  const checkpointWorkspaceDigest = checkpoint.workspace.workspaceDigest;
  if (checkpointWorkspaceDigest === null) {
    throw new MissionExecutionError(
      'A stale-context diagnostic requires a Checkpoint with a recoverable workspace digest',
    );
  }
  const currentWorkspace = snapshotGitWorkspace(spec.workspace);
  if (currentWorkspace.workspaceDigest !== checkpointWorkspaceDigest) {
    throw new MissionExecutionError(
      'The source workspace diverged after the diagnostic Checkpoint; refresh the boundary before retrying',
    );
  }
  if (intervention.beforeDigest === undefined) {
    throw new MissionExecutionError(
      'A stale-context diagnostic requires the cached Context digest as beforeDigest',
    );
  }
  let cached;
  try {
    cached = await readContextBinding(spec.context, {
      workspacePath: spec.workspace,
      currentWorkspaceDigest: checkpointWorkspaceDigest,
      mode: 'cached',
    });
  } catch (error) {
    throw new MissionExecutionError('The cached Context snapshot could not be read', {
      cause: error,
    });
  }
  if (intervention.targetRef !== `context:${spec.context.factId}`) {
    throw new MissionExecutionError(
      'The stale-context Intervention target must match the declared Context fact',
    );
  }
  if (intervention.beforeDigest !== cached.boundContextDigest) {
    throw new MissionExecutionError(
      'The stale-context Intervention beforeDigest does not match the cached Context snapshot',
    );
  }
  let refreshed;
  try {
    refreshed = await readContextBinding(spec.context, {
      workspacePath: spec.workspace,
      currentWorkspaceDigest: checkpointWorkspaceDigest,
      mode: 'refreshed',
    });
  } catch (error) {
    throw new MissionExecutionError('The declared Context source could not be refreshed', {
      cause: error,
    });
  }
  if (intervention.afterDigest !== refreshed.currentContextDigest) {
    throw new MissionExecutionError(
      'The stale-context Intervention afterDigest does not match the current Context source',
    );
  }
  if (intervention.authorityChange !== 'unchanged') {
    throw new MissionExecutionError(
      'A stale-context diagnostic Intervention cannot change execution authority',
    );
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

function requirementsFromSpec(spec: MissionSpecV1): ContractRequirementV1[] {
  return [
    {
      requirementId: 'objective',
      kind: 'objective',
      statement: spec.objective,
      acceptanceCriterionIds: [],
      evidenceRefs: [],
    },
    ...spec.constraints.map((statement, index) => ({
      requirementId: `constraint-${index + 1}`,
      kind: 'constraint' as const,
      statement,
      acceptanceCriterionIds: [],
      evidenceRefs: [],
    })),
    ...spec.acceptanceCriteria.map((criterion) => ({
      requirementId: `acceptance-${criterion.id}`,
      kind: 'acceptance-criterion' as const,
      statement: criterion.description,
      acceptanceCriterionIds: [criterion.id],
      evidenceRefs: [],
    })),
  ];
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
          runtimeBindings: (event.payload.receipt.runtimeBindings ?? []).map((binding) => ({
            ...binding,
          })),
          runtimeBindingsDigest: event.payload.receipt.runtimeBindingsDigest ?? null,
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
    'context.freshness': 'Context freshness compared',
    'context.prompt_budget_exceeded': 'Controller prompt exceeds Runtime budget',
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

function incidentScenarioIntervention(scenario: IncidentScenarioV1): CheckpointInterventionV1 {
  const artifact = scenario.artifacts.find((candidate) => candidate.kind === 'intervention');
  if (artifact === undefined) {
    throw new MissionExecutionError('Incident Scenario has no Intervention artifact');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.content) as unknown;
  } catch (error) {
    throw new MissionExecutionError('Incident Scenario Intervention is not valid JSON', {
      cause: error,
    });
  }
  if (
    !isJsonObject(parsed) ||
    typeof parsed.interventionId !== 'string' ||
    parsed.interventionId !== scenario.interventionId ||
    ![
      'context',
      'prompt',
      'tool',
      'permission-narrowing',
      'profile',
      'workspace',
      'guidance',
    ].includes(String(parsed.kind)) ||
    typeof parsed.targetRef !== 'string' ||
    (parsed.beforeDigest !== undefined && typeof parsed.beforeDigest !== 'string') ||
    typeof parsed.afterDigest !== 'string' ||
    typeof parsed.description !== 'string' ||
    (parsed.authorityChange !== 'unchanged' && parsed.authorityChange !== 'narrowed')
  ) {
    throw new MissionExecutionError('Incident Scenario Intervention is incomplete or mismatched');
  }
  return parsed as unknown as CheckpointInterventionV1;
}

function verifyMissionOutcomeStudioRerun(run: MissionOutcomeStudioRerunV1): void {
  const { runId: _runId, runHash: _runHash, ...core } = run;
  const expectedHash = hashPayload(core);
  if (
    run.runHash !== expectedHash ||
    run.runId !== `outcome-kernel-rerun-${expectedHash.slice(0, 32)}`
  ) {
    throw new MissionExecutionError('Outcome Studio Kernel rerun identity does not match content');
  }
  if (
    !Number.isSafeInteger(run.trialCount) ||
    run.trialCount <= 0 ||
    run.trials.length !== run.trialCount ||
    new Set(run.trials.map((trial) => trial.branchId)).size !== run.trials.length ||
    new Set(run.trials.map((trial) => trial.attemptId)).size !== run.trials.length ||
    new Set(run.trials.map((trial) => trial.bindingId)).size !== run.trials.length ||
    run.trials.some(
      (trial, index) =>
        trial.trialIndex !== index ||
        trial.sourceProfileId !== run.sourceProfileId ||
        trial.targetProfileId !== run.targetProfileId ||
        trial.targetStageId !== run.targetStageId ||
        trial.profileSelectionId !== run.profileSelectionId ||
        !/^[a-f0-9]{64}$/.test(trial.plannerDecisionHash),
    ) ||
    run.sourceProfileId === run.targetProfileId ||
    run.targetProfileDefinitionId.trim().length === 0 ||
    run.profileSelectionId.trim().length === 0
  ) {
    throw new MissionExecutionError('Outcome Studio Kernel rerun trial identities are invalid');
  }
  verifyStudioOutcomeReceipt(run.receipt);
  verifyOutcomeCiResult(run.ciResult);
  const receiptProfileBinding = run.receipt.runtimeProfileBinding;
  const ciProfileBinding = run.ciResult.runtimeProfileBinding;
  if (
    run.receipt.branchId !== run.targetBranchId ||
    run.receipt.agentRevisionId !== run.targetAgentRevisionId ||
    run.ciResult.scenarioId !== run.scenarioId ||
    run.ciResult.receiptId !== run.receipt.receiptId ||
    run.trials.at(-1)?.branchId !== run.targetBranchId ||
    run.trials.at(-1)?.targetProfileId !== run.targetProfileId ||
    receiptProfileBinding === undefined ||
    ciProfileBinding === undefined ||
    receiptProfileBinding.sourceProfileId !== run.sourceProfileId ||
    receiptProfileBinding.targetProfileId !== run.targetProfileId ||
    receiptProfileBinding.targetStageId !== run.targetStageId ||
    receiptProfileBinding.targetProfileDefinitionId !== run.targetProfileDefinitionId ||
    receiptProfileBinding.profileSelectionId !== run.profileSelectionId ||
    hashPayload(receiptProfileBinding) !== hashPayload(ciProfileBinding)
  ) {
    throw new MissionExecutionError('Outcome Studio Kernel rerun bindings are inconsistent');
  }
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

function adapterIdentity(manifest?: AdapterManifestV1): RuntimeAdapterIdentityV1 | undefined {
  return manifest === undefined
    ? undefined
    : {
        adapterId: manifest.adapterId,
        adapterVersion: manifest.adapterVersion,
        transport: manifest.transport,
        nativeProtocol: manifest.nativeProtocol,
      };
}

function runtimeBinding(attemptId: string, profile: ProfileV1): RuntimeBindingV1 {
  return {
    attemptId,
    profileId: profile.profileId,
    harness: profile.harness,
    ...(profile.adapter === undefined ? {} : profile.adapter),
  };
}

function profileDefinition(
  stage: AttemptStageSpecV1,
  manifest?: AdapterManifestV1,
): RuntimeProfileDefinitionV1 {
  const configuration = {
    harness: stage.profile.harness,
    adapterId: stage.profile.adapterId ?? null,
    providerWorkspaceRef: stage.profile.providerWorkspaceRef ?? null,
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
    ...(manifest === undefined ? {} : { adapter: adapterIdentity(manifest)! }),
  };
}

function uniqueProfileDefinitions(
  spec: MissionSpecV1,
  manifestFor: (stage: AttemptStageSpecV1) => AdapterManifestV1 | undefined = () => undefined,
): RuntimeProfileDefinitionV1[] {
  const definitions = new Map<string, RuntimeProfileDefinitionV1>();
  for (const stage of spec.attemptPlan) {
    const definition = profileDefinition(stage, manifestFor(stage));
    definitions.set(definition.definitionId, definition);
  }
  return [...definitions.values()];
}

function createProfile(
  stage: AttemptStageSpecV1,
  detection: RuntimeDetection,
  workspace: string,
  manifest?: AdapterManifestV1,
): ProfileV1 {
  const definition = profileDefinition(stage, manifest);
  const permissionMode = resolvedPermission(
    stage.profile.harness,
    stage.profile.permissionMode,
    stage.profile.adapterId,
  );
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
    adapterCapabilities: adapterCapabilities(stage, manifest),
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
    capabilities: resolvedProfileCapabilities(stage, permissionMode, manifest),
    configurationDigest: digest,
    ...(manifest === undefined ? {} : { adapter: adapterIdentity(manifest)! }),
    definition,
    catalogObservation,
    effective,
    adapterCapabilities: adapterCapabilities(stage, manifest),
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
      resolvedPermission(
        sourceStage.profile.harness,
        sourceStage.profile.permissionMode,
        sourceStage.profile.adapterId,
      ),
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

function plannerProfileReboundStates(
  checkpoint: CompositeCheckpointManifestV1,
  contract: ContractV1,
): readonly CandidateHandoffStateV1[] {
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
      checkpoint.workspace.state === 'restorable-artifact' ? 'exact' : 'blocking',
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

function discoverSkillManifests(workspace: string, harness: string): JsonValue[] {
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

function adapterCapabilities(
  stage: AttemptStageSpecV1,
  manifest?: AdapterManifestV1,
): AdapterCapabilitiesV1 {
  if (manifest !== undefined) {
    const get = (name: keyof typeof manifest.capabilities) => manifest.capabilities[name].fidelity;
    return {
      observe: get('observe'),
      contextCapture: get('context-capture'),
      steer: get('steer'),
      interrupt: get('interrupt'),
      preToolGate: get('pre-tool-gate'),
      resume: get('resume'),
      nativeFork: get('native-fork'),
      workspaceRestore: get('workspace-restore'),
      externalEffectControl: get('external-effect-control'),
    };
  }
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

function resolvedProfileCapabilities(
  stage: AttemptStageSpecV1,
  permissionMode: string,
  manifest?: AdapterManifestV1,
): string[] {
  if (manifest !== undefined) {
    return [
      `adapter:${manifest.adapterId}`,
      `transport:${manifest.transport}`,
      ...Object.entries(manifest.capabilities)
        .filter(([, item]) => item.status === 'supported')
        .map(([name, item]) => `adapter-capability:${name}:${item.fidelity}`),
    ];
  }
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
  contextText?: string,
): string {
  const criteria = contract.acceptanceCriteria
    .map((criterion) => `- ${criterion.criterionId}: ${criterion.description}`)
    .join('\n');
  const constraints = spec.constraints.map((constraint) => `- ${constraint}`).join('\n');
  return [
    // A cooperative Handoff acknowledgement is a protocol precondition, so it
    // must precede the task body instead of competing with Mission details for
    // the Runtime's first action.
    capsuleText === undefined ? '' : capsuleText,
    `MissionBraid Mission ${contract.contractId}`,
    `Objective: ${contract.objective}`,
    constraints.length === 0 ? 'Constraints: none declared' : `Constraints:\n${constraints}`,
    `Original acceptance criteria:\n${criteria}`,
    contextText === undefined ? '' : contextText,
    `Current stage (${stage.stageId}): ${stage.instruction}`,
    'Stay inside the provided workspace. Obey its AGENTS.md. Do not push, publish, deploy, install dependencies, access the network, or modify tests unless the Mission explicitly requires it.',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function initialPromptByteBudget(injectionBudgetTokens: number): number {
  const bytes = injectionBudgetTokens * 4;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new MissionExecutionError('Runtime Profile injection budget is invalid');
  }
  return Math.min(bytes, 64 * 1024);
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

function runtimeBindingsFromEvents(
  events: readonly StoredEventV1[],
  attemptIds: readonly string[],
): RuntimeBindingV1[] {
  const wanted = new Set(attemptIds);
  return events
    .filter((event) => event.type === 'attempt.bound')
    .map((event) => event.payload.binding)
    .filter(
      (binding): binding is AttemptBindingV1 & { readonly runtimeBinding: RuntimeBindingV1 } =>
        wanted.has(binding.attemptId) && binding.runtimeBinding !== undefined,
    )
    .map((binding) => binding.runtimeBinding)
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId, 'en'));
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
        typeof data.harness === 'string' &&
        data.harness.trim() !== '' &&
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

function resolvedPermission(
  harness: string,
  value: string | undefined,
  adapterId?: string,
): string {
  if (adapterId !== undefined) return value ?? 'adapter-default';
  if (harness === 'codex') return codexSandbox(value);
  if (harness === 'qoder') return qoderPermission(value);
  if (harness === 'claude') return claudePermission(value);
  throw new MissionExecutionError(`Harness ${harness} requires a registered Adapter`);
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
