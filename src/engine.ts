import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CodexAdapter, type CodexSandbox } from './adapters/codex.js';
import { QoderAdapter, type QoderPermissionMode } from './adapters/qoder.js';
import type { RuntimeDetection, RuntimeOutputLine, RuntimeRunResult } from './adapters/types.js';
import {
  createCanonicalCapsule,
  extractAndValidateAcknowledgement,
  projectCanonicalCapsule,
  type CanonicalCapsuleV1,
} from './capsule.js';
import {
  DOMAIN_SCHEMA_VERSION,
  type ContractV1,
  type EffectV1,
  type EventV1,
  type JsonValue,
  type MissionProjectionV1,
  type ProfileV1,
  type ReceiptEffectResultV1,
  type ReceiptV1,
  type StoredEventV1,
  type WorkspaceFenceV1,
} from './domain.js';
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
} from './spec.js';
import { hashPayload, MissionStore } from './store.js';
import { runCommandVerifier, type CommandVerificationResultV1 } from './verifier.js';
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
  readonly now?: () => Date;
  readonly id?: () => string;
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
  readonly harness: 'codex' | 'qoder';
  readonly profileId: string;
}

interface AttemptBaselineRecord {
  readonly attemptId: string;
  readonly stageId: string;
  readonly harness: 'codex' | 'qoder';
  readonly profileId: string;
  readonly snapshot: GitWorkspaceSnapshotV1;
}

interface CheckpointRecord {
  readonly checkpointId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly stageId: string;
  readonly harness: 'codex' | 'qoder';
  readonly profileId: string;
  readonly status: 'succeeded' | 'handed_off' | 'failed';
  readonly delta: StageWorkspaceDeltaV1;
  readonly origin?: 'runtime-completion' | 'controller-recovery';
}

interface ExecutionState {
  readonly plans: ReadonlyMap<string, AttemptPlanRecord>;
  readonly baselines: ReadonlyMap<string, AttemptBaselineRecord>;
  readonly finished: ReadonlyMap<string, 'succeeded' | 'failed' | 'abandoned'>;
  readonly checkpoints: readonly CheckpointRecord[];
  readonly confirmedEffectIds: readonly string[];
  readonly effects: readonly ReceiptEffectResultV1[];
  readonly effectsByAttempt: ReadonlyMap<string, ReceiptEffectResultV1>;
  readonly handoffIds: readonly string[];
  readonly processByAttempt: ReadonlyMap<string, number>;
}

export class MissionExecutionError extends Error {}

export class MissionEngine {
  readonly #stateDir: string;
  readonly #store: MissionStore;
  readonly #codex: CodexAdapter;
  readonly #qoder: QoderAdapter;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: MissionEngineOptions) {
    this.#stateDir = resolve(options.stateDir);
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#codex = options.codexAdapter ?? new CodexAdapter();
    this.#qoder = options.qoderAdapter ?? new QoderAdapter();
    this.#store = new MissionStore(join(this.#stateDir, 'kernel.sqlite'), { now: this.#now });
  }

  close(): void {
    this.#store.close();
  }

  async run(
    missionFile: string,
    options: ExecuteMissionOptions = {},
  ): Promise<MissionExecutionResult> {
    await mkdir(this.#stateDir, { recursive: true });
    const spec = loadMissionSpec(
      missionFile,
      options.workspace === undefined ? {} : { workspace: options.workspace },
    );
    assertControlStateIsolation(this.#stateDir, spec.workspace);
    const specSnapshot = createMissionSpecSnapshot(spec);
    const missionId = `mission-${this.#id()}`;
    const workspaceKey = `workspace-${hashPayload(spec.workspace).slice(0, 32)}`;
    const ownerId = `runner-${this.#id()}`;
    return await this.#withLease(workspaceKey, ownerId, async (fence) => {
      const contract = createContract(spec, this.#now());
      const detection = await this.#detect(spec.attemptPlan[0]?.profile.harness ?? 'codex');
      const profile = createProfile(spec.attemptPlan[0]!, detection);
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
            status: 'pending',
            createdAt,
          },
          contract,
          profile,
        },
      };
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
      this.#store.appendEvents([createdEvent, specSnapshotEvent], fence);
      return await this.#execute(missionId, spec, fence, options.signal);
    });
  }

  async resume(
    missionId: string,
    options: Omit<ExecuteMissionOptions, 'workspace'> = {},
  ): Promise<MissionExecutionResult> {
    const mission = this.#requireMission(missionId);
    const spec = this.#requireSpecSnapshot(missionId);
    assertControlStateIsolation(this.#stateDir, spec.workspace);
    const ownerId = `runner-${this.#id()}`;
    return await this.#withLease(mission.workspaceKey, ownerId, async (fence) => {
      await this.#closeDanglingAttempts(missionId, spec, fence);
      return await this.#execute(missionId, spec, fence, options.signal);
    });
  }

  async verify(missionId: string): Promise<MissionExecutionResult> {
    const mission = this.#requireMission(missionId);
    const spec = this.#requireSpecSnapshot(missionId);
    assertControlStateIsolation(this.#stateDir, spec.workspace);
    const ownerId = `runner-${this.#id()}`;
    return await this.#withLease(
      mission.workspaceKey,
      ownerId,
      async (fence) => await this.#verifyAndReceipt(missionId, spec, fence),
    );
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

    for (
      let index = nextStageIndex(
        spec,
        reconstructExecutionState(this.#store.listEvents(missionId)),
      );
      index < spec.attemptPlan.length;
      index += 1
    ) {
      const stage = spec.attemptPlan[index]!;
      const result = await this.#executeStage(missionId, spec, stage, fence, signal);
      if (result === 'waiting') {
        const projection = this.#requireMission(missionId);
        const waitingReason = latestWaitingReason(this.#store.listEvents(missionId));
        return {
          missionId,
          status: projection.status,
          ...(waitingReason === undefined ? {} : { waitingReason }),
        };
      }
    }
    return await this.#verifyAndReceipt(missionId, spec, fence);
  }

  async #executeStage(
    missionId: string,
    spec: MissionSpecV1,
    stage: AttemptStageSpecV1,
    fence: WorkspaceFenceV1,
    signal?: AbortSignal,
  ): Promise<'progressed' | 'waiting'> {
    const detection = await this.#detect(stage.profile.harness);
    if (!detection.available) {
      this.#setWaiting(missionId, `Runtime ${stage.profile.harness} is not installed`, fence);
      return 'waiting';
    }

    const profile = createProfile(stage, detection);
    const mission = this.#requireMission(missionId);
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
      return 'waiting';
    }
    const attemptId = `attempt-${this.#id()}`;
    const effectId = `effect-${attemptId}`;
    const plan: AttemptPlanRecord = {
      attemptId,
      stageId: stage.stageId,
      harness: stage.profile.harness,
      profileId: profile.profileId,
    };

    let capsule: CanonicalCapsuleV1 | undefined;
    let projectedCapsuleText: string | undefined;
    let preparedHandoff: JsonValue | undefined;
    if (previousCheckpoint !== undefined) {
      capsule = createCanonicalCapsule({
        missionId,
        contractId: mission.contract.contractId,
        contractSummary: mission.contract.objective,
        constraints: spec.constraints,
        source: {
          attemptId: previousCheckpoint.attemptId,
          stageId: previousCheckpoint.stageId,
          profileId: previousCheckpoint.profileId,
        },
        target: { attemptId, stageId: stage.stageId, profileId: profile.profileId },
        checkpoint: {
          checkpointId: previousCheckpoint.checkpointId,
          workspaceDigest: previousCheckpoint.delta.afterWorkspaceDigest,
        },
        remainingCriteria: mission.contract.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          summary: criterion.description,
        })),
        doNotRepeatEffectIds: stateBefore.confirmedEffectIds,
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
        return 'waiting';
      }
      projectedCapsuleText = projected.projection.text;
      preparedHandoff = {
        capsuleId: projected.projection.capsuleId,
        capsuleHash: projected.projection.capsuleHash,
        projectionHash: projected.projection.projectionHash,
        checkpointId: previousCheckpoint.checkpointId,
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
      snapshot: before,
    };
    const effect: EffectV1 = {
      schemaVersion: DOMAIN_SCHEMA_VERSION,
      effectId,
      missionId,
      attemptId,
      kind: 'workspace.stage_mutation',
      resourceKey: `workspace-stage:${stage.stageId}`,
      controlLevel: 'advisory',
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
    let acknowledgementBeforeMutation = capsule === undefined;
    let acknowledgementId: string | undefined;
    let runtimeFailure: RuntimeFailureObservation | undefined;
    const onOutput = async (line: RuntimeOutputLine): Promise<void> => {
      outputHash.update(`${line.stream}\0${line.line}\n`, 'utf8');
      outputLines += 1;
      runtimeFailure ??= classifyRuntimeOutputFailure(line);
      if (capsule === undefined || acknowledged) return;
      const candidate = extractAndValidateAcknowledgement(line, capsule);
      if (!candidate.ok) return;
      const atAcknowledgement = snapshotGitWorkspace(spec.workspace);
      acknowledged = true;
      acknowledgementBeforeMutation = atAcknowledgement.workspaceDigest === before.workspaceDigest;
      acknowledgementId = `ack-${hashPayload(candidate.acknowledgement).slice(0, 24)}`;
      this.#observe(
        missionId,
        'handoff.acknowledged',
        {
          acknowledgementId,
          capsuleId: capsule.capsuleId,
          checkpointId: capsule.checkpoint.checkpointId,
          beforeMutation: acknowledgementBeforeMutation,
        },
        fence,
        attemptId,
      );
    };
    const prompt = createAttemptPrompt(spec, stage, mission.contract, projectedCapsuleText);
    const runtimeResult = await this.#runRuntime(stage, {
      workspace: spec.workspace,
      prompt,
      ...(signal === undefined ? {} : { signal }),
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

    const after = snapshotGitWorkspace(spec.workspace);
    const delta = createStageWorkspaceDelta(before, after);
    const processSucceeded = processResultSucceeded(runtimeResult);
    const handoffAccepted =
      capsule === undefined || (acknowledged && acknowledgementBeforeMutation);
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
        acknowledgementBeforeMutation,
        acknowledgementId: acknowledgementId ?? null,
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
                acknowledgementBeforeMutation,
                runtimeFailure,
              ),
        },
      },
      fence,
    );
    await this.#writeProvenanceProjection(missionId);

    if (attemptSucceeded || canHandOff) return 'progressed';
    this.#setWaiting(
      missionId,
      failureSummary(
        runtimeResult,
        capsule !== undefined,
        acknowledged,
        acknowledgementBeforeMutation,
        runtimeFailure,
      ),
      fence,
    );
    return 'waiting';
  }

  async #verifyAndReceipt(
    missionId: string,
    spec: MissionSpecV1,
    fence: WorkspaceFenceV1,
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

  async #runRuntime(
    stage: AttemptStageSpecV1,
    request: {
      readonly workspace: string;
      readonly prompt: string;
      readonly signal?: AbortSignal;
      readonly onStart: (pid: number) => void;
      readonly onOutput: (line: RuntimeOutputLine) => Promise<void>;
    },
  ): Promise<RuntimeRunResult> {
    const model = stage.profile.model === 'default' ? undefined : stage.profile.model;
    if (stage.profile.harness === 'codex') {
      return await this.#codex.run({
        ...request,
        ...(model === undefined ? {} : { model }),
        ...(stage.profile.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: stage.profile.reasoningEffort }),
        sandbox: codexSandbox(stage.profile.permissionMode),
        ephemeral: true,
      });
    }
    return await this.#qoder.run({
      ...request,
      ...(model === undefined ? {} : { model }),
      ...(stage.profile.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: stage.profile.reasoningEffort }),
      permissionMode: qoderPermission(stage.profile.permissionMode),
      maxTurns: 80,
      noSessionPersistence: true,
    });
  }

  async #detect(harness: 'codex' | 'qoder'): Promise<RuntimeDetection> {
    return harness === 'codex' ? await this.#codex.detect() : await this.#qoder.detect();
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
    }
    if (danglingPlans.length > 0) await this.#writeProvenanceProjection(missionId);
  }

  async #writeProvenanceProjection(missionId: string): Promise<void> {
    const state = reconstructExecutionState(this.#store.listEvents(missionId));
    const stages: ProvenanceStageV1[] = state.checkpoints.map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      stageId: checkpoint.stageId,
      harness: checkpoint.harness,
      attemptId: checkpoint.attemptId,
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

function createProfile(stage: AttemptStageSpecV1, detection: RuntimeDetection): ProfileV1 {
  const configuration = {
    harness: stage.profile.harness,
    model: stage.profile.model,
    reasoningEffort: stage.profile.reasoningEffort ?? null,
    permissionMode: stage.profile.permissionMode ?? null,
    injectionBudgetTokens: stage.profile.injectionBudgetTokens,
    runtimeVersion: detection.version,
  };
  const digest = hashPayload(configuration);
  return {
    schemaVersion: DOMAIN_SCHEMA_VERSION,
    profileId: `profile-${digest.slice(0, 28)}`,
    harness: stage.profile.harness,
    model: stage.profile.model,
    ...(stage.profile.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: stage.profile.reasoningEffort }),
    ...(detection.version === null ? {} : { runtimeVersion: detection.version }),
    injectionBudgetTokens: stage.profile.injectionBudgetTokens,
    ...(stage.profile.permissionMode === undefined
      ? {}
      : { permissionMode: stage.profile.permissionMode }),
    capabilities: ['workspace-read', 'workspace-write', 'command-execution'],
    configurationDigest: digest,
  };
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
  acknowledgementBeforeMutation: boolean,
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
  if (acknowledgementRequired && !acknowledgementBeforeMutation)
    return 'Target runtime acknowledged the Handoff Capsule after changing the workspace';
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
  const confirmedEffects = new Set<string>();
  const effects = new Map<string, ReceiptEffectResultV1>();
  const effectIdsByAttempt = new Map<string, string>();
  const handoffIds: string[] = [];
  const processByAttempt = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'attempt.finished') {
      finished.set(event.payload.attemptId, event.payload.status);
      continue;
    }
    if (event.type === 'effect.status_changed' && event.payload.status === 'confirmed') {
      confirmedEffects.add(event.payload.effectId);
    }
    if (event.type === 'effect.recorded') {
      const effect = event.payload.effect;
      effectIdsByAttempt.set(effect.attemptId, effect.effectId);
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
        (data.harness === 'codex' || data.harness === 'qoder') &&
        typeof data.profileId === 'string'
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
    confirmedEffectIds: [...confirmedEffects],
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
