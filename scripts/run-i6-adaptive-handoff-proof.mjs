#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchHeadlessWorkbench, wait } from './headless-workbench.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
if (!existsSync(builtApp)) throw new Error('Run `pnpm build` before the Iteration 6 proof.');

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
if (outputFile !== undefined && existsSync(outputFile)) {
  throw new Error(`Refusing to overwrite ${outputFile}`);
}
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i6-adaptive-handoff-'));
const stateDir = join(proofRoot, 'state');
const successWorkspace = join(proofRoot, 'workspace-primary-success');
const adaptiveWorkspace = join(proofRoot, 'workspace-adaptive');
const providerLog = join(proofRoot, 'codex-provider.jsonl');
const successFixture = prepareFixture(successWorkspace, 'primary-success');
const adaptiveFixture = prepareFixture(adaptiveWorkspace, 'adaptive');
const realCodex = commandPath('codex');
const realQoder = commandPath('qodercli');
const realClaude = commandPath('claude');
const wrapper = join(proofRoot, 'codex-controlled-provider.mjs');
const wrapperSource = controlledCodexProviderSource({
  realCodex,
  adaptiveWorkspace: realpathSync(adaptiveWorkspace),
  providerLog,
});
writeFileSync(wrapper, wrapperSource, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
chmodSync(wrapper, 0o700);

const implementation = {
  revision: git(repositoryRoot, ['rev-parse', 'HEAD']),
  headTree: git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
  indexTree: git(repositoryRoot, ['write-tree']),
  dirtyBeforeRun: git(repositoryRoot, ['status', '--porcelain']).length > 0,
  nodeVersion: process.version,
};
const realVersions = {
  codex: commandVersion(realCodex),
  qoder: commandVersion(realQoder),
  claude: commandVersion(realClaude),
};

const { startMissionBraidApp } = await import('../dist/src/app.js');
const { MissionEngine } = await import('../dist/src/engine.js');
const { CodexAdapter } = await import('../dist/src/adapters/codex.js');
const { QoderAdapter } = await import('../dist/src/adapters/qoder.js');
const { ClaudeAdapter } = await import('../dist/src/adapters/claude.js');
const { planExecution } = await import('../dist/src/execution-planner.js');
const engineFactory = (directory) =>
  new MissionEngine({
    stateDir: directory,
    codexAdapter: new CodexAdapter({ command: wrapper }),
    qoderAdapter: new QoderAdapter({ command: realQoder }),
    claudeAdapter: new ClaudeAdapter({ command: realClaude }),
  });

let app;
let restarted;
let browser;
let restartBrowser;
try {
  app = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  browser = await launchHeadlessWorkbench(app.url, join(proofRoot, 'chrome-before-restart'));
  const inventoryResponse = await requestJson(`${app.url}/api/v1/runtimes`);
  const runtimeInventory = ['codex', 'qoder', 'claude'].map((id) => {
    const runtime = inventoryResponse.runtimes.find((candidate) => candidate.id === id);
    if (runtime?.status !== 'ready-supported') {
      throw new Error(`${id} is not execution-ready: ${runtime?.reason ?? 'not discovered'}`);
    }
    return runtime;
  });

  const successStartedAt = new Date();
  const successCreated = await submitMissionThroughWorkbench(browser, app.url, {
    title: 'I6 preferred Runtime succeeds without fallback',
    objective:
      'Follow AGENTS.md for PRIMARY-SUCCESS. Complete both exact marker files and pass node verify.mjs in the preferred Codex Runtime; the declared Qoder and Claude Profiles are fallback candidates only.',
    workspace: successWorkspace,
  });
  progress(`Preferred-success Mission ${successCreated.missionId} accepted through the browser`);
  const success = await waitForMission(app.url, successCreated.missionId, 20 * 60_000);
  const successEndedAt = new Date();
  assertVerified(success, 'Preferred-success Mission');
  if (
    success.attempts.length !== 1 ||
    success.attempts[0]?.harness !== 'codex' ||
    success.attempts[0]?.status !== 'succeeded'
  ) {
    throw new Error(`Preferred success started a fallback: ${stableJson(success.attempts)}`);
  }
  if (entries(success, 'execution-planner.decision').length !== 0) {
    throw new Error('Preferred success unexpectedly invoked the fallback planner.');
  }
  assertWorkspaceResult(successWorkspace, 'primary-complete\n');
  const successProvider = providerRun(readProviderLog(providerLog), successWorkspace);
  if (
    successProvider.spawned === undefined ||
    successProvider.terminationRequested !== undefined ||
    successProvider.childExit?.code !== 0 ||
    successProvider.childExit?.signal !== null
  ) {
    throw new Error(`Preferred Codex did not exit naturally: ${stableJson(successProvider)}`);
  }
  const successBrowser = await waitForBrowserReceipt(
    browser,
    successCreated.missionId,
    success.mission.receipt.receiptId,
  );

  const adaptiveStartedAt = new Date();
  const adaptiveCreated = await submitMissionThroughWorkbench(browser, app.url, {
    title: 'I6 automatic adaptive Handoff after controlled interruption',
    objective:
      'Follow AGENTS.md for ADAPTIVE. The first Runtime must create only source.txt and wait. If a MissionBraid Handoff Capsule is present, acknowledge it before any tool, preserve source.txt, create the exact final marker, and pass node verify.mjs.',
    workspace: adaptiveWorkspace,
  });
  progress(`Adaptive Mission ${adaptiveCreated.missionId} accepted through the browser`);
  const adaptive = await waitForMission(app.url, adaptiveCreated.missionId, 20 * 60_000);
  const adaptiveEndedAt = new Date();
  assertVerified(adaptive, 'Adaptive Handoff Mission');
  assertWorkspaceResult(adaptiveWorkspace, 'handoff-complete\n');
  if (
    adaptive.attempts.length !== 2 ||
    adaptive.attempts[0]?.harness !== 'codex' ||
    adaptive.attempts[0]?.status !== 'failed' ||
    !['qoder', 'claude'].includes(adaptive.attempts[1]?.harness) ||
    adaptive.attempts[1]?.status !== 'succeeded'
  ) {
    throw new Error(
      `Adaptive route did not finish in two Attempts: ${stableJson(adaptive.attempts)}`,
    );
  }

  const adaptiveProvider = providerRun(readProviderLog(providerLog), adaptiveWorkspace);
  if (
    adaptiveProvider.spawned === undefined ||
    adaptiveProvider.deltaObserved === undefined ||
    adaptiveProvider.terminationRequested === undefined ||
    adaptiveProvider.childExit?.signal !== 'SIGTERM' ||
    adaptiveProvider.childExit?.wrapperExitCode !== 86
  ) {
    throw new Error(
      `The controlled provider interruption is incomplete: ${stableJson(adaptiveProvider)}`,
    );
  }
  const adaptiveSnapshot = gitSnapshot(adaptiveWorkspace);
  if (
    adaptiveSnapshot.head !== adaptiveFixture.head ||
    stableJson(adaptiveSnapshot.status) !== stableJson(['?? final.txt', '?? source.txt'])
  ) {
    throw new Error(`Adaptive workspace frontier is not the expected two-file delta.`);
  }

  const plannerEntry = requireEntry(
    adaptive,
    'execution-planner.decision',
    'deterministic planner decision',
  );
  const planner = plannerEntry.data;
  const plannerInput = planner?.plannerInput;
  const decision = planner?.decision;
  if (plannerInput === undefined || decision === undefined) {
    throw new Error('Planner decision did not retain its input and output.');
  }
  const candidateHarnesses = plannerInput.candidates
    .map((candidate) => candidate.profile.harness)
    .sort();
  if (stableJson(candidateHarnesses) !== stableJson(['claude', 'qoder'])) {
    throw new Error(
      `Planner candidates are not Qoder and Claude: ${stableJson(candidateHarnesses)}`,
    );
  }
  if (
    !plannerInput.candidates.every(
      (candidate) =>
        candidate.observation.availability === 'ready' &&
        typeof candidate.profile.runtimeVersion === 'string',
    )
  ) {
    throw new Error('Planner candidates were not backed by fresh ready CLI observations.');
  }
  if (
    planner.manualOverrideRequest !== null ||
    decision.manualOverride?.status !== 'none' ||
    planner.trigger?.code !== 'DECLARED_HANDOFF_FAILURE' ||
    decision.binding?.action !== 'handoff' ||
    decision.binding?.selectedHarness !== adaptive.attempts[1].harness ||
    decision.binding?.selectedProfileId === null
  ) {
    throw new Error(`Planner did not make an automatic Handoff binding: ${stableJson(planner)}`);
  }
  const recomputedDecision = planExecution(plannerInput);
  if (
    recomputedDecision.decisionHash !== planner.decisionHash ||
    recomputedDecision.decisionHash !== decision.decisionHash
  ) {
    throw new Error('The persisted planner input does not reproduce the same decision hash.');
  }
  if (
    decision.filter?.candidates?.length !== 2 ||
    decision.rank?.length !== 2 ||
    decision.handoffCompatibility?.length !== 2
  ) {
    throw new Error('Planner filter, rank, or compatibility evidence is incomplete.');
  }

  const sourceAttempt = adaptive.attempts[0];
  const targetAttempt = adaptive.attempts[1];
  const checkpoint = adaptive.compositeCheckpoints.find(
    (candidate) => candidate.source?.attemptId === sourceAttempt.attemptId,
  );
  if (
    checkpoint === undefined ||
    checkpoint.checkpointId !== planner.sourceCompositeCheckpoint?.checkpointId ||
    checkpoint.workspace?.state !== 'digest-only' ||
    checkpoint.workspace?.workspaceDigest === null ||
    checkpoint.components?.length !== 12 ||
    checkpoint.components.find((component) => component.component === 'workspace')?.disposition !==
      'inspect-only'
  ) {
    throw new Error(
      'Planner Handoff is not bound to the complete digest-only Composite Checkpoint.',
    );
  }
  const prepared = requireEntry(adaptive, 'handoff.prepared', 'Handoff Capsule preparation');
  const acknowledged = requireEntry(
    adaptive,
    'handoff.acknowledged',
    'Handoff Capsule acknowledgement',
  );
  const targetProcess = entries(adaptive, 'runtime.process_finished').find(
    (entry) => entry.attemptId === targetAttempt.attemptId,
  );
  if (
    prepared.data?.checkpointId !== checkpoint.checkpointId ||
    prepared.data?.compositeCheckpointId !== checkpoint.checkpointId ||
    acknowledged.attemptId !== targetAttempt.attemptId ||
    acknowledged.data?.handoffOrderingEstablished !== true ||
    targetProcess?.data?.handoffOrderingEstablished !== true ||
    targetProcess?.data?.workspaceUnchangedAtAcknowledgement !== true ||
    typeof targetProcess?.data?.firstToolRequestRuntimeEventId !== 'string' ||
    !(prepared.seq < acknowledged.seq && acknowledged.seq < targetProcess.seq)
  ) {
    throw new Error('Target acknowledgement and first-action ordering are incomplete.');
  }
  const sourceFacts = semanticFacts(adaptive, sourceAttempt.attemptId);
  const targetFacts = semanticFacts(adaptive, targetAttempt.attemptId);
  if (!sourceFacts.some((fact) => fact.kind === 'tool_request')) {
    throw new Error('Interrupted Codex exposed no real native tool request.');
  }
  if (!targetFacts.some((fact) => fact.kind === 'tool_request')) {
    throw new Error('Selected native target exposed no real native tool request.');
  }
  const sourceEffectRecorded = entries(adaptive, 'effect.recorded').find(
    (entry) => entry.attemptId === sourceAttempt.attemptId,
  );
  const sourceEffect = adaptive.mission.receipt.effects?.find(
    (effect) => effect.effectId === sourceEffectRecorded?.data?.effectId,
  );
  if (sourceEffect?.status !== 'confirmed') {
    throw new Error('The real source workspace delta is not a confirmed Effect.');
  }
  const targetPrompt = await controllerPrompt(app.url, adaptive, targetAttempt.attemptId);
  if (!targetPrompt.content.includes(sourceEffect.effectId)) {
    throw new Error('The target Capsule did not carry the confirmed source Effect as no-repeat.');
  }

  const plannerBrowser = await waitForBrowserPlanner(browser, adaptiveCreated.missionId, {
    decisionHash: planner.decisionHash,
    checkpointId: checkpoint.checkpointId,
    trigger: planner.trigger.code,
    selectedHarness: decision.binding.selectedHarness,
    policyVersion: planner.policyVersion,
    receiptId: adaptive.mission.receipt.receiptId,
  });
  const finalAdaptiveHead = adaptive.mission.headHash;
  const finalAdaptiveReceipt = adaptive.mission.receipt.receiptId;
  const finalSuccessHead = success.mission.headHash;
  const finalSuccessReceipt = success.mission.receipt.receiptId;
  const providerCallsBeforeRestart = readProviderLog(providerLog);

  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;
  restarted = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const restoredSuccess = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(successCreated.missionId)}`,
  );
  const restoredAdaptive = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(adaptiveCreated.missionId)}`,
  );
  if (
    restoredSuccess.mission.headHash !== finalSuccessHead ||
    restoredSuccess.mission.receipt?.receiptId !== finalSuccessReceipt ||
    restoredSuccess.attempts.length !== 1 ||
    restoredAdaptive.mission.headHash !== finalAdaptiveHead ||
    restoredAdaptive.mission.receipt?.receiptId !== finalAdaptiveReceipt ||
    restoredAdaptive.compositeCheckpoints.find(
      (candidate) => candidate.checkpointId === checkpoint.checkpointId,
    ) === undefined ||
    requireEntry(restoredAdaptive, 'execution-planner.decision', 'restored planner decision').data
      ?.decisionHash !== planner.decisionHash
  ) {
    throw new Error('Mission, planner, Checkpoint, or Receipt evidence changed after restart.');
  }
  restartBrowser = await launchHeadlessWorkbench(
    restarted.url,
    join(proofRoot, 'chrome-after-restart'),
  );
  const restartPlannerBrowser = await waitForBrowserPlanner(
    restartBrowser,
    adaptiveCreated.missionId,
    {
      decisionHash: planner.decisionHash,
      checkpointId: checkpoint.checkpointId,
      trigger: planner.trigger.code,
      selectedHarness: decision.binding.selectedHarness,
      policyVersion: planner.policyVersion,
      receiptId: finalAdaptiveReceipt,
    },
  );
  const providerCallsAfterRestart = readProviderLog(providerLog);
  if (
    providerCallsAfterRestart.filter((event) => event.kind === 'provider.spawned').length !==
    providerCallsBeforeRestart.filter((event) => event.kind === 'provider.spawned').length
  ) {
    throw new Error('Restart unexpectedly launched another Runtime process.');
  }

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-6-adaptive-handoff/v1',
    evidenceLevel: 'same-host-local-real-native-runtime-browser-controlled-provider-interruption',
    recordedOn: shanghaiDate(new Date()),
    implementation,
    fixture: {
      source: 'examples/i6-adaptive-handoff-fixture/template',
      preparer: 'scripts/prepare-i6-adaptive-handoff-fixture.mjs',
      primarySuccess: successFixture,
      adaptive: adaptiveFixture,
    },
    productEntry: {
      entry: 'built local Workbench browser form and versioned Mission detail API',
      missionsCreatedThroughBrowser: true,
      userSelectedReplacement: false,
      manualPlannerOverride: false,
      manualContextCopy: false,
      declaredRoute: ['codex', 'qoder', 'claude'],
    },
    runtimeInventory: runtimeInventory.map((runtime) => ({
      id: runtime.id,
      status: runtime.status,
      version: runtime.version,
      source: runtime.source,
      model:
        runtime.id === 'codex'
          ? 'gpt-5.6-sol'
          : runtime.id === 'qoder'
            ? 'Qwen3.8-Max'
            : 'deepseek-v4-pro',
      reasoningEffort: 'medium',
    })),
    realRuntimeVersions: realVersions,
    preferredSuccess: {
      missionId: successCreated.missionId,
      commandId: successCreated.commandId,
      receiptId: finalSuccessReceipt,
      finalHeadHash: finalSuccessHead,
      elapsedSeconds: elapsedSeconds(successStartedAt, successEndedAt),
      attempts: success.attempts,
      plannerDecisionCount: 0,
      fallbackAttemptsStarted: 0,
      workspace: gitSnapshot(successWorkspace),
      providerExit: successProvider.childExit,
      browser: successBrowser,
    },
    adaptiveHandoff: {
      missionId: adaptiveCreated.missionId,
      commandId: adaptiveCreated.commandId,
      receiptId: finalAdaptiveReceipt,
      contractId: adaptive.mission.contract.contractId,
      finalHeadHash: finalAdaptiveHead,
      elapsedSeconds: elapsedSeconds(adaptiveStartedAt, adaptiveEndedAt),
      attempts: adaptive.attempts,
      controlledProviderInterruption: {
        boundary: 'proof-runtime-provider-wrapper',
        wrapperSourceSha256: sha256(wrapperSource),
        realExecutable: realCodex,
        realRuntimeVersion: realVersions.codex,
        spawned: adaptiveProvider.spawned,
        deltaObserved: adaptiveProvider.deltaObserved,
        terminationRequested: adaptiveProvider.terminationRequested,
        childExit: adaptiveProvider.childExit,
        sourceSemanticFactKinds: uniqueStrings(sourceFacts.map((fact) => fact.kind)),
        representation:
          'The proof provider deliberately terminated the real Codex process after observing the exact source.txt delta; this is not presented as a natural provider failure.',
      },
      sourceWorkspaceDelta: adaptiveSnapshot,
      planner: {
        trigger: planner.trigger,
        policyVersion: planner.policyVersion,
        decisionHash: planner.decisionHash,
        recomputedDecisionHash: recomputedDecision.decisionHash,
        requirements: decision.extracted.requirements,
        candidates: decision.extracted.candidates,
        filter: decision.filter,
        rank: decision.rank,
        compatibility: decision.handoffCompatibility,
        binding: decision.binding,
        manualOverride: decision.manualOverride,
        sourceCompositeCheckpoint: planner.sourceCompositeCheckpoint,
      },
      compositeCheckpoint: {
        checkpointId: checkpoint.checkpointId,
        manifestHash: checkpoint.manifestHash,
        source: checkpoint.source,
        eventPrefix: checkpoint.eventPrefix,
        workspace: checkpoint.workspace,
        componentDispositions: checkpoint.components.map((component) => ({
          component: component.component,
          disposition: component.disposition,
        })),
      },
      selectedRuntime: {
        harness: targetAttempt.harness,
        attemptId: targetAttempt.attemptId,
        requestedModel: targetAttempt.harness === 'qoder' ? 'Qwen3.8-Max' : 'deepseek-v4-pro',
        runtimeVersion: plannerInput.candidates.find(
          (candidate) => candidate.profile.harness === targetAttempt.harness,
        )?.profile.runtimeVersion,
        semanticFactKinds: uniqueStrings(targetFacts.map((fact) => fact.kind)),
      },
      handoff: {
        preparedSeq: prepared.seq,
        acknowledgedSeq: acknowledged.seq,
        targetFinishedSeq: targetProcess.seq,
        capsuleId: prepared.data.capsuleId,
        checkpointId: prepared.data.checkpointId,
        acknowledgementId: acknowledged.data.acknowledgementId,
        orderingEstablished: acknowledged.data.handoffOrderingEstablished,
        workspaceUnchangedAtAcknowledgement: targetProcess.data.workspaceUnchangedAtAcknowledgement,
        firstToolRequestRuntimeEventId: targetProcess.data.firstToolRequestRuntimeEventId,
      },
      confirmedSourceEffectNoRepeat: {
        effectId: sourceEffect.effectId,
        status: sourceEffect.status,
        carriedInTargetCapsule: true,
      },
      browserBeforeRestart: plannerBrowser,
      browserAfterRestart: restartPlannerBrowser,
    },
    restartRecovery: {
      samePreferredMissionHeadAndReceipt: true,
      sameAdaptiveMissionHeadAndReceipt: true,
      samePlannerDecisionHash: true,
      sameCompositeCheckpoint: true,
      runtimeProcessesAdded: 0,
    },
    claimBoundary:
      'This is same-host local evidence through the built MissionBraid Workbench. A real Codex 0.149.x process first completed a preferred Mission without launching either declared fallback. In the adaptive Mission, a separately recorded proof runtime-provider wrapper terminated a real Codex process only after it produced the exact source workspace delta; this is a controlled provider interruption, not a natural Codex, model, quota, or network failure. MissionBraid captured that frontier as a complete 12-component Composite Checkpoint whose workspace component is digest-only and inspect-only, deterministically filtered and ranked fresh local Qoder and Claude CLI Profile observations without a user choice or manual override, bound one native target, projected a semantic Handoff Capsule, required its acknowledgement before the first tool request, preserved the confirmed source Effect as no-repeat, passed the immutable verifier, issued a verified Receipt, rendered the decision in the browser, and reconstructed it after restart. It does not prove a restorable Handoff workspace, native session migration, native session resume, cross-host continuity, production reliability, independent reproduction, or that unselected CLI probes establish authenticated model access or remaining quota.',
    proofRoot,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputFile === undefined) process.stdout.write(serialized);
  else writeFileSync(outputFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  progress('Iteration 6 real adaptive Handoff evidence complete');
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (restartBrowser !== undefined) await restartBrowser.close().catch(() => undefined);
  if (app !== undefined) await app.close();
  if (restarted !== undefined) await restarted.close();
}

function prepareFixture(workspace, mode) {
  const result = run(process.execPath, [
    join(repositoryRoot, 'scripts', 'prepare-i6-adaptive-handoff-fixture.mjs'),
    workspace,
    mode,
  ]);
  return JSON.parse(result.stdout);
}

async function submitMissionThroughWorkbench(browserClient, baseUrl, input) {
  const before = new Set(
    (await requestJson(`${baseUrl}/api/v1/missions`)).missions.map((mission) => mission.missionId),
  );
  const deadline = Date.now() + 30_000;
  let submitted = false;
  while (Date.now() < deadline && !submitted) {
    submitted = await browserClient.evaluate(`(() => {
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
      setValue('#mission-title', ${JSON.stringify(input.title)});
      setValue('#mission-objective', ${JSON.stringify(input.objective)});
      setValue('#mission-workspace', ${JSON.stringify(input.workspace)});
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
    if (!submitted) await wait(100);
  }
  if (!submitted) throw new Error('Workbench Mission form did not become ready.');

  const acceptedDeadline = Date.now() + 60_000;
  while (Date.now() < acceptedDeadline) {
    const missions = (await requestJson(`${baseUrl}/api/v1/missions`)).missions;
    const created = missions.find(
      (mission) => !before.has(mission.missionId) && mission.title === input.title,
    );
    if (created !== undefined) {
      return {
        missionId: created.missionId,
        commandId: created.operation?.commandId ?? null,
      };
    }
    const formStatus = await browserClient.evaluate(
      `document.querySelector('#form-status')?.textContent || ''`,
    );
    if (/failed|error|cannot|invalid|not ready/i.test(formStatus)) {
      throw new Error(`Workbench Mission submission failed: ${formStatus}`);
    }
    await wait(200);
  }
  throw new Error('Workbench did not persist the submitted Mission in time.');
}

async function waitForMission(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    const phase = detail.operation?.phase ?? detail.mission.status;
    if (phase === 'completed' || phase === 'failed') return detail;
    await wait(500);
  }
  throw new Error(`Mission ${missionId} timed out.`);
}

function assertVerified(detail, label) {
  if (
    detail.mission.status !== 'succeeded' ||
    detail.mission.receipt?.outcome !== 'verified' ||
    detail.chainValid !== true
  ) {
    throw new Error(
      `${label} did not reach a verified Receipt: ${stableJson({
        mission: detail.mission,
        operation: detail.operation,
        attempts: detail.attempts,
      })}`,
    );
  }
}

function assertWorkspaceResult(workspace, expectedFinal) {
  if (
    readFileSync(join(workspace, 'source.txt'), 'utf8') !== 'codex-source\n' ||
    readFileSync(join(workspace, 'final.txt'), 'utf8') !== expectedFinal
  ) {
    throw new Error(`Workspace ${workspace} does not contain the expected result.`);
  }
}

async function waitForBrowserReceipt(browserClient, missionId, receiptId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await browserClient.evaluate(`(() => {
      const button = document.querySelector('[data-mission-id=${JSON.stringify(missionId)}]');
      if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
      const view = document.querySelector('[data-continuity-workbench=${JSON.stringify(missionId)}]');
      return view ? { text: view.textContent || '', planner: Boolean(view.querySelector('[data-execution-planner="true"]')) } : null;
    })()`);
    if (snapshot?.text.includes(receiptId)) {
      return {
        receiptVisible: true,
        plannerDecisionVisible: snapshot.text.includes('decision-'),
      };
    }
    await wait(200);
  }
  throw new Error(`Workbench did not render Receipt ${receiptId}.`);
}

async function waitForBrowserPlanner(browserClient, missionId, expected) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await browserClient.evaluate(`(() => {
      const zh = document.querySelector('[data-locale="zh-CN"]');
      if (zh && zh.getAttribute('aria-pressed') !== 'true') zh.click();
      const button = document.querySelector('[data-mission-id=${JSON.stringify(missionId)}]');
      if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
      const view = document.querySelector('[data-continuity-workbench=${JSON.stringify(missionId)}]');
      const section = document.querySelector('[data-execution-planner="true"]');
      const detail = document.querySelector('#mission-detail');
      if (!view || !section) return null;
      return {
        locale: document.documentElement.lang,
        text: section.textContent || '',
        missionText: detail?.textContent || '',
        facts: Array.from(section.querySelectorAll('.intelligence-fact')).map((item) => ({
          label: item.querySelector('dt')?.textContent || '',
          value: item.querySelector('dd')?.textContent || '',
        })),
      };
    })()`);
    if (
      snapshot !== null &&
      snapshot.locale === 'zh-CN' &&
      snapshot.text.includes(expected.decisionHash) &&
      snapshot.text.includes(expected.checkpointId) &&
      snapshot.text.includes(expected.trigger) &&
      snapshot.text.includes(expected.selectedHarness) &&
      snapshot.text.includes(expected.policyVersion) &&
      snapshot.missionText.includes(expected.receiptId)
    ) {
      const values = snapshot.facts.map((fact) => fact.value).join('\n');
      if (!values.includes(expected.decisionHash) || !values.includes(expected.checkpointId)) {
        throw new Error('Planner values are not present in the structured Workbench facts.');
      }
      return {
        locale: snapshot.locale,
        triggerVisible: true,
        filterVisible: snapshot.facts.some((fact) =>
          /Profile|\u5019\u9009|\u53ef\u7528|\u8fc7\u6ee4/.test(fact.label),
        ),
        rankedSelectionVisible: snapshot.text.includes(expected.selectedHarness),
        rankVectorVisible: false,
        compatibilityVisible: snapshot.facts.some((fact) =>
          /compatibility|\u517c\u5bb9/.test(fact.label),
        ),
        decisionHashVisible: true,
        sourceCompositeCheckpointVisible: true,
        selectedHarnessVisible: true,
        receiptVisible: true,
        facts: snapshot.facts,
      };
    }
    await wait(200);
  }
  throw new Error('Workbench did not render the complete adaptive planner decision.');
}

async function controllerPrompt(baseUrl, detail, attemptId) {
  const entry = entries(detail, 'context.controller_prompt').find(
    (candidate) => candidate.attemptId === attemptId,
  );
  const artifactId = entry?.data?.nativeArtifact?.artifactId;
  if (typeof artifactId !== 'string')
    throw new Error('Target controller prompt artifact is absent.');
  return await requestJson(`${baseUrl}/api/v1/artifacts/${encodeURIComponent(artifactId)}`);
}

function requireEntry(detail, kind, description) {
  const entry = entries(detail, kind)[0];
  if (entry === undefined) throw new Error(`Missing ${description}.`);
  return entry;
}

function entries(detail, kind) {
  return detail.timeline.filter((entry) => entry.kind === kind);
}

function semanticFacts(detail, attemptId) {
  return detail.timeline
    .filter((entry) => entry.kind === 'runtime.event' && entry.attemptId === attemptId)
    .flatMap((entry) =>
      Array.isArray(entry.data?.normalized?.semanticFacts)
        ? entry.data.normalized.semanticFacts
        : [],
    );
}

function providerRun(events, workspace) {
  const normalized = realpathSync(workspace);
  const matching = events.filter((event) => event.workspace === normalized && event.run === true);
  return {
    spawned: matching.find((event) => event.kind === 'provider.spawned'),
    deltaObserved: matching.find((event) => event.kind === 'provider.delta_observed'),
    terminationRequested: matching.find((event) => event.kind === 'provider.termination_requested'),
    childExit: matching.find((event) => event.kind === 'provider.child_exit'),
  };
}

function readProviderLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function controlledCodexProviderSource({ realCodex, adaptiveWorkspace, providerLog }) {
  return `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';

const realExecutable = ${JSON.stringify(realCodex)};
const controlledWorkspace = ${JSON.stringify(adaptiveWorkspace)};
const logFile = ${JSON.stringify(providerLog)};
const args = process.argv.slice(2);
const workspace = realpathSync(process.cwd());
const append = (event) => appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), workspace, ...event }) + '\\n', 'utf8');
if (args.length === 1 && args[0] === '--version') {
  const probe = spawnSync(realExecutable, args, { cwd: workspace, env: process.env, encoding: 'utf8', shell: false });
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  append({ kind: 'provider.probe', run: false, status: probe.status, signal: probe.signal });
  process.exit(probe.status ?? 1);
}

const controlled = workspace === controlledWorkspace && args[0] === 'exec';
const child = spawn(realExecutable, args, {
  cwd: workspace,
  env: process.env,
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
append({ kind: 'provider.spawned', run: true, controlled, realExecutable, realPid: child.pid, args });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let exited = false;
let deltaObserved = false;
let terminationRequested = false;
let forceTimer;
const sourceFile = new URL('file://' + workspace.replaceAll('%', '%25').replaceAll(' ', '%20') + '/source.txt');
const monitor = controlled
  ? setInterval(() => {
      if (deltaObserved || !existsSync(sourceFile)) return;
      if (readFileSync(sourceFile, 'utf8') !== 'codex-source\\n') return;
      deltaObserved = true;
      append({ kind: 'provider.delta_observed', run: true, sourcePath: 'source.txt', sourceSha256: 'sha256:${sha256('codex-source\n')}' });
      setTimeout(() => {
        if (exited || terminationRequested) return;
        terminationRequested = true;
        append({ kind: 'provider.termination_requested', run: true, signal: 'SIGTERM', reason: 'controlled-proof-boundary-after-exact-source-delta' });
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { child.kill('SIGTERM'); }
        forceTimer = setTimeout(() => {
          if (exited) return;
          append({ kind: 'provider.force_termination_requested', run: true, signal: 'SIGKILL' });
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }, 5_000);
      }, 350);
    }, 10)
  : undefined;
monitor?.unref();

child.once('error', (error) => {
  append({ kind: 'provider.child_error', run: true, code: error.code ?? null, message: error.message });
});
child.once('exit', (code, signal) => {
  exited = true;
  if (monitor !== undefined) clearInterval(monitor);
  if (forceTimer !== undefined) clearTimeout(forceTimer);
  process.stdin.unpipe(child.stdin);
  child.stdin.destroy();
  const wrapperExitCode = controlled ? (terminationRequested ? 86 : 87) : (code ?? 1);
  append({ kind: 'provider.child_exit', run: true, controlled, code, signal, deltaObserved, terminationRequested, wrapperExitCode });
  process.exitCode = wrapperExitCode;
});
`;
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

function gitSnapshot(workspace) {
  return {
    head: git(workspace, ['rev-parse', 'HEAD']),
    tree: git(workspace, ['rev-parse', 'HEAD^{tree}']),
    status: git(workspace, ['status', '--porcelain']).split('\n').filter(Boolean),
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

async function requestJson(url, options, expectedStatus = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = JSON.parse(text);
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${String(response.status)}: ${text.slice(0, 800)}`);
  }
  return body;
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

function uniqueStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en'));
}

function elapsedSeconds(start, end) {
  return Number(((end.getTime() - start.getTime()) / 1_000).toFixed(3));
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(value)
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function progress(message) {
  process.stderr.write(`[iteration-6] ${message}\n`);
}
