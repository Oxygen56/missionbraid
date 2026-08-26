#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  captureImplementationSource,
  completeFreshBuildImplementation,
} from './implementation-binding.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const adjacentCiOutputFile =
  outputFile === undefined
    ? undefined
    : join(dirname(outputFile), 'iteration-9-outcome-ci-result.json');
const implementationSource = captureImplementationSource(repositoryRoot, [
  outputFile,
  adjacentCiOutputFile,
]);
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i9-regression-'));
const stateDir = join(proofRoot, 'state');
const workspace = join(proofRoot, 'mission-workspace');
const hiddenVerifier = join(proofRoot, 'hidden-context-verifier.mjs');
const externalRunnerSource = join(
  repositoryRoot,
  'examples',
  'i9-outcome-regression-fixture',
  'ci',
  'check-outcome-ci.mjs',
);

progress('Building the exact source tree used by the Iteration 9 proof');
run('pnpm', ['build'], repositoryRoot);
if (!existsSync(join(repositoryRoot, 'dist', 'src', 'outcome-studio.js'))) {
  throw new Error('The fresh build did not produce Outcome Studio.');
}
const implementation = completeFreshBuildImplementation(repositoryRoot, implementationSource, [
  outputFile,
  adjacentCiOutputFile,
]);

run(
  process.execPath,
  [join(repositoryRoot, 'scripts', 'prepare-i7-stale-context-fixture.mjs'), workspace],
  repositoryRoot,
);
writeFileSync(
  hiddenVerifier,
  `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(readFileSync(join(process.cwd(), 'agent-config.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(process.cwd(), 'context-source.json'), 'utf8'));
if (config.requiredPrefix !== source.requiredPrefix) process.exit(1);
process.stdout.write('Agent behavior matches the current controller source.\\n');
`,
  { encoding: 'utf8', mode: 0o700 },
);

const { snapshotGitWorkspace } = await import('../dist/src/workspace.js');
const { CONTEXT_CACHE_SCHEMA_VERSION } = await import('../dist/src/context-binding.js');
const { startMissionBraidApp } = await import('../dist/src/app.js');
const studio = await import('../dist/src/outcome-studio.js');

const baseline = snapshotGitWorkspace(workspace);
mkdirSync(join(workspace, '.missionbraid'), { recursive: true });
writeFileSync(
  join(workspace, '.missionbraid', 'context-cache.json'),
  `${JSON.stringify(
    {
      schemaVersion: CONTEXT_CACHE_SCHEMA_VERSION,
      contextFactId: 'agent-behavior-source',
      boundWorkspaceDigest: baseline.workspaceDigest,
      content: '{"requiredPrefix":"OLD:","source":"baseline"}',
    },
    null,
    2,
  )}\n`,
  { encoding: 'utf8', mode: 0o600 },
);
writeFileSync(
  join(workspace, 'context-source.json'),
  '{"requiredPrefix":"SOURCE:","source":"current"}\n',
  'utf8',
);
git(workspace, ['add', 'context-source.json']);
git(workspace, [
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'advance Context source for I9 incident',
]);

let app;
let restarted;
try {
  app = await startMissionBraidApp({ stateDir, port: 0 });
  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const runtime = inventory.runtimes.find((candidate) => candidate.id === 'qoder');
  if (runtime?.status !== 'ready-supported') {
    throw new Error(`Qoder is not execution-ready: ${runtime?.reason ?? 'missing'}`);
  }

  const created = await requestJson(
    `${app.url}/api/v1/missions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(missionInput(workspace, hiddenVerifier)),
    },
    202,
  );
  const initial = await waitForMission(app.url, created.missionId, 20 * 60_000);
  if (
    initial.mission.status !== 'failed' ||
    initial.attempts?.[0]?.status !== 'succeeded' ||
    initial.mission.receipt?.outcome !== 'rejected' ||
    initial.mission.receipt?.verifications?.[0]?.status !== 'failed'
  ) {
    throw new Error('The original real Agent did not produce the required false-success incident.');
  }
  progress(
    'Original real Qoder Attempt exited successfully; deterministic verification rejected it',
  );

  const runtimeFrontier = snapshotGitWorkspace(workspace);
  if (
    runtimeFrontier.status.length !== 1 ||
    runtimeFrontier.status[0]?.path !== 'agent-config.json'
  ) {
    throw new Error('Original Runtime left an unexpected workspace delta.');
  }
  git(workspace, ['add', '--', 'agent-config.json']);
  git(workspace, [
    '-c',
    'user.name=MissionBraid',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'seal I9 incident checkpoint',
  ]);
  const checkpointResponse = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/checkpoints`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
    201,
  );
  const checkpoint = checkpointResponse.checkpoint;
  if (checkpoint?.workspace?.state !== 'restorable-artifact') {
    throw new Error('The incident did not produce a restorable source Checkpoint.');
  }
  const diagnosticView = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  const candidate = diagnosticView.failureIntelligence?.graph?.candidates?.find(
    (item) => item.detector === 'stale-context',
  );
  const freshness = initial.timeline.find((entry) => entry.kind === 'context.freshness')?.data;
  if (
    candidate === undefined ||
    typeof freshness?.boundContextDigest !== 'string' ||
    typeof freshness?.currentContextDigest !== 'string'
  ) {
    throw new Error('The incident did not retain a runnable stale-Context diagnosis.');
  }
  const intervention = {
    interventionId: `intervention-i9-${randomUUID()}`,
    kind: 'context',
    targetRef: 'context:agent-behavior-source',
    beforeDigest: freshness.boundContextDigest,
    afterDigest: freshness.currentContextDigest,
    description:
      'Refresh the declared Agent behavior Context and keep Contract, authority, tools, and workspace boundary unchanged.',
    authorityChange: 'unchanged',
  };
  const forkResponse = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/failure-intelligence/${encodeURIComponent(candidate.candidateId)}/forks`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checkpointId: checkpoint.checkpointId, intervention }),
    },
    201,
  );
  if (
    forkResponse.executionFork?.runtimeResult?.status !== 'completed' ||
    forkResponse.receipt?.outcome !== 'verified'
  ) {
    throw new Error('The revised real Agent Branch did not verify.');
  }
  const revised = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  const view = revised.outcomeStudio;
  if (
    view?.comparison?.branchIds?.length !== 2 ||
    view.comparison.contractId !== initial.mission.contract.contractId ||
    view.branch?.evaluation?.eventHeadHash !== revised.mission.receipt.verifiedHeadHash ||
    view.branch?.checkpointId !== checkpoint.checkpointId
  ) {
    throw new Error('Outcome Studio did not compare terminal Branch evidence under one Contract.');
  }
  const rootBranchId = initial.mission.rootBranchId;
  const rootView = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio?branchId=${encodeURIComponent(rootBranchId)}`,
  );
  if (
    rootView.branch?.agentReported?.status !== 'reported-success' ||
    rootView.studioReceipt?.completion?.verified !== 'rejected' ||
    view.studioReceipt?.completion?.verified !== 'verified' ||
    rootView.agentRevision?.revisionId === view.agentRevision?.revisionId
  ) {
    throw new Error('False-success separation or content-addressed Agent Revision failed.');
  }
  const selected = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/selections`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branchId: view.branch.branchId,
        authorityKind: 'human',
        authorityRef: 'developer:local-i9-proof',
      }),
    },
    201,
  );
  const persistedSelections = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/selections`,
  );
  if (
    !persistedSelections.selections?.some(
      (selection) => selection.selectionId === selected.selectionId,
    )
  ) {
    throw new Error('The human Branch selection was not durably visible through Workbench.');
  }
  await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/scenarios`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchId: view.branch.branchId }),
    },
    201,
  );
  const saved = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/scenarios`,
  );
  const savedScenario = saved.scenarios?.[0];
  if (savedScenario?.executionPlan === null || savedScenario?.executionPlan === undefined) {
    throw new Error('Workbench saved a passive snapshot instead of an executable scenario.');
  }
  progress('Workbench saved an executable incident and a human selected the verified Branch');

  const executableScenario = savedScenario;
  const stochasticSuite = executableScenario.executionPlan.evaluationSuite;
  const upgradedCandidate = diagnosticView.executionPlanner?.candidates?.find(
    (candidate) => candidate.stageId === 'qoder-agent-context-upgraded',
  );
  if (
    executableScenario.sourceAgentRevisionId !== rootView.agentRevision.revisionId ||
    typeof upgradedCandidate?.profileDefinition?.definitionId !== 'string' ||
    stochasticSuite.criteria.some(
      (criterion) =>
        criterion.mode !== 'stochastic-model' ||
        criterion.trialCount !== 3 ||
        criterion.threshold?.value !== 1,
    )
  ) {
    throw new Error(
      'The saved incident did not predeclare the original Revision and 3/3 threshold.',
    );
  }
  const runEndpoint = `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/scenarios/${encodeURIComponent(executableScenario.scenarioId)}/runs`;
  const rerun = await requestJson(
    runEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetStageId: upgradedCandidate.stageId,
        targetProfileDefinitionId: upgradedCandidate.profileDefinition.definitionId,
      }),
    },
    201,
  );
  const trialResults = rerun.trials;
  const regressionBranchId = rerun.targetBranchId;
  if (
    trialResults?.length !== 3 ||
    new Set(trialResults.map((trial) => trial.branchId)).size !== 3 ||
    new Set(trialResults.map((trial) => trial.attemptId)).size !== 3 ||
    new Set(trialResults.map((trial) => trial.bindingId)).size !== 3 ||
    new Set(trialResults.map((trial) => trial.sourceProfileId)).size !== 1 ||
    new Set(trialResults.map((trial) => trial.targetProfileId)).size !== 1 ||
    new Set(trialResults.map((trial) => trial.profileSelectionId)).size !== 1 ||
    trialResults.some(
      (trial) =>
        trial.sourceProfileId === trial.targetProfileId ||
        trial.targetStageId !== upgradedCandidate.stageId ||
        trial.receiptOutcome !== 'verified' ||
        trial.runtimeEvidenceRefs.length === 0 ||
        trial.criterionEvidenceRefs.length === 0 ||
        trial.retainedArtifactRefs.length === 0,
    )
  ) {
    throw new Error('Workbench rerun did not persist three complete Kernel Runtime trials.');
  }
  if (rerun.receipt.completion.verified !== 'verified') {
    throw new Error('Repeated real Runtime trials did not produce a verified rerun Receipt.');
  }
  if (
    rerun.receipt.runtimeProfileBinding?.sourceProfileId !== rerun.sourceProfileId ||
    rerun.receipt.runtimeProfileBinding?.targetProfileId !== rerun.targetProfileId ||
    rerun.receipt.runtimeProfileBinding?.profileSelectionId !== rerun.profileSelectionId ||
    JSON.stringify(rerun.receipt.runtimeProfileBinding) !==
      JSON.stringify(rerun.ciResult.runtimeProfileBinding)
  ) {
    throw new Error('Outcome Receipt or CI result did not bind the Profile-Rebound identity.');
  }
  const threshold = rerun.evaluation.criteria[0]?.thresholdEvaluation;
  if (
    threshold?.status !== 'passed' ||
    threshold.knownTrials !== 3 ||
    threshold.totalTrials !== 3 ||
    threshold.observedValue !== 1
  ) {
    throw new Error('The predeclared stochastic threshold did not pass 3/3 real trials.');
  }

  const ciResultFile = join(proofRoot, 'outcome-ci-result.json');
  writeFileSync(ciResultFile, `${JSON.stringify(rerun.ciResult, null, 2)}\n`, 'utf8');
  const externalRunner = join(proofRoot, 'external-ci-runner.mjs');
  copyFileSync(externalRunnerSource, externalRunner);
  const externalPass = spawn(process.execPath, [externalRunner, ciResultFile], proofRoot);
  if (externalPass.status !== 0) {
    throw new Error(`External CI runner rejected the retained result: ${externalPass.stderr}`);
  }
  const negative = await negativeCiResults({
    studio,
    scenario: executableScenario,
    upgradedRevision: (
      await requestJson(
        `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio?branchId=${encodeURIComponent(regressionBranchId)}`,
      )
    ).agentRevision,
    dimensions: (
      await requestJson(
        `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio?branchId=${encodeURIComponent(regressionBranchId)}`,
      )
    ).branch.dimensions,
    runtimeProfileBinding: rerun.receipt.runtimeProfileBinding,
  });
  const failedFile = join(proofRoot, 'outcome-ci-failed.json');
  const unknownFile = join(proofRoot, 'outcome-ci-unknown.json');
  writeFileSync(failedFile, `${JSON.stringify(negative.failed, null, 2)}\n`, 'utf8');
  writeFileSync(unknownFile, `${JSON.stringify(negative.unknown, null, 2)}\n`, 'utf8');
  const externalFailed = spawn(process.execPath, [externalRunner, failedFile], proofRoot);
  const externalUnknown = spawn(process.execPath, [externalRunner, unknownFile], proofRoot);
  if (externalFailed.status !== 1 || externalUnknown.status !== 1) {
    throw new Error('External CI runner did not fail closed for failed and unknown outcomes.');
  }
  progress('Three persisted Kernel Qoder trials passed; standalone CI enforced pass/fail/unknown');

  const completedMission = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  const trialAttemptIds = new Set(trialResults.map((trial) => trial.attemptId));
  const targetAttemptBindings = completedMission.timeline
    .filter(
      (entry) =>
        entry.kind === 'attempt.bound' &&
        trialAttemptIds.has(entry.attemptId) &&
        entry.data?.profileId === rerun.targetProfileId &&
        entry.data?.planNodeId === rerun.targetStageId,
    )
    .map((entry) => ({
      attemptId: entry.attemptId,
      bindingId: entry.data.bindingId,
      profileId: entry.data.profileId,
      targetStageId: entry.data.planNodeId,
    }));
  const targetAttemptStarts = completedMission.timeline.filter(
    (entry) =>
      entry.kind === 'attempt.started' &&
      trialAttemptIds.has(entry.attemptId) &&
      entry.data?.profileId === rerun.targetProfileId &&
      entry.data?.stageId === rerun.targetStageId,
  );
  if (targetAttemptBindings.length !== 3 || targetAttemptStarts.length !== 3) {
    throw new Error('Kernel Attempt/Binding evidence did not use the selected target Profile.');
  }
  const finalHead = completedMission.mission.headHash;
  await app.close();
  app = undefined;
  restarted = await startMissionBraidApp({ stateDir, port: 0 });
  const restored = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  const restoredScenarios = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/scenarios`,
  );
  const restoredRuns = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/scenarios/${encodeURIComponent(executableScenario.scenarioId)}/runs`,
  );
  if (
    restored.mission.headHash !== finalHead ||
    restoredScenarios.scenarios?.[0]?.scenarioId !== savedScenario.scenarioId ||
    restoredScenarios.ciResults?.some((result) => result.resultId === rerun.ciResult.resultId) !==
      true ||
    restoredRuns.runs?.some((run) => run.runId === rerun.runId) !== true
  ) {
    throw new Error(
      'Restart lost the Mission, saved incident, Kernel trials, Receipt, or CI result.',
    );
  }

  const knownComparisonDimensions = view.comparison.dimensions.filter(
    (dimension) => dimension.status !== 'unknown',
  );
  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-9-outcome-regression/v1',
    evidenceLevel: 'same-host-local-real-runtime-controlled-fixture',
    generatedAt: new Date().toISOString(),
    missionId: created.missionId,
    implementation,
    reusableFlagship: {
      missionId: created.missionId,
      stateDir,
      workspace,
      rootBranchId,
      revisedBranchId: view.branch.branchId,
      regressionBranchId,
      savedScenarioId: savedScenario.scenarioId,
      executableScenarioId: executableScenario.scenarioId,
      kernelRerunId: rerun.runId,
    },
    environment: {
      nodeVersion: process.version,
      qoderVersion: runtime.version ?? 'unknown',
    },
    originalAndRevised: {
      contractId: view.comparison.contractId,
      evaluationSuiteId: view.comparison.suiteId,
      rootBranchId,
      revisedBranchId: view.branch.branchId,
      sourceCheckpointId: checkpoint.checkpointId,
      originalAgentRevisionId: rootView.agentRevision.revisionId,
      revisedAgentRevisionId: view.agentRevision.revisionId,
      originalAgentReported: rootView.branch.agentReported.status,
      originalReceiptOutcome: initial.mission.receipt.outcome,
      originalCriterionStatus: initial.mission.receipt.verifications[0].status,
      revisedReceiptOutcome: revised.mission.receipt.outcome,
      revisedCriterionStatus: revised.mission.receipt.verifications[0].status,
      revisedTerminalHeadHash: revised.mission.receipt.verifiedHeadHash,
      branchEvaluationHeadHash: view.branch.evaluation.eventHeadHash,
      sourceCheckpointHeadHash: checkpoint.eventPrefix.headHash,
      knownComparisonDimensions: knownComparisonDimensions.map((dimension) => ({
        dimension: dimension.dimension,
        status: dimension.status,
      })),
    },
    selection: selected,
    incident: {
      savedScenarioId: savedScenario.scenarioId,
      executableScenarioId: executableScenario.scenarioId,
      sourceAgentRevisionId: executableScenario.sourceAgentRevisionId,
      executionRunner: executableScenario.executionPlan.runner,
      suiteId: stochasticSuite.suiteId,
      suiteHash: stochasticSuite.suiteHash,
      trialCount: stochasticSuite.criteria[0].trialCount,
      threshold: stochasticSuite.criteria[0].threshold,
      predeclaredBeforeTrials: true,
    },
    upgradedRuntimeBehaviorProfile: {
      sourceProfileId: rerun.sourceProfileId,
      profileId: rerun.targetProfileId,
      targetStageId: rerun.targetStageId,
      targetProfileDefinitionId: rerun.targetProfileDefinitionId,
      profileSelectionId: rerun.profileSelectionId,
      receiptRuntimeProfileBinding: rerun.receipt.runtimeProfileBinding,
      ciRuntimeProfileBinding: rerun.ciResult.runtimeProfileBinding,
      kernelTargetBindings: targetAttemptBindings,
      sourceAgentRevisionId: executableScenario.sourceAgentRevisionId,
      targetAgentRevisionId: rerun.targetAgentRevisionId,
      changedBehaviorInput:
        'controller-refreshed Context Intervention on a Planner-selected high-reasoning Qoder Runtime Profile',
    },
    realKernelTrials: trialResults,
    rerun: {
      targetAgentRevisionId: rerun.targetAgentRevisionId,
      targetProfileId: rerun.targetProfileId,
      evaluationId: rerun.evaluation.evaluationId,
      thresholdEvaluation: threshold,
      receiptId: rerun.receipt.receiptId,
      verified: rerun.receipt.completion.verified,
      unresolvedItems: rerun.receipt.unresolvedItems,
      ciResultId: rerun.ciResult.resultId,
      ciStatus: rerun.ciResult.status,
      regression: rerun.ciResult.regression,
    },
    externalCi: {
      runnerCopiedOutsideRepository: true,
      retainedExitCode: externalPass.status,
      retainedReport: JSON.parse(externalPass.stdout),
      failedExitCode: externalFailed.status,
      failedReport: JSON.parse(externalFailed.stdout),
      unknownExitCode: externalUnknown.status,
      unknownReport: JSON.parse(externalUnknown.stdout),
    },
    machineResult: rerun.ciResult,
    restart: {
      stableMissionHead: restored.mission.headHash === finalHead,
      stableSavedScenario:
        restoredScenarios.scenarios?.[0]?.scenarioId === savedScenario.scenarioId,
      stableKernelRerun: restoredRuns.runs?.some((run) => run.runId === rerun.runId) === true,
      stableCiResult:
        restoredScenarios.ciResults?.some(
          (result) => result.resultId === rerun.ciResult.resultId,
        ) === true,
    },
    claimBoundary:
      'This is same-host local evidence from a controlled disposable Git fixture and real Qoder/Qwen3.8-Max processes. It proves one original false-success Attempt, one revised verified MissionBraid Branch under the same Contract and controlling deterministic Suite, a separate human Branch selection, an executable saved incident, and three new Kernel-persisted Branch/Attempt/Binding Runtime trials rebound from the immutable source Checkpoint Profile to one distinct Planner-selected declared high-reasoning Qoder Profile. It also proves a predeclared 3/3 stochastic threshold, deterministic verifier evidence, restart recovery, and a standalone external process that exits nonzero for returned or unknown results. It does not establish provider-internal Context capture, production reliability, cross-host execution, deployment approval, or publication authority.',
  };
  if (outputFile === undefined) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  else {
    writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    writeFileSync(adjacentCiOutputFile, `${JSON.stringify(rerun.ciResult, null, 2)}\n`, 'utf8');
  }
} finally {
  if (app !== undefined) await app.close().catch(() => {});
  if (restarted !== undefined) await restarted.close().catch(() => {});
}

function missionInput(workspacePath, verifierPath) {
  return {
    title: 'Repair and retain a stale Agent Context incident',
    objective:
      'Use the visible Context Snapshot to configure Agent behavior; deterministic verification decides the outcome.',
    workspace: workspacePath,
    context: {
      factId: 'agent-behavior-source',
      source: 'context-source.json',
      snapshot: '.missionbraid/context-cache.json',
    },
    constraints: [
      'Change only agent-config.json',
      'Use the visible MissionBraid Context Snapshot as the accepted task input',
      'Do not inspect the controller-owned current source or hidden verifier',
    ],
    verifier: { executable: 'node', args: [verifierPath], timeoutMs: 30_000 },
    stages: [
      {
        stageId: 'qoder-agent-context',
        harness: 'qoder',
        model: 'Qwen3.8-Max',
        reasoningEffort: 'medium',
        permissionMode: 'bypass_permissions',
        injectionBudgetTokens: 2_400,
        instruction:
          'Follow AGENTS.md exactly. Use the visible MissionBraid Context Snapshot, run node --test, change only agent-config.json, run node --test again, and stop. Do not inspect context-source.json or the hidden verifier.',
      },
      {
        stageId: 'qoder-agent-context-upgraded',
        harness: 'qoder',
        model: 'Qwen3.8-Max',
        reasoningEffort: 'high',
        permissionMode: 'bypass_permissions',
        injectionBudgetTokens: 3_200,
        instruction:
          'Follow AGENTS.md exactly. Use the visible MissionBraid Context Snapshot, run node --test, change only agent-config.json, run node --test again, and stop. Do not inspect context-source.json or the hidden verifier.',
      },
    ],
  };
}

async function negativeCiResults({
  studio,
  scenario,
  upgradedRevision,
  dimensions,
  runtimeProfileBinding,
}) {
  const make = async (outcome, label) => {
    const registry = new studio.OutcomeStudioRegistry();
    const suite = scenario.executionPlan.evaluationSuite;
    const runner = suite.criteria[0].runner;
    const evaluator = suite.criteria[0].evaluators[0];
    registry.registerRunner({
      kind: runner.kind,
      version: runner.version,
      mode: 'stochastic-model',
      run: async ({ trialIndex }) => ({
        outcome,
        score: outcome === 'passed' ? 1 : 0,
        evidenceRefs: [`negative-control:${label}:${String(trialIndex)}`],
        retainedArtifactRefs: [],
      }),
    });
    registry.registerEvaluator({
      kind: evaluator.kind,
      version: evaluator.version,
      basis: 'deterministic',
      evaluate: async () => ({
        status: outcome,
        evidenceRefs: [`negative-control-audit:${label}`],
      }),
    });
    const negativeRevision = studio.createAgentRevision({
      profileId: `profile-negative-${label}`,
      attemptBindingId: `binding-negative-${label}`,
      dimensions: upgradedRevision.dimensions.map((dimension) => ({
        dimension: dimension.dimension,
        fidelity: dimension.fidelity,
        ...(dimension.contentDigest === null
          ? {}
          : { contentDigest: `${dimension.contentDigest}-${label}` }),
        evidenceRefs: dimension.evidenceRefs,
        ...(dimension.reason === null ? {} : { reason: dimension.reason }),
      })),
      policyEvidence: upgradedRevision.policyEvidence,
    });
    const branchId = `branch-negative-${label}`;
    return (
      await studio.rerunIncidentScenario({
        scenario,
        registry,
        target: {
          branchId,
          contractId: scenario.contractId,
          agentRevision: negativeRevision,
          checkpointId: scenario.sourceCheckpointId,
          eventHeadHash: `sha256:${sha256(label)}`,
          eventThroughSeq: 3,
          scenarioId: scenario.scenarioId,
        },
        lineageBranchIds: ['branch-regression-source', branchId],
        dimensions,
        agentReported: { status: 'not-reported', evidenceRefs: [] },
        effects: [],
        runtimeProfileBinding,
        outcomePolicyVersion: 'i9-outcome-policy-v1',
        issuedAt: new Date().toISOString(),
      })
    ).ciResult;
  };
  return { failed: await make('failed', 'failed'), unknown: await make('unknown', 'unknown') };
}

async function waitForMission(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    const phase = detail.operation?.phase ?? detail.mission.status;
    if (phase === 'completed' || phase === 'failed') return detail;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Mission ${missionId} timed out.`);
}

async function requestJson(url, options, expectedStatus = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON response: ${text.slice(0, 500)}`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${String(response.status)}: ${text.slice(0, 500)}`);
  }
  return body;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function spawn(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function run(command, args, cwd) {
  const result = spawn(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(`${command} failed (${String(result.status)}): ${result.stderr}`);
  }
  return result;
}

function git(cwd, args) {
  return run('git', ['-C', cwd, ...args], repositoryRoot);
}

function progress(message) {
  process.stderr.write(`${message}\n`);
}
