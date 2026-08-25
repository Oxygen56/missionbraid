#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchHeadlessWorkbench, wait } from './headless-workbench.mjs';
import { createQueryableHttpEffectTarget } from './queryable-http-effect-target.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
if (!existsSync(builtApp)) throw new Error('Run `pnpm build` before the Iteration 5 Replay proof.');

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
if (outputFile !== undefined && existsSync(outputFile)) {
  throw new Error(`Refusing to overwrite ${outputFile}`);
}

const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i5-checkpoint-replay-'));
const stateDir = join(proofRoot, 'state');
const workspace = join(proofRoot, 'workspace');
const providerLog = join(proofRoot, 'runtime-provider.jsonl');
const qoderEnabled = join(proofRoot, 'qoder-enabled');
const claudeEnabled = join(proofRoot, 'claude-enabled');
const codexWrapper = join(proofRoot, 'codex-controlled-provider.mjs');
const qoderWrapper = join(proofRoot, 'qoder-gated-provider.mjs');
const claudeWrapper = join(proofRoot, 'claude-gated-provider.mjs');
const fixture = prepareFixture(workspace);
const realCodex = commandPath('codex');
const realQoder = commandPath('qodercli');
const realClaude = commandPath('claude');

writeExecutable(
  codexWrapper,
  controlledCodexProviderSource({
    realExecutable: realCodex,
    controlledWorkspace: realpathSync(workspace),
    providerLog,
  }),
);
writeExecutable(
  qoderWrapper,
  gatedProviderSource({
    runtime: 'qoder',
    realExecutable: realQoder,
    enabledMarker: qoderEnabled,
    providerLog,
  }),
);
writeExecutable(
  claudeWrapper,
  gatedProviderSource({
    runtime: 'claude',
    realExecutable: realClaude,
    enabledMarker: claudeEnabled,
    providerLog,
  }),
);

const implementation = {
  revision: git(repositoryRoot, ['rev-parse', 'HEAD']),
  headTree: git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
  indexTree: git(repositoryRoot, ['write-tree']),
  dirtyBeforeRun: git(repositoryRoot, ['status', '--porcelain']).length > 0,
  nodeVersion: process.version,
};
const nativeRuntimes = {
  codex: { executable: realCodex, version: commandVersion(realCodex) },
  qoder: { executable: realQoder, version: commandVersion(realQoder) },
  claude: { executable: realClaude, version: commandVersion(realClaude) },
};

const effectFixture = await startQueryableTarget();
const targetId = 'iteration-5-replay-queryable-target';
const target = createQueryableHttpEffectTarget(effectFixture.url, targetId);
const { startMissionBraidApp } = await import('../dist/src/app.js');
const { MissionEngine } = await import('../dist/src/engine.js');
const { CodexAdapter } = await import('../dist/src/adapters/codex.js');
const { QoderAdapter } = await import('../dist/src/adapters/qoder.js');
const { ClaudeAdapter } = await import('../dist/src/adapters/claude.js');
const { NativeArtifactStore } = await import('../dist/src/artifact-store.js');
const { ClaudeModelOnlyResamplePort } = await import('../dist/src/model-only-resample.js');

const engineFactory = (directory) => {
  const claudeAdapter = new ClaudeAdapter({ command: claudeWrapper });
  const artifacts = new NativeArtifactStore(directory);
  return new MissionEngine({
    stateDir: directory,
    codexAdapter: new CodexAdapter({ command: codexWrapper }),
    qoderAdapter: new QoderAdapter({ command: qoderWrapper }),
    claudeAdapter,
    externalEffectTargets: [target],
    modelOnlyResamplePort: new ClaudeModelOnlyResamplePort({
      adapter: claudeAdapter,
      artifacts,
      sandboxDirectory: join(directory, 'model-only-sandbox'),
      model: 'deepseek-v4-pro',
      reasoningEffort: 'low',
    }),
  });
};

let app;
let restarted;
let browser;
let restartBrowser;
try {
  const proofStartedAt = new Date();
  app = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  browser = await launchHeadlessWorkbench(app.url, join(proofRoot, 'chrome-before-restart'));

  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const readyRuntimeIds = inventory.runtimes
    .filter((runtime) => runtime.status === 'ready-supported')
    .map((runtime) => runtime.id);
  for (const runtimeId of ['codex', 'qoder', 'claude']) {
    if (!readyRuntimeIds.includes(runtimeId)) {
      throw new Error(`${runtimeId} is not ready through the normal Workbench inventory.`);
    }
  }

  const created = await submitMissionThroughWorkbench(browser, app.url, workspace);
  progress(`Replay source Mission ${created.missionId} accepted through the browser`);
  const waiting = await waitForWaitingMission(app.url, created.missionId, 20 * 60_000);
  if (
    waiting.mission.status !== 'waiting' ||
    waiting.attempts.length !== 1 ||
    waiting.attempts[0]?.harness !== 'codex' ||
    waiting.attempts[0]?.status !== 'failed'
  ) {
    throw new Error(`Controlled source boundary did not wait: ${stableJson(waiting.attempts)}`);
  }
  const sourceAttemptId = waiting.attempts[0].attemptId;
  const sourceSnapshot = gitSnapshot(workspace);
  const sourceProvider = providerRun(readProviderLog(providerLog), 'codex', workspace);
  if (
    sourceProvider.spawned === undefined ||
    sourceProvider.deltaObserved === undefined ||
    sourceProvider.controllerSealed === undefined ||
    sourceProvider.terminationRequested === undefined ||
    sourceProvider.childExit?.signal !== 'SIGTERM' ||
    sourceProvider.childExit?.wrapperExitCode !== 86 ||
    sourceSnapshot.head === fixture.head ||
    sourceSnapshot.status.length !== 0 ||
    readFileSync(join(workspace, 'source.txt'), 'utf8') !== 'source-sealed\n' ||
    existsSync(join(workspace, 'final.txt'))
  ) {
    throw new Error(`Controlled source boundary is incomplete: ${stableJson(sourceProvider)}`);
  }

  const effectId = 'effect-iteration-5-replay-no-repeat';
  const idempotencyKey = 'iteration-5-replay-create-once';
  const effectPayload = { operation: 'create', value: 'Checkpoint Replay no-repeat proof' };
  const coordinated = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      body: JSON.stringify({
        attemptId: sourceAttemptId,
        targetId,
        kind: 'record.create',
        resourceKey: 'record:iteration-5-replay',
        authorityRef: 'grant:iteration-5-replay-local-proof',
        idempotencyKey,
        payloadDigest: sha256(stableJson(effectPayload)),
        payload: effectPayload,
      }),
    },
  );
  if (coordinated.outcome?.status !== 'confirmed' || effectFixture.postCount() !== 1) {
    throw new Error('The real queryable external Effect was not confirmed exactly once.');
  }
  const externalCallsAtCheckpoint = effectFixture.calls();

  const checkpointIdsBefore = waiting.compositeCheckpoints.map(
    (checkpoint) => checkpoint.checkpointId,
  );
  const checkpoint = await createRestorableCheckpointThroughWorkbench(
    browser,
    app.url,
    created.missionId,
    sourceAttemptId,
    checkpointIdsBefore,
  );
  if (
    checkpoint.workspace?.state !== 'restorable-artifact' ||
    checkpoint.workspace?.artifactRef !== `git-commit:${sourceSnapshot.head}` ||
    checkpoint.workspace?.artifactDigest !== `git-tree:${sourceSnapshot.tree}` ||
    checkpoint.externalEffectFrontier.find((effect) => effect.effectId === effectId)?.status !==
      'confirmed'
  ) {
    throw new Error('The Replay Checkpoint is not bound to the sealed commit and Effect frontier.');
  }

  writeFileSync(qoderEnabled, 'enabled\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await resumeMissionThroughWorkbench(browser, created.missionId);
  const completed = await waitForSucceededMission(app.url, created.missionId, 20 * 60_000);
  if (
    completed.mission.receipt?.outcome !== 'verified' ||
    completed.attempts.length !== 2 ||
    completed.attempts[1]?.harness !== 'qoder' ||
    completed.attempts[1]?.status !== 'succeeded'
  ) {
    throw new Error(
      `Real source-future continuation did not verify: ${stableJson(completed.attempts)}`,
    );
  }
  const qoderProvider = providerRun(readProviderLog(providerLog), 'qoder', workspace);
  if (
    qoderProvider.spawned === undefined ||
    qoderProvider.childExit?.code !== 0 ||
    qoderProvider.childExit?.signal !== null
  ) {
    throw new Error(`Real Qoder continuation did not exit normally: ${stableJson(qoderProvider)}`);
  }
  const completedSnapshot = gitSnapshot(workspace);
  if (
    completedSnapshot.head !== sourceSnapshot.head ||
    !completedSnapshot.status.some((line) => line.endsWith('final.txt')) ||
    readFileSync(join(workspace, 'source.txt'), 'utf8') !== 'source-sealed\n' ||
    readFileSync(join(workspace, 'final.txt'), 'utf8') !== 'source-future-complete\n'
  ) {
    throw new Error(
      'The real continuation did not preserve source and create the expected future.',
    );
  }

  const replayBaseline = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  const kernelBeforePlayback = kernelSnapshot(replayBaseline);
  const runtimeCountsBeforeReplay = runtimeEvidenceCounts(replayBaseline);
  const providerSpawnsBeforeReplay = providerSpawnCount(readProviderLog(providerLog));
  const artifactsBeforeReplay = artifactIds(stateDir);
  const workspaceBeforeReplay = gitSnapshot(workspace);

  await submitReplayThroughWorkbench(browser, checkpoint.checkpointId, 'playback');
  const afterPlayback = await waitForReplayMode(app.url, created.missionId, 'playback', 60_000);
  const playback = replayOf(afterPlayback, 'playback');
  const kernelAfterPlayback = kernelSnapshot(afterPlayback);
  if (
    playback.phase !== 'completed' ||
    stableJson(kernelAfterPlayback) !== stableJson(kernelBeforePlayback)
  ) {
    throw new Error('Playback changed the authoritative Kernel Branch or event chain.');
  }

  await submitReplayThroughWorkbench(
    browser,
    checkpoint.checkpointId,
    'cached-replay',
    'Continue with the already persisted successful source future.',
    'Reference the same-Branch native future Artifacts without new execution.',
  );
  const afterCached = await waitForReplayMode(app.url, created.missionId, 'cached-replay', 60_000);
  const cached = replayOf(afterCached, 'cached-replay');
  const cachedEvidence = cached.lineage.sourceFuture?.evidence ?? [];
  const cachedArtifactIds = cachedEvidence.flatMap((evidence) =>
    evidence.artifactRefs.map((artifact) => artifact.artifactId),
  );
  if (
    cached.phase !== 'completed' ||
    cached.lineage.sourceFuture?.sourceBranchId !== checkpoint.source.branchId ||
    cachedEvidence.length === 0 ||
    !cachedEvidence.every(
      (evidence) =>
        evidence.sourceSequence > checkpoint.eventPrefix.throughSeq &&
        evidence.artifactRefs.every((artifact) => artifact.fidelity === 'exact-replay-safe'),
    ) ||
    !cachedArtifactIds.every((artifactId) => artifactsBeforeReplay.has(artifactId)) ||
    cached.plan.semantics?.modelExecution !== 'cached' ||
    cached.plan.semantics?.toolExecution !== 'cached' ||
    cached.plan.semantics?.workspaceUse !== 'isolated-read-only' ||
    cached.receiptInput?.outcome !== 'unknown' ||
    cached.receiptInput?.authority !== 'receipt-input-not-kernel-state' ||
    cached.lineage.externalEffectDecisions.find((decision) => decision.effectId === effectId)
      ?.action !== 'inherit-no-repeat'
  ) {
    throw new Error(`Cached Replay evidence is incomplete: ${stableJson(cached)}`);
  }
  assertNoLiveReplaySideEffects({
    label: 'Cached Replay',
    detail: afterCached,
    baselineCounts: runtimeCountsBeforeReplay,
    baselineProviderSpawns: providerSpawnsBeforeReplay,
    baselineWorkspace: workspaceBeforeReplay,
    providerLog,
    workspace,
    effectFixture,
    externalCallsAtCheckpoint,
  });

  writeFileSync(claudeEnabled, 'enabled\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const providerSpawnsBeforeCounterfactual = providerSpawnCount(readProviderLog(providerLog));
  await submitReplayThroughWorkbench(
    browser,
    checkpoint.checkpointId,
    'counterfactual-resample',
    'Explain the same next step in one concise paragraph without requesting tools.',
    'Change only the next guidance and collect model-only evidence.',
  );
  const afterCounterfactual = await waitForReplayMode(
    app.url,
    created.missionId,
    'counterfactual-resample',
    10 * 60_000,
  );
  const counterfactual = replayOf(afterCounterfactual, 'counterfactual-resample');
  const claudeRuns = readProviderLog(providerLog).filter(
    (event) => event.runtime === 'claude' && event.kind === 'provider.spawned',
  );
  const modelOnlyRun = claudeRuns.at(-1);
  if (
    counterfactual.phase !== 'completed' ||
    counterfactual.modelResult?.status !== 'completed' ||
    counterfactual.modelEvidence.length === 0 ||
    counterfactual.plan.semantics?.modelExecution !== 'resampled' ||
    counterfactual.plan.semantics?.toolExecution !== 'cached' ||
    counterfactual.plan.semantics?.workspaceUse !== 'isolated-read-only' ||
    counterfactual.receiptInput?.outcome !== 'unknown' ||
    counterfactual.receiptInput?.authority !== 'receipt-input-not-kernel-state' ||
    counterfactual.receiptInput?.unresolvedItems.includes(
      'model-only-resample-did-not-run-live-tools-or-workspace',
    ) !== true ||
    counterfactual.lineage.externalEffectDecisions.find(
      (decision) => decision.effectId === effectId,
    )?.action !== 'inherit-no-repeat' ||
    modelOnlyRun === undefined ||
    modelOnlyRun.cwd !== realpathSync(join(stateDir, 'model-only-sandbox')) ||
    !hasFlag(modelOnlyRun.args, '--safe-mode') ||
    !hasFlagValue(modelOnlyRun.args, '--tools', '') ||
    !hasFlag(modelOnlyRun.args, '--no-session-persistence') ||
    !hasFlagValue(modelOnlyRun.args, '--model', 'deepseek-v4-pro') ||
    !hasFlagValue(modelOnlyRun.args, '--effort', 'low') ||
    providerSpawnCount(readProviderLog(providerLog)) !== providerSpawnsBeforeCounterfactual + 1
  ) {
    throw new Error(
      `Counterfactual model-only evidence is incomplete: ${stableJson(counterfactual)}`,
    );
  }
  assertNoKernelRuntimeOrWorkspaceSideEffects({
    label: 'Counterfactual Replay',
    detail: afterCounterfactual,
    baselineCounts: runtimeCountsBeforeReplay,
    baselineWorkspace: workspaceBeforeReplay,
    workspace,
    effectFixture,
    externalCallsAtCheckpoint,
  });

  const browserBeforeRestart = await waitForReplayCards(browser, created.missionId, [
    'playback',
    'cached-replay',
    'counterfactual-resample',
  ]);
  const replayRecordsBeforeRestart = replaySummary(afterCounterfactual.checkpointReplays);
  const branchesBeforeRestart = afterCounterfactual.branches
    .map((branch) => branch.branchId)
    .sort();
  const finalHeadBeforeRestart = afterCounterfactual.mission.headHash;
  const receiptBeforeRestart = afterCounterfactual.mission.receipt?.receiptId;
  const providerEventsBeforeRestart = readProviderLog(providerLog);
  const callsBeforeRestart = effectFixture.calls();

  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;
  restarted = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const recovered = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  restartBrowser = await launchHeadlessWorkbench(
    restarted.url,
    join(proofRoot, 'chrome-after-restart'),
  );
  const browserAfterRestart = await waitForReplayCards(restartBrowser, created.missionId, [
    'playback',
    'cached-replay',
    'counterfactual-resample',
  ]);
  if (
    stableJson(replaySummary(recovered.checkpointReplays)) !==
      stableJson(replayRecordsBeforeRestart) ||
    stableJson(recovered.branches.map((branch) => branch.branchId).sort()) !==
      stableJson(branchesBeforeRestart) ||
    recovered.mission.headHash !== finalHeadBeforeRestart ||
    recovered.mission.receipt?.receiptId !== receiptBeforeRestart ||
    stableJson(readProviderLog(providerLog)) !== stableJson(providerEventsBeforeRestart) ||
    stableJson(effectFixture.calls()) !== stableJson(callsBeforeRestart) ||
    stableJson(gitSnapshot(workspace)) !== stableJson(workspaceBeforeReplay)
  ) {
    throw new Error('Replay evidence did not reconstruct without new execution after restart.');
  }

  const proofEndedAt = new Date();
  const evidence = {
    schemaVersion: 1,
    capturedAt: proofEndedAt.toISOString(),
    evidenceLevel: 'same-host-local-real-native-runtime-browser-controlled-source-interruption',
    implementation,
    nativeRuntimes,
    timing: {
      startedAt: proofStartedAt.toISOString(),
      endedAt: proofEndedAt.toISOString(),
      elapsedMs: proofEndedAt.getTime() - proofStartedAt.getTime(),
    },
    productEntry:
      'built local Workbench and versioned API: controlled source boundary -> restorable Composite Checkpoint -> same-Branch native future -> playback/cached/counterfactual Replay -> restart',
    mission: {
      missionId: created.missionId,
      sourceAttemptId,
      continuationAttemptId: completed.attempts[1].attemptId,
      receiptId: completed.mission.receipt.receiptId,
      rootBranchId: checkpoint.source.branchId,
      finalHeadHash: finalHeadBeforeRestart,
    },
    controlledSourceBoundary: {
      runtime: 'codex',
      realProcess: sourceProvider.spawned,
      exactDeltaObserved: sourceProvider.deltaObserved,
      controllerSealedCommit: sourceProvider.controllerSealed,
      controlledTermination: sourceProvider.terminationRequested,
      childExit: sourceProvider.childExit,
      initialHead: fixture.head,
      sealedSnapshot: sourceSnapshot,
      claim:
        'The proof runtime-provider observed the exact real Codex source.txt delta, the local controller committed only that inspected delta, then deliberately terminated the real process. This is not a natural Runtime failure.',
    },
    externalEffect: {
      effectId,
      targetId,
      idempotencyKey,
      status: coordinated.outcome.status,
      targetPostCount: effectFixture.postCount(),
      calls: effectFixture.calls(),
      callsAddedByReplayOrRestart: 0,
    },
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      manifestHash: checkpoint.manifestHash,
      source: checkpoint.source,
      eventPrefix: checkpoint.eventPrefix,
      workspace: checkpoint.workspace,
      effectFrontier: checkpoint.externalEffectFrontier,
      componentDispositions: checkpoint.components.map((component) => ({
        component: component.component,
        disposition: component.disposition,
      })),
    },
    sameBranchSourceFuture: {
      runtime: 'qoder',
      realProcess: qoderProvider.spawned,
      childExit: qoderProvider.childExit,
      branchId: cached.lineage.sourceFuture.sourceBranchId,
      checkpointThroughSeq: checkpoint.eventPrefix.throughSeq,
      evidenceCount: cachedEvidence.length,
      evidenceKinds: [...new Set(cachedEvidence.map((entry) => entry.kind))].sort(),
      sourceSequences: cachedEvidence.map((entry) => entry.sourceSequence),
      artifactIds: [...new Set(cachedArtifactIds)].sort(),
      allArtifactsPersistedBeforeReplay: cachedArtifactIds.every((artifactId) =>
        artifactsBeforeReplay.has(artifactId),
      ),
    },
    playback: {
      replayId: playback.replayId,
      phase: playback.phase,
      kernelBefore: kernelBeforePlayback,
      kernelAfter: kernelAfterPlayback,
      kernelBranchAndEventCountsUnchanged:
        stableJson(kernelAfterPlayback) === stableJson(kernelBeforePlayback),
    },
    cachedReplay: {
      replayId: cached.replayId,
      phase: cached.phase,
      childBranchId: cached.lineage.childBranchId,
      semantics: cached.plan.semantics,
      receiptInputOutcome: cached.receiptInput.outcome,
      externalEffectDecisions: cached.lineage.externalEffectDecisions,
      newNativeRuntimeProcesses: 0,
      newKernelRuntimeEvents: 0,
      newToolSemanticFacts: 0,
      sourceWorkspaceChanged: false,
    },
    counterfactualResample: {
      replayId: counterfactual.replayId,
      phase: counterfactual.phase,
      childBranchId: counterfactual.lineage.childBranchId,
      semantics: counterfactual.plan.semantics,
      modelResult: counterfactual.modelResult,
      modelEvidenceCount: counterfactual.modelEvidence.length,
      modelEvidenceKinds: [...new Set(counterfactual.modelEvidence.map((entry) => entry.kind))],
      receiptInputOutcome: counterfactual.receiptInput.outcome,
      receiptInputAuthority: counterfactual.receiptInput.authority,
      nativeInvocation: {
        executable: modelOnlyRun.realExecutable,
        cwd: modelOnlyRun.cwd,
        safeMode: true,
        toolsArgument: '',
        noSessionPersistence: true,
        model: 'deepseek-v4-pro',
        reasoningEffort: 'low',
      },
      newLiveToolExecutions: 0,
      newExternalEffects: 0,
      sourceWorkspaceChanged: false,
    },
    workbench: {
      missionCreatedThroughBrowser: true,
      checkpointCreatedThroughBrowser: true,
      resumeTriggeredThroughBrowser: true,
      allThreeReplaysTriggeredThroughBrowser: true,
      beforeRestart: browserBeforeRestart,
      afterRestart: browserAfterRestart,
    },
    restartRecovery: {
      sameReplayRecords: true,
      sameBranches: true,
      sameMissionHeadAndReceipt: true,
      runtimeProcessesAdded: 0,
      externalTargetCallsAdded: 0,
      sourceWorkspaceChanged: false,
    },
    claimBoundary:
      'This is same-host local evidence through the built MissionBraid Workbench. A real Codex process produced one exact source delta; a separately recorded proof runtime-provider let the local controller inspect and seal only that delta as a Git commit, then deliberately interrupted the process. After the Mission waited, one real queryable external Effect was confirmed, the Workbench captured a complete restorable Composite Checkpoint, and a real Qoder native continuation acknowledged a semantic Capsule and produced persisted same-Branch future Artifacts. Playback preserved Kernel Branch and event counts; cached Replay referenced only those already-persisted future Artifacts without launching a Runtime, tool, Effect, or workspace mutation; counterfactual Replay launched one real Claude model-only process with --safe-mode and an empty --tools argument in an isolated controller sandbox, produced model evidence only, and left child Receipt input outcome unknown. All three Replay records, both replay child Branches, the no-repeat Effect decision, and the original verified Mission reconstructed after restart without new execution or target traffic. This does not prove native session migration, native session replay, cross-host continuity, production reliability, independent reproduction, or that the controlled provider interruption was a natural Harness failure.',
    proofRoot,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputFile === undefined) process.stdout.write(serialized);
  else writeFileSync(outputFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  progress(`Iteration 5 Replay evidence complete in ${String(evidence.timing.elapsedMs)} ms`);
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (restartBrowser !== undefined) await restartBrowser.close().catch(() => undefined);
  if (app !== undefined) await app.close();
  if (restarted !== undefined) await restarted.close();
  await effectFixture.close();
}

function prepareFixture(workspacePath) {
  const result = run(process.execPath, [
    join(repositoryRoot, 'scripts', 'prepare-i5-checkpoint-replay-fixture.mjs'),
    workspacePath,
  ]);
  return JSON.parse(result.stdout);
}

async function submitMissionThroughWorkbench(browserClient, baseUrl, workspacePath) {
  const title = 'I5 real Checkpoint Replay source and future';
  const before = new Set(
    (await requestJson(`${baseUrl}/api/v1/missions`)).missions.map((mission) => mission.missionId),
  );
  const submitted = await browserClient.evaluate(`(() => {
    const form = document.querySelector('#mission-form');
    const submit = document.querySelector('#create-mission');
    if (!form || !submit || submit.disabled) return false;
    const setValue = (selector, value) => {
      const field = form.querySelector(selector);
      if (!field) throw new Error('Missing form field ' + selector);
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue('#mission-title', ${JSON.stringify(title)});
    setValue('#mission-objective', ${JSON.stringify(
      'Create only source.txt in the first Runtime and wait for the controlled boundary. After a MissionBraid Handoff Capsule, acknowledge it before tools, preserve source.txt, create final.txt exactly as AGENTS.md requires, and pass node verify.mjs.',
    )});
    setValue('#mission-workspace', ${JSON.stringify(workspacePath)});
    setValue('#verifier-executable', 'node');
    setValue('#verifier-args', 'verify.mjs');
    setValue('#codex-model', 'gpt-5.6-sol');
    setValue('#codex-reasoning', 'medium');
    setValue('#qoder-model', 'Qwen3.8-Max');
    setValue('#qoder-reasoning', 'medium');
    setValue('#claude-model', 'deepseek-v4-pro');
    setValue('#claude-reasoning', 'medium');
    const route = form.querySelector('#route-three-runtime');
    if (!route) throw new Error('Three Runtime route is missing.');
    route.checked = true;
    route.dispatchEvent(new Event('change', { bubbles: true }));
    form.requestSubmit();
    return true;
  })()`);
  if (!submitted) throw new Error('Workbench Mission form did not become ready.');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const missions = (await requestJson(`${baseUrl}/api/v1/missions`)).missions;
    const created = missions.find(
      (mission) => !before.has(mission.missionId) && mission.title === title,
    );
    if (created !== undefined) return created;
    await wait(200);
  }
  throw new Error('Workbench did not persist the Replay Mission in time.');
}

async function createRestorableCheckpointThroughWorkbench(
  browserClient,
  baseUrl,
  missionId,
  sourceAttemptId,
  priorIds,
) {
  const prior = new Set(priorIds);
  const deadline = Date.now() + 60_000;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    clicked = await browserClient.evaluate(`(() => {
      const button = document.querySelector('[data-create-checkpoint=${JSON.stringify(missionId)}]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) await wait(100);
  }
  if (!clicked) throw new Error('Workbench could not create the Replay Checkpoint.');
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    const checkpoint = detail.compositeCheckpoints.find(
      (candidate) =>
        !prior.has(candidate.checkpointId) &&
        candidate.source.attemptId === sourceAttemptId &&
        candidate.workspace?.state === 'restorable-artifact',
    );
    if (checkpoint !== undefined) return checkpoint;
    await wait(100);
  }
  throw new Error('Workbench did not persist a new restorable Composite Checkpoint.');
}

async function resumeMissionThroughWorkbench(browserClient, missionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const clicked = await browserClient.evaluate(`(() => {
      const view = document.querySelector('[data-continuity-workbench=${JSON.stringify(missionId)}]');
      if (!view) return false;
      const button = document.querySelector('.detail-actions .action-button');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (clicked) return;
    await wait(100);
  }
  throw new Error('Workbench did not expose the Mission Resume action.');
}

async function submitReplayThroughWorkbench(
  browserClient,
  checkpointId,
  mode,
  replacement = '',
  description = '',
) {
  const buttonIndex =
    mode === 'playback'
      ? 0
      : mode === 'cached-replay'
        ? 1
        : mode === 'counterfactual-resample'
          ? 2
          : -1;
  if (buttonIndex < 0) throw new Error(`Unsupported Replay mode ${mode}`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await browserClient.evaluate(`(() => {
      const card = document.querySelector('[data-checkpoint-id=${JSON.stringify(checkpointId)}]');
      const form = card?.querySelector('[data-checkpoint-replay-action=${JSON.stringify(checkpointId)}]');
      if (!form) return { clicked: false, status: 'Replay form unavailable' };
      const textareas = form.querySelectorAll('textarea');
      const buttons = form.querySelectorAll('.fork-action-row button');
      const button = buttons[${String(buttonIndex)}];
      if (!button || button.disabled || textareas.length !== 2) {
        return { clicked: false, status: form.textContent || '' };
      }
      textareas[0].value = ${JSON.stringify(replacement)};
      textareas[1].value = ${JSON.stringify(description)};
      for (const field of textareas) {
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
      button.click();
      return { clicked: true, status: form.textContent || '' };
    })()`);
    if (result.clicked) return;
    await wait(100);
  }
  throw new Error(`Workbench could not start ${mode}.`);
}

async function waitForWaitingMission(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    if (detail.operation?.phase === 'failed') {
      throw new Error(`Source Mission command failed: ${detail.operation.error ?? 'unknown'}`);
    }
    if (detail.mission.status === 'waiting' && detail.operation?.phase === 'completed')
      return detail;
    await wait(500);
  }
  throw new Error('Controlled source Mission did not reach a durable waiting state.');
}

async function waitForSucceededMission(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    if (detail.operation?.phase === 'failed') {
      throw new Error(`Resumed Mission command failed: ${detail.operation.error ?? 'unknown'}`);
    }
    if (detail.mission.status === 'succeeded' && detail.operation?.phase === 'completed')
      return detail;
    if (detail.mission.status === 'waiting' && detail.attempts.length > 1) {
      throw new Error(`Resumed Mission returned to waiting: ${stableJson(detail.attempts)}`);
    }
    await wait(500);
  }
  throw new Error('Real Qoder source-future continuation timed out.');
}

async function waitForReplayMode(baseUrl, missionId, mode, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    const record = detail.checkpointReplays.find((candidate) => candidate.mode === mode);
    if (record?.phase === 'failed' || record?.phase === 'unknown') {
      throw new Error(
        `${mode} ended as ${record.phase}: ${stableJson(record.failure ?? record.unknown)}`,
      );
    }
    if (record?.phase === 'completed') {
      if (mode !== 'playback') {
        const childBranchId = record.lineage.childBranchId;
        const projected =
          typeof childBranchId === 'string' &&
          detail.branches.some((branch) => branch.branchId === childBranchId) &&
          detail.timeline.some(
            (entry) =>
              entry.kind === 'checkpoint-replay.recorded' &&
              entry.data?.replayId === record.replayId,
          );
        if (!projected) {
          await wait(100);
          continue;
        }
      }
      return detail;
    }
    await wait(250);
  }
  throw new Error(`${mode} did not complete through the Workbench.`);
}

async function waitForReplayCards(browserClient, missionId, modes) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await browserClient.evaluate(`(() => {
      const zh = document.querySelector('[data-locale="zh-CN"]');
      if (zh && zh.getAttribute('aria-pressed') !== 'true') zh.click();
      const view = document.querySelector('[data-continuity-workbench=${JSON.stringify(missionId)}]');
      if (!view) return null;
      const cards = Array.from(view.querySelectorAll('[data-checkpoint-replay-id]')).map((card) => ({
        replayId: card.dataset.checkpointReplayId,
        text: card.textContent || '',
      }));
      return { cards, locale: document.documentElement.lang, text: view.textContent || '' };
    })()`);
    if (
      snapshot !== null &&
      snapshot.cards.length === modes.length &&
      modes.every((mode) => snapshot.cards.some((card) => card.text.includes(mode))) &&
      snapshot.locale === 'zh-CN'
    ) {
      return {
        locale: snapshot.locale,
        replayIds: snapshot.cards.map((card) => card.replayId).sort(),
        replayModesVisible: [...modes],
        recordCount: snapshot.cards.length,
      };
    }
    await wait(200);
  }
  throw new Error('Workbench did not render all three Replay records.');
}

function replayOf(detail, mode) {
  const record = detail.checkpointReplays.find((candidate) => candidate.mode === mode);
  if (record === undefined) throw new Error(`Missing ${mode} Replay record.`);
  return record;
}

function kernelSnapshot(detail) {
  return {
    eventCount: detail.eventCount,
    headHash: detail.mission.headHash,
    lastSeq: detail.mission.lastSeq,
    branchIds: detail.branches.map((branch) => branch.branchId).sort(),
  };
}

function runtimeEvidenceCounts(detail) {
  return {
    processStarted: detail.timeline.filter((entry) => entry.kind === 'runtime.process_started')
      .length,
    processFinished: detail.timeline.filter((entry) => entry.kind === 'runtime.process_finished')
      .length,
    runtimeEvents: detail.timeline.filter((entry) => entry.kind === 'runtime.event').length,
    toolFacts: semanticFacts(detail).filter((fact) =>
      ['tool_request', 'tool_result', 'tool_completion'].includes(fact.kind),
    ).length,
    effectEntries: detail.timeline.filter(
      (entry) => entry.kind === 'effect.recorded' || entry.kind === 'effect.status_changed',
    ).length,
  };
}

function assertNoLiveReplaySideEffects({
  label,
  detail,
  baselineCounts,
  baselineProviderSpawns,
  baselineWorkspace,
  providerLog: logFile,
  workspace: workspacePath,
  effectFixture: fixtureTarget,
  externalCallsAtCheckpoint: calls,
}) {
  if (
    stableJson(runtimeEvidenceCounts(detail)) !== stableJson(baselineCounts) ||
    providerSpawnCount(readProviderLog(logFile)) !== baselineProviderSpawns ||
    stableJson(gitSnapshot(workspacePath)) !== stableJson(baselineWorkspace) ||
    stableJson(fixtureTarget.calls()) !== stableJson(calls)
  ) {
    throw new Error(`${label} launched live execution or changed an external/workspace frontier.`);
  }
}

function assertNoKernelRuntimeOrWorkspaceSideEffects({
  label,
  detail,
  baselineCounts,
  baselineWorkspace,
  workspace: workspacePath,
  effectFixture: fixtureTarget,
  externalCallsAtCheckpoint: calls,
}) {
  if (
    stableJson(runtimeEvidenceCounts(detail)) !== stableJson(baselineCounts) ||
    stableJson(gitSnapshot(workspacePath)) !== stableJson(baselineWorkspace) ||
    stableJson(fixtureTarget.calls()) !== stableJson(calls)
  ) {
    throw new Error(`${label} added Kernel Runtime/tool/Effect evidence or changed the workspace.`);
  }
}

function replaySummary(records) {
  return records
    .map((record) => ({
      replayId: record.replayId,
      mode: record.mode,
      phase: record.phase,
      lineageId: record.lineage.lineageId,
      childBranchId: record.mode === 'playback' ? null : record.lineage.childBranchId,
      receiptInputId: record.receiptInput?.receiptInputId ?? null,
      eventHashes: record.events.map((event) => event.eventHash),
    }))
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function semanticFacts(detail) {
  return detail.timeline
    .filter((entry) => entry.kind === 'runtime.event')
    .flatMap((entry) =>
      Array.isArray(entry.data?.normalized?.semanticFacts)
        ? entry.data.normalized.semanticFacts
        : [],
    );
}

function artifactIds(root) {
  const ids = new Set();
  const artifactRoot = join(root, 'artifacts', 'sha256');
  if (!existsSync(artifactRoot)) return ids;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        const match = basename(entry.name).match(/^([a-f0-9]{64})\.(?:json|txt)$/);
        if (match?.[1] !== undefined) ids.add(`artifact-${match[1]}`);
      }
    }
  };
  visit(artifactRoot);
  return ids;
}

function providerRun(events, runtime, workspacePath) {
  const realWorkspace = realpathSync(workspacePath);
  const matching = events.filter(
    (event) => event.runtime === runtime && event.cwd === realWorkspace,
  );
  return {
    spawned: matching.find((event) => event.kind === 'provider.spawned'),
    deltaObserved: matching.find((event) => event.kind === 'provider.delta_observed'),
    controllerSealed: matching.find((event) => event.kind === 'provider.controller_sealed'),
    terminationRequested: matching.find((event) => event.kind === 'provider.termination_requested'),
    childExit: matching.find((event) => event.kind === 'provider.child_exit'),
  };
}

function providerSpawnCount(events) {
  return events.filter((event) => event.kind === 'provider.spawned').length;
}

function readProviderLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function hasFlag(args, flag) {
  return Array.isArray(args) && args.includes(flag);
}

function hasFlagValue(args, flag, value) {
  if (!Array.isArray(args)) return false;
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] === value;
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', flag: 'wx', mode: 0o700 });
  chmodSync(path, 0o700);
}

function controlledCodexProviderSource({
  realExecutable,
  controlledWorkspace,
  providerLog: logFile,
}) {
  return `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const runtime = 'codex';
const realExecutable = ${JSON.stringify(realExecutable)};
const controlledWorkspace = ${JSON.stringify(controlledWorkspace)};
const logFile = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
const append = (event) => appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), runtime, cwd, ...event }) + '\\n', 'utf8');
if (args.length === 1 && args[0] === '--version') {
  const probe = spawnSync(realExecutable, args, { cwd, env: process.env, encoding: 'utf8', shell: false });
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  append({ kind: 'provider.probe', status: probe.status, signal: probe.signal });
  process.exit(probe.status ?? 1);
}

const controlled = cwd === controlledWorkspace && args[0] === 'exec';
const child = spawn(realExecutable, args, {
  cwd,
  env: process.env,
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
append({ kind: 'provider.spawned', controlled, realExecutable, realPid: child.pid, args });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let exited = false;
let deltaObserved = false;
let controllerSealed = false;
let terminationRequested = false;
let sealTimer;
let terminateTimer;
let forceTimer;
const sourcePath = join(cwd, 'source.txt');
const monitor = controlled
  ? setInterval(() => {
      if (deltaObserved || !existsSync(sourcePath)) return;
      if (readFileSync(sourcePath, 'utf8') !== 'source-sealed\\n') return;
      deltaObserved = true;
      append({ kind: 'provider.delta_observed', path: 'source.txt', sourceSha256: 'sha256:${sha256('source-sealed\n')}' });
      sealTimer = setTimeout(() => {
        if (exited || controllerSealed) return;
        const add = spawnSync('git', ['-C', cwd, 'add', '--', 'source.txt'], { encoding: 'utf8', shell: false });
        const commit = add.status === 0
          ? spawnSync('git', ['-C', cwd, '-c', 'user.name=MissionBraid Proof Controller', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'controller seal source boundary', '--', 'source.txt'], { encoding: 'utf8', shell: false })
          : add;
        if (commit.status !== 0) {
          append({ kind: 'provider.controller_seal_failed', addStatus: add.status, commitStatus: commit.status, stderr: String(commit.stderr || '').slice(0, 400) });
          return;
        }
        const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false });
        const tree = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8', shell: false });
        controllerSealed = true;
        append({ kind: 'provider.controller_sealed', ownership: 'local-proof-controller-after-inspecting-exact-runtime-delta', changedPaths: ['source.txt'], head: head.stdout.trim(), tree: tree.stdout.trim() });
        terminateTimer = setTimeout(() => {
          if (exited || terminationRequested) return;
          terminationRequested = true;
          append({ kind: 'provider.termination_requested', signal: 'SIGTERM', reason: 'controlled-proof-boundary-after-controller-sealed-exact-delta' });
          try { process.kill(-child.pid, 'SIGTERM'); }
          catch { child.kill('SIGTERM'); }
          forceTimer = setTimeout(() => {
            if (exited) return;
            append({ kind: 'provider.force_termination_requested', signal: 'SIGKILL' });
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { child.kill('SIGKILL'); }
          }, 5_000);
        }, 500);
      }, 200);
    }, 10)
  : undefined;
monitor?.unref();

child.once('error', (error) => {
  append({ kind: 'provider.child_error', code: error.code ?? null, message: error.message });
});
child.once('exit', (code, signal) => {
  exited = true;
  if (monitor !== undefined) clearInterval(monitor);
  if (sealTimer !== undefined) clearTimeout(sealTimer);
  if (terminateTimer !== undefined) clearTimeout(terminateTimer);
  if (forceTimer !== undefined) clearTimeout(forceTimer);
  process.stdin.unpipe(child.stdin);
  child.stdin.destroy();
  const wrapperExitCode = controlled ? (terminationRequested && controllerSealed ? 86 : 87) : (code ?? 1);
  append({ kind: 'provider.child_exit', controlled, code, signal, deltaObserved, controllerSealed, terminationRequested, wrapperExitCode });
  process.exitCode = wrapperExitCode;
});
`;
}

function gatedProviderSource({ runtime, realExecutable, enabledMarker, providerLog: logFile }) {
  return `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';

const runtime = ${JSON.stringify(runtime)};
const realExecutable = ${JSON.stringify(realExecutable)};
const enabledMarker = ${JSON.stringify(enabledMarker)};
const logFile = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
const append = (event) => appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), runtime, cwd, ...event }) + '\\n', 'utf8');
const enabled = existsSync(enabledMarker);
if (args.length === 1 && args[0] === '--version') {
  if (!enabled) {
    append({ kind: 'provider.probe_blocked', status: 86, reason: 'proof-target-not-enabled' });
    process.stderr.write(runtime + ' proof target is not enabled\\n');
    process.exit(86);
  }
  const probe = spawnSync(realExecutable, args, { cwd, env: process.env, encoding: 'utf8', shell: false });
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  append({ kind: 'provider.probe', status: probe.status, signal: probe.signal });
  process.exit(probe.status ?? 1);
}
if (!enabled) {
  append({ kind: 'provider.run_blocked', status: 86, reason: 'proof-target-not-enabled', args });
  process.exit(86);
}
const child = spawn(realExecutable, args, {
  cwd,
  env: process.env,
  detached: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});
append({ kind: 'provider.spawned', realExecutable, realPid: child.pid, args });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error', (error) => {
  append({ kind: 'provider.child_error', code: error.code ?? null, message: error.message });
});
child.once('exit', (code, signal) => {
  process.stdin.unpipe(child.stdin);
  child.stdin.destroy();
  append({ kind: 'provider.child_exit', code, signal });
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;
}

async function startQueryableTarget() {
  const records = new Map();
  const calls = [];
  let postCount = 0;
  const server = createServer(async (request, response) => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url.startsWith('/effects/')) {
      const key = decodeURIComponent(url.slice('/effects/'.length));
      calls.push(`GET:${key}`);
      const receipt = records.get(key);
      if (receipt === undefined) return respondJson(response, 404, { status: 'absent' });
      return respondJson(response, 200, receipt);
    }
    if (request.method === 'POST' && url === '/effects') {
      const header = request.headers['idempotency-key'];
      const key = Array.isArray(header) ? header[0] : header;
      if (typeof key !== 'string' || key.length === 0) {
        return respondJson(response, 400, { detail: 'missing idempotency key' });
      }
      calls.push(`POST:${key}`);
      postCount += 1;
      const body = JSON.parse(await readBody(request));
      const receipt = records.get(key) ?? {
        idempotencyKey: key,
        recordId: `receipt-${String(records.size + 1)}`,
        body,
      };
      records.set(key, receipt);
      return respondJson(response, 201, receipt);
    }
    return respondJson(response, 404, { detail: 'not found' });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Target has no TCP address.');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls: () => [...calls],
    postCount: () => postCount,
    close: async () =>
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error === undefined ? resolveClose() : reject(error))),
      ),
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function respondJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function requestJson(url, options, expectedStatus = 200) {
  const requestOptions = options === undefined ? {} : { ...options };
  const headers = new Headers(requestOptions.headers ?? {});
  headers.set('Accept', 'application/json');
  if (requestOptions.body !== undefined) headers.set('Content-Type', 'application/json');
  requestOptions.headers = headers;
  const response = await fetch(url, requestOptions);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON ${String(response.status)}: ${text.slice(0, 800)}`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${String(response.status)}: ${text.slice(0, 800)}`);
  }
  return body;
}

function commandPath(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8', shell: false });
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`${command} is unavailable: ${result.stderr}`);
  }
  return realpathSync(result.stdout.trim());
}

function commandVersion(command) {
  const result = spawnSync(command, ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error(`${command} --version failed: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`.trim();
}

function gitSnapshot(worktree) {
  return {
    head: git(worktree, ['rev-parse', 'HEAD']),
    tree: git(worktree, ['rev-parse', 'HEAD^{tree}']),
    status: git(worktree, ['status', '--porcelain']).split('\n').filter(Boolean),
  };
}

function git(cwd, args) {
  return run('git', ['-C', cwd, ...args]).stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function progress(message) {
  process.stderr.write(`[iteration-5-replay] ${message}\n`);
}
