#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { wait } from './headless-workbench.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
const builtEngine = join(repositoryRoot, 'dist', 'src', 'engine.js');
const buildInputFiles = [
  'src/app.ts',
  'src/engine.ts',
  'src/mission-draft.ts',
  'src/mission-plan.ts',
  'src/mission-plan-runtime.ts',
  'src/spec.ts',
  'examples/i8-multi-agent-revision-fixture/mission.yaml',
  'scripts/prepare-i8-multi-agent-revision-fixture.mjs',
  'scripts/run-i8-multi-agent-revision-proof.mjs',
];
const distributionFiles = [
  'dist/src/app.js',
  'dist/src/engine.js',
  'dist/src/mission-draft.js',
  'dist/src/mission-plan.js',
  'dist/src/mission-plan-runtime.js',
  'dist/src/spec.js',
];
const buildInputDigestBefore = digestFiles(repositoryRoot, buildInputFiles);
const distributionDigestBefore = digestExistingFiles(repositoryRoot, distributionFiles);
progress('Building the exact source tree used by the Iteration 8 proof');
run('pnpm', ['build']);
const buildInputDigestAfter = digestFiles(repositoryRoot, buildInputFiles);
const distributionDigestAfter = digestFiles(repositoryRoot, distributionFiles);
if (buildInputDigestBefore !== buildInputDigestAfter) {
  throw new Error('The selected source inputs changed during the fresh proof build.');
}
if (!existsSync(builtApp) || !existsSync(builtEngine)) {
  throw new Error('The fresh Iteration 8 proof build did not produce the Workbench distribution.');
}

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i8-multi-agent-'));
const stateDir = join(proofRoot, 'state');
const workspace = join(proofRoot, 'workspace');
const missionFile = join(
  repositoryRoot,
  'examples',
  'i8-multi-agent-revision-fixture',
  'mission.yaml',
);
const preparation = JSON.parse(
  run(process.execPath, [
    join(repositoryRoot, 'scripts', 'prepare-i8-multi-agent-revision-fixture.mjs'),
    workspace,
  ]).stdout,
);
const implementation = implementationEvidence(repositoryRoot, {
  buildInputDigestBefore,
  buildInputDigestAfter,
  distributionDigestBefore,
  distributionDigestAfter,
});

const { startMissionBraidApp } = await import('../dist/src/app.js');

let app;
let restarted;
let promptV1Marker;
try {
  app = await startMissionBraidApp({ stateDir, port: 0 });
  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const qoderRuntime = requireReadyRuntime(inventory, 'qoder');
  const claudeRuntime = requireReadyRuntime(inventory, 'claude');

  const created = await requestJson(
    `${app.url}/api/v1/missions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(explicitPlanDraftPayload(missionFile, workspace)),
    },
    201,
  );
  progress(`Mission ${created.missionId} created through the Workbench Plan composer API`);

  const initialPlan = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/plan`,
  );
  assertEqual(initialPlan.contractRevision.revisionNumber, 1, 'initial Contract revision');
  assertEqual(initialPlan.planRevision.revisionNumber, 1, 'initial Plan revision');
  assertSetEqual(
    initialPlan.planRevision.nodes.map((node) => node.nodeId),
    ['tool-implementation', 'prompt-skill', 'integrate'],
    'initial Plan nodes',
  );

  const launched = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/plan/execute`,
    { method: 'POST' },
    202,
  );
  if (launched.operation?.phase !== 'running' || launched.operation?.action !== 'plan') {
    throw new Error(`Workbench did not start the Plan operation: ${JSON.stringify(launched)}`);
  }

  const beforeRevision = await waitForInitialParallelFrontier(
    app.url,
    created.missionId,
    stateDir,
    30 * 60_000,
  );
  const contractV1 = beforeRevision.missionPlan.contractRevision;
  const planV1 = beforeRevision.missionPlan.planRevision;
  const toolV1Attempt = single(
    beforeRevision.missionPlan.execution.attempts.filter(
      (attempt) => attempt.nodeId === 'tool-implementation',
    ),
    'Contract v1 tool Attempt',
  );
  const promptV1Attempt = single(
    beforeRevision.missionPlan.execution.attempts.filter(
      (attempt) =>
        attempt.nodeId === 'prompt-skill' &&
        attempt.contractRevisionId === contractV1.contractRevisionId,
    ),
    'Contract v1 prompt Attempt',
  );
  const toolV1Artifact = single(
    beforeRevision.missionPlan.execution.artifacts.filter(
      (record) =>
        record.artifact.producedByNodeId === 'tool-implementation' &&
        record.artifact.contractRevisionId === contractV1.contractRevisionId,
    ),
    'Contract v1 tool artifact',
  );
  assertEqual(toolV1Attempt.status, 'succeeded', 'Contract v1 tool Attempt status');
  assertEqual(promptV1Attempt.status, 'running', 'Contract v1 prompt Attempt status');
  promptV1Marker = beforeRevision.promptMarker;
  assertEqual(promptV1Marker.value.phase, 'initial', 'prompt hold phase');
  assertEqual(promptV1Marker.value.state, 'waiting-for-contract-revision', 'prompt hold state');
  runInWorkspace(process.execPath, ['verify-prompt-node.mjs'], promptV1Marker.workspacePath);
  progress('Qoder tool artifact verified while Claude revision-1 work remained active');

  const revisedRequirements = contractV1.requirements.map((requirement) =>
    requirement.requirementId === 'acceptance-prompt-schema'
      ? {
          ...requirement,
          statement:
            'Both the prompt and Skill require exactly three output fields: classification copied from tool.decision, rationale copied from tool.rationale, and evidenceSource copied from tool.evidenceRefs.',
          evidenceRefs: [...requirement.evidenceRefs, 'user-request:i8-add-evidence-source'],
        }
      : requirement,
  );
  assertOnlyRequirementChanged(
    contractV1.requirements,
    revisedRequirements,
    'acceptance-prompt-schema',
  );
  const revised = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/contract-revisions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: contractV1.contract,
        requirements: revisedRequirements,
        reason: 'Add policy evidence provenance to every triage response.',
        evidenceRefs: ['workbench:i8-live-requirement-revision'],
      }),
    },
    201,
  );
  assertEqual(revised.contractRevision.revisionNumber, 2, 'revised Contract revision');
  assertEqual(revised.planRevision.revisionNumber, 2, 'revised Plan revision');
  assertSetEqual(
    revised.invalidation.changedRequirementIds,
    ['acceptance-prompt-schema'],
    'changed requirements',
  );
  assertSetEqual(
    revised.invalidation.directlyImpactedNodeIds,
    ['prompt-skill'],
    'directly impacted nodes',
  );
  assertSetEqual(
    revised.invalidation.invalidatedNodeIds,
    ['prompt-skill', 'integrate'],
    'invalidated nodes',
  );
  assertSetEqual(revised.invalidation.replanFrontierNodeIds, ['prompt-skill'], 'replan frontier');
  assertSetEqual(revised.invalidation.reusableNodeIds, ['tool-implementation'], 'reusable nodes');
  if (!revised.invalidation.reusableArtifactIds.includes(toolV1Artifact.artifact.artifactId)) {
    throw new Error('The verified Qoder artifact was not selected for reuse.');
  }
  const requestedFence = single(
    revised.invalidation.staleAttemptFences,
    'stale prompt Attempt fence',
  );
  assertEqual(requestedFence.attemptId, promptV1Attempt.attemptId, 'fenced Attempt identity');
  assertEqual(requestedFence.nodeId, 'prompt-skill', 'fenced node');
  assertEqual(requestedFence.action, 'interrupt-and-preserve-evidence', 'fence action');
  if (requestedFence.acceptsFurtherEffects !== false) {
    throw new Error('The stale prompt Attempt fence still accepts Effects.');
  }
  progress('Workbench accepted the prompt-only Contract revision and fenced only Claude v1');

  const completed = await waitForPlanCompletion(app.url, created.missionId, 30 * 60_000);
  const plan = completed.missionPlan;
  const execution = plan.execution;
  const contractV2 = plan.contractRevision;
  const planV2 = plan.planRevision;
  const receipt = completed.mission.receipt;
  if (receipt?.outcome !== 'verified') {
    throw new Error('The revised Mission did not issue a verified Receipt.');
  }
  assertEqual(
    contractV2.contractRevisionId,
    revised.contractRevision.contractRevisionId,
    'final Contract revision',
  );
  assertEqual(planV2.planRevisionId, revised.planRevision.planRevisionId, 'final Plan revision');
  assertEqual(
    receipt.contractRevisionId,
    contractV2.contractRevisionId,
    'Receipt Contract revision',
  );
  assertEqual(receipt.planRevisionId, planV2.planRevisionId, 'Receipt Plan revision');

  const toolAttempts = execution.attempts.filter(
    (attempt) => attempt.nodeId === 'tool-implementation',
  );
  assertEqual(toolAttempts.length, 1, 'Qoder tool execution count');
  assertEqual(toolAttempts[0].attemptId, toolV1Attempt.attemptId, 'Qoder tool Attempt reuse');
  assertEqual(toolAttempts[0].status, 'succeeded', 'Qoder tool terminal status');

  const promptAttempts = execution.attempts.filter((attempt) => attempt.nodeId === 'prompt-skill');
  assertEqual(promptAttempts.length, 2, 'Claude prompt execution count');
  const finalPromptV1 = single(
    promptAttempts.filter((attempt) => attempt.attemptId === promptV1Attempt.attemptId),
    'final Claude v1 Attempt',
  );
  const promptV2Attempt = single(
    promptAttempts.filter(
      (attempt) => attempt.contractRevisionId === contractV2.contractRevisionId,
    ),
    'Claude v2 Attempt',
  );
  assertEqual(finalPromptV1.status, 'abandoned', 'Claude v1 terminal status');
  assertEqual(finalPromptV1.fence?.fenceId, requestedFence.fenceId, 'Claude v1 fence identity');
  assertEqual(promptV2Attempt.status, 'succeeded', 'Claude v2 terminal status');
  if (promptV2Attempt.attemptId === promptV1Attempt.attemptId) {
    throw new Error('Claude v2 reused the stale Attempt identity.');
  }

  const joinAttempt = single(
    execution.attempts.filter((attempt) => attempt.nodeId === 'integrate'),
    'consolidation Attempt',
  );
  assertEqual(joinAttempt.status, 'succeeded', 'consolidation Attempt status');
  assertEqual(
    joinAttempt.contractRevisionId,
    contractV2.contractRevisionId,
    'consolidation Contract',
  );
  assertEqual(joinAttempt.planRevisionId, planV2.planRevisionId, 'consolidation Plan');

  const reusedToolArtifact = single(
    execution.artifacts.filter(
      (record) =>
        record.artifact.producedByNodeId === 'tool-implementation' &&
        record.artifact.contractRevisionId === contractV2.contractRevisionId,
    ),
    'reused Qoder tool artifact',
  );
  assertEqual(
    reusedToolArtifact.reusedFromArtifactId,
    toolV1Artifact.artifact.artifactId,
    'reused artifact provenance',
  );
  assertEqual(
    reusedToolArtifact.invalidationId,
    revised.invalidation.invalidationId,
    'reuse invalidation provenance',
  );
  assertEqual(
    reusedToolArtifact.artifact.artifactDigest,
    toolV1Artifact.artifact.artifactDigest,
    'reused tool digest',
  );
  const promptV2Artifact = single(
    execution.artifacts.filter(
      (record) =>
        record.artifact.producedByNodeId === 'prompt-skill' &&
        record.artifact.contractRevisionId === contractV2.contractRevisionId,
    ),
    'Claude v2 prompt artifact',
  );
  const joinArtifact = single(
    execution.artifacts.filter(
      (record) =>
        record.artifact.producedByNodeId === 'integrate' &&
        record.artifact.contractRevisionId === contractV2.contractRevisionId,
    ),
    'consolidation artifact',
  );
  assertSetEqual(
    joinArtifact.artifact.sourceArtifactIds,
    [reusedToolArtifact.artifact.artifactId, promptV2Artifact.artifact.artifactId],
    'consolidation source artifacts',
  );

  const consolidation = single(execution.consolidations, 'consolidation record');
  assertEqual(consolidation.plan.attempt.attemptId, joinAttempt.attemptId, 'consolidation Attempt');
  assertEqual(consolidation.outcome?.conclusion, 'confirmed', 'consolidation conclusion');
  assertEqual(consolidation.outcome?.effect?.status, 'confirmed', 'integration Effect status');
  if (
    stableJson(consolidation.sourceCommitsBefore) !== stableJson(consolidation.sourceCommitsAfter)
  ) {
    throw new Error('A source Branch commit changed during consolidation.');
  }
  assertIntegratedSourcesUnmodified(
    consolidation.workspacePath,
    reusedToolArtifact,
    promptV2Artifact,
  );

  const fencedObservation = completed.timeline.find(
    (entry) =>
      entry.kind === 'mission.attempt_fenced' && entry.attemptId === promptV1Attempt.attemptId,
  );
  if (fencedObservation?.data?.processAborted !== true) {
    throw new Error('The runtime journal did not prove the stale Claude process was aborted.');
  }
  assertRuntimeProfiles(completed.timeline);
  if (
    receipt.verifications.length !== 3 ||
    receipt.verifications.some((verification) => verification.status !== 'passed')
  ) {
    throw new Error('The final Receipt is not backed by all three deterministic verifiers.');
  }
  if (receipt.unresolvedItems.length !== 0) {
    throw new Error('The final Receipt retained unresolved items.');
  }

  const finalState = durableState(completed);
  const finalHeadHash = completed.mission.headHash;
  const finalReceiptId = receipt.receiptId;
  await app.close();
  app = undefined;

  restarted = await startMissionBraidApp({ stateDir, port: 0 });
  const restored = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  assertEqual(restored.mission.headHash, finalHeadHash, 'restart Mission head');
  assertEqual(restored.mission.receipt?.receiptId, finalReceiptId, 'restart Receipt');
  if (stableJson(durableState(restored)) !== stableJson(finalState)) {
    throw new Error(
      'Restart changed the Contract, Plan, invalidation, Attempt, artifact, or consolidation state.',
    );
  }
  if (restored.chainValid !== true) throw new Error('Restarted Kernel event chain is invalid.');

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-8-multi-agent-revision/v1',
    evidenceLevel: 'same-host-local-real-runtime-controlled-fixture',
    generatedAt: new Date().toISOString(),
    missionId: created.missionId,
    implementation,
    environment: {
      nodeVersion: process.version,
      qoderVersion: qoderRuntime.version,
      claudeCodeVersion: claudeRuntime.version,
    },
    productEntry: {
      workbenchStarted: true,
      missionCreatedThroughWorkbenchHttpApi: true,
      planStartedThroughWorkbenchHttpApi: true,
      contractRevisedThroughWorkbenchHttpApi: true,
      statusReadThroughWorkbenchHttpApi: true,
      missionDraftApiSupportsExplicitPlanDag: true,
    },
    fixture: {
      workspace: preparation.workspace,
      baselineHead: preparation.head,
      baselineTree: preparation.tree,
      baselineVerifierExitCodes: preparation.baseline,
    },
    initial: {
      contractRevisionId: contractV1.contractRevisionId,
      planRevisionId: planV1.planRevisionId,
      toolAttemptId: toolV1Attempt.attemptId,
      toolArtifactId: toolV1Artifact.artifact.artifactId,
      toolArtifactDigest: toolV1Artifact.artifact.artifactDigest,
      promptAttemptId: promptV1Attempt.attemptId,
      promptAttemptActiveAtRevision: true,
      promptHoldMarker: promptV1Marker.value,
    },
    revision: {
      contractRevisionId: contractV2.contractRevisionId,
      planRevisionId: planV2.planRevisionId,
      changedRequirementIds: revised.invalidation.changedRequirementIds,
      directlyImpactedNodeIds: revised.invalidation.directlyImpactedNodeIds,
      invalidatedNodeIds: revised.invalidation.invalidatedNodeIds,
      replanFrontierNodeIds: revised.invalidation.replanFrontierNodeIds,
      reusableNodeIds: revised.invalidation.reusableNodeIds,
      reusableArtifactIds: revised.invalidation.reusableArtifactIds,
      fence: requestedFence,
    },
    execution: {
      qoderToolAttemptCount: toolAttempts.length,
      qoderToolRerun: false,
      reusedToolArtifactId: reusedToolArtifact.artifact.artifactId,
      reusedFromArtifactId: reusedToolArtifact.reusedFromArtifactId,
      claudeV1AttemptId: promptV1Attempt.attemptId,
      claudeV1Status: finalPromptV1.status,
      claudeV1ProcessAborted: fencedObservation.data.processAborted,
      claudeV2AttemptId: promptV2Attempt.attemptId,
      claudeV2Status: promptV2Attempt.status,
      claudeV2ArtifactId: promptV2Artifact.artifact.artifactId,
      consolidationAttemptId: joinAttempt.attemptId,
      consolidationId: consolidation.plan.consolidationId,
      consolidationStatus: joinAttempt.status,
      integrationConclusion: consolidation.outcome.conclusion,
      sourceHistoryImmutable: true,
      sourceArtifactIds: joinArtifact.artifact.sourceArtifactIds,
    },
    receipt: {
      receiptId: receipt.receiptId,
      outcome: receipt.outcome,
      contractRevisionId: receipt.contractRevisionId,
      planRevisionId: receipt.planRevisionId,
      branchId: receipt.branchId,
      attemptIds: receipt.attemptIds,
      verifications: receipt.verifications,
      unresolvedItems: receipt.unresolvedItems,
    },
    restart: {
      stableMissionHead: restored.mission.headHash === finalHeadHash,
      stableReceipt: restored.mission.receipt?.receiptId === finalReceiptId,
      stablePlanExecution: true,
      eventChainValid: restored.chainValid,
    },
    claimBoundary:
      'This is same-host local evidence from real Qoder and Claude Code processes in a controlled Git fixture. It proves one explicit Mission Plan was created, started, revised, observed, and completed through Workbench HTTP APIs; preserved a verified unaffected tool artifact; interrupted and fenced a stale prompt Attempt after a prompt-only Contract revision; executed a fresh revised prompt Attempt; consolidated immutable source Branches in a new Attempt; passed deterministic verifiers; issued a Receipt bound to the latest Contract and Plan revisions; and reconstructed the same state after Workbench restart. It does not claim production adoption, provider-internal state capture, distributed execution, or reliability outside this controlled same-host run.',
  };
  if (outputFile === undefined) process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  else writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
} finally {
  cleanupHoldProcess(promptV1Marker);
  if (app !== undefined) await app.close().catch(() => {});
  if (restarted !== undefined) await restarted.close().catch(() => {});
}

async function waitForInitialParallelFrontier(baseUrl, missionId, stateDirPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    failOnPlanOperation(detail);
    const execution = detail.missionPlan?.execution;
    const revision = detail.missionPlan?.contractRevision;
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
          stateDirPath,
          'worktrees',
          missionId,
          promptAttempt.attemptId.slice('attempt-'.length),
        );
        const markerPath = join(workspacePath, '.missionbraid', 'i8-prompt-attempt-ready.json');
        if (existsSync(markerPath)) {
          const value = JSON.parse(readFileSync(markerPath, 'utf8'));
          if (value.state === 'waiting-for-contract-revision') {
            return {
              ...detail,
              promptMarker: { markerPath, workspacePath, value },
            };
          }
        }
      }
    }
    await wait(500);
  }
  throw new Error(
    'Timed out waiting for the verified Qoder artifact and active Claude v1 frontier.',
  );
}

async function waitForPlanCompletion(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    failOnPlanOperation(detail);
    if (
      detail.operation?.phase === 'completed' &&
      detail.operation?.resultStatus === 'succeeded' &&
      detail.mission.receipt?.outcome === 'verified'
    ) {
      return detail;
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

function assertOnlyRequirementChanged(previous, next, requirementId) {
  const previousById = new Map(
    previous.map((requirement) => [requirement.requirementId, requirement]),
  );
  const nextById = new Map(next.map((requirement) => [requirement.requirementId, requirement]));
  assertSetEqual([...previousById.keys()], [...nextById.keys()], 'Contract requirement identities');
  const changed = [...previousById.keys()].filter(
    (id) => stableJson(previousById.get(id)) !== stableJson(nextById.get(id)),
  );
  assertSetEqual(changed, [requirementId], 'Contract requirement delta');
}

function assertRuntimeProfiles(timeline) {
  const selected = timeline.filter((entry) => entry.kind === 'profile.selected');
  const nodeProfiles = selected.filter((entry) =>
    String(entry.data?.reason ?? '').startsWith('Mission Plan node '),
  );
  const tool = single(
    nodeProfiles.filter((entry) => entry.data.reason === 'Mission Plan node tool-implementation'),
    'Qoder tool Runtime Profile',
  );
  const prompts = nodeProfiles.filter(
    (entry) => entry.data.reason === 'Mission Plan node prompt-skill',
  );
  assertEqual(prompts.length, 2, 'Claude Runtime Profile selections');
  const consolidation = single(
    selected.filter((entry) => entry.data?.reason === 'Mission Plan consolidation integrate'),
    'Qoder consolidation Runtime Profile',
  );
  for (const [label, entry] of [
    ['Qoder tool', tool],
    ['Qoder consolidation', consolidation],
  ]) {
    assertEqual(entry.data.profile.harness, 'qoder', `${label} harness`);
    assertEqual(entry.data.profile.model, 'Qwen3.8-Max', `${label} model`);
    assertEqual(entry.data.profile.reasoningEffort, 'medium', `${label} reasoning`);
  }
  for (const entry of prompts) {
    assertEqual(entry.data.profile.harness, 'claude', 'Claude prompt harness');
    assertEqual(entry.data.profile.model, 'deepseek-v4-pro', 'Claude prompt model');
    assertEqual(entry.data.profile.reasoningEffort, 'medium', 'Claude prompt reasoning');
  }
}

function assertIntegratedSourcesUnmodified(consolidationWorkspace, toolArtifact, promptArtifact) {
  const sources = [
    [toolArtifact.workspacePath, 'src/tools/policy-lookup.mjs'],
    [promptArtifact.workspacePath, 'prompts/triage.md'],
    [promptArtifact.workspacePath, 'skills/triage/SKILL.md'],
  ];
  for (const [sourceWorkspace, path] of sources) {
    const source = readFileSync(join(sourceWorkspace, path));
    const integrated = readFileSync(join(consolidationWorkspace, path));
    if (!source.equals(integrated)) {
      throw new Error(`Consolidation mutated verifier-backed source ${path}.`);
    }
  }
}

function durableState(detail) {
  const plan = detail.missionPlan;
  return {
    contractRevisionId: plan.contractRevision.contractRevisionId,
    contractRevisionDigest: plan.contractRevision.revisionDigest,
    planRevisionId: plan.planRevision.planRevisionId,
    planRevisionDigest: plan.planRevision.revisionDigest,
    invalidations: plan.invalidations.map((invalidation) => ({
      invalidationId: invalidation.invalidationId,
      targetContractRevisionId: invalidation.targetContractRevisionId,
      changedRequirementIds: invalidation.changedRequirementIds,
      invalidatedNodeIds: invalidation.invalidatedNodeIds,
      reusableArtifactIds: invalidation.reusableArtifactIds,
      staleAttemptFences: invalidation.staleAttemptFences,
    })),
    attempts: plan.execution.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      nodeId: attempt.nodeId,
      status: attempt.status,
      planRevisionId: attempt.planRevisionId,
      contractRevisionId: attempt.contractRevisionId,
      nodeVersion: attempt.nodeVersion,
      fence: attempt.fence,
    })),
    artifacts: plan.execution.artifacts.map((record) => ({
      recordId: record.recordId,
      artifactId: record.artifact.artifactId,
      artifactDigest: record.artifact.artifactDigest,
      producedByNodeId: record.artifact.producedByNodeId,
      planRevisionId: record.artifact.planRevisionId,
      contractRevisionId: record.artifact.contractRevisionId,
      sourceArtifactIds: record.artifact.sourceArtifactIds,
      reusedFromArtifactId: record.reusedFromArtifactId ?? null,
      invalidationId: record.invalidationId ?? null,
      sourceCommit: record.sourceCommit,
    })),
    consolidations: plan.execution.consolidations.map((record) => ({
      consolidationId: record.plan.consolidationId,
      attemptId: record.plan.attempt.attemptId,
      planRevisionId: record.plan.planRevisionId,
      contractRevisionId: record.plan.contractRevisionId,
      sourceArtifactIds: record.sourceArtifactIds,
      sourceCommitsBefore: record.sourceCommitsBefore,
      sourceCommitsAfter: record.sourceCommitsAfter,
      conclusion: record.outcome?.conclusion ?? null,
      outputWorkspaceDigest: record.outcome?.outputWorkspaceDigest ?? null,
    })),
    runtime: detail.missionPlanRuntime,
  };
}

function requireReadyRuntime(inventory, runtimeId) {
  const runtime = inventory.runtimes?.find((candidate) => candidate.id === runtimeId);
  if (runtime?.status !== 'ready-supported') {
    throw new Error(`${runtimeId} is not execution-ready: ${runtime?.reason ?? 'missing'}`);
  }
  return runtime;
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
    throw new Error(`${url} returned ${String(response.status)}: ${text.slice(0, 1_000)}`);
  }
  return body;
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function runInWorkspace(command, args, workspacePath) {
  const result = spawnSync(command, args, {
    cwd: workspacePath,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, MISSIONBRAID_TARGET_WORKSPACE: workspacePath },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function explicitPlanDraftPayload(sourceFile, workspacePath) {
  const document = parseYaml(readFileSync(sourceFile, 'utf8'));
  if (!document || typeof document !== 'object' || !Array.isArray(document.attemptPlan)) {
    throw new Error('The Iteration 8 fixture is not a valid explicit Mission Plan document.');
  }
  return {
    title: document.title,
    objective: document.objective,
    workspace: workspacePath,
    constraints: document.constraints ?? [],
    acceptanceCriteria: document.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verifier: {
        executable: criterion.verifier.executable,
        args: criterion.verifier.args ?? [],
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

function implementationEvidence(root, build) {
  const status = run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    root,
  ).stdout.trim();
  return {
    gitRevision: run('git', ['rev-parse', 'HEAD'], root).stdout.trim(),
    worktreeState: status.length === 0 ? 'clean' : 'dirty',
    freshBuildUsed: true,
    buildInputDigestBefore: build.buildInputDigestBefore,
    buildInputDigestAfter: build.buildInputDigestAfter,
    buildInputsStable: build.buildInputDigestBefore === build.buildInputDigestAfter,
    distributionDigestBefore: build.distributionDigestBefore,
    distributionDigestAfter: build.distributionDigestAfter,
    selectedBuildInputFileCount: buildInputFiles.length,
    selectedDistributionFileCount: distributionFiles.length,
  };
}

function digestExistingFiles(root, files) {
  return files.every((path) => existsSync(join(root, path))) ? digestFiles(root, files) : null;
}

function digestFiles(root, files) {
  const hash = createHash('sha256');
  for (const path of files) {
    const absolute = join(root, path);
    hash.update(path, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
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

function single(values, label) {
  if (values.length !== 1) {
    throw new Error(`${label} expected exactly one value, received ${String(values.length)}.`);
  }
  return values[0];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function assertSetEqual(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(`${label}: expected ${stableJson(right)}, received ${stableJson(left)}.`);
  }
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
  process.stderr.write(`${message}\n`);
}
