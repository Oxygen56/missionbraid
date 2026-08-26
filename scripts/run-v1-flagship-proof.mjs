#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { launchHeadlessWorkbench, wait } from './headless-workbench.mjs';
import {
  captureImplementationSource,
  completeFreshBuildImplementation,
} from './implementation-binding.mjs';
import { createQueryableHttpEffectTarget } from './queryable-http-effect-target.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const implementationSource = captureImplementationSource(repositoryRoot, [outputFile]);
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-v1-flagship-'));
const stateDir = join(proofRoot, 'state');
const workspace = join(proofRoot, 'workspace');
const hiddenVerifier = join(proofRoot, 'hidden-context-verifier.mjs');
const qoderWrapper = join(proofRoot, 'qoder-flagship-provider.mjs');
const providerLog = join(proofRoot, 'qoder-provider.jsonl');
const missionFile = join(repositoryRoot, 'examples', 'v1-flagship-fixture', 'mission.yaml');
const ciRunnerSource = join(
  repositoryRoot,
  'examples',
  'i9-outcome-regression-fixture',
  'ci',
  'check-outcome-ci.mjs',
);

progress('Building the exact source tree for the unified flagship Mission');
run('pnpm', ['build']);
const implementation = completeFreshBuildImplementation(repositoryRoot, implementationSource, [
  outputFile,
]);
const preparation = JSON.parse(
  run(process.execPath, [
    join(repositoryRoot, 'scripts', 'prepare-v1-flagship-fixture.mjs'),
    workspace,
  ]).stdout,
);
writeFileSync(
  hiddenVerifier,
  `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
const config = JSON.parse(await readFile('agent-config.json', 'utf8'));
const source = JSON.parse(await readFile('context-source.json', 'utf8'));
assert.equal(config.requiredPrefix, source.requiredPrefix);
assert.equal(await readFile('approved.txt', 'utf8'), 'APPROVED\\n');
assert.equal(await readFile('handoff-qoder.txt', 'utf8'), 'qoder-observed\\n');
await assert.rejects(access('original.txt', constants.F_OK));
process.stdout.write('verified current Context and approved bootstrap effects\\n');
`,
  { encoding: 'utf8', mode: 0o700 },
);
const realQoder = commandPath('qodercli');
writeFileSync(
  qoderWrapper,
  controlledProviderSource({
    realExecutable: realQoder,
    controlledWorkspace: workspace,
    providerLog,
  }),
  { encoding: 'utf8', mode: 0o700 },
);
chmodSync(qoderWrapper, 0o700);

const { snapshotGitWorkspace, createStageChangedPaths } = await import('../dist/src/workspace.js');
const { sanitizeNativeArtifact } = await import('../dist/src/artifact-store.js');
const { deriveFailureIntelligence } = await import('../dist/src/failure-intelligence.js');
const { startMissionBraidApp } = await import('../dist/src/app.js');
const { MissionEngine } = await import('../dist/src/engine.js');
const { QoderAdapter } = await import('../dist/src/adapters/qoder.js');
const studio = await import('../dist/src/outcome-studio.js');

let externalTargets = [];
const engineFactory = (directory) =>
  new MissionEngine({
    stateDir: directory,
    qoderAdapter: new QoderAdapter({ command: qoderWrapper }),
    externalEffectTargets: externalTargets,
  });

let app;
let browser;
let targetFixture;
let crashController;
let promptV1Marker;
try {
  app = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const qoderRuntime = requireReadyRuntime(inventory, 'qoder');
  const claudeRuntime = requireReadyRuntime(inventory, 'claude');
  const draft = explicitPlanDraftPayload(missionFile, workspace, hiddenVerifier);
  const created = await requestJson(
    `${app.url}/api/v1/missions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    },
    201,
  );
  if (created.operation !== null)
    throw new Error('Explicit Plan Mission unexpectedly auto-started.');
  const missionId = created.missionId;
  progress(`Created unified flagship Mission ${missionId}`);

  browser = await launchHeadlessWorkbench(app.url, join(proofRoot, 'chrome-gateway'));
  await selectMissionInWorkbench(browser, missionId);
  const fallbackOverride = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/execution-planner/override`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stageId: 'claude-prompt',
        reason:
          'Use the declared native Tool Gateway Profile for the controlled fallback; keep the upgraded Profile reserved for the later Outcome Studio regression.',
      }),
    },
    201,
  );
  await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/resume`,
    { method: 'POST' },
    202,
  );
  const gateway = { handled: new Set(), decisions: [], modified: undefined };
  const initial = await waitForLegacyWithToolGates({
    baseUrl: app.url,
    missionId,
    browser,
    gateway,
    timeoutMs: 40 * 60_000,
  });
  if (initial.mission.status !== 'failed' || initial.mission.receipt?.outcome !== 'rejected') {
    throw new Error('The cached Context bootstrap did not produce the expected rejected Receipt.');
  }
  const qoderAttempt = single(
    initial.attempts.filter((attempt) => attempt.harness === 'qoder'),
    'fallback source Qoder Attempt',
  );
  const claudeAttempt = single(
    initial.attempts.filter((attempt) => attempt.harness === 'claude'),
    'fallback target Claude Attempt',
  );
  if (qoderAttempt.status !== 'failed' || claudeAttempt.status !== 'succeeded') {
    throw new Error(
      'The fallback Attempts did not establish a failed Qoder to successful Claude route.',
    );
  }
  const planner = requireTimeline(initial, 'execution-planner.decision');
  const prepared = requireTimeline(initial, 'handoff.prepared');
  const acknowledged = requireTimeline(initial, 'handoff.acknowledged');
  if (
    planner.data?.decision?.binding?.selectedHarness !== 'claude' ||
    planner.data?.decision?.manualOverride?.status !== 'applied' ||
    planner.data?.manualOverrideRequest?.overrideId !== fallbackOverride.override.overrideId ||
    planner.data?.trigger?.code !== 'DECLARED_HANDOFF_FAILURE' ||
    claudeAttempt.stageId !== 'claude-prompt' ||
    acknowledged.attemptId !== claudeAttempt.attemptId ||
    acknowledged.data?.handoffOrderingEstablished !== true ||
    !(prepared.seq < acknowledged.seq)
  ) {
    throw new Error('The planned Handoff or acknowledgement-before-tool ordering is incomplete.');
  }
  if (
    gateway.modified === undefined ||
    existsSync(join(workspace, 'original.txt')) ||
    readFileSync(join(workspace, 'approved.txt'), 'utf8') !== 'APPROVED\n'
  ) {
    throw new Error('The native Write was not modified before dispatch.');
  }
  const initialVerifications = new Map(
    initial.mission.receipt.verifications.map((result) => [result.criterionId, result.status]),
  );
  if (
    initialVerifications.get('context-current') !== 'failed' ||
    ['tool-behavior', 'prompt-schema', 'final-outcome'].some(
      (criterionId) => initialVerifications.get(criterionId) !== 'passed',
    )
  ) {
    throw new Error('The bootstrap did not isolate stale Context as the rejected criterion.');
  }
  const freshness = initial.timeline.find(
    (entry) => entry.kind === 'context.freshness' && entry.attemptId === claudeAttempt.attemptId,
  );
  if (
    typeof freshness?.data?.boundContextDigest !== 'string' ||
    typeof freshness.data.currentContextDigest !== 'string' ||
    freshness.data.boundContextDigest === freshness.data.currentContextDigest
  ) {
    throw new Error('The real Claude Attempt did not retain stale Context freshness evidence.');
  }
  progress(
    'Real Qoder Handoff, Claude native gate, stale Context, and deterministic rejection completed',
  );
  await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/execution-planner/override`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reason: 'The controlled fallback is complete; return later routing to automatic planning.',
      }),
    },
  );

  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;

  targetFixture = await startQueryableTarget();
  const targetId = 'flagship-queryable-target';
  const target = createQueryableHttpEffectTarget(targetFixture.url, targetId);
  const effectId = 'effect-flagship-crash-reconcile';
  const idempotencyKey = `flagship-create-once-${missionId}`;
  const payload = { operation: 'record', missionId, value: 'flagship external Effect' };
  const effectBody = {
    attemptId: claudeAttempt.attemptId,
    targetId,
    kind: 'record.create',
    resourceKey: `record:${missionId}`,
    authorityRef: 'grant:flagship-local-proof',
    idempotencyKey,
    payloadDigest: `sha256:${sha256(JSON.stringify(payload))}`,
    payload,
  };
  crashController = await startCrashingController(stateDir, targetFixture.url, targetId);
  const crashedRequest = fetch(
    `${crashController.url}/api/v1/missions/${encodeURIComponent(missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(effectBody),
      signal: AbortSignal.timeout(30_000),
    },
  );
  await expectControllerCrash(crashedRequest, crashController.completed);
  crashController = undefined;
  if (targetFixture.postCount() !== 1)
    throw new Error('External target did not accept exactly once.');
  await wait(30_500);
  externalTargets = [target];
  app = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const callsBeforeLookup = targetFixture.calls().length;
  const reconciled = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(effectBody),
    },
  );
  if (
    reconciled.outcome?.status !== 'confirmed' ||
    reconciled.outcome?.source !== 'lookup' ||
    targetFixture.postCount() !== 1 ||
    targetFixture.calls().slice(callsBeforeLookup).join(',') !== `GET:${idempotencyKey}`
  ) {
    throw new Error('Restart did not reconcile the accepted Effect by lookup without duplication.');
  }
  progress('Controller crash reconciled the queryable external Effect without a second dispatch');

  git(workspace, ['add', '-A']);
  git(workspace, [
    '-c',
    'user.name=MissionBraid',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'seal flagship rejected bootstrap frontier',
  ]);
  const sealed = snapshotGitWorkspace(workspace);
  if (sealed.status.length !== 0) throw new Error('Flagship checkpoint frontier is not clean.');
  const checkpointResponse = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/checkpoints`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: claudeAttempt.attemptId }),
    },
    201,
  );
  const checkpoint = checkpointResponse.checkpoint;
  if (
    checkpoint?.workspace?.state !== 'restorable-artifact' ||
    checkpoint.workspace.workspaceDigest !== sealed.workspaceDigest ||
    !checkpoint.externalEffectFrontier?.some(
      (effect) => effect.effectId === effectId && effect.status === 'confirmed',
    )
  ) {
    throw new Error('Composite Checkpoint is not a complete restorable frontier with the Effect.');
  }
  const incident = await requestJson(`${app.url}/api/v1/missions/${encodeURIComponent(missionId)}`);
  const staleCandidate = incident.failureIntelligence?.graph?.candidates?.find(
    (candidate) => candidate.detector === 'stale-context',
  );
  const toolCandidate = incident.failureIntelligence?.graph?.candidates?.find(
    (candidate) => candidate.detector === 'tool-error',
  );
  const unknownBefore = incident.failureIntelligence?.graph?.candidates?.find(
    (candidate) => candidate.status === 'unknown',
  );
  if (
    staleCandidate?.status !== 'inferred' ||
    toolCandidate?.layer !== 'tool' ||
    toolCandidate.status !== 'observed'
  ) {
    throw new Error(
      'Failure Intelligence did not retain distinct Context and tool-layer evidence.',
    );
  }
  const currentSource = sanitizeNativeArtifact(
    readFileSync(join(workspace, 'context-source.json'), 'utf8'),
  ).content.trimEnd();
  const intervention = {
    interventionId: `intervention-flagship-${randomUUID()}`,
    kind: 'context',
    targetRef: 'context:agent-behavior-source',
    beforeDigest: freshness.data.boundContextDigest,
    afterDigest: `sha256:${sha256(currentSource)}`,
    description: 'Refresh only the accepted Agent behavior Context on the restored frontier.',
    authorityChange: 'unchanged',
  };
  const diagnosticController = new AbortController();
  const diagnosticGateApproval = approveExecutionForkGates({
    baseUrl: app.url,
    missionId,
    signal: diagnosticController.signal,
    timeoutMs: 40 * 60_000,
  });
  let diagnosticGateDecisions;
  let forkResponse;
  try {
    const forkRequest = requestJson(
      `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/failure-intelligence/${encodeURIComponent(staleCandidate.candidateId)}/forks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkpointId: checkpoint.checkpointId, intervention }),
        signal: diagnosticController.signal,
      },
      201,
    );
    forkResponse = await Promise.race([
      forkRequest,
      diagnosticGateApproval.then(() => {
        throw new Error('Diagnostic Fork gate approver stopped before the Fork completed.');
      }),
    ]);
  } finally {
    diagnosticController.abort();
    diagnosticGateDecisions = await diagnosticGateApproval;
  }
  const fork = forkResponse.executionFork;
  if (fork?.phase !== 'finished' || forkResponse.receipt?.outcome !== 'verified') {
    throw new Error('The Context-only diagnostic Fork did not reach a verified Receipt.');
  }
  const forkChangedPaths = createStageChangedPaths(fork.baselineSnapshot, fork.futureSnapshot)
    .map((change) => change.path)
    .sort();
  if (stableJson(forkChangedPaths) !== stableJson(['agent-config.json'])) {
    throw new Error(`Diagnostic Fork changed unexpected paths: ${stableJson(forkChangedPaths)}`);
  }
  if (
    !fork.lineage?.externalEffectDecisions?.some(
      (decision) => decision.effectId === effectId && decision.action === 'inherit-no-repeat',
    )
  ) {
    throw new Error('Diagnostic Fork did not inherit the confirmed Effect as no-repeat.');
  }
  const diagnosed = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}`,
  );
  const confirmed = diagnosed.failureIntelligence?.graph?.candidates?.find(
    (candidate) => candidate.candidateId === staleCandidate.candidateId,
  );
  const diagnosticOutcome =
    diagnosed.failureIntelligence?.failureIntelligenceInput?.diagnosticOutcomes?.find(
      (outcome) => outcome.candidateId === staleCandidate.candidateId,
    );
  if (confirmed?.status !== 'confirmed' || diagnosticOutcome?.result !== 'mechanism-confirmed') {
    throw new Error('The diagnostic outcome did not confirm the stale Context mechanism.');
  }
  const ablated = deriveFailureIntelligence({
    ...diagnosed.failureIntelligence.failureIntelligenceInput,
    diagnosticOutcomes: [],
  });
  const downgraded = ablated.candidates.find(
    (candidate) => candidate.candidateId === staleCandidate.candidateId,
  );
  const verifierOnly = deriveFailureIntelligence({
    persistedRuntimeFacts: [],
    verifications: incident.failureIntelligence.failureIntelligenceInput.verifications,
  });
  const honestUnknown = verifierOnly.candidates.find(
    (candidate) => candidate.detector === 'unattributed' && candidate.status === 'unknown',
  );
  if (downgraded?.status !== 'inferred' || honestUnknown === undefined) {
    throw new Error('Evidence ablation did not lower certainty or preserve honest unknown.');
  }
  progress(
    'Composite Checkpoint, Context-only Fork, confirmed diagnosis, unknown, and ablation completed',
  );

  const diagnosticBranchId = fork.lineage.childBranchId;
  const revisedView = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio?branchId=${encodeURIComponent(diagnosticBranchId)}`,
  );
  const rootBranchId = initial.mission.rootBranchId;
  const rootView = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio?branchId=${encodeURIComponent(rootBranchId)}`,
  );
  if (
    revisedView.comparison?.contractId !== initial.mission.contract.contractId ||
    revisedView.comparison?.suiteId !== rootView.comparison?.suiteId ||
    rootView.studioReceipt?.completion?.verified !== 'rejected' ||
    revisedView.studioReceipt?.completion?.verified !== 'verified'
  ) {
    throw new Error(
      'Outcome Studio did not compare original and revised Branches under one Contract/Suite.',
    );
  }
  const selection = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/selections`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branchId: diagnosticBranchId,
        authorityKind: 'human',
        authorityRef: 'developer:flagship-local-proof',
      }),
    },
    201,
  );
  await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/scenarios`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchId: diagnosticBranchId }),
    },
    201,
  );
  const scenarios = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/scenarios`,
  );
  const scenario = single(scenarios.scenarios, 'saved executable flagship scenario');
  if (scenario.executionPlan === null)
    throw new Error('Saved flagship incident is not executable.');
  const reboundCandidate = single(
    diagnosed.executionPlanner.candidates.filter(
      (candidate) => candidate.stageId === 'claude-regression-upgraded',
    ),
    'declared upgraded Claude Profile-Rebound candidate',
  );
  const rerunController = new AbortController();
  const rerunGateApproval = approveExecutionForkGates({
    baseUrl: app.url,
    missionId,
    signal: rerunController.signal,
    timeoutMs: 40 * 60_000,
  });
  let reboundGateDecisions;
  let rerun;
  try {
    const rerunRequest = requestJson(
      `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/scenarios/${encodeURIComponent(scenario.scenarioId)}/runs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targetStageId: reboundCandidate.stageId,
          targetProfileDefinitionId: reboundCandidate.profileDefinition.definitionId,
        }),
        signal: rerunController.signal,
      },
      201,
    );
    rerun = await Promise.race([
      rerunRequest,
      rerunGateApproval.then(() => {
        throw new Error('Profile-Rebound gate approver stopped before the rerun completed.');
      }),
    ]);
  } finally {
    rerunController.abort();
    reboundGateDecisions = await rerunGateApproval;
  }
  if (
    rerun.trials?.length !== 3 ||
    rerun.sourceProfileId === rerun.targetProfileId ||
    rerun.targetStageId !== reboundCandidate.stageId ||
    rerun.targetProfileDefinitionId !== reboundCandidate.profileDefinition.definitionId ||
    new Set(rerun.trials.map((trial) => trial.branchId)).size !== 3 ||
    new Set(rerun.trials.map((trial) => trial.attemptId)).size !== 3 ||
    new Set(rerun.trials.map((trial) => trial.bindingId)).size !== 3 ||
    new Set(rerun.trials.map((trial) => trial.targetProfileId)).size !== 1 ||
    new Set(rerun.trials.map((trial) => trial.profileSelectionId)).size !== 1 ||
    rerun.trials.some(
      (trial) =>
        trial.receiptOutcome !== 'verified' ||
        trial.sourceProfileId !== rerun.sourceProfileId ||
        trial.targetProfileId !== rerun.targetProfileId ||
        trial.targetStageId !== reboundCandidate.stageId ||
        trial.profileSelectionId !== rerun.profileSelectionId,
    ) ||
    rerun.ciResult?.status !== 'passed'
  ) {
    throw new Error(
      'Executable incident rerun did not retain three verified Profile-Rebound Runtime trials.',
    );
  }
  const rerunAttemptIds = new Set(rerun.trials.map((trial) => trial.attemptId));
  const approvedWriteAttemptIds = new Set(
    reboundGateDecisions
      .filter((decision) => decision.toolName === 'Write')
      .map((decision) => decision.attemptId),
  );
  if (
    reboundGateDecisions.some(
      (decision) => decision.decision !== 'approve' || decision.originalWrite,
    ) ||
    approvedWriteAttemptIds.size !== rerunAttemptIds.size ||
    [...rerunAttemptIds].some((attemptId) => !approvedWriteAttemptIds.has(attemptId))
  ) {
    throw new Error(
      'Every Profile-Rebound Runtime trial must pass a non-original native Write through the public Tool Gate decision API.',
    );
  }
  const rerunDetail = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}`,
  );
  assertProfileReboundKernelBindings(rerunDetail, rerun);
  const ciRunner = join(proofRoot, 'check-outcome-ci.mjs');
  copyFileSync(ciRunnerSource, ciRunner);
  const retainedCiFile = join(proofRoot, 'retained-ci-result.json');
  writeFileSync(retainedCiFile, `${JSON.stringify(rerun.ciResult, null, 2)}\n`, 'utf8');
  const retainedCi = spawnCommand(process.execPath, [ciRunner, retainedCiFile], proofRoot);
  const rerunBranchView = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio?branchId=${encodeURIComponent(rerun.targetBranchId)}`,
  );
  if (rerunBranchView.branch === null) {
    throw new Error('The Profile-Rebound Branch is unavailable for the fail-closed CI check.');
  }
  const blockedReceipt = studio.issueStudioOutcomeReceipt({
    branch: { ...rerunBranchView.branch, evaluation: rerun.evaluation },
    effects: [
      {
        effectId: 'effect-flagship-ci-unresolved',
        required: true,
        status: 'ambiguous',
        resolution: 'blocking',
        evidenceRefs: ['fixture:flagship-ci-unresolved-effect'],
      },
    ],
    runtimeProfileBinding: rerun.receipt.runtimeProfileBinding,
    outcomePolicyVersion: scenario.executionPlan.evaluationSuite.outcomePolicyVersion,
    issuedAt: new Date().toISOString(),
  });
  const blockedCiResult = studio.createOutcomeCiResult({
    scenario,
    receipt: blockedReceipt,
    generatedAt: new Date().toISOString(),
  });
  const blockedCiFile = join(proofRoot, 'blocked-ci-result.json');
  writeFileSync(blockedCiFile, `${JSON.stringify(blockedCiResult, null, 2)}\n`, 'utf8');
  const blockedCi = spawnCommand(process.execPath, [ciRunner, blockedCiFile], proofRoot);
  if (
    retainedCi.status !== 0 ||
    blockedCiResult.regression !== 'retained' ||
    blockedCiResult.status !== 'failed' ||
    blockedCi.status !== 1
  ) {
    throw new Error('Standalone Outcome CI did not fail closed on an unresolved required Effect.');
  }
  progress('Saved incident reran as three new real Runtime trials and standalone CI failed closed');

  const planBefore = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/plan`,
  );
  await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/plan/execute`,
    { method: 'POST' },
    202,
  );
  const frontier = await waitForInitialParallelFrontier(app.url, missionId, stateDir, 40 * 60_000);
  const contractV1 = frontier.missionPlan.contractRevision;
  const toolV1Attempt = single(
    frontier.missionPlan.execution.attempts.filter(
      (attempt) => attempt.nodeId === 'tool-implementation',
    ),
    'Qoder Plan tool Attempt',
  );
  const promptV1Attempt = single(
    frontier.missionPlan.execution.attempts.filter(
      (attempt) => attempt.nodeId === 'prompt-skill' && attempt.status === 'running',
    ),
    'Claude Plan prompt v1 Attempt',
  );
  const toolV1Artifact = single(
    frontier.missionPlan.execution.artifacts.filter(
      (record) => record.artifact.producedByNodeId === 'tool-implementation',
    ),
    'Qoder Plan tool Artifact',
  );
  promptV1Marker = frontier.promptMarker;
  if (
    toolV1Attempt.status !== 'succeeded' ||
    promptV1Marker.value.state !== 'waiting-for-contract-revision'
  ) {
    throw new Error('The two real Plan Agents did not reach the expected parallel frontier.');
  }
  const revisedRequirements = contractV1.requirements.map((requirement) =>
    requirement.requirementId === 'acceptance-prompt-schema'
      ? {
          ...requirement,
          statement:
            'Both the prompt and Skill require exactly classification copied from tool.decision, rationale copied from tool.rationale, and evidenceSource copied from tool.evidenceRefs.',
          evidenceRefs: [...requirement.evidenceRefs, 'user-request:flagship-add-evidence-source'],
        }
      : requirement,
  );
  const revisedContract = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/contract-revisions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: contractV1.contract,
        requirements: revisedRequirements,
        reason: 'Add evidence provenance to every triage response.',
        evidenceRefs: ['workbench:flagship-live-prompt-revision'],
      }),
    },
    201,
  );
  if (
    stableJson(revisedContract.invalidation.changedRequirementIds) !==
      stableJson(['acceptance-prompt-schema']) ||
    stableJson(revisedContract.invalidation.directlyImpactedNodeIds) !==
      stableJson(['prompt-skill']) ||
    !revisedContract.invalidation.reusableArtifactIds.includes(toolV1Artifact.artifact.artifactId)
  ) {
    throw new Error('Live Contract revision did not fence only the affected prompt work.');
  }
  const completedPlan = await waitForPlanCompletion(app.url, missionId, 40 * 60_000);
  const planExecution = completedPlan.missionPlan.execution;
  const promptAttempts = planExecution.attempts.filter(
    (attempt) => attempt.nodeId === 'prompt-skill',
  );
  const promptV1Final = single(
    promptAttempts.filter((attempt) => attempt.attemptId === promptV1Attempt.attemptId),
    'fenced Claude v1 Attempt',
  );
  const promptV2 = single(
    promptAttempts.filter(
      (attempt) =>
        attempt.contractRevisionId === revisedContract.contractRevision.contractRevisionId,
    ),
    'Claude v2 Attempt',
  );
  const reusedTool = single(
    planExecution.artifacts.filter(
      (record) =>
        record.artifact.producedByNodeId === 'tool-implementation' &&
        record.artifact.contractRevisionId === revisedContract.contractRevision.contractRevisionId,
    ),
    'reused Qoder Artifact',
  );
  const consolidation = single(planExecution.consolidations, 'independent consolidation');
  if (
    completedPlan.mission.receipt?.outcome !== 'verified' ||
    promptV1Final.status !== 'abandoned' ||
    promptV2.status !== 'succeeded' ||
    reusedTool.reusedFromArtifactId !== toolV1Artifact.artifact.artifactId ||
    consolidation.outcome?.conclusion !== 'confirmed'
  ) {
    throw new Error(
      'The revised Plan did not reuse Qoder work, replace Claude work, and consolidate.',
    );
  }
  progress(
    'Two real Agents, live Contract revision, selective fence, Artifact reuse, and consolidation completed',
  );

  const finalBeforeRestart = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}`,
  );
  const scenariosBeforeRestart = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/scenarios`,
  );
  const finalHeadHash = finalBeforeRestart.mission.headHash;
  const finalReceiptId = finalBeforeRestart.mission.receipt.receiptId;
  const stableBefore = durableIdentities(
    finalBeforeRestart,
    scenariosBeforeRestart,
    rerun,
    selection,
  );
  await app.close();
  app = undefined;
  const targetCallsBeforeRestart = targetFixture.calls().length;
  app = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const restored = await requestJson(`${app.url}/api/v1/missions/${encodeURIComponent(missionId)}`);
  const restoredScenarios = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/scenarios`,
  );
  const restoredRuns = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/scenarios/${encodeURIComponent(scenario.scenarioId)}/runs`,
  );
  const restoredRerun = single(
    restoredRuns.runs.filter((candidate) => candidate.runId === rerun.runId),
    'restored flagship rerun',
  );
  const persistedEffect = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(effectBody),
    },
  );
  if (
    restored.mission.headHash !== finalHeadHash ||
    restored.mission.receipt?.receiptId !== finalReceiptId ||
    stableJson(durableIdentities(restored, restoredScenarios, restoredRerun, selection)) !==
      stableJson(stableBefore) ||
    persistedEffect.outcome?.source !== 'persisted' ||
    targetFixture.calls().length !== targetCallsBeforeRestart
  ) {
    throw new Error('Restart changed durable flagship identities or repeated the external Effect.');
  }

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/v1-flagship/v1',
    evidenceLevel: 'same-host-local-real-multi-runtime-controlled-fixture',
    generatedAt: new Date().toISOString(),
    missionId,
    implementation,
    environment: {
      nodeVersion: process.version,
      qoderVersion: qoderRuntime.version,
      claudeVersion: claudeRuntime.version,
    },
    fallback: {
      qoderAttemptId: qoderAttempt.attemptId,
      claudeAttemptId: claudeAttempt.attemptId,
      plannerDecisionHash: planner.data.decisionHash,
      plannerOverrideId: fallbackOverride.override.overrideId,
      plannerOverrideStageId: fallbackOverride.override.stageId,
      capsuleId: prepared.data.capsuleId,
      acknowledgementBeforeTool: acknowledged.data.handoffOrderingEstablished,
      modifiedGate: gateway.modified,
      receiptId: initial.mission.receipt.receiptId,
      receiptOutcome: initial.mission.receipt.outcome,
    },
    externalEffect: {
      effectId,
      idempotencyKey,
      postCount: targetFixture.postCount(),
      calls: targetFixture.calls(),
      reconciledSource: reconciled.outcome.source,
    },
    diagnostic: {
      checkpointId: checkpoint.checkpointId,
      forkId: fork.forkId,
      childBranchId: diagnosticBranchId,
      changedPaths: forkChangedPaths,
      staleCandidateId: staleCandidate.candidateId,
      toolCandidateId: toolCandidate.candidateId,
      unknownCandidateId: honestUnknown.candidateId,
      preexistingUnknownCandidateId: unknownBefore?.candidateId ?? null,
      fullStatus: confirmed.status,
      ablatedStatus: downgraded.status,
      toolGateDecisions: diagnosticGateDecisions,
      receiptId: forkResponse.receipt.receiptId,
    },
    outcomeRegression: {
      contractId: revisedView.comparison.contractId,
      suiteId: revisedView.comparison.suiteId,
      rootBranchId,
      revisedBranchId: diagnosticBranchId,
      selectionId: selection.selectionId,
      scenarioId: scenario.scenarioId,
      rerunId: rerun.runId,
      sourceProfileId: rerun.sourceProfileId,
      targetProfileId: rerun.targetProfileId,
      targetStageId: rerun.targetStageId,
      targetProfileDefinitionId: rerun.targetProfileDefinitionId,
      profileSelectionId: rerun.profileSelectionId,
      trialIds: rerun.trials.map((trial) => ({
        branchId: trial.branchId,
        attemptId: trial.attemptId,
        bindingId: trial.bindingId,
        runtimeRunId: trial.runtimeRunId,
      })),
      toolGateDecisions: reboundGateDecisions,
      retainedCiExitCode: retainedCi.status,
      returnedCiExitCode: returnedCi.status,
    },
    plan: {
      initialContractRevisionId: planBefore.contractRevision.contractRevisionId,
      revisedContractRevisionId: revisedContract.contractRevision.contractRevisionId,
      qoderToolAttemptId: toolV1Attempt.attemptId,
      qoderToolArtifactId: toolV1Artifact.artifact.artifactId,
      reusedToolArtifactId: reusedTool.artifact.artifactId,
      claudeV1AttemptId: promptV1Attempt.attemptId,
      claudeV1Status: promptV1Final.status,
      claudeV2AttemptId: promptV2.attemptId,
      consolidationId: consolidation.plan.consolidationId,
      receiptId: finalReceiptId,
    },
    restart: {
      stableHeadHash: true,
      stableReceipt: true,
      stableCheckpointForkPlanScenarioAndRerunIdentities: true,
      externalEffectCallsAdded: 0,
    },
    proofRoot,
    claimBoundary:
      'This is same-host local evidence from one Mission identity, real installed Qoder/Qwen3.8-Max and Claude Code/deepseek-v4-pro processes, a controlled provider termination, a real native Claude pre-tool Hook, deterministic verifiers, a local queryable HTTP target with controller SIGKILL, Git worktrees, and standalone CI. It proves the listed workflow only in this controlled fixture. The provider termination and exit-17 tool probe are deliberately induced observation boundaries. Scenario reruns use a Planner-selected Profile-Rebound from the source Claude Profile to a separately declared higher-reasoning Claude Profile with the same native tool-control capability, while changing only the accepted Context intervention. It does not claim production adoption, cross-host execution, provider-internal Context capture, organizational approval, publication, or independent third-party reproduction.',
  };
  if (outputFile === undefined) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  else writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
} finally {
  cleanupHoldProcess(promptV1Marker);
  if (crashController !== undefined) crashController.process.kill('SIGKILL');
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (app !== undefined) await app.close().catch(() => undefined);
  if (targetFixture !== undefined) await targetFixture.close().catch(() => undefined);
}

function explicitPlanDraftPayload(sourceFile, workspacePath, verifierPath) {
  const document = parseYaml(readFileSync(sourceFile, 'utf8'));
  if (!document || typeof document !== 'object' || !Array.isArray(document.attemptPlan)) {
    throw new Error('The flagship fixture is not a valid Mission document.');
  }
  assertFlagshipProfileReboundStages(document.attemptPlan);
  return {
    title: document.title,
    objective: document.objective,
    workspace: workspacePath,
    context: document.context,
    constraints: document.constraints ?? [],
    acceptanceCriteria: document.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verifier: {
        executable: criterion.verifier.executable,
        args: (criterion.verifier.args ?? []).map((argument) =>
          argument === '${HIDDEN_VERIFIER}' ? verifierPath : argument,
        ),
        timeoutMs: criterion.verifier.timeoutMs,
      },
    })),
    stages: document.attemptPlan.map((stage) => ({
      stageId: stage.stageId,
      harness: stage.profile.harness,
      model: stage.profile.model,
      ...(stage.profile.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: stage.profile.reasoningEffort }),
      ...(stage.profile.permissionMode === undefined
        ? {}
        : { permissionMode: stage.profile.permissionMode }),
      injectionBudgetTokens: stage.profile.injectionBudgetTokens,
      instruction: stage.instruction,
      ...(stage.breakpoint === undefined ? {} : { breakpoint: stage.breakpoint }),
      ...(stage.onFailure === undefined ? {} : { onFailure: stage.onFailure }),
    })),
    plan: document.plan,
  };
}

function assertFlagshipProfileReboundStages(attemptPlan) {
  const source = single(
    attemptPlan.filter((stage) => stage.stageId === 'claude-prompt'),
    'flagship source Claude stage',
  );
  const target = single(
    attemptPlan.filter((stage) => stage.stageId === 'claude-regression-upgraded'),
    'flagship upgraded Claude stage',
  );
  if (
    source.profile?.harness !== 'claude' ||
    target.profile?.harness !== 'claude' ||
    source.breakpoint !== 'mutable-tools' ||
    target.breakpoint !== 'mutable-tools' ||
    source.profile.model !== target.profile.model ||
    source.profile.reasoningEffort !== 'medium' ||
    target.profile.reasoningEffort !== 'high' ||
    !(target.profile.injectionBudgetTokens > source.profile.injectionBudgetTokens)
  ) {
    throw new Error(
      'Flagship Profile-Rebound must preserve native Claude tool control while selecting a distinct higher-reasoning Profile.',
    );
  }
}

async function waitForLegacyWithToolGates({
  baseUrl,
  missionId,
  browser: client,
  gateway,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mission = await missionSummary(baseUrl, missionId);
    const gates = await pendingToolGates(missionId);
    for (const gate of gates) {
      if (gateway.handled.has(gate.gateId)) continue;
      if (gate.toolName === 'Write' && isOriginalWrite(gate.toolInput)) {
        if (gateway.modified !== undefined) {
          throw new Error('Claude requested the controlled original Write more than once.');
        }
        if (existsSync(join(workspace, 'original.txt'))) {
          throw new Error('The original Write dispatched before its decision.');
        }
        await waitForBrowserGate(client, gate.gateId);
        const updatedInput = modifiedWriteInput(gate.toolInput, join(workspace, 'approved.txt'));
        const clicked = await clickGate(client, gate.gateId, 'modify', updatedInput);
        if (!clicked.clicked) throw new Error('Workbench could not modify the native Write.');
        await waitForGateRelease(missionId, gate.gateId, 60_000);
        gateway.modified = {
          attemptId: gate.attemptId,
          gateId: gate.gateId,
          effectId: gate.effectId,
          requestSha256: gate.requestSha256,
          originalInput: gate.toolInput,
          updatedInput,
          decision: 'modify',
        };
        gateway.decisions.push({
          gateId: gate.gateId,
          toolName: gate.toolName,
          decision: 'modify',
        });
      } else {
        await decideGate(baseUrl, missionId, gate, 'approve');
        gateway.decisions.push({
          gateId: gate.gateId,
          toolName: gate.toolName,
          decision: 'approve',
        });
      }
      gateway.handled.add(gate.gateId);
    }
    if (
      mission.receipt !== undefined &&
      (mission.operation?.phase === 'completed' || mission.operation?.phase === 'failed') &&
      gates.length === 0
    ) {
      return await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    }
    await wait(200);
  }
  throw new Error(`Flagship fallback route timed out for Mission ${missionId}.`);
}

async function pendingToolGates(missionId) {
  const engine = engineFactory(stateDir);
  try {
    if (engine.pendingToolGates === undefined) return [];
    return await engine.pendingToolGates(missionId);
  } finally {
    engine.close();
  }
}

async function missionSummary(baseUrl, missionId) {
  const collection = await requestJson(`${baseUrl}/api/v1/missions`);
  return single(
    collection.missions.filter((candidate) => candidate.missionId === missionId),
    `Mission summary ${missionId}`,
  );
}

async function approveExecutionForkGates({ baseUrl, missionId, signal, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const handled = new Set();
  const decisions = [];
  while (!signal.aborted) {
    if (Date.now() >= deadline) {
      throw new Error(`Execution Fork Tool Gate approval timed out for Mission ${missionId}.`);
    }
    const gateList = await requestJson(
      `${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}/tool-gates`,
    );
    if (signal.aborted) break;
    for (const gate of gateList.toolGates ?? []) {
      if (handled.has(gate.gateId)) continue;
      if (!gate.attemptId.startsWith('fork-attempt-')) {
        throw new Error(`Unexpected non-Fork pending Tool Gate ${gate.gateId}.`);
      }
      const originalWrite = gate.toolName === 'Write' && isOriginalWrite(gate.toolInput);
      if (originalWrite) {
        throw new Error('An Execution Fork attempted to repeat the original bootstrap Write.');
      }
      await decideGate(baseUrl, missionId, gate, 'approve');
      handled.add(gate.gateId);
      decisions.push({
        attemptId: gate.attemptId,
        gateId: gate.gateId,
        effectId: gate.effectId,
        requestSha256: gate.requestSha256,
        toolName: gate.toolName,
        decision: 'approve',
        originalWrite,
        transport: 'public-tool-gate-list-and-decision-api',
      });
    }
    await wait(150);
  }
  return decisions;
}

async function decideGate(baseUrl, missionId, gate, decision, updatedInput) {
  await requestJson(
    `${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(gate.attemptId)}/tool-gates/${encodeURIComponent(gate.gateId)}/decision`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRequestSha256: gate.requestSha256,
        decision,
        reason: 'Flagship controlled fixture decision through the public Tool Gate API.',
        ...(updatedInput === undefined ? {} : { updatedInput }),
      }),
    },
    202,
  );
}

async function waitForGateRelease(missionId, gateId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gates = await pendingToolGates(missionId);
    if (!gates.some((gate) => gate.gateId === gateId)) return;
    await wait(100);
  }
  throw new Error(`Tool Gate ${gateId} did not produce a persisted release.`);
}

function isOriginalWrite(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const path = typeof value.file_path === 'string' ? value.file_path : value.path;
  if (typeof path !== 'string') return false;
  const normalized = path.replaceAll('\\', '/');
  return normalized === 'original.txt' || normalized.endsWith('/original.txt');
}

function modifiedWriteInput(value, approvedPath) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native Write input is not an object.');
  }
  const updated = { ...value };
  if (typeof updated.file_path === 'string') updated.file_path = approvedPath;
  else if (typeof updated.path === 'string') updated.path = approvedPath;
  else throw new Error('Native Write input exposes no supported path.');
  if (typeof updated.content !== 'string') throw new Error('Native Write exposes no content.');
  updated.content = 'APPROVED\n';
  return updated;
}

async function waitForBrowserGate(client, gateId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const visible = await client.evaluate(`(() => Array.from(
      document.querySelectorAll('.tool-gate-card')
    ).some((card) => card.dataset.gateId === ${JSON.stringify(gateId)}))()`);
    if (visible) return;
    await wait(100);
  }
  throw new Error(`Workbench did not render pending gate ${gateId}.`);
}

async function clickGate(client, gateId, decision, updatedInput) {
  return await client.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.tool-gate-card')).find(
      (candidate) => candidate.dataset.gateId === ${JSON.stringify(gateId)}
    );
    if (!card) return { clicked: false };
    if (${JSON.stringify(decision)} === 'modify') {
      const editor = card.querySelector('textarea');
      if (!editor) return { clicked: false };
      editor.value = ${JSON.stringify(JSON.stringify(updatedInput, null, 2))};
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const button = card.querySelector(
      '[data-tool-gate-decision="' + ${JSON.stringify(decision)} + '"]'
    );
    if (!button) return { clicked: false };
    button.click();
    return { clicked: true };
  })()`);
}

async function selectMissionInWorkbench(client, missionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const clicked = await client.evaluate(`(() => {
      const button = document.querySelector('[data-mission-id=${JSON.stringify(missionId)}]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (clicked) return;
    await wait(100);
  }
  throw new Error('Workbench did not render the flagship Mission.');
}

async function waitForInitialParallelFrontier(baseUrl, missionId, statePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mission = await missionSummary(baseUrl, missionId);
    failOnPlanOperation({ operation: mission.operation });
    const missionPlan = await requestJson(
      `${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}/plan`,
    );
    const execution = missionPlan.execution;
    const revision = missionPlan.contractRevision;
    if (execution !== undefined && revision?.revisionNumber === 1) {
      const toolArtifact = execution.artifacts.find(
        (record) =>
          record.artifact.producedByNodeId === 'tool-implementation' &&
          record.artifact.contractRevisionId === revision.contractRevisionId,
      );
      const promptAttempt = execution.attempts.find(
        (attempt) =>
          attempt.nodeId === 'prompt-skill' &&
          attempt.contractRevisionId === revision.contractRevisionId &&
          attempt.status === 'running',
      );
      if (toolArtifact !== undefined && promptAttempt !== undefined) {
        const workspacePath = join(
          statePath,
          'worktrees',
          missionId,
          promptAttempt.attemptId.slice('attempt-'.length),
        );
        const markerPath = join(workspacePath, '.missionbraid', 'i8-prompt-attempt-ready.json');
        if (existsSync(markerPath)) {
          const value = JSON.parse(readFileSync(markerPath, 'utf8'));
          if (value.state === 'waiting-for-contract-revision') {
            return {
              mission,
              operation: mission.operation,
              missionPlan,
              promptMarker: { markerPath, workspacePath, value },
            };
          }
        }
      }
    }
    await wait(500);
  }
  throw new Error('Timed out waiting for parallel Qoder artifact and active Claude v1.');
}

async function waitForPlanCompletion(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mission = await missionSummary(baseUrl, missionId);
    failOnPlanOperation({ operation: mission.operation });
    if (
      mission.operation?.phase === 'completed' &&
      mission.operation?.resultStatus === 'succeeded' &&
      mission.receipt?.outcome === 'verified'
    ) {
      return await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    }
    await wait(500);
  }
  throw new Error(`Mission ${missionId} Plan execution timed out.`);
}

function failOnPlanOperation(detail) {
  if (detail.operation?.phase === 'failed' || detail.operation?.phase === 'interrupted') {
    throw new Error(
      `Plan operation ${detail.operation.phase}: ${detail.operation.error ?? 'unknown error'}`,
    );
  }
  if (detail.operation?.phase === 'completed' && detail.operation?.resultStatus !== 'succeeded') {
    throw new Error(
      `Plan operation ended ${detail.operation.resultStatus ?? 'without a result'}: ${detail.operation.error ?? 'unknown error'}`,
    );
  }
}

async function startQueryableTarget() {
  const records = new Map();
  const calls = [];
  let posts = 0;
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
      posts += 1;
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
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Target did not bind TCP.');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    postCount: () => posts,
    calls: () => [...calls],
    close: async () =>
      await new Promise((resolvePromise, reject) =>
        server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
      ),
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function respondJson(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

async function startCrashingController(directory, targetUrl, targetId) {
  const child = spawn(
    process.execPath,
    [
      join(repositoryRoot, 'scripts', 'i4-external-effect-controller.mjs'),
      directory,
      targetUrl,
      targetId,
    ],
    { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolveCompleted, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveCompleted({ code, signal, stdout, stderr }));
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'));
    if (line !== undefined) {
      const ready = JSON.parse(line);
      return { process: child, completed, url: ready.url };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Crash controller exited early: ${stderr}`);
    }
    await wait(25);
  }
  child.kill('SIGKILL');
  throw new Error(`Crash controller did not become ready: ${stderr}`);
}

async function expectControllerCrash(request, completion) {
  const [requestResult, controller] = await Promise.all([
    request.then(
      (response) => ({ response }),
      (error) => ({ error }),
    ),
    completion,
  ]);
  if (requestResult.response !== undefined) {
    throw new Error(`Crash controller unexpectedly returned ${requestResult.response.status}.`);
  }
  if (controller.signal !== 'SIGKILL') {
    throw new Error(`Controller did not exit through SIGKILL: ${stableJson(controller)}`);
  }
}

function controlledProviderSource({ realExecutable, controlledWorkspace, providerLog: logFile }) {
  return `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const realExecutable = ${JSON.stringify(realExecutable)};
const controlledWorkspace = ${JSON.stringify(realpathSync(controlledWorkspace))};
const logFile = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
const workspace = realpathSync(process.cwd());
const append = (event) => appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), workspace, ...event }) + '\\n', 'utf8');
if (args.length === 1 && args[0] === '--version') {
  const probe = spawnSync(realExecutable, args, { cwd: workspace, env: process.env, encoding: 'utf8', shell: false });
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  append({ kind: 'provider.probe', controlled: false, status: probe.status, signal: probe.signal });
  process.exit(probe.status ?? 1);
}

const controlled = workspace === controlledWorkspace;
const child = spawn(realExecutable, args, {
  cwd: workspace,
  env: process.env,
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
append({ kind: 'provider.spawned', controlled, realPid: child.pid, args });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let exited = false;
let markerObserved = false;
let terminationRequested = false;
let forceTimer;
const marker = resolve(workspace, 'handoff-qoder.txt');
const monitor = controlled
  ? setInterval(() => {
      if (markerObserved || !existsSync(marker)) return;
      if (readFileSync(marker, 'utf8') !== 'qoder-observed\\n') return;
      markerObserved = true;
      append({ kind: 'provider.marker_observed', marker: 'handoff-qoder.txt' });
      setTimeout(() => {
        if (exited || terminationRequested) return;
        terminationRequested = true;
        append({ kind: 'provider.termination_requested', signal: 'SIGTERM', reason: 'controlled-boundary-after-qoder-observation' });
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { child.kill('SIGTERM'); }
        forceTimer = setTimeout(() => {
          if (exited) return;
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }, 5_000);
      }, 350);
    }, 10)
  : undefined;
monitor?.unref();
child.once('error', (error) => append({ kind: 'provider.child_error', code: error.code ?? null, message: error.message }));
child.once('exit', (code, signal) => {
  exited = true;
  if (monitor !== undefined) clearInterval(monitor);
  if (forceTimer !== undefined) clearTimeout(forceTimer);
  process.stdin.unpipe(child.stdin);
  child.stdin.destroy();
  const wrapperExitCode = controlled ? (markerObserved ? 86 : 87) : (code ?? 1);
  append({ kind: 'provider.child_exit', controlled, code, signal, markerObserved, terminationRequested, wrapperExitCode });
  process.exitCode = wrapperExitCode;
});
`;
}

function assertProfileReboundKernelBindings(detail, rerun) {
  for (const trial of rerun.trials) {
    const binding = single(
      detail.timeline.filter(
        (entry) => entry.kind === 'attempt.bound' && entry.attemptId === trial.attemptId,
      ),
      `Profile-Rebound binding ${trial.bindingId}`,
    );
    const started = single(
      detail.timeline.filter(
        (entry) => entry.kind === 'attempt.started' && entry.attemptId === trial.attemptId,
      ),
      `Profile-Rebound Attempt ${trial.attemptId}`,
    );
    const executionFork = single(
      detail.executionForks.filter(
        (candidate) => candidate.lineage.childBranchId === trial.branchId,
      ),
      `Profile-Rebound Fork ${trial.branchId}`,
    );
    if (
      binding.data?.bindingId !== trial.bindingId ||
      binding.data?.profileId !== rerun.targetProfileId ||
      started.data?.profileId !== rerun.targetProfileId ||
      executionFork.lineage.profileId !== rerun.sourceProfileId ||
      executionFork.lineage.sourceProfileId !== rerun.sourceProfileId ||
      executionFork.lineage.targetProfileId !== rerun.targetProfileId ||
      executionFork.lineage.targetStageId !== rerun.targetStageId ||
      executionFork.lineage.profileSelection?.selectionId !== rerun.profileSelectionId
    ) {
      throw new Error(
        `Kernel Profile-Rebound identity mismatch for trial ${String(trial.trialIndex)}.`,
      );
    }
  }
}

function durableIdentities(detail, scenarioCollection, rerunRecord, selection) {
  const plan = detail.missionPlan;
  return {
    missionId: detail.mission.missionId,
    receiptId: detail.mission.receipt?.receiptId ?? null,
    checkpointIds: (detail.compositeCheckpoints ?? []).map((item) => item.checkpointId).sort(),
    forkIds: (detail.executionForks ?? []).map((item) => item.forkId).sort(),
    contractRevisionId: plan?.contractRevision?.contractRevisionId ?? null,
    planRevisionId: plan?.planRevision?.planRevisionId ?? null,
    planAttemptIds: (plan?.execution?.attempts ?? []).map((item) => item.attemptId).sort(),
    artifactIds: (plan?.execution?.artifacts ?? []).map((item) => item.artifact.artifactId).sort(),
    consolidationIds: (plan?.execution?.consolidations ?? [])
      .map((item) => item.plan.consolidationId)
      .sort(),
    scenarioIds: (scenarioCollection.scenarios ?? []).map((item) => item.scenarioId).sort(),
    ciResultIds: (scenarioCollection.ciResults ?? []).map((item) => item.resultId).sort(),
    rerunId: rerunRecord?.runId ?? null,
    selectionId: selection.selectionId,
  };
}

function requireReadyRuntime(inventory, runtimeId) {
  const runtime = inventory.runtimes?.find((candidate) => candidate.id === runtimeId);
  if (runtime?.status !== 'ready-supported') {
    throw new Error(`${runtimeId} is not execution-ready: ${runtime?.reason ?? 'missing'}`);
  }
  return runtime;
}

function requireTimeline(detail, kind) {
  return single(
    detail.timeline.filter((entry) => entry.kind === kind),
    kind,
  );
}

function cleanupHoldProcess(marker) {
  const pid = marker?.value?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

function commandPath(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8', shell: false });
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`${command} is unavailable: ${result.stderr}`);
  }
  return realpathSync(result.stdout.trim());
}

function spawnCommand(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function git(cwd, args) {
  return run('git', ['-C', cwd, ...args]).stdout.trim();
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnCommand(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function requestJson(url, options = {}, expectedStatus = 200) {
  const target = new URL(url);
  if (target.protocol !== 'http:') {
    throw new Error(`Local flagship client only supports HTTP URLs: ${url}`);
  }
  const requestBody =
    options.body === undefined
      ? undefined
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body);
  const headers = {
    ...(options.headers ?? {}),
    ...(requestBody === undefined ? {} : { 'content-length': String(requestBody.byteLength) }),
  };
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      target,
      {
        method: options.method ?? 'GET',
        headers,
        signal: options.signal,
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on('error', rejectResponse);
        incoming.on('end', () => {
          resolveResponse({
            status: incoming.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', rejectResponse);
    request.end(requestBody);
  });
  const text = response.text;
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 1_000)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON response: ${text.slice(0, 500)}`);
  }
  return body;
}

function single(values, label) {
  if (values.length !== 1) {
    throw new Error(`${label} expected exactly one value, received ${values.length}.`);
  }
  return values[0];
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

function progress(message) {
  process.stderr.write(`[flagship] ${message}\n`);
}
