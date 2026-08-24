#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createMissionSpecSnapshot, loadMissionSpec } from '../dist/src/spec.js';
import { canonicalJson, computeEventHash, hashPayload } from '../dist/src/store.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 250;
const COMMAND_TIMEOUT_MS = 10_000;
const CORE_TEST_TIMEOUT_MS = 30_000;
const MIN_CONTROLLER_LEASE_TTL_MS = 15_000;
const EXPECTED_CHANGED_PATHS = ['src/effect-core.mjs', 'src/ledger.mjs'];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e1MissionFile = join(repositoryRoot, 'examples', 'e1-fixture', 'mission.yaml');
const e1Template = join(repositoryRoot, 'examples', 'e1-fixture', 'template');

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await interruptAtCheckpoint(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}

async function interruptAtCheckpoint(options) {
  const stateDir = realpathSync(options.stateDir);
  const workspace = realpathSync(options.workspace);
  assertDisjoint(stateDir, workspace);
  const expectedWorkspaceKey = `workspace-${hashPayload(workspace).slice(0, 32)}`;
  const expectedE1 = loadExpectedE1Fixture(workspace);
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;

  const initialObservation = inspectMission(stateDir, expectedWorkspaceKey);
  const missionId = initialObservation.missionId;
  assertPreCheckpointState(initialObservation);
  const initialKernel = readKernelBindings({
    stateDir,
    workspace,
    workspaceKey: expectedWorkspaceKey,
    missionId,
    expectedE1,
    attempt: initialObservation.activeAttempt,
    process: initialObservation.activeProcess,
  });
  const initialLease = initialKernel.lease;
  let latestLeaseUntilMs = initialLease.leaseUntilMs;
  let controllerRenewalObserved = false;
  let observedAttemptId;
  let observedPid;
  let observedProcessIdentity;

  while (Date.now() < deadline) {
    const observation = inspectMission(stateDir, expectedWorkspaceKey, missionId);
    assertPreCheckpointState(observation);
    const kernel = readKernelBindings({
      stateDir,
      workspace,
      workspaceKey: expectedWorkspaceKey,
      missionId,
      expectedE1,
      attempt: observation.activeAttempt,
      process: observation.activeProcess,
    });
    assertSameLeaseOwner(initialLease, kernel.lease);
    if (kernel.lease.leaseUntilMs < latestLeaseUntilMs) {
      throw new Error('The controller lease moved backwards while waiting');
    }
    latestLeaseUntilMs = kernel.lease.leaseUntilMs;
    controllerRenewalObserved ||= kernel.lease.leaseUntilMs > initialLease.leaseUntilMs;
    assertUnexpiredLease(kernel.lease);
    if (observation.activeProcess === undefined) {
      if (observedAttemptId !== undefined) {
        throw new Error('The observed Codex process exited before the checkpoint was signaled');
      }
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    const active = observation.activeProcess;
    if (active.harness !== 'codex') {
      throw new Error(`Refusing to signal an active ${active.harness} runtime`);
    }
    assertPid(active.pid);
    assertProcessAlive(active.pid);
    const processIdentity = readCodexProcessIdentity(active.pid, workspace);
    observedAttemptId ??= active.attemptId;
    observedPid ??= active.pid;
    observedProcessIdentity ??= processIdentity;
    if (active.attemptId !== observedAttemptId || active.pid !== observedPid) {
      throw new Error('The active Codex Attempt or runtime PID changed while waiting');
    }
    if (processIdentity !== observedProcessIdentity) {
      throw new Error('The persisted runtime PID no longer identifies the observed Codex process');
    }
    const checkpoint = snapshotExpectedChanges(workspace, requireBaseline(kernel));

    if (!checkpoint.ready) {
      await delay(POLL_INTERVAL_MS);
      continue;
    }
    assertLedgerUsesEffectCore(workspace);

    if (
      !controllerRenewalObserved ||
      kernel.lease.leaseUntilMs - Date.now() < MIN_CONTROLLER_LEASE_TTL_MS
    ) {
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    const tests = runCoreTests(workspace, deadline);
    if (tests.status !== 'passed') {
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    const confirmed = inspectMission(stateDir, expectedWorkspaceKey, missionId);
    assertPreCheckpointState(confirmed);
    const confirmedActive = confirmed.activeProcess;
    if (
      confirmedActive === undefined ||
      confirmedActive.harness !== 'codex' ||
      confirmedActive.attemptId !== active.attemptId ||
      confirmedActive.stageId !== active.stageId ||
      confirmedActive.pid !== active.pid
    ) {
      throw new Error('Mission, Attempt, or runtime PID changed during checkpoint verification');
    }
    const confirmedKernel = readKernelBindings({
      stateDir,
      workspace,
      workspaceKey: expectedWorkspaceKey,
      missionId,
      expectedE1,
      attempt: confirmed.activeAttempt,
      process: confirmed.activeProcess,
    });
    const confirmedCheckpoint = snapshotExpectedChanges(
      workspace,
      requireBaseline(confirmedKernel),
    );
    if (!sameCheckpoint(checkpoint, confirmedCheckpoint)) {
      await delay(POLL_INTERVAL_MS);
      continue;
    }
    assertLedgerUsesEffectCore(workspace);
    assertSameLeaseOwner(initialLease, confirmedKernel.lease);
    if (
      !controllerRenewalObserved ||
      confirmedKernel.lease.leaseUntilMs <= initialLease.leaseUntilMs ||
      confirmedKernel.lease.leaseUntilMs < latestLeaseUntilMs ||
      confirmedKernel.lease.leaseUntilMs - Date.now() < MIN_CONTROLLER_LEASE_TTL_MS
    ) {
      throw new Error('The original run controller does not hold a sufficiently renewed lease');
    }
    assertProcessAlive(active.pid);
    if (readCodexProcessIdentity(active.pid, workspace) !== observedProcessIdentity) {
      throw new Error('The Codex process identity changed before signaling');
    }
    const signalLease = readControllerLease(stateDir, expectedWorkspaceKey);
    assertSameLeaseOwner(initialLease, signalLease);
    const signalLeaseTtlMs = signalLease.leaseUntilMs - Date.now();
    if (
      signalLease.leaseUntilMs <= initialLease.leaseUntilMs ||
      signalLease.leaseUntilMs < confirmedKernel.lease.leaseUntilMs ||
      signalLeaseTtlMs < MIN_CONTROLLER_LEASE_TTL_MS
    ) {
      throw new Error('The controller lease is not safe at the signal boundary');
    }
    if (readCodexProcessIdentity(active.pid, workspace) !== observedProcessIdentity) {
      throw new Error('The Codex process identity changed at the signal boundary');
    }

    process.kill(active.pid, 'SIGTERM');
    return {
      status: 'signaled',
      missionId,
      attemptId: active.attemptId,
      pid: active.pid,
      changedPaths: checkpoint.changedPaths,
      tests,
      bindings: {
        specSnapshotHash: confirmedKernel.specSnapshotHash,
        baselineWorkspaceDigest: requireBaseline(confirmedKernel).workspaceDigest,
        controllerLeaseRenewed: true,
        controllerLeaseTtlMs: signalLeaseTtlMs,
      },
      signal: 'SIGTERM',
      elapsedMs: Date.now() - startedAt,
    };
  }

  throw new Error(`Timed out after ${String(options.timeoutMs)}ms without a safe E1 checkpoint`);
}

function parseArguments(argv) {
  let stateDir;
  let workspace;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--state-dir' && flag !== '--workspace' && flag !== '--timeout-ms') {
      throw new Error(`Unknown option ${String(flag)}`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
    seen.add(flag);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === '--state-dir') stateDir = resolve(value);
    else if (flag === '--workspace') workspace = resolve(value);
    else timeoutMs = requirePositiveInteger(value, flag);
    index += 1;
  }

  if (stateDir === undefined || workspace === undefined) {
    throw new Error(
      'Usage: interrupt-e1-at-checkpoint.mjs --state-dir <dir> --workspace <dir> [--timeout-ms <ms>]',
    );
  }
  return { stateDir, workspace, timeoutMs };
}

function inspectMission(stateDir, expectedWorkspaceKey, expectedMissionId) {
  const database = openReadOnlyKernel(stateDir);
  let missionRows;
  let eventRows;
  try {
    missionRows = database
      .prepare(
        `SELECT mission_id, workspace_key, status, receipt_json, last_seq, head_hash
           FROM missions
          ORDER BY created_at ASC, mission_id ASC`,
      )
      .all();
    if (missionRows.length !== 1) {
      throw new Error('State directory must contain exactly one fresh Mission');
    }
    eventRows = database
      .prepare(
        `SELECT schema_version, event_id, mission_id, attempt_id, seq, event_type,
                occurred_at, recorded_at, payload_json, payload_hash, prev_hash, event_hash
           FROM mission_events
          WHERE mission_id = ?
          ORDER BY seq ASC`,
      )
      .all(missionRows[0].mission_id);
  } finally {
    database.close();
  }

  const mission = requireRecord(missionRows[0], 'Mission projection row');
  const missionId = requireNonEmptyString(mission.mission_id, 'missionId');
  if (expectedMissionId !== undefined && missionId !== expectedMissionId) {
    throw new Error('The only Mission changed while waiting');
  }
  if (mission.workspace_key !== expectedWorkspaceKey) {
    throw new Error('The only Mission is not bound to the requested workspace');
  }
  if (mission.receipt_json !== null) {
    throw new Error('The Mission already has a Receipt and is not fresh');
  }
  if (mission.status !== 'pending' && mission.status !== 'running') {
    throw new Error(`Mission is already ${String(mission.status)}`);
  }
  const events = eventRows.map(parseMissionEvent);
  assertMissionEventChain(events, mission);

  const plans = new Map();
  const finished = new Map();
  const processByAttempt = new Map();
  for (const event of events) {
    if (event.eventType === 'attempt.finished') {
      const attemptId = requireNonEmptyString(event.payload.attemptId, 'finished attemptId');
      const status = requireNonEmptyString(event.payload.status, 'finished Attempt status');
      if (finished.has(attemptId)) throw new Error('Attempt has more than one finish event');
      finished.set(attemptId, status);
      continue;
    }
    if (event.eventType !== 'runtime.observation') continue;
    const kind = requireNonEmptyString(event.payload.kind, 'runtime observation kind');
    const data = requireRecord(event.payload.data, 'runtime observation data');
    if (kind === 'attempt.plan') {
      const attemptId = requireNonEmptyString(data.attemptId, 'planned attemptId');
      if (plans.has(attemptId)) throw new Error('Attempt has more than one plan event');
      plans.set(attemptId, {
        attemptId,
        stageId: requireNonEmptyString(data.stageId, 'planned stageId'),
        harness: requireNonEmptyString(data.harness, 'planned harness'),
        profileId: requireNonEmptyString(data.profileId, 'planned profileId'),
      });
    } else if (kind === 'runtime.process_started') {
      const attemptId = requireNonEmptyString(data.attemptId, 'process attemptId');
      if (processByAttempt.has(attemptId)) {
        throw new Error('Attempt has more than one runtime process');
      }
      processByAttempt.set(attemptId, {
        attemptId,
        stageId: requireNonEmptyString(data.stageId, 'process stageId'),
        harness: requireNonEmptyString(data.harness, 'process harness'),
        pid: data.pid,
      });
    }
  }
  const attempts = [...plans.values()].map((plan) => ({
    ...plan,
    status: finished.get(plan.attemptId) ?? 'running',
  }));
  if (attempts.length > 1) {
    throw new Error('Fresh E1 state must not contain more than one Attempt before interruption');
  }
  if (attempts.some((attempt) => attempt.harness === 'qoder')) {
    throw new Error('Qoder is already present; refusing a late interruption');
  }
  if (
    attempts.some(
      (attempt) =>
        attempt.stageId !== 'codex-core' ||
        attempt.harness !== 'codex' ||
        attempt.status !== 'running',
    )
  ) {
    throw new Error('The pre-interruption Attempt is not a running Codex Attempt');
  }
  const activeAttempt = attempts.find((attempt) => attempt.status === 'running');
  let activeProcess;
  if (activeAttempt !== undefined) {
    activeProcess = processByAttempt.get(activeAttempt.attemptId);
  }
  if (activeProcess !== undefined) {
    if (
      attempts.length !== 1 ||
      activeAttempt.attemptId !== activeProcess.attemptId ||
      activeAttempt.stageId !== activeProcess.stageId ||
      activeProcess.stageId !== 'codex-core' ||
      activeAttempt.harness !== activeProcess.harness
    ) {
      throw new Error('Active process is ambiguous with the persisted Attempt state');
    }
  }
  return { missionId, activeAttempt, activeProcess };
}

function parseMissionEvent(rowValue) {
  const row = requireRecord(rowValue, 'Mission event row');
  const payloadJson = requireNonEmptyString(row.payload_json, 'Mission event payload');
  let payload;
  try {
    payload = requireRecord(JSON.parse(payloadJson), 'Mission event payload');
  } catch {
    throw new Error('Mission event payload is invalid JSON');
  }
  const event = {
    schemaVersion: requirePositiveSafeInteger(row.schema_version, 'event schema version'),
    eventId: requireNonEmptyString(row.event_id, 'eventId'),
    missionId: requireNonEmptyString(row.mission_id, 'event missionId'),
    attemptId:
      row.attempt_id === null ? null : requireNonEmptyString(row.attempt_id, 'event attemptId'),
    seq: requirePositiveSafeInteger(row.seq, 'event sequence'),
    eventType: requireNonEmptyString(row.event_type, 'event type'),
    occurredAt: requireNonEmptyString(row.occurred_at, 'event occurredAt'),
    recordedAt: requireNonEmptyString(row.recorded_at, 'event recordedAt'),
    payload,
    payloadHash: requireSha256(row.payload_hash, 'event payload hash'),
    prevHash: row.prev_hash === null ? null : requireSha256(row.prev_hash, 'event prevHash'),
    eventHash: requireSha256(row.event_hash, 'event hash'),
  };
  if (hashPayload(payload) !== event.payloadHash) {
    throw new Error('Mission event payload hash does not match its content');
  }
  return event;
}

function assertMissionEventChain(events, mission) {
  const missionId = requireNonEmptyString(mission.mission_id, 'Mission projection missionId');
  let expectedPrevHash = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.missionId !== missionId ||
      event.seq !== index + 1 ||
      event.prevHash !== expectedPrevHash
    ) {
      throw new Error('Mission event chain ordering is invalid');
    }
    const computed = computeEventHash({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      missionId: event.missionId,
      attemptId: event.attemptId,
      seq: event.seq,
      type: event.eventType,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      payloadHash: event.payloadHash,
      prevHash: event.prevHash,
    });
    if (computed !== event.eventHash) throw new Error('Mission event hash is invalid');
    expectedPrevHash = event.eventHash;
  }
  if (
    mission.last_seq !== events.length ||
    mission.head_hash !== expectedPrevHash ||
    !Number.isSafeInteger(mission.last_seq)
  ) {
    throw new Error('Mission projection does not match the event chain');
  }
}

function assertPreCheckpointState(observation) {
  if (observation.activeProcess?.harness === 'qoder') {
    throw new Error('Qoder is already active; refusing a late interruption');
  }
}

function loadExpectedE1Fixture(workspace) {
  const missionFile = realpathSync(e1MissionFile);
  const spec = loadMissionSpec(missionFile, { workspace });
  const [codex, qoder] = spec.attemptPlan;
  if (
    spec.attemptPlan.length !== 2 ||
    codex?.stageId !== 'codex-core' ||
    codex.profile.harness !== 'codex' ||
    codex.onFailure !== 'handoff' ||
    qoder?.stageId !== 'qoder-completion' ||
    qoder.profile.harness !== 'qoder' ||
    qoder.onFailure !== 'stop'
  ) {
    throw new Error('Repository E1 fixture is not the expected Codex-to-Qoder plan');
  }
  const snapshot = createMissionSpecSnapshot(spec);
  return {
    missionFile,
    snapshot,
    snapshotHash: hashPayload(snapshot),
    templatePaths: readTemplatePaths(realpathSync(e1Template)),
  };
}

function readKernelBindings({ stateDir, workspace, workspaceKey, missionId, expectedE1, attempt }) {
  const database = openReadOnlyKernel(stateDir);
  let rows;
  let leaseRow;
  try {
    rows = database
      .prepare(
        `SELECT attempt_id, seq, payload_json, payload_hash
           FROM mission_events
          WHERE mission_id = ? AND event_type = 'runtime.observation'
          ORDER BY seq ASC`,
      )
      .all(missionId);
    leaseRow = database
      .prepare(
        `SELECT workspace_key, owner_id, fencing_token, acquired_at_ms, lease_until_ms
           FROM workspace_leases
          WHERE workspace_key = ?`,
      )
      .get(workspaceKey);
  } finally {
    database.close();
  }

  const observations = rows.map(parseKernelObservation);
  const snapshots = observations.filter(
    (observation) => observation.payload.kind === 'mission.spec_snapshot',
  );
  if (snapshots.length !== 1) {
    throw new Error('Kernel must contain exactly one Mission specification snapshot');
  }
  const specSnapshotHash = assertExactSpecSnapshot(snapshots[0], expectedE1);

  const baselines = observations.filter(
    (observation) => observation.payload.kind === 'attempt.baseline',
  );
  let baseline;
  if (attempt === undefined) {
    if (baselines.length !== 0) {
      throw new Error('Kernel baseline exists without a matching active Attempt');
    }
  } else {
    if (baselines.length !== 1) {
      throw new Error('Kernel must contain exactly one pre-interruption Attempt baseline');
    }
    baseline = assertExactAttemptBaseline(
      baselines[0],
      attempt,
      workspace,
      expectedE1.templatePaths,
    );
  }

  return {
    specSnapshotHash,
    baseline,
    lease: parseLease(leaseRow, workspaceKey),
  };
}

function openReadOnlyKernel(stateDir) {
  const requestedDatabase = join(stateDir, 'kernel.sqlite');
  const databaseStat = lstatSync(requestedDatabase);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw new Error('Kernel database must be a regular file');
  }
  return new DatabaseSync(realpathSync(requestedDatabase), {
    readOnly: true,
    timeout: 5_000,
  });
}

function readControllerLease(stateDir, workspaceKey) {
  const database = openReadOnlyKernel(stateDir);
  let row;
  try {
    row = database
      .prepare(
        `SELECT workspace_key, owner_id, fencing_token, acquired_at_ms, lease_until_ms
           FROM workspace_leases
          WHERE workspace_key = ?`,
      )
      .get(workspaceKey);
  } finally {
    database.close();
  }
  return parseLease(row, workspaceKey);
}

function parseKernelObservation(rowValue) {
  const row = requireRecord(rowValue, 'Kernel observation row');
  const attemptId =
    row.attempt_id === null
      ? null
      : requireNonEmptyString(row.attempt_id, 'Kernel observation attempt_id');
  if (!Number.isSafeInteger(row.seq) || row.seq <= 0) {
    throw new Error('Kernel observation sequence is invalid');
  }
  const payloadJson = requireNonEmptyString(row.payload_json, 'Kernel observation payload');
  const payloadHash = requireSha256(row.payload_hash, 'Kernel observation payload hash');
  let payload;
  try {
    payload = requireRecord(JSON.parse(payloadJson), 'Kernel observation payload');
  } catch {
    throw new Error('Kernel observation payload is invalid JSON');
  }
  if (hashPayload(payload) !== payloadHash) {
    throw new Error('Kernel observation payload hash does not match its content');
  }
  requireNonEmptyString(payload.kind, 'Kernel observation kind');
  requireRecord(payload.data, 'Kernel observation data');
  return { attemptId, seq: row.seq, payload };
}

function assertExactSpecSnapshot(observation, expectedE1) {
  if (observation.attemptId !== null) {
    throw new Error('Mission specification snapshot must not belong to an Attempt');
  }
  const data = requireRecord(observation.payload.data, 'Mission specification snapshot data');
  const snapshotHash = requireSha256(data.snapshotHash, 'Mission specification snapshot hash');
  if (hashPayload(data.snapshot) !== snapshotHash) {
    throw new Error('Mission specification snapshot has an invalid hash');
  }
  if (
    snapshotHash !== expectedE1.snapshotHash ||
    canonicalJson(data.snapshot) !== canonicalJson(expectedE1.snapshot)
  ) {
    throw new Error('Mission is not the exact resolved repository E1 fixture');
  }
  const provenance = requireRecord(data.provenance, 'Mission specification provenance');
  const sourceFile = realpathSync(
    requireNonEmptyString(provenance.sourceFile, 'Mission specification sourceFile'),
  );
  if (sourceFile !== expectedE1.missionFile) {
    throw new Error('Mission specification did not originate from the repository E1 fixture');
  }
  return snapshotHash;
}

function assertExactAttemptBaseline(observation, attempt, workspace, expectedTemplatePaths) {
  if (observation.attemptId !== attempt.attemptId) {
    throw new Error('Attempt baseline event is not bound to the active Attempt');
  }
  const data = requireRecord(observation.payload.data, 'Attempt baseline data');
  if (
    data.attemptId !== attempt.attemptId ||
    data.stageId !== attempt.stageId ||
    data.harness !== attempt.harness
  ) {
    throw new Error('Attempt baseline identity does not match the active Codex stage');
  }
  if (requireNonEmptyString(data.profileId, 'Attempt baseline profileId') !== attempt.profileId) {
    throw new Error('Attempt baseline profile does not match the active Codex plan');
  }
  const snapshot = requireRecord(data.snapshot, 'Attempt baseline snapshot');
  if (snapshot.schemaVersion !== 1 || snapshot.workspaceRoot !== workspace) {
    throw new Error('Attempt baseline belongs to a different workspace or schema');
  }
  const head = requireNonEmptyString(snapshot.head, 'Attempt baseline HEAD');
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) {
    throw new Error('Attempt baseline HEAD is not a Git object id');
  }
  if (!Array.isArray(snapshot.status) || snapshot.status.length !== 0) {
    throw new Error('Attempt baseline workspace was not clean');
  }
  if (!Array.isArray(snapshot.paths)) {
    throw new Error('Attempt baseline has no path digest set');
  }
  const paths = snapshot.paths.map(normalizeBaselinePath);
  if (canonicalJson(paths) !== canonicalJson(expectedTemplatePaths)) {
    throw new Error('Attempt baseline does not exactly match the repository E1 template');
  }
  const expectedStatusDigest = hashPayload([]);
  if (snapshot.statusDigest !== expectedStatusDigest) {
    throw new Error('Attempt baseline clean-status digest is invalid');
  }
  const workspaceDigest = hashPayload({ head, status: [], paths });
  if (snapshot.workspaceDigest !== workspaceDigest) {
    throw new Error('Attempt baseline workspace digest is invalid');
  }
  return { head, paths, workspaceDigest };
}

function requireBaseline(kernel) {
  if (kernel.baseline === undefined) {
    throw new Error('Kernel has no exact pre-interruption Attempt baseline');
  }
  return kernel.baseline;
}

function normalizeBaselinePath(value) {
  const entry = requireRecord(value, 'Attempt baseline path');
  const path = requireNonEmptyString(entry.path, 'Attempt baseline path name');
  const kind = requireNonEmptyString(entry.kind, 'Attempt baseline path kind');
  if (kind !== 'file' && kind !== 'symlink') {
    throw new Error(`Attempt baseline path has unsupported kind: ${kind}`);
  }
  return {
    path,
    kind,
    sha256: requireSha256(entry.sha256, `Attempt baseline hash for ${path}`),
  };
}

function readTemplatePaths(root, relativeDirectory = '') {
  const entries = [];
  const directory = join(root, relativeDirectory);
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = relativeDirectory.length === 0 ? item.name : join(relativeDirectory, item.name);
    const absolutePath = join(root, path);
    if (item.isDirectory()) {
      entries.push(...readTemplatePaths(root, path));
    } else if (item.isFile()) {
      entries.push({ path, kind: 'file', sha256: sha256(readFileSync(absolutePath)) });
    } else if (item.isSymbolicLink()) {
      entries.push({
        path,
        kind: 'symlink',
        sha256: sha256(`symlink\0${readlinkSync(absolutePath)}`),
      });
    } else {
      throw new Error(`Repository E1 template has an unsupported path: ${path}`);
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function parseLease(value, expectedWorkspaceKey) {
  const lease = requireRecord(value, 'Controller workspace lease');
  if (lease.workspace_key !== expectedWorkspaceKey) {
    throw new Error('Controller lease belongs to a different workspace');
  }
  return {
    workspaceKey: expectedWorkspaceKey,
    ownerId: requireNonEmptyString(lease.owner_id, 'Controller lease owner'),
    fencingToken: requirePositiveSafeInteger(lease.fencing_token, 'Controller fencing token'),
    acquiredAtMs: requirePositiveSafeInteger(lease.acquired_at_ms, 'Controller lease acquisition'),
    leaseUntilMs: requirePositiveSafeInteger(lease.lease_until_ms, 'Controller lease expiry'),
  };
}

function assertSameLeaseOwner(initial, current) {
  if (
    current.workspaceKey !== initial.workspaceKey ||
    current.ownerId !== initial.ownerId ||
    current.fencingToken !== initial.fencingToken ||
    current.acquiredAtMs !== initial.acquiredAtMs
  ) {
    throw new Error('The original run controller no longer owns the workspace lease');
  }
}

function assertUnexpiredLease(lease) {
  if (lease.leaseUntilMs <= Date.now()) {
    throw new Error('The original run controller lease expired');
  }
}

function assertLedgerUsesEffectCore(workspace) {
  const source = readFileSync(join(workspace, 'src', 'ledger.mjs'), 'utf8');
  const probe = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-vm-modules',
      '--input-type=module',
      '--eval',
      `import { SourceTextModule } from 'node:vm';
       const chunks = [];
       for await (const chunk of process.stdin) chunks.push(chunk);
       const module = new SourceTextModule(chunks.join(''));
       process.stdout.write(JSON.stringify(module.dependencySpecifiers));`,
    ],
    {
      encoding: 'utf8',
      input: source,
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 65_536,
    },
  );
  let dependencies;
  try {
    dependencies = probe.status === 0 ? JSON.parse(probe.stdout) : [];
  } catch {
    dependencies = [];
  }
  if (!Array.isArray(dependencies) || !dependencies.includes('./effect-core.mjs')) {
    throw new Error('src/ledger.mjs does not retain the required ./effect-core.mjs dependency');
  }
}

function snapshotExpectedChanges(workspace, baseline) {
  const head = runGit(workspace, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim();
  if (head !== baseline.head) {
    throw new Error('Workspace HEAD moved away from the recorded Attempt baseline');
  }
  const tracked = runGit(workspace, ['diff', '--name-only', '-z', 'HEAD', '--']);
  const untracked = runGit(workspace, ['ls-files', '--others', '--exclude-standard', '-z']);
  const changedPaths = [...new Set([...parseNulList(tracked), ...parseNulList(untracked)])].sort();
  const unexpected = changedPaths.filter((path) => !EXPECTED_CHANGED_PATHS.includes(path));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected workspace changes: ${unexpected.join(', ')}`);
  }
  const ready = arraysEqual(changedPaths, EXPECTED_CHANGED_PATHS);
  if (!ready) return { ready, changedPaths, digests: {} };
  assertCurrentPathSetMatchesBaseline(workspace, baseline.paths);

  const digests = {};
  for (const path of changedPaths) {
    const absolutePath = join(workspace, path);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Checkpoint path is not a regular file: ${path}`);
    }
    digests[path] = sha256(readFileSync(absolutePath));
  }
  return { ready, changedPaths, digests };
}

function assertCurrentPathSetMatchesBaseline(workspace, baselinePaths) {
  const baselineByPath = new Map(baselinePaths.map((entry) => [entry.path, entry]));
  const allowedPaths = [...new Set([...baselineByPath.keys(), ...EXPECTED_CHANGED_PATHS])].sort(
    (left, right) => left.localeCompare(right, 'en'),
  );
  const currentPaths = parseNulList(
    runGit(workspace, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
  ).sort((left, right) => left.localeCompare(right, 'en'));
  if (!arraysEqual(currentPaths, allowedPaths)) {
    throw new Error('Workspace path set no longer matches the recorded Attempt baseline');
  }
  for (const [path, expected] of baselineByPath) {
    if (EXPECTED_CHANGED_PATHS.includes(path)) continue;
    const actual = digestWorkspaceEntry(workspace, path);
    if (actual.kind !== expected.kind || actual.sha256 !== expected.sha256) {
      throw new Error(`Non-checkpoint path changed after the Attempt baseline: ${path}`);
    }
  }
}

function digestWorkspaceEntry(workspace, path) {
  const absolutePath = join(workspace, path);
  const stat = lstatSync(absolutePath);
  if (stat.isFile() && !stat.isSymbolicLink()) {
    return { kind: 'file', sha256: sha256(readFileSync(absolutePath)) };
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', sha256: sha256(`symlink\0${readlinkSync(absolutePath)}`) };
  }
  throw new Error(`Workspace path has unsupported kind at checkpoint: ${path}`);
}

function runCoreTests(workspace, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Timed out before core tests could run');
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'test/core.test.mjs'],
    {
      cwd: workspace,
      encoding: 'utf8',
      shell: false,
      timeout: Math.min(CORE_TEST_TIMEOUT_MS, remaining),
      killSignal: 'SIGKILL',
      maxBuffer: 1_048_576,
    },
  );
  if (result.error !== undefined) {
    throw new Error(`Core test process failed: ${result.error.message}`);
  }
  const total = parseTapCount(result.stdout, 'tests');
  const passed = parseTapCount(result.stdout, 'pass');
  const failed = parseTapCount(result.stdout, 'fail');
  const passedCheckpoint = result.status === 0 && total > 0 && passed === total && failed === 0;
  return {
    status: passedCheckpoint ? 'passed' : 'failed',
    total,
    passed,
    failed,
  };
}

function runGit(workspace, args) {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'buffer',
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 1_048_576,
  });
  if (result.error !== undefined) throw new Error(`git failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git exited with status ${String(result.status)}`);
  }
  return result.stdout;
}

function sameCheckpoint(left, right) {
  return (
    left.ready &&
    right.ready &&
    arraysEqual(left.changedPaths, right.changedPaths) &&
    left.changedPaths.every((path) => left.digests[path] === right.digests[path])
  );
}

function parseNulList(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0);
}

function parseTapCount(stdout, label) {
  const match = stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  return match === null ? 0 : Number.parseInt(match[1], 10);
}

function assertPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error('Persisted runtime PID is invalid or unsafe to signal');
  }
}

function assertProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error('The persisted Codex runtime PID is no longer alive');
  }
}

function readCodexProcessIdentity(pid, workspace) {
  if (process.platform === 'win32') {
    throw new Error('Safe E1 process identity checks are not supported on Windows');
  }
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8',
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 65_536,
  });
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error('The persisted Codex runtime process could not be identified');
  }
  const identity = result.stdout.trim();
  if (!/codex/i.test(identity) || !identity.includes('exec') || !identity.includes(workspace)) {
    throw new Error('The persisted runtime PID is not the expected Codex workspace process');
  }
  return sha256(identity);
}

function assertDisjoint(stateDir, workspace) {
  if (isPathInside(stateDir, workspace) || isPathInside(workspace, stateDir)) {
    throw new Error('State directory and target workspace must be disjoint');
  }
}

function isPathInside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function delay(milliseconds) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
