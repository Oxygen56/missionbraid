#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
if (!existsSync(builtApp)) throw new Error('Run `pnpm build` before the Iteration 2 proof.');

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'missionbraid-i2-proof-'));
const workspace = join(root, 'workspace');
const stateDir = join(root, 'state');
const prepared = run(process.execPath, [
  join(repositoryRoot, 'scripts', 'prepare-i2-fixture.mjs'),
  workspace,
]);
const fixture = JSON.parse(prepared.stdout);
const revision = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const dirtyBeforeRun = git(['status', '--porcelain']).length > 0;
const startedAt = new Date();

const { startMissionBraidApp } = await import('../dist/src/app.js');
let app;
let restarted;
try {
  app = await startMissionBraidApp({ stateDir, port: 0 });
  progress(`Workbench started at ${app.url}`);
  const runtimeInventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const selectedRuntimes = ['codex', 'qoder', 'claude'].map((id) => {
    const runtime = runtimeInventory.runtimes.find((candidate) => candidate.id === id);
    if (runtime?.status !== 'ready-supported') {
      throw new Error(`${id} is not execution-ready: ${runtime?.reason ?? 'not discovered'}`);
    }
    return runtime;
  });

  const create = await requestJson(
    `${app.url}/api/v1/missions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(missionInput(workspace)),
    },
    202,
  );
  progress(`Mission ${create.missionId} accepted as command ${create.commandId}`);
  const completed = await waitForMission(app.url, create.missionId, 20 * 60_000);
  if (
    completed.mission.status !== 'succeeded' ||
    completed.mission.receipt?.outcome !== 'verified'
  ) {
    throw new Error(
      `Mission ended as ${completed.mission.status}: ${JSON.stringify(completed.operation)}`,
    );
  }
  if (
    completed.attempts.length !== 3 ||
    !completed.attempts.every((attempt) => attempt.status === 'succeeded')
  ) {
    throw new Error(
      `Not every declared Runtime Attempt succeeded: ${JSON.stringify(completed.attempts)}`,
    );
  }

  const runtimeEvents = entries(completed, 'runtime.event').map((entry) => entry.data);
  const artifactRef = runtimeEvents.find((event) => event.nativeArtifact)?.nativeArtifact;
  if (artifactRef === undefined) throw new Error('No native artifact reference was recorded.');
  const artifact = await requestJson(
    `${app.url}/api/v1/artifacts/${encodeURIComponent(artifactRef.artifactId)}`,
  );
  const artifactHashVerified = sha256(artifact.content) === artifact.sha256;
  if (!artifactHashVerified)
    throw new Error('Artifact endpoint returned content with the wrong hash.');

  const stableRuntimeIdentity = runtimeEvents.map(stableRuntimeEvent);
  await app.close();
  app = undefined;
  restarted = await startMissionBraidApp({ stateDir, port: 0 });
  const restored = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(create.missionId)}`,
  );
  const restoredRuntimeIdentity = entries(restored, 'runtime.event').map((entry) =>
    stableRuntimeEvent(entry.data),
  );
  const restartStable =
    restored.mission.receipt?.receiptId === completed.mission.receipt.receiptId &&
    restored.mission.headHash === completed.mission.headHash &&
    JSON.stringify(restoredRuntimeIdentity) === JSON.stringify(stableRuntimeIdentity);
  if (!restartStable) throw new Error('Mission evidence changed after Workbench restart.');

  const endedAt = new Date();
  const definitionRecords = entries(completed, 'profile.definition_recorded').map(
    (entry) => entry.data,
  );
  const initialProfile = entries(completed, 'mission.created')[0]?.data?.profile;
  const snapshotRecords = uniqueBy(
    [
      initialProfile,
      ...entries(completed, 'profile.selected').map((entry) => entry.data.profile),
      completed.mission.activeProfile,
    ].filter(Boolean),
    'profileId',
  );
  const catalogRecords = uniqueBy(
    entries(completed, 'runtime.catalog_observed').map((entry) => entry.data),
    'observationId',
  );
  const bindings = entries(completed, 'attempt.bound').map((entry) => entry.data);
  const effectiveReports = entries(completed, 'runtime.effective_profile_reported').map(
    (entry) => entry.data,
  );
  const handoffAcknowledgements = entries(completed, 'handoff.acknowledged').map(
    (entry) => entry.data,
  );
  const commandEvents = completed.timeline
    .filter((entry) => entry.kind === 'command.accepted' || entry.kind === 'command.status_changed')
    .map((entry) => ({ kind: entry.kind, status: entry.data.status ?? null }));
  const sourceSequences = [...groupBy(runtimeEvents, (event) => event.sourceId)].map(
    ([sourceId, events]) => ({
      sourceId,
      sequences: events.map((event) => event.sourceSequence),
    }),
  );
  const runtimeEventIds = new Set(runtimeEvents.map((event) => event.runtimeEventId));
  const allCausalParentsResolve = runtimeEvents.every((event) =>
    event.causalParentIds.every((parentId) => runtimeEventIds.has(parentId)),
  );

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-2/v1',
    evidenceLevel: 'same-host-local-real-runtime',
    recordedOn: endedAt.toISOString().slice(0, 10),
    implementation: {
      revision,
      tree,
      repository: 'https://github.com/Oxygen56/missionbraid',
      dirtyBeforeRun,
      nodeVersion: process.version,
    },
    productEntry: {
      entry: 'local-loopback-workbench-api',
      userAuthoredMissionYaml: false,
      manualContextTransferBetweenHarnesses: false,
      durableCommandId: create.commandId,
      selectedRoute: ['codex', 'qoder', 'claude'],
      runtimeProfiles: missionInput('$DISPOSABLE_WORKSPACE').stages.map((stage) => ({
        harness: stage.harness,
        model: stage.model,
        reasoningEffort: stage.reasoningEffort,
        permissionMode: stage.permissionMode,
      })),
    },
    runtimeInventory: selectedRuntimes.map((runtime) => ({
      id: runtime.id,
      status: runtime.status,
      version: runtime.version,
      capabilityDeclarations: runtime.capabilityDeclarations,
    })),
    fixture: {
      source: 'examples/i2-fixture/template',
      preparer: 'scripts/prepare-i2-fixture.mjs',
      baseline: fixture.baseline,
      baselineExitCode: fixture.baselineExitCode,
      finalMarkers: Object.fromEntries(
        ['codex.txt', 'qoder.txt', 'claude.txt'].map((file) => [
          file,
          readFileSync(join(workspace, file), 'utf8'),
        ]),
      ),
    },
    mission: {
      missionId: create.missionId,
      rootBranchId: completed.mission.rootBranchId,
      contractId: completed.mission.contract.contractId,
      finalStatus: completed.mission.status,
      startedAt: startedAt.toISOString(),
      completedAt: endedAt.toISOString(),
      elapsedSeconds: Number(((endedAt.getTime() - startedAt.getTime()) / 1_000).toFixed(3)),
      eventCount: completed.eventCount,
      eventChainValid: completed.chainValid,
      finalHeadHash: completed.mission.headHash,
    },
    runtimeModel: {
      profileDefinitions: definitionRecords.map((definition) => ({
        definitionId: definition.definitionId,
        harness: definition.harness,
        requestedModel: definition.requestedModel,
      })),
      profileSnapshots: snapshotRecords.map((snapshot) => ({
        profileId: snapshot.profileId,
        definitionId: snapshot.definition?.definitionId,
        harness: snapshot.harness,
        runtimeVersion: snapshot.runtimeVersion ?? null,
        permissionMode: snapshot.permissionMode,
      })),
      catalogObservations: catalogRecords.map((observation) => ({
        observationId: observation.observationId,
        harness: observation.harness,
        availability: observation.availability,
        authentication: observation.authentication.status,
        quota: observation.quota.status,
        cost: observation.cost.status,
      })),
      attemptBindings: bindings.map((binding) => ({
        bindingId: binding.bindingId,
        attemptId: binding.attemptId,
        branchId: binding.branchId,
        profileId: binding.profileId,
        planNodeId: binding.planNodeId,
      })),
      effectiveReports: effectiveReports.map((report) => ({
        sourceRuntimeEventId: report.sourceRuntimeEventId,
        requestedModel: report.requestedModel,
        observedModel: report.observedModel,
        modelOverride: report.modelOverride,
        permissionMode: report.permissionMode,
        sessionObserved: typeof report.sessionId === 'string',
        toolCount: Array.isArray(report.tools) ? report.tools.length : null,
        skillCount: Array.isArray(report.skills) ? report.skills.length : null,
        slashCommandCount: Array.isArray(report.slashCommands) ? report.slashCommands.length : null,
        mcpServerCount: Array.isArray(report.mcpServers) ? report.mcpServers.length : null,
        runtimeVersion: report.runtimeVersion,
        contextWindowTokens: report.contextWindowTokens,
        costUsd: report.costUsd,
      })),
    },
    eventIR: {
      eventCount: runtimeEvents.length,
      harnesses: [...new Set(runtimeEvents.map((event) => event.sourceHarness))],
      sourceSequences,
      missionIngestSequences: entries(completed, 'runtime.event').map((entry) => entry.seq),
      allCausalParentsResolve,
      nativeArtifactCount: new Set(runtimeEvents.map((event) => event.nativeArtifact.artifactId))
        .size,
      artifactEndpointRead: {
        artifactId: artifact.artifactId,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        hashVerified: artifactHashVerified,
      },
    },
    continuity: {
      attempts: completed.attempts,
      handoffAcknowledgements,
      everyHandoffOrderingEstablished:
        handoffAcknowledgements.length === 2 &&
        handoffAcknowledgements.every(
          (acknowledgement) =>
            acknowledgement.handoffOrderingEstablished === true &&
            typeof acknowledgement.orderingEvidence === 'string' &&
            acknowledgement.orderingEvidence !== 'unknown',
        ),
      commandEvents,
    },
    receipt: {
      receiptId: completed.mission.receipt.receiptId,
      outcome: completed.mission.receipt.outcome,
      rootBranchId: completed.mission.receipt.rootBranchId,
      verifiedThroughSeq: completed.mission.receipt.verifiedThroughSeq,
      verifiedHeadHash: completed.mission.receipt.verifiedHeadHash,
      attemptIds: completed.mission.receipt.attemptIds,
      effectIds: completed.mission.receipt.effectIds,
      unresolvedItems: completed.mission.receipt.unresolvedItems,
    },
    restartRecovery: {
      newWorkbenchInstanceUsedSameState: true,
      sameMissionRestored: restored.mission.missionId === create.missionId,
      sameReceiptRestored:
        restored.mission.receipt.receiptId === completed.mission.receipt.receiptId,
      sameKernelHeadRestored: restored.mission.headHash === completed.mission.headHash,
      sourceSequenceAndCausalityStable: restartStable,
      restoredStatus: restored.mission.status,
    },
    honestUnknown: {
      catalogAuthentication: 'unknown',
      catalogQuota: 'unknown',
      explanation:
        'Version probes do not prove authentication or expose remaining provider quota; MissionBraid preserves those fields as unknown.',
    },
    claimBoundary:
      'This proves one same-host local Workbench Mission using authenticated local Codex, Qoder, and Claude Code installations. It establishes ordered native Attempts, immutable Runtime Profile snapshots, durable command intent, source-scoped Event IR, inspectable sanitized native artifacts, two cooperatively acknowledged Handoff Capsules with recorded ordering evidence, a verified Receipt, and stable restart restoration. It does not establish automatic routing, executable Fork/Replay, live tool gating, cross-host reproduction, production isolation, third-party adoption, or optimal model selection.',
  };

  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputFile === undefined) process.stdout.write(serialized);
  else writeFileSync(outputFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  progress(`Evidence complete: ${String(runtimeEvents.length)} normalized Runtime events`);
  progress(`Disposable proof state retained at ${root}`);
} finally {
  if (app !== undefined) await app.close();
  if (restarted !== undefined) await restarted.close();
}

function missionInput(workspace) {
  return {
    title: 'Complete one Mission through Codex, Qoder, and Claude Code',
    objective:
      'Create the three declared Runtime marker files through ordered native Attempts and satisfy the original verifier.',
    workspace,
    constraints: [
      'Stay inside the disposable workspace',
      'Each Runtime changes only its declared marker file',
      'A continuation acknowledges its Handoff Capsule before mutation',
    ],
    verifier: { executable: 'node', args: ['verify.mjs'], timeoutMs: 30_000 },
    stages: [
      {
        stageId: 'codex-primary',
        harness: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        permissionMode: 'workspace-write',
        injectionBudgetTokens: 1_600,
        instruction:
          'Create codex.txt with exactly one line: codex. Do not create qoder.txt or claude.txt.',
      },
      {
        stageId: 'qoder-continuation',
        harness: 'qoder',
        model: 'Qwen3.8-Max',
        reasoningEffort: 'medium',
        permissionMode: 'bypass_permissions',
        injectionBudgetTokens: 1_600,
        instruction:
          'First acknowledge the Handoff Capsule exactly as instructed. Then create qoder.txt with exactly one line: qoder. Preserve codex.txt and do not create claude.txt.',
      },
      {
        stageId: 'claude-continuation',
        harness: 'claude',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'medium',
        permissionMode: 'bypassPermissions',
        injectionBudgetTokens: 1_600,
        instruction:
          'First acknowledge the Handoff Capsule exactly as instructed. Then create claude.txt with exactly one line: claude. Preserve both earlier marker files.',
      },
    ],
  };
}

async function waitForMission(baseUrl, missionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastPhase;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    const phase = detail.operation?.phase ?? detail.mission.status;
    if (phase !== lastPhase) {
      progress(`Mission ${missionId}: ${phase}`);
      lastPhase = phase;
    }
    if (phase === 'completed' || phase === 'failed') return detail;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Mission ${missionId} did not finish within ${String(timeoutMs)} ms.`);
}

async function requestJson(url, options, expectedStatus = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url}, received ${text.slice(0, 200)}`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body;
}

function entries(detail, kind) {
  return detail.timeline.filter((entry) => entry.kind === kind);
}

function stableRuntimeEvent(event) {
  return {
    runtimeEventId: event.runtimeEventId,
    sourceId: event.sourceId,
    sourceSequence: event.sourceSequence,
    causalParentIds: event.causalParentIds,
    nativeArtifactId: event.nativeArtifact.artifactId,
  };
}

function uniqueBy(values, key) {
  return [...new Map(values.map((value) => [value[key], value])).values()];
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const identity = key(value);
    const group = groups.get(identity) ?? [];
    group.push(value);
    groups.set(identity, group);
  }
  return groups;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function git(args) {
  return run('git', ['-C', repositoryRoot, ...args]).stdout.trim();
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${String(result.status)}: ${result.stderr}`);
  }
  return result;
}

function progress(message) {
  process.stderr.write(`[iteration-2] ${message}\n`);
}
