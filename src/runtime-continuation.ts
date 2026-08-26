import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { sanitizeNativeArtifact, NativeArtifactStore } from './artifact-store.js';
import {
  contextPrompt,
  readContextBinding,
  type ContextBindingMaterialV1,
  type ContextBindingSpecV1,
} from './context-binding.js';
import { CodexAdapter, type CodexRunRequest, type CodexSandbox } from './adapters/codex.js';
import {
  ClaudeAdapter,
  type ClaudePermissionMode,
  type ClaudeRunRequest,
} from './adapters/claude.js';
import { QoderAdapter, type QoderPermissionMode, type QoderRunRequest } from './adapters/qoder.js';
import type { AdapterHostV1 } from './adapter-host.js';
import type {
  RuntimeAdapter,
  RuntimeOutputLine,
  RuntimeOutputObserver,
  RuntimeRunResult,
} from './adapters/types.js';
import type { CheckpointInterventionV1 } from './composite-checkpoint.js';
import type { ClaudeToolGateBindingV1 } from './claude-tool-gate.js';
import type { ContractV1, ProfileV1 } from './domain.js';
import type {
  ExecutionForkProfileSelectionV1,
  RuntimeContinuationInputV1,
  RuntimeContinuationPortV1,
  RuntimeContinuationResultV1,
  RuntimeForkEvidenceKindV1,
  RuntimeForkEvidenceV1,
} from './execution-fork.js';
import { normalizeRuntimeOutput } from './runtime-events.js';
import { extractRuntimeSemanticFacts, type RuntimeSemanticFactV1 } from './runtime-semantics.js';
import type {
  AttemptProfileSpecV1,
  AttemptStageSpecV1,
  CommandVerifierSpecV1,
  ResolvedMissionSpecV1,
} from './spec.js';
import { isSupportedHarnessV1 } from './spec.js';
import { runCommandVerifier } from './verifier.js';
import { createStageWorkspaceDelta, snapshotGitWorkspace } from './workspace.js';

const DEFAULT_MAX_PROMPT_BYTES = 32 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;

type NativeRuntimeProtocol = string;

export interface RuntimeContinuationAdaptersV1 {
  readonly codex: RuntimeAdapter<CodexRunRequest>;
  readonly qoder: RuntimeAdapter<QoderRunRequest>;
  readonly claude: RuntimeAdapter<ClaudeRunRequest>;
}

export interface RuntimeContinuationCheckpointBindingV1 {
  readonly checkpointId: string;
  readonly missionId: string;
  readonly contractId: string;
  readonly profileId: string;
}

export interface NativeAdapterRuntimeContinuationOptionsV1 {
  readonly missionId: string;
  readonly acceptedContract: ContractV1;
  readonly acceptedMissionSpec: ResolvedMissionSpecV1;
  readonly acceptedStage: AttemptStageSpecV1;
  readonly acceptedCheckpoint: RuntimeContinuationCheckpointBindingV1;
  /** Required when acceptedProfileSelection rebinds away from the Checkpoint Profile. */
  readonly acceptedSourceProfile?: ProfileV1;
  readonly acceptedProfile: ProfileV1;
  readonly acceptedProfileSelection?: ExecutionForkProfileSelectionV1;
  readonly acceptedIntervention: CheckpointInterventionV1;
  readonly acceptedContext?: ContextBindingSpecV1;
  /** Root for sanitized native artifacts and verifier provenance. */
  readonly controllerStateDir: string;
  readonly provenanceFile?: string;
  readonly adapters?: Partial<RuntimeContinuationAdaptersV1>;
  /** Public Adapter host used for an external-Harness controller Execution Fork. */
  readonly adapterHost?: AdapterHostV1;
  /** Concrete controller-created native Tool Gateway binding for a mutable Claude Fork. */
  readonly acceptedToolGateBinding?: ClaudeToolGateBindingV1;
  readonly maxPromptBytes?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export class RuntimeContinuationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeContinuationConfigurationError';
  }
}

/**
 * Live execution-fork continuation backed by a native CLI or registered public Adapter.
 *
 * Native output is written only through NativeArtifactStore, which sanitizes
 * it before persistence. Kernel-facing evidence contains digests, structural
 * summaries, and artifact references; it never copies prompts, commands, tool
 * arguments, output text, or credential material.
 */
export class NativeAdapterRuntimeContinuationPort implements RuntimeContinuationPortV1 {
  readonly #missionId: string;
  readonly #contract: ContractV1;
  readonly #missionSpec: ResolvedMissionSpecV1;
  readonly #stage: AttemptStageSpecV1;
  readonly #checkpoint: RuntimeContinuationCheckpointBindingV1;
  readonly #sourceProfile: ProfileV1;
  readonly #profile: ProfileV1;
  readonly #profileSelection: ExecutionForkProfileSelectionV1 | undefined;
  readonly #intervention: CheckpointInterventionV1;
  readonly #context: ContextBindingSpecV1 | undefined;
  readonly #controllerStateDir: string;
  readonly #provenanceFile: string;
  readonly #adapters: RuntimeContinuationAdaptersV1;
  readonly #adapterHost: AdapterHostV1 | undefined;
  readonly #toolGateBinding: ClaudeToolGateBindingV1 | undefined;
  readonly #maxPromptBytes: number;
  readonly #signal: AbortSignal | undefined;
  readonly #now: () => Date;

  constructor(options: NativeAdapterRuntimeContinuationOptionsV1) {
    requireNonEmpty(options.missionId, 'missionId');
    if (!isAbsolute(options.controllerStateDir)) {
      throw new RuntimeContinuationConfigurationError(
        'controllerStateDir must be an absolute path',
      );
    }
    const maxPromptBytes = options.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
    if (
      !Number.isSafeInteger(maxPromptBytes) ||
      maxPromptBytes <= 0 ||
      maxPromptBytes > MAX_PROMPT_BYTES
    ) {
      throw new RuntimeContinuationConfigurationError(
        `maxPromptBytes must be a positive safe integer no greater than ${String(MAX_PROMPT_BYTES)}`,
      );
    }

    validateAcceptedBinding(
      options.missionId,
      options.acceptedContract,
      options.acceptedMissionSpec,
      options.acceptedStage,
      options.acceptedCheckpoint,
      options.acceptedSourceProfile,
      options.acceptedProfile,
      options.acceptedProfileSelection,
      options.acceptedIntervention,
    );
    if (options.acceptedStage.profile.adapterId !== undefined) {
      if (options.adapterHost === undefined) {
        throw new RuntimeContinuationConfigurationError(
          `External Harness ${options.acceptedStage.profile.harness} requires its registered Adapter host for Execution Fork`,
        );
      }
      const manifest = options.adapterHost.manifest(options.acceptedStage.profile.adapterId);
      if (manifest.harnessId !== options.acceptedStage.profile.harness) {
        throw new RuntimeContinuationConfigurationError(
          `Adapter ${manifest.adapterId} is bound to Harness ${manifest.harnessId}, not ${options.acceptedStage.profile.harness}`,
        );
      }
      if (
        manifest.transport === 'provider-backed' ||
        options.acceptedStage.profile.providerWorkspaceRef !== undefined
      ) {
        throw new RuntimeContinuationConfigurationError(
          `Execution Fork for Adapter ${manifest.adapterId} requires a local isolated worktree; provider-backed or opaque provider workspace execution is not supported and will not fall back to a built-in Harness`,
        );
      }
    } else if (!isSupportedHarnessV1(options.acceptedStage.profile.harness)) {
      throw new RuntimeContinuationConfigurationError(
        `External Harness ${options.acceptedStage.profile.harness} requires an Adapter`,
      );
    }
    if (
      options.acceptedStage.breakpoint === 'mutable-tools' &&
      options.acceptedToolGateBinding === undefined
    ) {
      throw new RuntimeContinuationConfigurationError(
        'A mutable-tools Execution Fork requires a concrete native Tool Gateway binding',
      );
    }
    if (
      options.acceptedToolGateBinding !== undefined &&
      (options.acceptedStage.profile.harness !== 'claude' ||
        options.acceptedStage.breakpoint !== 'mutable-tools')
    ) {
      throw new RuntimeContinuationConfigurationError(
        'A native Tool Gateway binding is valid only for a mutable Claude Execution Fork',
      );
    }
    this.#missionId = options.missionId;
    this.#contract = clone(options.acceptedContract);
    this.#missionSpec = clone(options.acceptedMissionSpec);
    this.#stage = clone(options.acceptedStage);
    this.#checkpoint = clone(options.acceptedCheckpoint);
    this.#sourceProfile = clone(options.acceptedSourceProfile ?? options.acceptedProfile);
    this.#profile = clone(options.acceptedProfile);
    this.#profileSelection =
      options.acceptedProfileSelection === undefined
        ? undefined
        : clone(options.acceptedProfileSelection);
    this.#intervention = clone(options.acceptedIntervention);
    this.#context =
      options.acceptedContext === undefined ? undefined : clone(options.acceptedContext);
    this.#controllerStateDir = resolve(options.controllerStateDir);
    this.#provenanceFile = resolve(
      options.provenanceFile ?? join(this.#controllerStateDir, 'provenance.json'),
    );
    assertInside(this.#controllerStateDir, this.#provenanceFile, 'provenanceFile');
    this.#adapters = {
      codex: options.adapters?.codex ?? new CodexAdapter(),
      qoder: options.adapters?.qoder ?? new QoderAdapter(),
      claude: options.adapters?.claude ?? new ClaudeAdapter(),
    };
    this.#adapterHost = options.adapterHost;
    this.#toolGateBinding = options.acceptedToolGateBinding;
    this.#maxPromptBytes = maxPromptBytes;
    this.#signal = options.signal;
    this.#now = options.now ?? (() => new Date());
  }

  async continueFromCheckpoint(
    input: RuntimeContinuationInputV1,
  ): Promise<RuntimeContinuationResultV1> {
    this.#assertInputBinding(input);
    const workspacePath = await realpath(input.workspacePath);
    if (!isAbsolute(workspacePath)) {
      throw new RuntimeContinuationConfigurationError('workspacePath must be absolute');
    }
    await mkdir(this.#controllerStateDir, { recursive: true });

    const beforeWorkspace = snapshotGitWorkspace(workspacePath, { now: this.#now });
    const contextMaterial = await this.#loadContext(workspacePath, beforeWorkspace.workspaceDigest);
    const contextEvidenceRefs: string[] = [];
    const prompt = buildBoundedPrompt(
      input,
      this.#contract,
      this.#stage,
      Math.min(this.#maxPromptBytes, promptByteBudget(this.#stage.profile.injectionBudgetTokens)),
      contextMaterial === undefined ? undefined : contextPrompt(contextMaterial),
    );
    const runtimeRunId = `runtime-run-${sha256(
      stableJson({
        forkId: input.forkId,
        missionId: input.missionId,
        contractId: input.contractId,
        childBranchId: input.childBranchId,
        parentCheckpointId: input.parentCheckpointId,
        intervention: input.intervention,
        profileId: this.#profile.profileId,
        profileDigest: sha256(stableJson(this.#profile)),
        stageProfile: this.#stage.profile,
        promptDigest: sha256(prompt),
      }),
    ).slice(0, 32)}`;
    const artifactStore = new NativeArtifactStore(
      join(this.#controllerStateDir, 'runtime-continuations', runtimeRunId),
    );
    const toolExecutionEvidenceRefs: string[] = [];
    const verificationEvidenceRefs: string[] = [];
    const unresolvedItems: string[] = [];
    if (contextMaterial !== undefined) {
      // A refreshed material intentionally has the current source as both its
      // bound and current content. Preserve the parent checkpoint's digest in
      // the evidence so the diagnostic result still proves a real old→new
      // Context change. The Engine validates this parent digest against the
      // cached snapshot before launching the child.
      const evidenceBoundContextDigest =
        contextMaterial.mode === 'refreshed' && this.#intervention.kind === 'context'
          ? (this.#intervention.beforeDigest ?? contextMaterial.boundContextDigest)
          : contextMaterial.boundContextDigest;
      const contextEvidenceId = evidenceId(runtimeRunId, 'context-freshness');
      await input.appendEvidence({
        evidenceId: contextEvidenceId,
        kind: 'model',
        observedAt: this.#now().toISOString(),
        contentDigest: digestRef({
          contextFactId: contextMaterial.contextFactId,
          mode: contextMaterial.mode,
          boundWorkspaceDigest: contextMaterial.boundWorkspaceDigest,
          currentWorkspaceDigest: contextMaterial.currentWorkspaceDigest,
          boundContextDigest: evidenceBoundContextDigest,
          currentContextDigest: contextMaterial.currentContextDigest,
        }),
        evidenceRefs: [
          `context:${contextMaterial.contextFactId}`,
          `context-mode:${contextMaterial.mode}`,
          `context-bound-workspace:${contextMaterial.boundWorkspaceDigest}`,
          `context-current-workspace:${contextMaterial.currentWorkspaceDigest}`,
          `context-bound-digest:${evidenceBoundContextDigest}`,
          `context-current-digest:${contextMaterial.currentContextDigest}`,
        ],
        summary:
          contextMaterial.mode === 'refreshed'
            ? 'The diagnostic Branch refreshed the declared Context source on the restored workspace frontier.'
            : 'The Fork reused the declared cached Context snapshot.',
      });
      contextEvidenceRefs.push(`evidence:${contextEvidenceId}`);
    }
    const protocol =
      this.#stage.profile.adapterId === undefined
        ? protocolFor(this.#stage.profile.harness)
        : (this.#adapterHost?.nativeProtocol(this.#stage.profile.adapterId) ?? 'adapter-v1');

    let runResult: RuntimeRunResult | undefined;
    try {
      runResult = await this.#runAdapter(
        input,
        runtimeRunId,
        workspacePath,
        prompt,
        async (line) => {
          await this.#recordNativeOutput(
            input,
            runtimeRunId,
            protocol,
            artifactStore,
            line,
            toolExecutionEvidenceRefs,
          );
        },
        async () => {
          await input.appendEvidence({
            evidenceId: evidenceId(runtimeRunId, 'runtime-started'),
            kind: 'runtime',
            observedAt: this.#now().toISOString(),
            contentDigest: digestRef({
              runtimeRunId,
              harness: this.#stage.profile.harness,
              checkpointId: this.#checkpoint.checkpointId,
              sourceProfileId: this.#sourceProfile.profileId,
              profileId: this.#profile.profileId,
              profileDigest: sha256(stableJson(this.#profile)),
              stageProfileDigest: sha256(stableJson(this.#stage.profile)),
              promptDigest: sha256(prompt),
              profileSelection: this.#profileSelection ?? null,
            }),
            evidenceRefs: uniqueSorted([
              `runtime:${runtimeRunId}`,
              `harness:${this.#stage.profile.harness}`,
              `protocol:${protocol}`,
              this.#stage.profile.adapterId === undefined
                ? 'process:spawned'
                : `adapter:${this.#stage.profile.adapterId}:dispatched`,
              ...(this.#profileSelection === undefined
                ? []
                : [
                    `profile-rebound-selection:${this.#profileSelection.selectionId}`,
                    `source-profile:${this.#profileSelection.sourceProfileId}`,
                    `target-profile:${this.#profileSelection.targetProfileId}`,
                    ...this.#profileSelection.evidenceRefs,
                  ]),
            ]),
            summary:
              this.#stage.profile.adapterId === undefined
                ? 'The selected native Harness process started in the isolated worktree.'
                : 'The selected external Adapter was dispatched against the isolated worktree.',
          });
        },
      );
    } catch (error) {
      const sanitized = sanitizeNativeArtifact(errorMessage(error));
      await input.appendEvidence({
        evidenceId: evidenceId(runtimeRunId, 'runtime-threw'),
        kind: 'runtime',
        observedAt: this.#now().toISOString(),
        contentDigest: digestRef(sanitized.content),
        evidenceRefs: [`runtime:${runtimeRunId}`, 'process:adapter-threw'],
        summary:
          'The native Harness adapter threw before a successful process result was available.',
      });
      unresolvedItems.push('runtime-process:adapter-threw');
    }

    const afterWorkspace = snapshotGitWorkspace(workspacePath, { now: this.#now });
    const workspaceDelta = createStageWorkspaceDelta(beforeWorkspace, afterWorkspace);
    const workspaceEvidenceId = evidenceId(runtimeRunId, 'workspace-delta');
    await input.appendEvidence({
      evidenceId: workspaceEvidenceId,
      kind: 'workspace',
      observedAt: afterWorkspace.capturedAt,
      contentDigest: digestRef(workspaceDelta),
      evidenceRefs: uniqueSorted([
        `workspace-before:${workspaceDelta.beforeWorkspaceDigest}`,
        `workspace-after:${workspaceDelta.afterWorkspaceDigest}`,
        ...workspaceDelta.changedPaths.map(
          (change) => `workspace-path-digest:${sha256(change.path)}`,
        ),
      ]),
      summary: `The isolated worktree contains ${String(workspaceDelta.changedPaths.length)} changed path(s).`,
    });

    const processSucceeded = runResult === undefined ? false : isSuccessfulProcess(runResult);
    if (runResult !== undefined) {
      await input.appendEvidence({
        evidenceId: evidenceId(runtimeRunId, 'runtime-finished'),
        kind: 'runtime',
        observedAt: runResult.process.endedAt,
        contentDigest: digestRef(runResult.process),
        evidenceRefs: uniqueSorted([
          `runtime:${runtimeRunId}`,
          `process-exit:${runResult.process.exitCode === null ? 'none' : String(runResult.process.exitCode)}`,
          `process-signal:${runResult.process.signal ?? 'none'}`,
          runResult.process.aborted ? 'process:aborted' : 'process:not-aborted',
        ]),
        summary: processSucceeded
          ? 'The native Harness process completed successfully.'
          : 'The native Harness process did not complete successfully.',
      });
      if (!processSucceeded) unresolvedItems.push('runtime-process:failed');
    }

    const verification = await this.#verify(input, runtimeRunId, workspacePath);
    verificationEvidenceRefs.push(...verification.evidenceRefs);
    unresolvedItems.push(...verification.unresolvedItems);
    if (toolExecutionEvidenceRefs.length === 0) {
      await input.appendEvidence({
        evidenceId: evidenceId(runtimeRunId, 'tool-completion-missing'),
        kind: 'runtime',
        observedAt: this.#now().toISOString(),
        contentDigest: digestRef({ runtimeRunId, protocol, observedToolCompletion: false }),
        evidenceRefs: [
          `runtime:${runtimeRunId}`,
          `protocol:${protocol}`,
          'tool-completion-evidence:missing',
        ],
        summary:
          'The native transcript exposed no terminal tool-result event, so no real tool execution can be claimed.',
      });
      unresolvedItems.push('tool-completion-evidence:missing');
    }

    const status =
      processSucceeded &&
      toolExecutionEvidenceRefs.length > 0 &&
      verification.allPassed &&
      unresolvedItems.length === 0
        ? 'completed'
        : 'failed';
    return {
      runtimeRunId,
      status,
      toolExecutionEvidenceRefs: uniqueSorted(toolExecutionEvidenceRefs),
      ...(contextEvidenceRefs.length === 0
        ? {}
        : { contextEvidenceRefs: uniqueSorted(contextEvidenceRefs) }),
      verificationEvidenceRefs: uniqueSorted(verificationEvidenceRefs),
      unresolvedItems: uniqueSorted(unresolvedItems),
    };
  }

  async #loadContext(
    workspacePath: string,
    currentWorkspaceDigest: string,
  ): Promise<ContextBindingMaterialV1 | undefined> {
    if (this.#context === undefined) {
      if (this.#intervention.kind === 'context') {
        throw new RuntimeContinuationConfigurationError(
          'A Context Intervention requires an accepted Mission Context binding',
        );
      }
      return undefined;
    }
    const context = remapContextToWorkspace(
      this.#context,
      this.#missionSpec.workspace,
      workspacePath,
    );
    const refreshing = this.#intervention.kind === 'context';
    const material = await readContextBinding(context, {
      workspacePath,
      currentWorkspaceDigest,
      mode: refreshing ? 'refreshed' : 'cached',
    });
    if (refreshing) {
      if (
        this.#intervention.targetRef !== `context:${context.factId}` &&
        this.#intervention.targetRef !== context.factId
      ) {
        throw new RuntimeContinuationConfigurationError(
          'Context Intervention target does not match the accepted Context binding',
        );
      }
      if (this.#intervention.afterDigest !== material.currentContextDigest) {
        throw new RuntimeContinuationConfigurationError(
          'Context Intervention afterDigest does not match the current Context source',
        );
      }
      // The child worktree may not contain the controller-owned ignored cache.
      // The parent digest is therefore validated by MissionEngine at the
      // source checkpoint boundary and carried explicitly in the Intervention.
      // Do not compare it with refreshed material, whose bound content is
      // intentionally the new source.
    }
    return material;
  }

  #assertInputBinding(input: RuntimeContinuationInputV1): void {
    if (input.missionId !== this.#missionId) {
      throw new RuntimeContinuationConfigurationError(
        `Runtime continuation Mission ${input.missionId} is not the accepted Mission`,
      );
    }
    if (input.contractId !== this.#contract.contractId) {
      throw new RuntimeContinuationConfigurationError(
        `Runtime continuation Contract ${input.contractId} is not accepted`,
      );
    }
    if (input.parentCheckpointId !== this.#checkpoint.checkpointId) {
      throw new RuntimeContinuationConfigurationError(
        `Runtime continuation Checkpoint ${input.parentCheckpointId} is not accepted`,
      );
    }
    if (stableJson(input.intervention) !== stableJson(this.#intervention)) {
      throw new RuntimeContinuationConfigurationError(
        'Runtime continuation Intervention is not the accepted Intervention',
      );
    }
  }

  async #runAdapter(
    input: RuntimeContinuationInputV1,
    runtimeRunId: string,
    workspace: string,
    prompt: string,
    onOutput: RuntimeOutputObserver,
    onStart: () => Promise<void>,
  ): Promise<RuntimeRunResult> {
    const profile = this.#stage.profile;
    if (profile.adapterId !== undefined) {
      if (this.#adapterHost === undefined) {
        throw new RuntimeContinuationConfigurationError(
          `Adapter ${profile.adapterId} is unavailable for Execution Fork`,
        );
      }
      await onStart();
      return await this.#adapterHost.run({
        identity: {
          executionId: runtimeRunId,
          missionId: input.missionId,
          branchId: input.childBranchId,
          attemptId: `fork-attempt-${input.forkId}`,
          bindingId: `fork-binding-${input.forkId}`,
        },
        profile: {
          profileId: this.#profile.profileId,
          adapterId: profile.adapterId,
          harness: profile.harness,
          model: this.#profile.model,
          configurationDigest: this.#profile.configurationDigest,
          ...(this.#profile.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: this.#profile.reasoningEffort }),
          ...(this.#profile.permissionMode === undefined
            ? {}
            : { permissionMode: this.#profile.permissionMode }),
        },
        workspaceKey: `fork-workspace:${input.forkId}`,
        localWorkspace: workspace,
        instruction: prompt,
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
        onOutput,
      });
    }
    if (!isSupportedHarnessV1(profile.harness)) {
      throw new RuntimeContinuationConfigurationError(
        `External Harness ${profile.harness} requires an Adapter`,
      );
    }
    switch (profile.harness) {
      case 'codex':
        return await this.#adapters.codex.run({
          workspace,
          prompt,
          model: profile.model,
          ...(profile.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: profile.reasoningEffort }),
          ...(profile.permissionMode === undefined
            ? {}
            : { sandbox: codexSandbox(profile.permissionMode) }),
          ephemeral: true,
          ...(this.#signal === undefined ? {} : { signal: this.#signal }),
          onOutput,
          onStart,
        });
      case 'qoder':
        return await this.#adapters.qoder.run({
          workspace,
          prompt,
          model: profile.model,
          ...(profile.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: profile.reasoningEffort }),
          ...(profile.permissionMode === undefined
            ? {}
            : { permissionMode: qoderPermissionMode(profile.permissionMode) }),
          noSessionPersistence: true,
          ...(this.#signal === undefined ? {} : { signal: this.#signal }),
          onOutput,
          onStart,
        });
      case 'claude':
        return await this.#adapters.claude.run({
          workspace,
          prompt,
          model: profile.model,
          ...(profile.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: profile.reasoningEffort }),
          ...(profile.permissionMode === undefined
            ? {}
            : { permissionMode: claudePermissionMode(profile.permissionMode) }),
          noSessionPersistence: true,
          includeHookEvents: true,
          ...(this.#toolGateBinding === undefined
            ? {}
            : {
                settingsFile: this.#toolGateBinding.settingsFile,
                tools: this.#toolGateBinding.tools,
                verifiedHookGate: true,
              }),
          ...(this.#signal === undefined ? {} : { signal: this.#signal }),
          onOutput,
          onStart,
        });
    }
    throw new RuntimeContinuationConfigurationError(`Unsupported Harness ${profile.harness}`);
  }

  async #recordNativeOutput(
    input: RuntimeContinuationInputV1,
    runtimeRunId: string,
    protocol: NativeRuntimeProtocol,
    artifactStore: NativeArtifactStore,
    line: RuntimeOutputLine,
    toolExecutionEvidenceRefs: string[],
  ): Promise<void> {
    const artifact = await artifactStore.putLine(line.line);
    const content = await artifactStore.get(artifact.artifactId);
    if (content === undefined) {
      throw new RuntimeContinuationConfigurationError(
        `Sanitized native artifact ${artifact.artifactId} could not be read back`,
      );
    }
    const sanitizedLine: RuntimeOutputLine = {
      ...line,
      line: content.content.trimEnd(),
      ...(content.mediaType === 'application/json'
        ? { value: JSON.parse(content.content) as unknown }
        : { value: undefined }),
    };
    const runtimeEvent = normalizeRuntimeOutput(
      sanitizedLine,
      {
        missionId: input.missionId,
        branchId: input.childBranchId,
        attemptId: `fork-attempt-${input.forkId}`,
        bindingId: `fork-binding-${input.forkId}`,
        planNodeId: `fork-plan-${input.forkId}`,
        sourceProtocol: protocol,
      },
      artifact,
    );
    const artifactRef = `native-artifact:${artifact.artifactId}`;
    await input.appendEvidence({
      evidenceId: evidenceId(runtimeRunId, `native-${runtimeEvent.runtimeEventId}`),
      kind: 'runtime',
      observedAt: runtimeEvent.observedAt,
      contentDigest: `sha256:${artifact.sha256}`,
      evidenceRefs: uniqueSorted([
        artifactRef,
        `runtime-event:${runtimeEvent.runtimeEventId}`,
        `protocol:${protocol}`,
        `stream:${line.stream}`,
        `redactions:${String(artifact.redactionCount)}`,
      ]),
      summary: 'One sanitized native Harness output event was retained as evidence.',
    });

    for (const fact of extractRuntimeSemanticFacts(runtimeEvent, content)) {
      const kind = evidenceKind(fact);
      const factEvidenceId = evidenceId(runtimeRunId, fact.factId);
      const evidence: RuntimeForkEvidenceV1 = {
        evidenceId: factEvidenceId,
        kind,
        observedAt: runtimeEvent.observedAt,
        contentDigest: `sha256:${artifact.sha256}`,
        evidenceRefs: uniqueSorted([
          artifactRef,
          `runtime-event:${runtimeEvent.runtimeEventId}`,
          `semantic-fact:${fact.factId}`,
          `semantic-evidence:${fact.evidence}`,
        ]),
        summary: semanticSummary(fact),
      };
      await input.appendEvidence(evidence);
      if (isTerminalNativeToolExecution(fact, protocol)) {
        toolExecutionEvidenceRefs.push(`evidence:${factEvidenceId}`);
      }
    }
  }

  async #verify(
    input: RuntimeContinuationInputV1,
    runtimeRunId: string,
    workspacePath: string,
  ): Promise<{
    readonly allPassed: boolean;
    readonly evidenceRefs: readonly string[];
    readonly unresolvedItems: readonly string[];
  }> {
    const evidenceRefs: string[] = [];
    const unresolvedItems: string[] = [];
    let allPassed = true;
    for (const criterion of this.#missionSpec.acceptanceCriteria) {
      const evidenceIdValue = evidenceId(runtimeRunId, `verification-${criterion.id}`);
      let passed = false;
      let contentDigest: string;
      let references: readonly string[];
      try {
        const verifier = await mapVerifierToWorktree(
          criterion.verifier,
          this.#missionSpec.workspace,
          workspacePath,
        );
        const result = await runCommandVerifier(verifier, {
          workspace: workspacePath,
          // A Fork verifier must not retain the source workspace as a second
          // allowed execution root. Its mapped cwd and target workspace are B.
          missionSourceDir: workspacePath,
          controllerStateDir: this.#controllerStateDir,
          provenanceFile: this.#provenanceFile,
          now: this.#now,
          ...(this.#signal === undefined ? {} : { signal: this.#signal }),
        });
        passed = result.passed;
        contentDigest = digestRef(result);
        references = uniqueSorted([
          `criterion:${criterion.id}`,
          `verification:${passed ? 'passed' : 'failed'}`,
          `invocation:${result.invocationDigest}`,
          `stdout:sha256:${result.stdout.sha256}`,
          `stderr:sha256:${result.stderr.sha256}`,
        ]);
      } catch (error) {
        const sanitized = sanitizeNativeArtifact(errorMessage(error));
        contentDigest = digestRef(sanitized.content);
        references = [`criterion:${criterion.id}`, 'verification:error'];
      }
      await input.appendEvidence({
        evidenceId: evidenceIdValue,
        kind: 'verification',
        observedAt: this.#now().toISOString(),
        contentDigest,
        evidenceRefs: references,
        summary: passed
          ? `Deterministic verifier ${criterion.id} passed.`
          : `Deterministic verifier ${criterion.id} did not pass.`,
      });
      evidenceRefs.push(`evidence:${evidenceIdValue}`);
      if (!passed) {
        allPassed = false;
        unresolvedItems.push(`verification:${criterion.id}:failed`);
      }
    }
    return { allPassed, evidenceRefs, unresolvedItems };
  }
}

export function createNativeAdapterRuntimeContinuationPort(
  options: NativeAdapterRuntimeContinuationOptionsV1,
): NativeAdapterRuntimeContinuationPort {
  return new NativeAdapterRuntimeContinuationPort(options);
}

export function buildRuntimeContinuationPrompt(
  input: RuntimeContinuationInputV1,
  acceptedContract: ContractV1,
  acceptedStage: AttemptStageSpecV1,
  maxBytes = DEFAULT_MAX_PROMPT_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PROMPT_BYTES) {
    throw new RuntimeContinuationConfigurationError('Invalid continuation prompt byte limit');
  }
  return buildBoundedPrompt(
    input,
    acceptedContract,
    acceptedStage,
    Math.min(maxBytes, promptByteBudget(acceptedStage.profile.injectionBudgetTokens)),
  );
}

function buildBoundedPrompt(
  input: RuntimeContinuationInputV1,
  contract: ContractV1,
  stage: AttemptStageSpecV1,
  byteLimit: number,
  contextText?: string,
): string {
  const constraints = (contract.constraints ?? []).map((value) => `- ${value}`).join('\n');
  const criteria = contract.acceptanceCriteria
    .map((criterion) => `- ${criterion.criterionId}: ${criterion.description}`)
    .join('\n');
  const inheritedEffects = input.inheritedExternalEffectFrontier
    .map((effect) => `- ${effect.effectId}: ${effect.status}`)
    .join('\n');
  const decisions = input.externalEffectDecisions
    .map((decision) => `- ${decision.effectId}: ${decision.action}`)
    .join('\n');
  const profile = stage.profile;
  const raw = [
    `MissionBraid Execution Fork ${input.forkId}`,
    `Accepted Contract: ${contract.contractId}`,
    `Objective: ${contract.objective}`,
    constraints.length === 0 ? 'Constraints: none declared' : `Constraints:\n${constraints}`,
    `Acceptance criteria:\n${criteria}`,
    [
      `Accepted Runtime Profile: harness=${profile.harness}, model=${profile.model}`,
      `reasoningEffort=${profile.reasoningEffort ?? 'runtime-default'}`,
      `permissionMode=${profile.permissionMode ?? 'runtime-default'}`,
    ].join(', '),
    contextText === undefined ? '' : contextText,
    `Accepted stage (${stage.stageId}): ${stage.instruction}`,
    [
      `Single accepted Intervention: ${input.intervention.interventionId}`,
      `kind=${input.intervention.kind}`,
      `target=${input.intervention.targetRef}`,
      `afterDigest=${input.intervention.afterDigest}`,
      `authorityChange=${input.intervention.authorityChange}`,
      `description=${input.intervention.description}`,
    ].join(', '),
    inheritedEffects.length === 0
      ? 'Inherited external Effects: none'
      : `Inherited external Effects:\n${inheritedEffects}`,
    decisions.length === 0
      ? 'External Effect replay decisions: none'
      : `External Effect replay decisions:\n${decisions}`,
    [
      'Continue only in the provided isolated worktree.',
      'Obey its AGENTS.md and the accepted Contract.',
      'Apply only the declared Intervention; do not expand authority.',
      'Never repeat inherited external Effects marked inherit-no-repeat.',
      'Do not push, publish, deploy, send messages, install dependencies, or access the network unless the accepted Contract explicitly requires that exact action.',
      'Use native tools when needed. Do not claim completion; deterministic verifiers decide acceptance after the process exits.',
    ].join(' '),
  ].join('\n\n');
  const sanitized = sanitizeNativeArtifact(raw).content.trimEnd();
  if (Buffer.byteLength(sanitized, 'utf8') > byteLimit) {
    throw new RuntimeContinuationConfigurationError(
      `Continuation prompt exceeds its accepted ${String(byteLimit)} byte budget`,
    );
  }
  return sanitized;
}

function validateAcceptedBinding(
  missionId: string,
  contract: ContractV1,
  missionSpec: ResolvedMissionSpecV1,
  stage: AttemptStageSpecV1,
  checkpoint: RuntimeContinuationCheckpointBindingV1,
  sourceProfile: ProfileV1 | undefined,
  profile: ProfileV1,
  profileSelection: ExecutionForkProfileSelectionV1 | undefined,
  intervention: CheckpointInterventionV1,
): void {
  for (const [name, value] of [
    ['checkpoint.checkpointId', checkpoint.checkpointId],
    ['checkpoint.missionId', checkpoint.missionId],
    ['checkpoint.contractId', checkpoint.contractId],
    ['checkpoint.profileId', checkpoint.profileId],
    ['profile.profileId', profile.profileId],
    ['profile.configurationDigest', profile.configurationDigest],
  ] as const) {
    requireNonEmpty(value, name);
  }
  if (checkpoint.missionId !== missionId || checkpoint.contractId !== contract.contractId) {
    throw new RuntimeContinuationConfigurationError(
      'Accepted Checkpoint is not bound to the accepted Mission and Contract',
    );
  }
  if (profileSelection === undefined) {
    if (checkpoint.profileId !== profile.profileId) {
      throw new RuntimeContinuationConfigurationError(
        'Accepted Checkpoint is not bound to the accepted Mission, Contract, and Profile',
      );
    }
  } else {
    validateProfileReboundBinding(checkpoint, sourceProfile, profile, stage, profileSelection);
  }
  if (
    contract.objective !== missionSpec.objective ||
    stableJson(contract.constraints ?? []) !== stableJson(missionSpec.constraints)
  ) {
    throw new RuntimeContinuationConfigurationError(
      'Accepted Contract does not match the accepted Mission specification',
    );
  }
  if (
    contract.acceptanceCriteria.length === 0 ||
    contract.acceptanceCriteria.length !== missionSpec.acceptanceCriteria.length
  ) {
    throw new RuntimeContinuationConfigurationError(
      'Accepted Contract verifier count is empty or does not match the Mission specification',
    );
  }
  const contractCriterionIds = contract.acceptanceCriteria.map(
    (criterion) => criterion.criterionId,
  );
  const specificationCriterionIds = missionSpec.acceptanceCriteria.map((criterion) => criterion.id);
  if (
    new Set(contractCriterionIds).size !== contractCriterionIds.length ||
    new Set(specificationCriterionIds).size !== specificationCriterionIds.length ||
    stableJson([...contractCriterionIds].sort()) !==
      stableJson([...specificationCriterionIds].sort())
  ) {
    throw new RuntimeContinuationConfigurationError(
      'Accepted Contract criteria must be the complete unique Mission criterion set',
    );
  }
  const specifications = new Map(
    missionSpec.acceptanceCriteria.map((criterion) => [criterion.id, criterion]),
  );
  for (const criterion of contract.acceptanceCriteria) {
    const specification = specifications.get(criterion.criterionId);
    const configuration = jsonRecord(criterion.verifier.configuration);
    if (
      specification === undefined ||
      criterion.description !== specification.description ||
      criterion.verifier.kind !== 'command' ||
      configuration.executable !== specification.verifier.executable ||
      configuration.timeoutMs !== specification.verifier.timeoutMs ||
      stableJson(configuration.environmentKeys) !==
        stableJson(Object.keys(specification.verifier.env).sort()) ||
      configuration.configurationDigest !== sha256(stableJson(specification.verifier))
    ) {
      throw new RuntimeContinuationConfigurationError(
        `Accepted Contract criterion ${criterion.criterionId} does not match its command verifier`,
      );
    }
    if (Object.keys(specification.verifier.env).length > 0) {
      throw new RuntimeContinuationConfigurationError(
        `Verifier ${criterion.criterionId} may not bind environment values`,
      );
    }
  }
  if (!missionSpec.attemptPlan.some((candidate) => stableJson(candidate) === stableJson(stage))) {
    throw new RuntimeContinuationConfigurationError(
      `Stage ${stage.stageId} is not part of the accepted Mission specification`,
    );
  }
  validateProfile(stage.profile);
  const expectedPermissionMode =
    stage.profile.permissionMode ?? defaultPermissionMode(stage.profile);
  if (
    profile.harness !== stage.profile.harness ||
    profile.model !== stage.profile.model ||
    (profile.reasoningEffort ?? null) !== (stage.profile.reasoningEffort ?? null) ||
    profile.permissionMode !== expectedPermissionMode ||
    (profile.injectionBudgetTokens ?? null) !== stage.profile.injectionBudgetTokens
  ) {
    throw new RuntimeContinuationConfigurationError(
      `Accepted Profile ${profile.profileId} does not match stage ${stage.stageId}`,
    );
  }
  if (
    profile.definition !== undefined &&
    (profile.definition.harness !== stage.profile.harness ||
      profile.definition.requestedModel !== stage.profile.model ||
      (profile.definition.requestedReasoningEffort ?? null) !==
        (stage.profile.reasoningEffort ?? null) ||
      (profile.definition.permissionCeiling ?? null) !== (stage.profile.permissionMode ?? null) ||
      profile.definition.injectionBudgetTokens !== stage.profile.injectionBudgetTokens)
  ) {
    throw new RuntimeContinuationConfigurationError(
      `Accepted Profile definition does not match stage ${stage.stageId}`,
    );
  }
  for (const [name, value] of [
    ['interventionId', intervention.interventionId],
    ['targetRef', intervention.targetRef],
    ['afterDigest', intervention.afterDigest],
    ['description', intervention.description],
  ] as const) {
    requireNonEmpty(value, name);
  }
  if (intervention.authorityChange !== 'unchanged' && intervention.authorityChange !== 'narrowed') {
    throw new RuntimeContinuationConfigurationError(
      'Intervention may only keep or narrow authority',
    );
  }
}

function validateProfileReboundBinding(
  checkpoint: RuntimeContinuationCheckpointBindingV1,
  sourceProfile: ProfileV1 | undefined,
  targetProfile: ProfileV1,
  targetStage: AttemptStageSpecV1,
  selection: ExecutionForkProfileSelectionV1,
): void {
  if (
    sourceProfile === undefined ||
    sourceProfile.profileId !== checkpoint.profileId ||
    selection.sourceProfileId !== checkpoint.profileId ||
    selection.targetProfileId !== targetProfile.profileId ||
    selection.sourceProfileId === selection.targetProfileId ||
    selection.targetStageId !== targetStage.stageId ||
    targetProfile.definition?.definitionId !== selection.targetProfileDefinitionId
  ) {
    throw new RuntimeContinuationConfigurationError(
      'Accepted Profile-Rebound selection conflicts with the immutable source Checkpoint or target stage',
    );
  }
  for (const [name, value] of [
    ['profileSelection.selectionId', selection.selectionId],
    ['profileSelection.targetProfileDefinitionId', selection.targetProfileDefinitionId],
  ] as const) {
    requireNonEmpty(value, name);
  }
  if (
    !/^[a-f0-9]{64}$/.test(selection.plannerDecisionHash) ||
    !Number.isFinite(Date.parse(selection.selectedAt)) ||
    selection.evidenceRefs.length === 0 ||
    selection.evidenceRefs.some((reference) => reference.trim().length === 0)
  ) {
    throw new RuntimeContinuationConfigurationError(
      'Accepted Profile-Rebound selection lacks durable Planner evidence',
    );
  }
  const authorityChange = executionForkProfileAuthorityChange(sourceProfile, targetProfile);
  if (authorityChange === 'expanded' || selection.authorityChange !== authorityChange) {
    throw new RuntimeContinuationConfigurationError(
      'Accepted Profile-Rebound target may only keep or narrow the source Profile authority',
    );
  }
}

export function executionForkProfileAuthorityChange(
  sourceProfile: ProfileV1,
  targetProfile: ProfileV1,
): 'unchanged' | 'narrowed' | 'expanded' {
  if (sourceProfile.permissionMode === targetProfile.permissionMode) return 'unchanged';
  const sourceRank = permissionAuthorityRank(sourceProfile.harness, sourceProfile.permissionMode);
  const targetRank = permissionAuthorityRank(targetProfile.harness, targetProfile.permissionMode);
  if (sourceRank === null || targetRank === null) return 'expanded';
  return targetRank < sourceRank ? 'narrowed' : 'expanded';
}

function permissionAuthorityRank(harness: string, mode: string | undefined): number | null {
  const normalized = `${harness}:${mode ?? ''}`;
  if (['codex:read-only', 'qoder:plan', 'claude:plan', 'claude:manual'].includes(normalized)) {
    return 0;
  }
  if (
    [
      'codex:workspace-write',
      'qoder:accept_edits',
      'qoder:auto',
      'qoder:dont_ask',
      'claude:acceptEdits',
      'claude:auto',
      'claude:dontAsk',
    ].includes(normalized)
  ) {
    return 1;
  }
  if (
    ['codex:danger-full-access', 'qoder:bypass_permissions', 'claude:bypassPermissions'].includes(
      normalized,
    )
  ) {
    return 2;
  }
  return null;
}

function validateProfile(profile: AttemptProfileSpecV1): void {
  requireNonEmpty(profile.model, 'profile.model');
  if (!Number.isSafeInteger(profile.injectionBudgetTokens) || profile.injectionBudgetTokens <= 0) {
    throw new RuntimeContinuationConfigurationError(
      'profile.injectionBudgetTokens must be a positive safe integer',
    );
  }
  if (profile.reasoningEffort !== undefined) {
    requireNonEmpty(profile.reasoningEffort, 'profile.reasoningEffort');
  }
  if (profile.permissionMode !== undefined) {
    requireNonEmpty(profile.permissionMode, 'profile.permissionMode');
    switch (profile.harness) {
      case 'codex':
        codexSandbox(profile.permissionMode);
        break;
      case 'qoder':
        qoderPermissionMode(profile.permissionMode);
        break;
      case 'claude':
        claudePermissionMode(profile.permissionMode);
        break;
    }
  }
}

async function mapVerifierToWorktree(
  verifier: CommandVerifierSpecV1,
  acceptedWorkspace: string,
  worktree: string,
): Promise<CommandVerifierSpecV1> {
  const sourceRoot = await realpath(acceptedWorkspace);
  const targetRoot = await realpath(worktree);
  const sourceAliases = [...new Set([resolve(acceptedWorkspace), sourceRoot])].sort(
    (left, right) => right.length - left.length,
  );
  const sourceCwd = await realpath(verifier.cwd);
  const relativeCwd = relative(sourceRoot, sourceCwd);
  if (relativeCwd === '..' || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) {
    throw new RuntimeContinuationConfigurationError(
      'Continuation verifier cwd must be inside the accepted source workspace',
    );
  }
  const mapped = resolve(targetRoot, relativeCwd);
  assertInside(targetRoot, mapped, 'mapped verifier cwd');
  const mappedVerifier = {
    ...verifier,
    executable: mapSourcePathReferences(verifier.executable, sourceAliases, targetRoot),
    args: verifier.args.map((argument) =>
      mapSourcePathReferences(argument, sourceAliases, targetRoot),
    ),
    cwd: await realpath(mapped),
    env: {},
  };
  for (const [label, value] of [
    ['verifier executable', mappedVerifier.executable],
    ...mappedVerifier.args.map(
      (argument, index) => [`verifier args[${String(index)}]`, argument] as const,
    ),
    ['verifier cwd', mappedVerifier.cwd],
  ] as const) {
    if (sourceAliases.some((sourceAlias) => containsPathReference(value, sourceAlias))) {
      throw new RuntimeContinuationConfigurationError(
        `${label} retains a reference to the source workspace`,
      );
    }
  }
  return mappedVerifier;
}

function remapContextToWorkspace(
  context: ContextBindingSpecV1,
  sourceWorkspace: string,
  targetWorkspace: string,
): ContextBindingSpecV1 {
  const sourceRoot = resolve(sourceWorkspace);
  const targetRoot = resolve(targetWorkspace);
  const sourcePath = resolve(context.source);
  const snapshotPath = resolve(context.snapshot);
  const sourceRelative = relative(sourceRoot, sourcePath);
  const snapshotRelative = relative(sourceRoot, snapshotPath);
  for (const [label, value] of [
    ['Context source', sourceRelative],
    ['Context snapshot', snapshotRelative],
  ] as const) {
    if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
      throw new RuntimeContinuationConfigurationError(
        `${label} must remain inside the accepted source workspace`,
      );
    }
  }
  return {
    factId: context.factId,
    source: resolve(targetRoot, sourceRelative),
    snapshot: resolve(targetRoot, snapshotRelative),
  };
}

function mapSourcePathReferences(
  value: string,
  sourceRoots: readonly string[],
  targetRoot: string,
): string {
  if (sourceRoots.includes(targetRoot)) {
    throw new RuntimeContinuationConfigurationError(
      'Execution Fork verifier target must differ from the source workspace',
    );
  }
  let mapped = value;
  for (const sourceRoot of sourceRoots) {
    mapped = mapOneSourcePathReference(mapped, sourceRoot, targetRoot);
  }
  return mapped;
}

function mapOneSourcePathReference(value: string, sourceRoot: string, targetRoot: string): string {
  let cursor = 0;
  let mapped = '';
  while (cursor < value.length) {
    const match = value.indexOf(sourceRoot, cursor);
    if (match === -1) {
      mapped += value.slice(cursor);
      break;
    }
    const suffix = value[match + sourceRoot.length];
    mapped += value.slice(cursor, match);
    if (isSourcePathBoundary(suffix)) {
      mapped += targetRoot;
    } else {
      mapped += sourceRoot;
    }
    cursor = match + sourceRoot.length;
  }
  return mapped;
}

function containsPathReference(value: string, sourceRoot: string): boolean {
  let cursor = 0;
  while (cursor < value.length) {
    const match = value.indexOf(sourceRoot, cursor);
    if (match === -1) return false;
    const suffix = value[match + sourceRoot.length];
    if (isSourcePathBoundary(suffix)) return true;
    cursor = match + sourceRoot.length;
  }
  return false;
}

function isSourcePathBoundary(value: string | undefined): boolean {
  return value === undefined || /[\\/\s'"`),;:\]}=?#]/.test(value);
}

function evidenceKind(fact: RuntimeSemanticFactV1): RuntimeForkEvidenceKindV1 {
  switch (fact.kind) {
    case 'model_call':
    case 'context':
    case 'message':
    case 'usage':
      return 'model';
    case 'tool_request':
    case 'tool_result':
    case 'test_run':
      return 'tool';
    case 'workspace_change':
      return 'workspace';
    case 'subagent_started':
    case 'subagent_finished':
    case 'failure':
      return 'runtime';
  }
}

function semanticSummary(fact: RuntimeSemanticFactV1): string {
  switch (fact.kind) {
    case 'model_call':
      return `A ${fact.evidence} native model-call fact was observed with phase ${fact.phase}.`;
    case 'context':
      return `A ${fact.evidence} native context fact was observed.`;
    case 'message':
      return `A ${fact.evidence} native ${fact.role} message fact was observed.`;
    case 'usage':
      return `A ${fact.evidence} native usage fact was observed.`;
    case 'tool_request':
      return `A ${fact.evidence} native tool request was observed.`;
    case 'tool_result':
      return `A ${fact.evidence} native tool result was observed with phase ${fact.phase}.`;
    case 'test_run':
      return `A ${fact.evidence} native test-run fact was observed with status ${fact.status}.`;
    case 'workspace_change':
      return `A ${fact.evidence} native workspace-change fact was observed.`;
    case 'subagent_started':
    case 'subagent_finished':
      return `A ${fact.evidence} native subagent lifecycle fact was observed.`;
    case 'failure':
      return `A ${fact.evidence} native failure fact was observed.`;
  }
}

function isSuccessfulProcess(result: RuntimeRunResult): boolean {
  return (
    result.process.exitCode === 0 &&
    result.process.signal === null &&
    !result.process.aborted &&
    result.process.spawnError === undefined &&
    result.process.startError === undefined &&
    result.process.observerError === undefined
  );
}

function protocolFor(harness: string): NativeRuntimeProtocol {
  switch (harness) {
    case 'codex':
      return 'codex-jsonl';
    case 'qoder':
      return 'qoder-stream-json';
    case 'claude':
      return 'claude-stream-json';
  }
  throw new RuntimeContinuationConfigurationError(
    `External Harness ${harness} requires an Adapter protocol`,
  );
}

/**
 * A request only proves model intent. Execution evidence starts at the native
 * protocol's terminal tool-result boundary.
 */
function isTerminalNativeToolExecution(
  fact: RuntimeSemanticFactV1,
  protocol: NativeRuntimeProtocol,
): boolean {
  if (fact.kind !== 'tool_result' || fact.evidence !== 'explicit') return false;
  if (protocol === 'codex-jsonl') {
    return fact.phase === 'completed' || fact.phase === 'failed';
  }
  // Claude and Qoder stream-json expose a `tool_result` content item only after
  // the tool boundary returns. The result may omit a status, so phase=unknown
  // is still terminal for these two native protocols.
  return true;
}

function codexSandbox(value: string): CodexSandbox {
  if (['read-only', 'workspace-write', 'danger-full-access'].includes(value)) {
    return value as CodexSandbox;
  }
  throw new RuntimeContinuationConfigurationError(`Unsupported Codex sandbox ${value}`);
}

function defaultPermissionMode(profile: AttemptProfileSpecV1): string {
  if (profile.adapterId !== undefined) return 'adapter-default';
  if (profile.harness === 'codex') return 'workspace-write';
  if (profile.harness === 'qoder') return 'dont_ask';
  if (profile.harness === 'claude') return 'dontAsk';
  throw new RuntimeContinuationConfigurationError(
    `External Harness ${profile.harness} requires an Adapter`,
  );
}

function qoderPermissionMode(value: string): QoderPermissionMode {
  if (
    ['default', 'plan', 'auto', 'bypass_permissions', 'accept_edits', 'dont_ask'].includes(value)
  ) {
    return value as QoderPermissionMode;
  }
  throw new RuntimeContinuationConfigurationError(`Unsupported Qoder permission mode ${value}`);
}

function claudePermissionMode(value: string): ClaudePermissionMode {
  if (
    ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'].includes(
      value,
    )
  ) {
    return value as ClaudePermissionMode;
  }
  throw new RuntimeContinuationConfigurationError(`Unsupported Claude permission mode ${value}`);
}

function promptByteBudget(injectionBudgetTokens: number): number {
  const bytes = injectionBudgetTokens * 4;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new RuntimeContinuationConfigurationError('Prompt byte budget is invalid');
  }
  return Math.min(bytes, MAX_PROMPT_BYTES);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new RuntimeContinuationConfigurationError(
      'Contract verifier configuration must be an object',
    );
  }
  return value as Record<string, unknown>;
}

function assertInside(root: string, candidate: string, label: string): void {
  const path = relative(resolve(root), resolve(candidate));
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new RuntimeContinuationConfigurationError(`${label} must stay inside its root`);
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new RuntimeContinuationConfigurationError(`${name} must not be empty`);
  }
}

function evidenceId(runtimeRunId: string, discriminator: string): string {
  return `evidence-${sha256(`${runtimeRunId}\0${discriminator}`).slice(0, 32)}`;
}

function digestRef(value: unknown): string {
  return `sha256:${sha256(stableJson(value))}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown Runtime continuation error';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RuntimeContinuationConfigurationError('Canonical JSON forbids non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const member = record[key];
        if (member === undefined) {
          throw new RuntimeContinuationConfigurationError(
            `Canonical JSON forbids undefined at ${key}`,
          );
        }
        return `${JSON.stringify(key)}:${stableJson(member)}`;
      })
      .join(',')}}`;
  }
  throw new RuntimeContinuationConfigurationError(
    `Canonical JSON cannot encode a ${typeof value} value`,
  );
}
