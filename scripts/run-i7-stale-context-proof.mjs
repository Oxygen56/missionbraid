#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { launchHeadlessWorkbench, wait } from './headless-workbench.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
if (!existsSync(builtApp)) throw new Error('Run `pnpm build` before the Iteration 7 proof.');
const runtimeProfile = {
  harness: 'qoder',
  model: 'Qwen3.8-Max',
  reasoningEffort: 'medium',
  permissionMode: 'bypass_permissions',
};

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const implementation = inspectImplementation(repositoryRoot, outputFile);
const chromeVersion = commandOutput(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--version'],
);
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i7-stale-context-'));
const stateDir = join(proofRoot, 'state');
const workspace = join(proofRoot, 'workspace');
const hiddenVerifier = join(proofRoot, 'hidden-context-verifier.mjs');
run(process.execPath, [
  join(repositoryRoot, 'scripts', 'prepare-i7-stale-context-fixture.mjs'),
  workspace,
]);
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

const { createStageChangedPaths, snapshotGitWorkspace } = await import('../dist/src/workspace.js');
const { sanitizeNativeArtifact } = await import('../dist/src/artifact-store.js');
const { CONTEXT_CACHE_SCHEMA_VERSION } = await import('../dist/src/context-binding.js');
const { deriveFailureIntelligence } = await import('../dist/src/failure-intelligence.js');
const { startMissionBraidApp } = await import('../dist/src/app.js');

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
run('git', ['-C', workspace, 'add', 'context-source.json']);
run('git', [
  '-C',
  workspace,
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'advance Context source',
]);
const current = snapshotGitWorkspace(workspace);
if (current.workspaceDigest === baseline.workspaceDigest) {
  throw new Error('Fixture did not create a new workspace frontier for the cached Context.');
}

let app;
let restarted;
let browser;
try {
  app = await startMissionBraidApp({ stateDir, port: 0 });
  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const runtime = inventory.runtimes.find((candidate) => candidate.id === runtimeProfile.harness);
  if (runtime?.status !== 'ready-supported') {
    throw new Error(
      `${runtimeProfile.harness} is not execution-ready: ${runtime?.reason ?? 'missing'}`,
    );
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
  progress(`Stale Context Mission ${created.missionId} accepted`);
  const initial = await waitForMission(app.url, created.missionId, 20 * 60_000);
  if (initial.mission.status !== 'failed' || initial.mission.receipt?.outcome !== 'rejected') {
    throw new Error('The stale cached Context did not produce the expected rejected outcome.');
  }
  const selectedProfile = initial.timeline.find((entry) => entry.kind === 'profile.selected')?.data
    ?.profile;
  if (
    selectedProfile === undefined ||
    selectedProfile.harness !== runtimeProfile.harness ||
    selectedProfile.model !== runtimeProfile.model ||
    selectedProfile.reasoningEffort !== runtimeProfile.reasoningEffort ||
    selectedProfile.permissionMode !== runtimeProfile.permissionMode
  ) {
    throw new Error(
      `The real Runtime path did not retain the requested Qoder Runtime Profile: ${JSON.stringify(selectedProfile)}`,
    );
  }

  const freshness = initial.timeline.find((entry) => entry.kind === 'context.freshness');
  if (
    freshness?.data?.boundWorkspaceDigest === undefined ||
    freshness.data.currentWorkspaceDigest === undefined ||
    freshness.data.boundWorkspaceDigest === freshness.data.currentWorkspaceDigest ||
    freshness.data.boundContextDigest === undefined ||
    freshness.data.currentContextDigest === undefined ||
    freshness.data.boundContextDigest === freshness.data.currentContextDigest
  ) {
    throw new Error(
      'The real Runtime path did not persist stale workspace and Context content freshness evidence.',
    );
  }
  const failedVerification = initial.timeline.find(
    (entry) => entry.kind === 'verification.completed' && entry.data?.passed === false,
  );
  if (failedVerification === undefined) {
    throw new Error('The stale Context Mission did not retain a failed deterministic verifier.');
  }

  // The native Harness can change files but cannot reliably seal Git
  // metadata. The proof controller seals the exact inspected frontier before
  // asking the Workbench to create a restorable Composite Checkpoint.
  const runtimeFrontier = snapshotGitWorkspace(workspace);
  if (
    runtimeFrontier.status.length !== 1 ||
    runtimeFrontier.status[0]?.path !== 'agent-config.json'
  ) {
    throw new Error(
      'The stale Context Runtime did not leave exactly agent-config.json as its delta.',
    );
  }
  const initialConfig = JSON.parse(readFileSync(join(workspace, 'agent-config.json'), 'utf8'));
  if (initialConfig.requiredPrefix !== 'OLD:') {
    throw new Error(
      `The stale Context Runtime did not apply the cached OLD value; observed ${String(initialConfig.requiredPrefix)}.`,
    );
  }
  run('git', ['-C', workspace, 'add', '--', 'agent-config.json']);
  run('git', [
    '-C',
    workspace,
    '-c',
    'user.name=MissionBraid',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'seal stale Context parent boundary',
  ]);
  const sealedFrontier = snapshotGitWorkspace(workspace);
  if (sealedFrontier.status.length > 0) {
    throw new Error('The stale Context parent boundary was not clean after controller sealing.');
  }

  browser = await launchHeadlessWorkbench(app.url, join(proofRoot, 'chrome-parent'));
  await selectMissionInWorkbench(browser, created.missionId);
  const checkpointClick = await browser.evaluate(`(() => {
    const button = document.querySelector('[data-create-checkpoint=${JSON.stringify(created.missionId)}]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!checkpointClick) throw new Error('Workbench could not create the stale Context Checkpoint.');
  const checkpointDetail = await waitForCheckpoint(app.url, created.missionId);
  const checkpoint = checkpointDetail.compositeCheckpoints.at(-1);
  if (
    checkpoint?.workspace?.state !== 'restorable-artifact' ||
    checkpoint.workspace.workspaceDigest !== sealedFrontier.workspaceDigest
  ) {
    throw new Error(
      'The diagnostic Checkpoint is not bound to the current clean workspace frontier.',
    );
  }

  const failure = checkpointDetail.failureIntelligence;
  const candidate = failure?.graph?.candidates?.find((item) => item.detector === 'stale-context');
  const toolCandidate = failure?.graph?.candidates?.find((item) => item.detector === 'tool-error');
  const toolProbeFacts = (failure?.failureIntelligenceInput?.persistedRuntimeFacts ?? []).filter(
    (fact) => fact.kind === 'tool_result' && fact.exitCode === 17,
  );
  const proposal = failure?.graph?.diagnosticBranchProposals?.find(
    (item) => item.candidateId === candidate?.candidateId,
  );
  if (candidate === undefined || proposal?.ready !== true) {
    throw new Error(
      'Failure Intelligence did not prepare a ready stale-context diagnostic Branch.',
    );
  }
  if (
    toolCandidate?.layer !== 'tool' ||
    toolCandidate.status !== 'observed' ||
    toolProbeFacts.length === 0 ||
    !toolCandidate.supportingEvidenceRefs.some((reference) =>
      toolProbeFacts.some(
        (fact) =>
          reference === fact.factId ||
          reference === fact.sourceRuntimeEventId ||
          reference === fact.artifact.artifactId,
      ),
    )
  ) {
    throw new Error(
      'The real Qoder run did not retain the expected exit-17 tool failure as source-linked tool-layer evidence.',
    );
  }

  const sourceContent = sanitizeNativeArtifact(
    readFileSync(join(workspace, 'context-source.json'), 'utf8'),
  ).content.trimEnd();
  const refreshedContextDigest = `sha256:${sha256(sourceContent)}`;
  const diagnostic = await submitContextDiagnosticThroughWorkbench(
    browser,
    created.missionId,
    checkpoint.checkpointId,
    candidate.candidateId,
    refreshedContextDigest,
  );
  if (!diagnostic.clicked)
    throw new Error('Workbench could not submit the Context-only diagnostic Branch.');

  const completed = await waitForExecutionFork(app.url, created.missionId, 20 * 60_000);
  const fork = completed.executionForks.find(
    (record) => record.lineage.parentCheckpointId === checkpoint.checkpointId,
  );
  if (
    fork?.phase !== 'finished' ||
    fork.runtimeResult?.status !== 'completed' ||
    completed.mission.receipt?.outcome !== 'verified' ||
    completed.mission.receipt?.branchId !== fork.lineage.childBranchId
  ) {
    throw new Error('The refreshed Context diagnostic Branch did not reach a verified Receipt.');
  }
  if (fork.baselineSnapshot === undefined || fork.futureSnapshot === undefined) {
    throw new Error('The diagnostic Branch did not retain both child workspace snapshots.');
  }
  const childChangedPaths = createStageChangedPaths(fork.baselineSnapshot, fork.futureSnapshot)
    .map((change) => change.path)
    .sort();
  if (JSON.stringify(childChangedPaths) !== JSON.stringify(['agent-config.json'])) {
    throw new Error(
      `The Context-only diagnostic Branch changed unexpected paths: ${JSON.stringify(childChangedPaths)}`,
    );
  }
  if (
    fork.lineage.intervention.kind !== 'context' ||
    fork.lineage.intervention.targetRef !== 'context:agent-behavior-source' ||
    !fork.runtimeResult.contextEvidenceRefs?.some((ref) => ref.startsWith('evidence:'))
  ) {
    throw new Error('The child Fork did not retain explicit Context refresh evidence.');
  }
  if (fork.lineage.profileId !== checkpoint.source.profileId) {
    throw new Error(
      'The diagnostic Branch changed the Runtime Profile instead of one Context input.',
    );
  }
  if (fork.lineage.contractId !== checkpoint.source.contractId) {
    throw new Error('The diagnostic Branch changed the accepted Outcome Contract.');
  }

  const finalFailure = completed.failureIntelligence;
  const confirmed = finalFailure?.graph?.candidates?.find(
    (item) => item.candidateId === candidate.candidateId,
  );
  if (confirmed?.status !== 'confirmed') {
    throw new Error(
      'Failure Intelligence did not promote the stale Context mechanism to confirmed.',
    );
  }
  const diagnosticOutcome = finalFailure?.failureIntelligenceInput?.diagnosticOutcomes?.find(
    (item) => item.candidateId === candidate.candidateId,
  );
  if (diagnosticOutcome?.result !== 'mechanism-confirmed') {
    throw new Error('The diagnostic Branch outcome was not mechanism-confirmed.');
  }

  const withoutDiagnosticOutcome = deriveFailureIntelligence({
    ...finalFailure.failureIntelligenceInput,
    diagnosticOutcomes: [],
  });
  const downgraded = withoutDiagnosticOutcome.candidates.find(
    (item) => item.candidateId === candidate.candidateId,
  );
  if (downgraded?.status !== 'inferred') {
    throw new Error(
      'Removing the decisive diagnostic outcome did not downgrade the same stale-Context conclusion to inferred.',
    );
  }

  const verifierOnlyInput = {
    persistedRuntimeFacts: (failure.failureIntelligenceInput.persistedRuntimeFacts ?? []).filter(
      (fact) => !isFailureSemanticFact(fact),
    ),
    ...(failure.failureIntelligenceInput.verifications === undefined
      ? {}
      : { verifications: failure.failureIntelligenceInput.verifications }),
  };
  const verifierOnly = deriveFailureIntelligence(verifierOnlyInput);
  const honestUnknown = verifierOnly.candidates.find(
    (item) => item.detector === 'unattributed' && item.status === 'unknown',
  );
  if (
    honestUnknown === undefined ||
    !verifierOnly.candidates.some(
      (item) => item.detector === 'verification-failure' && item.status === 'observed',
    )
  ) {
    throw new Error(
      'A terminal verifier symptom without Context or tool mechanism evidence did not remain honestly unknown upstream.',
    );
  }

  const saveScenario = await browser.evaluate(`(() => {
    const section = document.querySelector('.outcome-studio');
    const button = section?.querySelector('button.continuity-action');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!saveScenario) throw new Error('Workbench did not expose a ready regression scenario.');
  await waitForSavedScenario(app.url, created.missionId);

  // Saving the regression scenario is itself a persisted observation, so the
  // post-save Kernel head is the restart-stability boundary.
  const savedDetail = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  const finalHeadHash = savedDetail.mission.headHash;
  const finalReceiptId = completed.mission.receipt.receiptId;
  const scenarioCollection = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/scenarios`,
  );
  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;

  restarted = await startMissionBraidApp({ stateDir, port: 0 });
  const restored = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  const restoredScenarios = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/outcome-studio/scenarios`,
  );
  const stableScenarios = sameIdentitySet(
    scenarioCollection.scenarios,
    restoredScenarios.scenarios,
    'scenarioId',
    'scenarioHash',
  );
  const stableCiResults = sameIdentitySet(
    scenarioCollection.ciResults,
    restoredScenarios.ciResults,
    'resultId',
    'resultHash',
  );
  if (
    restored.mission.headHash !== finalHeadHash ||
    restored.mission.receipt?.receiptId !== finalReceiptId ||
    restored.executionForks.find((record) => record.forkId === fork.forkId)?.phase !== 'finished' ||
    restored.failureIntelligence?.failureIntelligenceInput?.diagnosticOutcomes?.find(
      (item) => item.candidateId === candidate.candidateId,
    )?.result !== 'mechanism-confirmed' ||
    !stableScenarios ||
    !stableCiResults
  ) {
    throw new Error(
      'Restart changed the Context diagnosis, Fork Receipt, or saved regression scenario.',
    );
  }

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-7-stale-context/v1',
    evidenceLevel: 'same-host-local-real-runtime-controlled-fixture',
    generatedAt: new Date().toISOString(),
    missionId: created.missionId,
    harness: runtimeProfile.harness,
    implementation,
    environment: {
      nodeVersion: process.version,
      qoderVersion: selectedProfile.runtimeVersion ?? runtime?.version ?? 'unknown',
      chromeVersion,
    },
    identities: {
      contractId: checkpoint.source.contractId,
      rootBranchId: initial.mission.rootBranchId,
      initialAttemptId: checkpoint.source.attemptId,
      initialReceiptId: initial.mission.receipt.receiptId,
      checkpointId: checkpoint.checkpointId,
      failureCandidateId: candidate.candidateId,
      forkId: fork.forkId,
      childAttemptId: completed.mission.receipt.attemptIds[0],
      childBranchId: fork.lineage.childBranchId,
      diagnosticReceiptId: completed.mission.receipt.receiptId,
      initialEffectIds: initial.mission.receipt.effectIds,
      diagnosticEffectIds: completed.mission.receipt.effectIds,
      toolFailureCandidateId: toolCandidate.candidateId,
      honestUnknownCandidateId: honestUnknown.candidateId,
      capsuleId: null,
    },
    workspace: {
      boundDigest: freshness.data.boundWorkspaceDigest,
      currentDigest: freshness.data.currentWorkspaceDigest,
      boundContextDigest: freshness.data.boundContextDigest,
      currentContextDigest: freshness.data.currentContextDigest,
      checkpointDigest: checkpoint.workspace.workspaceDigest,
      childBaselineDigest: fork.baselineSnapshot.workspaceDigest,
      childFutureDigest: fork.futureSnapshot.workspaceDigest,
      refreshedContextDigest,
      parentChangedPaths: ['agent-config.json'],
      childChangedPaths,
    },
    runtimeProfile: {
      profileId: selectedProfile.profileId,
      harness: selectedProfile.harness,
      model: selectedProfile.model,
      reasoningEffort: selectedProfile.reasoningEffort,
      permissionMode: selectedProfile.permissionMode,
    },
    initial: {
      status: initial.mission.status,
      attemptStatus: initial.attempts.find(
        (attempt) => attempt.attemptId === checkpoint.source.attemptId,
      )?.status,
      runtimeProcessFinished: initial.timeline.some(
        (entry) =>
          entry.kind === 'runtime.process_finished' &&
          entry.attemptId === checkpoint.source.attemptId,
      ),
      receiptOutcome: initial.mission.receipt?.outcome,
      receiptId: initial.mission.receipt?.receiptId,
      criterion: initial.mission.receipt?.verifications?.[0],
      staleContextCandidate: candidate.candidateId,
      toolFailureCandidate: toolCandidate.candidateId,
      proposalReady: proposal.ready,
      verifierFailed: true,
    },
    multiLayerFailureEvidence: {
      context: {
        candidateId: candidate.candidateId,
        layer: candidate.layer,
        statusBeforeDiagnostic: candidate.status,
        evidenceRefs: candidate.supportingEvidenceRefs,
        recommendedAction: candidate.recommendedAction,
      },
      tool: {
        candidateId: toolCandidate.candidateId,
        layer: toolCandidate.layer,
        status: toolCandidate.status,
        exitCode: 17,
        nativeFactIds: toolProbeFacts.map((fact) => fact.factId),
        sourceRuntimeEventIds: toolProbeFacts.map((fact) => fact.sourceRuntimeEventId),
        nativeArtifactIds: toolProbeFacts.map((fact) => fact.artifact.artifactId),
        evidenceRefs: toolCandidate.supportingEvidenceRefs,
        recommendedAction: toolCandidate.recommendedAction,
      },
      distinctCandidateIds: candidate.candidateId !== toolCandidate.candidateId,
      distinctEvidencePaths: !candidate.supportingEvidenceRefs.some((reference) =>
        toolCandidate.supportingEvidenceRefs.includes(reference),
      ),
    },
    diagnostic: {
      forkId: fork.forkId,
      parentCheckpointId: checkpoint.checkpointId,
      childBranchId: fork.lineage.childBranchId,
      sameRuntimeProfile: fork.lineage.profileId === checkpoint.source.profileId,
      sameContract: fork.lineage.contractId === checkpoint.source.contractId,
      intervention: fork.lineage.intervention,
      contextEvidenceRefs: fork.runtimeResult.contextEvidenceRefs,
      outcome: diagnosticOutcome.result,
      receiptId: completed.mission.receipt.receiptId,
      receiptOutcome: completed.mission.receipt.outcome,
      criterion: completed.mission.receipt.verifications[0],
      unresolvedItems: completed.mission.receipt.unresolvedItems,
    },
    evidenceAblation: {
      decisiveDiagnosticOutcomeId: diagnosticOutcome.outcomeId,
      candidateId: candidate.candidateId,
      fullStatus: confirmed.status,
      withoutDiagnosticOutcomeStatus: downgraded.status,
      terminalVerifierSymptomStatus: verifierOnly.candidates.find(
        (item) => item.detector === 'verification-failure',
      )?.status,
      upstreamStatusWithoutLayerEvidence: honestUnknown.status,
      honestUnknownCandidateId: honestUnknown.candidateId,
      honestUnknownMissingEvidence: honestUnknown.missingEvidence,
    },
    verifier: {
      kind: 'deterministic-command',
      initialStatus: initial.mission.receipt.verifications[0]?.status,
      initialEvidenceRefs: initial.mission.receipt.verifications[0]?.evidenceRefs ?? [],
      diagnosticStatus: completed.mission.receipt.verifications[0]?.status,
      diagnosticEvidenceRefs: completed.mission.receipt.verifications[0]?.evidenceRefs ?? [],
    },
    controlledComparison: {
      declaredChangedVariable: 'context:agent-behavior-source',
      sameContractId: fork.lineage.contractId === checkpoint.source.contractId,
      sameRuntimeProfileId: fork.lineage.profileId === checkpoint.source.profileId,
      authorityChange: fork.lineage.intervention.authorityChange,
      childBaselineMatchesCheckpoint:
        fork.baselineSnapshot.workspaceDigest === checkpoint.workspace.workspaceDigest,
      parentChangedPaths: ['agent-config.json'],
      childChangedPaths,
      necessarilyDifferentRunState: [
        'branchId',
        'attemptId',
        'runtimeProcess',
        'timestamps',
        'eventHistory',
      ],
    },
    productEntry: {
      missionCreatedThroughApi: true,
      checkpointCreatedThroughWorkbench: true,
      diagnosticSubmittedThroughWorkbench: true,
      regressionSavedThroughWorkbench: true,
    },
    regressionScenario: {
      saved: (scenarioCollection.scenarios?.length ?? 0) > 0,
      ciResults: scenarioCollection.ciResults?.length ?? 0,
      scenarioIdentities: (scenarioCollection.scenarios ?? []).map((scenario) => ({
        scenarioId: scenario.scenarioId,
        scenarioHash: scenario.scenarioHash,
      })),
      ciResultIdentities: (scenarioCollection.ciResults ?? []).map((result) => ({
        resultId: result.resultId,
        resultHash: result.resultHash,
      })),
    },
    restart: {
      stableHeadHash: restored.mission.headHash === finalHeadHash,
      stableReceipt: restored.mission.receipt?.receiptId === finalReceiptId,
      stableDiagnosis: true,
      stableScenario: stableScenarios && stableCiResults,
    },
    claimBoundary:
      'This is same-host local evidence from a real Qoder Runtime using Qwen3.8-Max, source-linked native Context and tool evidence, a deterministic verifier, the Workbench checkpoint/diagnostic path, evidence-ablation reprojection, and restart reconstruction. The controlled exit-17 tool probe is a real but deliberately induced tool failure and is not claimed as the Mission outcome cause. The Context diagnostic uses the same Contract, Runtime Profile, and authority while declaring Context refresh as the product variable; Branch, Attempt, process, timestamps, and event history necessarily differ. Removing the decisive diagnostic outcome downgrades the Context conclusion, while retaining only the terminal verifier symptom leaves the upstream mechanism unknown. The fixture controls the visible Context Snapshot and instruction boundary. The child is a fresh isolated Attempt, not native session resume or fork. This record does not claim provider-internal Context capture, general diagnosis accuracy or recall, portable persistence of the refreshed cache for later Attempts, production reliability, or independent external reproduction.',
  };
  if (outputFile === undefined) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  else writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
} finally {
  if (browser !== undefined) await browser.close().catch(() => {});
  if (app !== undefined) await app.close().catch(() => {});
  if (restarted !== undefined) await restarted.close().catch(() => {});
}

function isFailureSemanticFact(fact) {
  if (fact.kind === 'failure') return true;
  if (fact.kind === 'tool_result') {
    return (
      fact.isError === true ||
      fact.phase === 'failed' ||
      (typeof fact.exitCode === 'number' && fact.exitCode !== 0)
    );
  }
  if (fact.kind === 'test_run') return fact.status === 'failed';
  if (fact.kind === 'model_call') return fact.phase === 'failed';
  return false;
}

function missionInput(workspace, hiddenVerifier) {
  return {
    title: 'Diagnose a stale Agent Context with one refresh-only Branch',
    objective:
      'Use the visible Context Snapshot to repair the Agent behavior and let the deterministic verifier decide whether the Context is fresh.',
    workspace,
    context: {
      factId: 'agent-behavior-source',
      source: 'context-source.json',
      snapshot: '.missionbraid/context-cache.json',
    },
    constraints: [
      'Run the local structural tests before changing agent-config.json and again afterward',
      'Change only agent-config.json',
      'Use the visible MissionBraid Context Snapshot as the only accepted task input',
      'Do not inspect context-source.json or infer the controller-owned hidden verifier expectation',
    ],
    verifier: { executable: 'node', args: [hiddenVerifier], timeoutMs: 30_000 },
    stages: [
      {
        stageId: 'qoder-stale-context',
        ...runtimeProfile,
        injectionBudgetTokens: 2_400,
        instruction:
          'Follow AGENTS.md exactly. First run the required exit-17 controlled tool probe and continue after it fails. Then use the visible MissionBraid Context Snapshot before editing. Run node --test, change only agent-config.json to match the requiredPrefix in that visible snapshot, and run node --test again. Do not inspect context-source.json or the controller-owned hidden verifier.',
      },
    ],
  };
}

async function selectMissionInWorkbench(browser, missionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const selected = await browser.evaluate(`(() => {
      const button = document.querySelector('[data-mission-id=${JSON.stringify(missionId)}]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (selected) {
      await waitForBrowserMission(browser, missionId);
      return;
    }
    await wait(100);
  }
  throw new Error('Workbench did not render the Mission list entry.');
}

async function waitForBrowserMission(browser, missionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const visible = await browser.evaluate(
      `Boolean(document.querySelector('[data-continuity-workbench=${JSON.stringify(missionId)}]'))`,
    );
    if (visible) return;
    await wait(100);
  }
  throw new Error('Workbench did not render the Mission detail.');
}

async function submitContextDiagnosticThroughWorkbench(
  browser,
  missionId,
  checkpointId,
  candidateId,
  afterDigest,
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await browser.evaluate(`(() => {
      const candidate = document.querySelector('[data-diagnostic-candidate-id=${JSON.stringify(candidateId)}]');
      if (!candidate) return null;
      candidate.click();
      const form = document.querySelector('[data-execution-fork-action=${JSON.stringify(checkpointId)}]');
      if (!form) return null;
      const field = (name) => form.querySelector('[data-intervention-field="' + name + '"]');
      const values = {
        kind: field('kind')?.value,
        target: field('target')?.value,
        afterDigest: field('afterDigest')?.value,
        authority: field('authority')?.value,
        description: field('description')?.value,
        beforeDigest: field('beforeDigest')?.value,
      };
      if (
        values.kind !== 'context' ||
        values.target !== 'context:agent-behavior-source' ||
        values.afterDigest !== ${JSON.stringify(afterDigest)} ||
        values.authority !== 'unchanged' ||
        !values.description ||
        !values.beforeDigest
      ) return { invalidDefaults: values };
      const submit = form.querySelector('button.continuity-action');
      if (!submit || submit.disabled) return null;
      submit.click();
      return { clicked: true, values };
    })()`);
    if (result?.invalidDefaults) {
      throw new Error(
        `Workbench prepared invalid Context defaults: ${JSON.stringify(result.invalidDefaults)}`,
      );
    }
    if (result !== null) return result;
    await wait(200);
  }
  throw new Error('Workbench did not render a ready stale-context diagnostic proposal.');
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
    if (detail.compositeCheckpoints?.length > 0 && detail.failureIntelligence !== null)
      return detail;
    await wait(200);
  }
  throw new Error('Workbench did not persist the Composite Checkpoint.');
}

async function waitForExecutionFork(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    const fork = detail.executionForks?.find(
      (record) => record.phase === 'finished' || record.phase === 'failed',
    );
    if (fork?.phase === 'failed')
      throw new Error(`Execution Fork failed: ${fork.failure?.detail ?? 'unknown'}`);
    if (fork?.phase === 'finished' && fork.runtimeResult?.status !== 'completed') {
      throw new Error(
        `Execution Fork Runtime failed: ${(fork.runtimeResult?.unresolvedItems ?? []).join(', ') || 'unknown'}`,
      );
    }
    if (
      fork?.phase === 'finished' &&
      detail.mission.receipt?.branchId === fork.lineage.childBranchId
    )
      return detail;
    await wait(500);
  }
  throw new Error('Diagnostic Execution Fork timed out.');
}

async function waitForSavedScenario(baseUrl, missionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await requestJson(
      `${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}/outcome-studio/scenarios`,
    );
    if (value.scenarios?.length > 0 && value.ciResults?.length > 0) return value;
    await wait(200);
  }
  throw new Error('Workbench did not save the regression scenario.');
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

function sameIdentitySet(left, right, idKey, hashKey) {
  const normalize = (values) =>
    (Array.isArray(values) ? values : [])
      .map((value) => `${String(value?.[idKey] ?? '')}:${String(value?.[hashKey] ?? '')}`)
      .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function progress(message) {
  process.stderr.write(`${message}\n`);
}

function inspectImplementation(root, excludedOutputFile) {
  const status = commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  const sourceFingerprint = fingerprintGitVisibleFiles(root, excludedOutputFile);
  return {
    gitRevision: commandOutput('git', ['rev-parse', 'HEAD'], root),
    committedTree: commandOutput('git', ['rev-parse', 'HEAD^{tree}'], root),
    worktreeState: status.length === 0 ? 'clean' : 'dirty',
    cleanCloneUsed: false,
    freshBuildUsed: false,
    sourceTreeDigest: sourceFingerprint.digest,
    sourceFileCount: sourceFingerprint.fileCount,
    distributionDigest: fingerprintDirectory(join(root, 'dist')),
  };
}

function fingerprintGitVisibleFiles(root, excludedOutputFile) {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
    shell: false,
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${String(listed.stderr)}`);
  const excluded = excludedOutputFile === undefined ? undefined : resolve(excludedOutputFile);
  const files = listed.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path, absolute: resolve(root, path) }))
    .filter((entry) => entry.absolute !== excluded)
    .sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash('sha256');
  for (const entry of files) appendPathFingerprint(hash, entry.path, entry.absolute);
  return { digest: `sha256:${hash.digest('hex')}`, fileCount: files.length };
}

function fingerprintDirectory(root) {
  const files = collectFiles(root).sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const absolute of files) {
    appendPathFingerprint(hash, absolute.slice(root.length + 1), absolute);
  }
  return `sha256:${hash.digest('hex')}`;
}

function collectFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(absolute) : [absolute];
  });
}

function appendPathFingerprint(hash, path, absolute) {
  const stat = lstatSync(absolute);
  hash.update(path, 'utf8');
  hash.update('\0');
  if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute), 'utf8');
  else hash.update(readFileSync(absolute));
  hash.update('\0');
}

function commandOutput(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
}
