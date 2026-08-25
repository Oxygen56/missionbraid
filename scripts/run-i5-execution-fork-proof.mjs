#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchHeadlessWorkbench, wait } from './headless-workbench.mjs';
import { createQueryableHttpEffectTarget } from './queryable-http-effect-target.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
if (!existsSync(builtApp)) throw new Error('Run `pnpm build` before the Iteration 5 proof.');

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i5-execution-fork-'));
const stateDir = join(proofRoot, 'state');
const workspace = join(proofRoot, 'workspace-a');
run(process.execPath, [join(repositoryRoot, 'scripts', 'prepare-i5-fixture.mjs'), workspace]);

const sourceInitial = gitSnapshot(workspace);
const implementation = {
  revision: git(repositoryRoot, ['rev-parse', 'HEAD']),
  headTree: git(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
  indexTree: git(repositoryRoot, ['write-tree']),
  dirtyBeforeRun: git(repositoryRoot, ['status', '--porcelain']).length > 0,
  nodeVersion: process.version,
};
const effectFixture = await startQueryableTarget();
const targetId = 'iteration-5-queryable-target';
const target = createQueryableHttpEffectTarget(effectFixture.url, targetId);
const { startMissionBraidApp } = await import('../dist/src/app.js');
const { MissionEngine } = await import('../dist/src/engine.js');
const engineFactory = (directory) =>
  new MissionEngine({ stateDir: directory, externalEffectTargets: [target] });

let app;
let restarted;
let browser;
let restartBrowser;
try {
  app = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const runtime = inventory.runtimes.find((candidate) => candidate.id === 'codex');
  if (runtime?.status !== 'ready-supported') {
    throw new Error(`Codex is not execution-ready: ${runtime?.reason ?? 'missing'}`);
  }

  const created = await requestJson(
    `${app.url}/api/v1/missions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(missionInput(workspace)),
    },
    202,
  );
  progress(`Parent Mission ${created.missionId} accepted`);
  const parent = await waitForMission(app.url, created.missionId, 20 * 60_000);
  if (parent.mission.status !== 'succeeded' || parent.mission.receipt?.outcome !== 'verified') {
    throw new Error('The real Codex parent Mission did not reach a verified Receipt.');
  }
  const parentReceipt = parent.mission.receipt;
  const parentAttemptId = parentReceipt.attemptIds?.[0];
  if (typeof parentAttemptId !== 'string') throw new Error('Parent Receipt has no Attempt.');
  const sourceAfterRuntime = gitSnapshot(workspace);
  if (
    sourceAfterRuntime.head !== sourceInitial.head ||
    sourceAfterRuntime.status.length !== 1 ||
    !sourceAfterRuntime.status[0].endsWith('mode.txt') ||
    readFileSync(join(workspace, 'mode.txt'), 'utf8') !== 'PARENT\n'
  ) {
    throw new Error('The parent Harness did not produce exactly the expected PARENT delta.');
  }
  const parentFacts = semanticFacts(parent);
  if (!parentFacts.some((fact) => fact.kind === 'tool_request')) {
    throw new Error('The parent Mission exposed no real native tool request.');
  }
  run('git', ['-C', workspace, 'add', '--', 'mode.txt']);
  run('git', [
    '-C',
    workspace,
    '-c',
    'user.name=MissionBraid',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'complete parent boundary',
  ]);
  const sourceAfterParent = gitSnapshot(workspace);
  if (sourceAfterParent.head === sourceInitial.head || sourceAfterParent.status.length > 0) {
    throw new Error('The local proof controller did not seal a clean parent Git boundary.');
  }

  const effectId = 'effect-iteration-5-inherited-no-repeat';
  const idempotencyKey = 'iteration-5-create-once';
  const effectPayload = { operation: 'create', value: 'Execution Fork inheritance proof' };
  const coordinated = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: parentAttemptId,
        targetId,
        kind: 'record.create',
        resourceKey: 'record:iteration-5',
        authorityRef: 'grant:iteration-5-local-proof',
        idempotencyKey,
        payloadDigest: sha256(stableJson(effectPayload)),
        payload: effectPayload,
      }),
    },
  );
  if (coordinated.outcome?.status !== 'confirmed' || effectFixture.postCount() !== 1) {
    throw new Error('The inherited external Effect was not confirmed exactly once.');
  }
  const targetCallsBeforeFork = effectFixture.calls();

  browser = await launchHeadlessWorkbench(app.url, join(proofRoot, 'chrome-before-restart'));
  await waitForBrowserMission(browser, created.missionId);
  const checkpointClick = await browser.evaluate(`(() => {
    const button = document.querySelector('[data-create-checkpoint="${created.missionId}"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!checkpointClick) throw new Error('Workbench could not create the Composite Checkpoint.');
  const checkpointDetail = await waitForCheckpoint(app.url, created.missionId);
  const checkpoint = checkpointDetail.compositeCheckpoints[0];
  if (
    checkpoint.workspace?.state !== 'restorable-artifact' ||
    checkpoint.workspace?.artifactRef !== `git-commit:${sourceAfterParent.head}` ||
    checkpoint.workspace?.artifactDigest !== `git-tree:${sourceAfterParent.tree}`
  ) {
    throw new Error('Composite Checkpoint is not bound to the clean parent commit and tree.');
  }

  const interventionDescription =
    'Change only mode.txt from exactly PARENT to exactly FORK-GUIDANCE, run node verify.mjs, and leave the Branch B change uncommitted so its isolated delta remains visible.';
  const intervention = {
    kind: 'guidance',
    targetRef: 'stage:codex-parent-and-fork',
    afterDigest: `sha256:${sha256(interventionDescription)}`,
    description: interventionDescription,
    authorityChange: 'unchanged',
  };
  const browserSubmission = await submitForkInBrowser(
    browser,
    checkpoint.checkpointId,
    intervention,
  );
  if (!browserSubmission.clicked) {
    throw new Error(`Workbench could not submit the Execution Fork: ${browserSubmission.text}`);
  }
  if (
    browserSubmission.modeStates.find((mode) => mode.id === 'execution-fork')?.disabled !== false ||
    browserSubmission.modeStates
      .filter((mode) => mode.id !== 'execution-fork')
      .some((mode) => mode.disabled !== true)
  ) {
    throw new Error('Workbench did not keep the four checkpoint operation boundaries distinct.');
  }

  const completed = await waitForExecutionFork(app.url, created.missionId, 20 * 60_000);
  const fork = completed.executionForks[0];
  if (
    fork.phase !== 'finished' ||
    fork.runtimeResult?.status !== 'completed' ||
    completed.mission.receipt?.outcome !== 'verified' ||
    completed.mission.receipt?.branchId !== fork.lineage.childBranchId
  ) {
    throw new Error(
      `Execution Fork did not finish with a child Branch Receipt: ${stableJson(fork)}`,
    );
  }
  const sourceAfterFork = gitSnapshot(workspace);
  if (stableJson(sourceAfterFork) !== stableJson(sourceAfterParent)) {
    throw new Error('Branch A changed while the real Branch B Runtime executed.');
  }
  const isolatedWorkspace = fork.lineage.isolatedWorktreePath;
  const childSnapshot = gitSnapshot(isolatedWorkspace);
  if (
    childSnapshot.head !== sourceAfterParent.head ||
    !childSnapshot.status.some((line) => line.endsWith('mode.txt')) ||
    readFileSync(join(isolatedWorkspace, 'mode.txt'), 'utf8') !== 'FORK-GUIDANCE\n'
  ) {
    throw new Error('Branch B does not contain the expected isolated one-file guidance delta.');
  }
  if (
    fork.lineage.inheritedExternalEffectFrontier.find((effect) => effect.effectId === effectId)
      ?.status !== 'confirmed' ||
    fork.lineage.externalEffectDecisions.find((decision) => decision.effectId === effectId)
      ?.action !== 'inherit-no-repeat' ||
    effectFixture.postCount() !== 1 ||
    stableJson(effectFixture.calls()) !== stableJson(targetCallsBeforeFork)
  ) {
    throw new Error('The confirmed external Effect was not inherited as no-repeat.');
  }

  const order = executionForkOrder(completed, fork);
  assertStrictlyIncreasing(Object.values(order), 'Execution Fork Kernel event order');
  const timing = executionTiming(completed);
  const rootBranch = completed.branches.find((branch) => branch.parentBranchId === undefined);
  const childBranch = completed.branches.find(
    (branch) => branch.branchId === fork.lineage.childBranchId,
  );
  if (
    rootBranch === undefined ||
    childBranch?.parentBranchId !== rootBranch.branchId ||
    childBranch.baseCheckpointId !== checkpoint.checkpointId
  ) {
    throw new Error('Kernel Branch A/B lineage is incomplete.');
  }

  const browserFinal = await waitForBrowserFork(
    browser,
    created.missionId,
    checkpoint.checkpointId,
    fork.forkId,
    [rootBranch.branchId, childBranch.branchId],
    completed.mission.receipt.receiptId,
  );
  await browser.close();
  browser = undefined;
  const finalHead = completed.mission.headHash;
  const childReceiptId = completed.mission.receipt.receiptId;
  await app.close();
  app = undefined;

  restarted = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const restored = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  if (
    restored.mission.headHash !== finalHead ||
    restored.mission.receipt?.receiptId !== childReceiptId ||
    restored.mission.receipt?.branchId !== childBranch.branchId ||
    restored.branches.length !== 2 ||
    restored.compositeCheckpoints[0]?.checkpointId !== checkpoint.checkpointId ||
    restored.executionForks[0]?.forkId !== fork.forkId ||
    restored.executionForks[0]?.phase !== 'finished' ||
    effectFixture.postCount() !== 1 ||
    stableJson(effectFixture.calls()) !== stableJson(targetCallsBeforeFork)
  ) {
    throw new Error(
      'Checkpoint, Branches, Fork, Receipt, or Effect evidence changed after restart.',
    );
  }
  restartBrowser = await launchHeadlessWorkbench(
    restarted.url,
    join(proofRoot, 'chrome-after-restart'),
  );
  const browserRestart = await waitForBrowserFork(
    restartBrowser,
    created.missionId,
    checkpoint.checkpointId,
    fork.forkId,
    [rootBranch.branchId, childBranch.branchId],
    childReceiptId,
  );
  await restartBrowser.close();
  restartBrowser = undefined;

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-5-execution-fork/v1',
    evidenceLevel: 'same-host-local-real-native-runtime-browser-and-git-worktree',
    recordedOn: new Date().toISOString().slice(0, 10),
    implementation,
    runtime: {
      harness: 'codex',
      version: runtime.version,
      source: runtime.source,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    },
    timing,
    productEntry:
      'built local Workbench and versioned API: parent Mission -> Composite Checkpoint -> Execution Fork -> child Branch Receipt',
    mission: {
      missionId: created.missionId,
      parentAttemptId,
      parentReceiptId: parentReceipt.receiptId,
      parentBranchId: rootBranch.branchId,
      childBranchId: childBranch.branchId,
      childReceiptId,
      finalHeadHash: finalHead,
    },
    parentRuntime: {
      initialHead: sourceInitial.head,
      resultBeforeBoundaryCommit: sourceAfterRuntime,
      committedHead: sourceAfterParent.head,
      committedTree: sourceAfterParent.tree,
      cleanStatus: sourceAfterParent.status,
      boundaryCommitOwner: 'local-proof-controller-after-verifying-the-real-runtime-delta',
      mode: 'PARENT',
      semanticFactKinds: [...new Set(parentFacts.map((fact) => fact.kind))],
    },
    inheritedExternalEffect: {
      effectId,
      targetId,
      idempotencyKey,
      status: coordinated.outcome.status,
      decision: 'inherit-no-repeat',
      targetPostCount: effectFixture.postCount(),
      targetCallOrder: effectFixture.calls(),
      callsAddedByForkOrRestart: 0,
    },
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      manifestHash: checkpoint.manifestHash,
      source: checkpoint.source,
      workspace: checkpoint.workspace,
      componentDispositions: checkpoint.components.map((component) => ({
        component: component.component,
        disposition: component.disposition,
      })),
    },
    executionFork: {
      forkId: fork.forkId,
      phase: fork.phase,
      lineageId: fork.lineage.lineageId,
      intervention: fork.lineage.intervention,
      sameRuntimeProfile: fork.lineage.profileId === checkpoint.source.profileId,
      isolatedWorktreePath: isolatedWorkspace,
      sourceWorkspaceUnchanged: stableJson(sourceAfterFork) === stableJson(sourceAfterParent),
      sourceSnapshot: sourceAfterFork,
      childSnapshot,
      childMode: 'FORK-GUIDANCE',
      runtimeRunId: fork.runtimeResult.runtimeRunId,
      runtimeStatus: fork.runtimeResult.status,
      runtimeEvidenceKinds: [...new Set(fork.runtimeEvidence.map((entry) => entry.kind))],
      toolExecutionEvidenceRefs: fork.runtimeResult.toolExecutionEvidenceRefs,
      verificationEvidenceRefs: fork.runtimeResult.verificationEvidenceRefs,
      kernelEventOrder: order,
    },
    workbench: {
      checkpointCreatedThroughBrowser: true,
      executionForkSubmittedThroughBrowser: true,
      operationModeStates: browserSubmission.modeStates,
      beforeRestart: browserFinal,
      afterRestart: browserRestart,
    },
    restartRecovery: {
      sameMissionHead: true,
      sameChildReceipt: true,
      sameBranches: true,
      sameCheckpoint: true,
      sameExecutionFork: true,
      noExternalTargetTraffic: true,
    },
    claimBoundary:
      'This proves on one local host that the built MissionBraid Workbench and API ran a real Codex parent Mission to a verified one-file result; after the local proof controller inspected and committed exactly that result because the Codex workspace sandbox cannot write Git metadata, MissionBraid captured a complete Git-backed Composite Checkpoint, created Branch B from that exact commit after one declared guidance Intervention, ran a fresh real Codex native process with terminal tool evidence only in the isolated Git worktree, passed the deterministic Contract verifier, and let the Mission Kernel issue a child-Branch Receipt. It also proves one confirmed queryable external Effect was inherited as no-repeat, the source workspace stayed unchanged, the Workbench rendered A/B, Checkpoint, Fork, Effect inheritance, and Receipt, and all of that reconstructed after restart. It does not claim that Codex created the parent Git commit, native session resume or native session fork, arbitrary external systems, multi-host execution, production use, or independent external reproduction.',
    proofRoot,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputFile === undefined) process.stdout.write(serialized);
  else writeFileSync(outputFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  progress('Iteration 5 real Execution Fork evidence complete.');
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (restartBrowser !== undefined) await restartBrowser.close().catch(() => undefined);
  if (app !== undefined) await app.close();
  if (restarted !== undefined) await restarted.close();
  await effectFixture.close();
}

function missionInput(workspacePath) {
  return {
    title: 'Fork one Agent guidance change from a clean checkpoint',
    objective:
      'Establish a clean committed parent Agent boundary, then verify that the accepted mode remains valid after one isolated guidance change.',
    workspace: workspacePath,
    constraints: [
      'Follow AGENTS.md exactly',
      'Change only mode.txt',
      'Do not access the network or any external service',
    ],
    verifier: { executable: 'node', args: ['verify.mjs'], timeoutMs: 30_000 },
    stages: [
      {
        stageId: 'codex-parent-and-fork',
        harness: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        permissionMode: 'workspace-write',
        injectionBudgetTokens: 2_400,
        instruction:
          'Follow AGENTS.md. Read mode.txt. For the parent PENDING state, use a native file tool to write exactly PARENT, run node verify.mjs, and commit only mode.txt as the clean parent boundary. In an Execution Fork, apply only its declared guidance Intervention and run the same verifier.',
      },
    ],
  };
}

async function submitForkInBrowser(browserClient, checkpointId, intervention) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await browserClient.evaluate(`(() => {
      const card = document.querySelector('[data-checkpoint-id=${JSON.stringify(checkpointId)}]');
      if (!card) return null;
      const modeStates = Array.from(card.querySelectorAll('[data-fork-mode]')).map((button) => ({
        id: button.dataset.forkMode,
        disabled: button.disabled,
        text: button.textContent || '',
      }));
      const form = card.querySelector('[data-execution-fork-action=${JSON.stringify(checkpointId)}]');
      if (!form) return { clicked: false, text: card.textContent || '', modeStates };
      const selects = form.querySelectorAll('select');
      const inputs = form.querySelectorAll('input');
      const description = form.querySelector('textarea');
      const submit = form.querySelector('button.continuity-action');
      if (selects.length < 2 || inputs.length < 2 || !description || !submit || submit.disabled) {
        return { clicked: false, text: form.textContent || '', modeStates };
      }
      selects[0].value = ${JSON.stringify(intervention.kind)};
      inputs[0].value = ${JSON.stringify(intervention.targetRef)};
      inputs[1].value = ${JSON.stringify(intervention.afterDigest)};
      selects[1].value = ${JSON.stringify(intervention.authorityChange)};
      description.value = ${JSON.stringify(intervention.description)};
      for (const control of [...selects, ...inputs, description]) {
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
      submit.click();
      return { clicked: true, text: card.textContent || '', modeStates };
    })()`);
    if (result !== null) return result;
    await wait(100);
  }
  throw new Error('Workbench did not render the Composite Checkpoint in time.');
}

async function waitForBrowserMission(browserClient, missionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const visible = await browserClient.evaluate(`(() => {
      const view = document.querySelector('[data-continuity-workbench=${JSON.stringify(missionId)}]');
      return Boolean(view && document.querySelector('[data-create-checkpoint=${JSON.stringify(missionId)}]'));
    })()`);
    if (visible) return;
    await wait(100);
  }
  throw new Error('Workbench did not render the parent Mission.');
}

async function waitForBrowserFork(
  browserClient,
  missionId,
  checkpointId,
  forkId,
  branchIds,
  receiptId,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await browserClient.evaluate(`(() => {
      const zh = document.querySelector('[data-locale="zh-CN"]');
      if (zh && zh.getAttribute('aria-pressed') !== 'true') zh.click();
      const view = document.querySelector('[data-continuity-workbench=${JSON.stringify(missionId)}]');
      if (!view) return null;
      return {
        branchIds: Array.from(view.querySelectorAll('[data-branch-id]')).map((node) => node.dataset.branchId),
        checkpointIds: Array.from(view.querySelectorAll('[data-checkpoint-id]')).map((node) => node.dataset.checkpointId),
        forkIds: Array.from(view.querySelectorAll('[data-execution-fork-id]')).map((node) => node.dataset.executionForkId),
        text: view.textContent || '',
        locale: document.documentElement.lang,
      };
    })()`);
    if (
      snapshot !== null &&
      branchIds.every((branchId) => snapshot.branchIds.includes(branchId)) &&
      snapshot.checkpointIds.includes(checkpointId) &&
      snapshot.forkIds.includes(forkId) &&
      snapshot.text.includes(receiptId) &&
      snapshot.locale === 'zh-CN'
    ) {
      return {
        branchIds: snapshot.branchIds,
        checkpointIds: snapshot.checkpointIds,
        forkIds: snapshot.forkIds,
        receiptVisible: true,
        chineseBranchLabelsVisible:
          snapshot.text.includes('Branch A') && snapshot.text.includes('Branch B'),
        effectInheritanceVisible: snapshot.text.includes('\u5df2\u7ee7\u627f'),
        locale: snapshot.locale,
      };
    }
    await wait(200);
  }
  throw new Error('Workbench did not render the restart-stable Branch A/B Fork Receipt view.');
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

async function waitForCheckpoint(baseUrl, missionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    if (detail.compositeCheckpoints?.length > 0) return detail;
    await wait(100);
  }
  throw new Error('Composite Checkpoint was not created through the Workbench.');
}

async function waitForExecutionFork(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    const fork = detail.executionForks?.[0];
    if (fork?.phase === 'failed') {
      throw new Error(`Execution Fork failed: ${fork.failure?.detail ?? 'unknown'}`);
    }
    if (
      fork?.phase === 'finished' &&
      detail.mission.receipt?.branchId === fork.lineage.childBranchId
    ) {
      return detail;
    }
    await wait(500);
  }
  throw new Error('Execution Fork timed out.');
}

function executionForkOrder(detail, fork) {
  const transitions = detail.timeline.filter(
    (entry) => entry.kind === 'execution-fork.transition' && entry.data?.forkId === fork.forkId,
  );
  const transitionSeq = (transition) => {
    const entry = transitions.find((candidate) => candidate.data?.transition === transition);
    if (entry === undefined) throw new Error(`Missing ${transition} Kernel transition.`);
    return entry.seq;
  };
  const workspaceEffectId = fork.receiptInput?.workspaceEffectInput?.effectId;
  const effectSeq = (status) => {
    const entry = detail.timeline.find(
      (candidate) =>
        candidate.kind === 'effect.status_changed' &&
        candidate.data?.effectId === workspaceEffectId &&
        candidate.data?.status === status,
    );
    if (entry === undefined) throw new Error(`Missing workspace Effect ${status}.`);
    return entry.seq;
  };
  const attemptStarted = detail.timeline.find(
    (entry) =>
      entry.kind === 'attempt.started' && entry.attemptId === `fork-attempt-${fork.forkId}`,
  );
  const receipt = [...detail.timeline]
    .reverse()
    .find(
      (entry) =>
        entry.kind === 'receipt.issued' &&
        entry.data?.receiptId === detail.mission.receipt?.receiptId,
    );
  if (attemptStarted === undefined || receipt === undefined) {
    throw new Error('Child Attempt or child Receipt timeline entry is missing.');
  }
  return {
    planned: transitionSeq('fork.planned'),
    createStarted: transitionSeq('worktree.create-started'),
    dispatchStarted: effectSeq('dispatch_started'),
    worktreeCreated: transitionSeq('worktree.created'),
    runtimeStarted: transitionSeq('runtime.started'),
    attemptStarted: attemptStarted.seq,
    runtimeFinished: transitionSeq('runtime.finished'),
    effectExecuted: effectSeq('executed'),
    receiptInputReady: transitionSeq('receipt-input.ready'),
    effectConfirmed: effectSeq('confirmed'),
    receiptIssued: receipt.seq,
  };
}

function executionTiming(detail) {
  const requireEntry = (description, predicate) => {
    const entry = detail.timeline.find(predicate);
    if (entry === undefined) throw new Error(`Missing ${description} timing event.`);
    return entry;
  };
  const missionCreated = requireEntry(
    'Mission creation',
    (entry) => entry.kind === 'mission.created',
  );
  const parentStarted = requireEntry(
    'parent Runtime start',
    (entry) => entry.kind === 'runtime.process_started',
  );
  const parentFinished = requireEntry(
    'parent Runtime finish',
    (entry) => entry.kind === 'runtime.process_finished',
  );
  const forkPlanned = requireEntry(
    'Fork plan',
    (entry) =>
      entry.kind === 'execution-fork.transition' && entry.data?.transition === 'fork.planned',
  );
  const forkStarted = requireEntry(
    'Fork Runtime start',
    (entry) =>
      entry.kind === 'execution-fork.transition' && entry.data?.transition === 'runtime.started',
  );
  const forkFinished = requireEntry(
    'Fork Runtime finish',
    (entry) =>
      entry.kind === 'execution-fork.transition' && entry.data?.transition === 'runtime.finished',
  );
  const childReceipt = [...detail.timeline]
    .reverse()
    .find((entry) => entry.kind === 'receipt.issued');
  if (childReceipt === undefined) throw new Error('Missing child Receipt timing event.');
  const elapsed = (start, end) => Date.parse(end.occurredAt) - Date.parse(start.occurredAt);
  return {
    missionCreatedAt: missionCreated.occurredAt,
    parentRuntimeStartedAt: parentStarted.occurredAt,
    parentRuntimeFinishedAt: parentFinished.occurredAt,
    parentRuntimeMs: elapsed(parentStarted, parentFinished),
    forkPlannedAt: forkPlanned.occurredAt,
    forkRuntimeStartedAt: forkStarted.occurredAt,
    forkRuntimeFinishedAt: forkFinished.occurredAt,
    forkRuntimeMs: elapsed(forkStarted, forkFinished),
    childReceiptIssuedAt: childReceipt.occurredAt,
    forkToReceiptMs: elapsed(forkPlanned, childReceipt),
    missionToChildReceiptMs: elapsed(missionCreated, childReceipt),
    measurement: 'durable Mission Kernel occurredAt timestamps',
  };
}

function assertStrictlyIncreasing(values, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (!(values[index - 1] < values[index])) {
      throw new Error(`${label} is not strictly increasing: ${values.join(', ')}`);
    }
  }
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

function gitSnapshot(worktree) {
  return {
    head: git(worktree, ['rev-parse', 'HEAD']),
    tree: git(worktree, ['rev-parse', 'HEAD^{tree}']),
    status: git(worktree, ['status', '--porcelain']).split('\n').filter(Boolean),
  };
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

function progress(message) {
  process.stderr.write(`[iteration-5] ${message}\n`);
}
