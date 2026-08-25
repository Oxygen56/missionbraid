#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createQueryableHttpEffectTarget } from './queryable-http-effect-target.mjs';
import { wait } from './headless-workbench.mjs';

const toolEvidenceFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const outputFile = process.argv[3] === undefined ? undefined : resolve(process.argv[3]);
if (toolEvidenceFile === undefined) {
  throw new Error('Expected the retained Iteration 4 Tool Gateway evidence file.');
}
const toolEvidence = JSON.parse(readFileSync(toolEvidenceFile, 'utf8'));
const stateDir = resolve(toolEvidence.proofRoot, 'state');
const missionId = toolEvidence.missionId;
const attemptId = toolEvidence.modifiedGate?.attemptId;
if (typeof missionId !== 'string' || typeof attemptId !== 'string') {
  throw new Error('Tool Gateway evidence does not identify its Mission and Attempt.');
}

const fixture = await startQueryableTarget();
const targetId = 'iteration-4-http-target';
const CONTROLLER_LEASE_TTL_MS = 30_000;
const target = createQueryableHttpEffectTarget(fixture.url, targetId);
const effectId = 'effect-iteration-4-crash-reconcile';
const idempotencyKey = 'iteration-4-create-once';
const payload = { operation: 'create', value: 'MissionBraid external Effect proof' };
const requestBody = {
  attemptId,
  targetId,
  kind: 'record.create',
  resourceKey: 'record:iteration-4',
  authorityRef: 'grant:iteration-4-local-proof',
  idempotencyKey,
  payloadDigest: sha256(JSON.stringify(payload)),
  payload,
};

let crashingController;
let app;
let restarted;
try {
  crashingController = await startCrashingController(stateDir, fixture.url, targetId);
  const crashedRequest = fetch(
    `${crashingController.url}/api/v1/missions/${encodeURIComponent(missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    },
  );
  await expectControllerCrash(crashedRequest, crashingController.completed);
  crashingController = undefined;
  if (fixture.postCount() !== 1 || fixture.receipt(idempotencyKey) === undefined) {
    throw new Error('The queryable target did not accept exactly one Effect before the crash.');
  }
  const leaseRecoveryStartedAt = Date.now();
  await wait(CONTROLLER_LEASE_TTL_MS + 500);
  const leaseRecoveryDelayMs = Date.now() - leaseRecoveryStartedAt;

  const { startMissionBraidApp } = await import('../dist/src/app.js');
  const { MissionEngine } = await import('../dist/src/engine.js');
  const engineFactory = (directory) =>
    new MissionEngine({ stateDir: directory, externalEffectTargets: [target] });
  app = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const callsBeforeReconcile = fixture.calls().length;
  const reconciled = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
  );
  if (
    reconciled.outcome?.status !== 'confirmed' ||
    reconciled.outcome?.source !== 'lookup' ||
    fixture.postCount() !== 1 ||
    fixture.calls().slice(callsBeforeReconcile).join(',') !== `GET:${idempotencyKey}`
  ) {
    throw new Error('Restart did not reconcile by lookup before retry.');
  }

  const detailAfterReconcile = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}`,
  );
  const intended = timeline(detailAfterReconcile, 'effect.intended', effectId);
  const dispatchStarted = timeline(detailAfterReconcile, 'effect.dispatch_started', effectId);
  const reconcileStarted = timeline(detailAfterReconcile, 'effect.reconcile_started', effectId);
  const confirmed = timeline(detailAfterReconcile, 'effect.confirmed', effectId);
  if (
    intended === undefined ||
    dispatchStarted === undefined ||
    reconcileStarted === undefined ||
    confirmed === undefined ||
    !(intended.seq < dispatchStarted.seq && dispatchStarted.seq < reconcileStarted.seq) ||
    confirmed.data?.source !== 'lookup'
  ) {
    throw new Error('External Effect crash/reconciliation evidence is incomplete or misordered.');
  }

  const priorReceiptId = detailAfterReconcile.mission.receipt?.receiptId;
  const verify = await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(missionId)}/verify`,
    { method: 'POST' },
    202,
  );
  const reverified = await waitForReceipt(app.url, missionId, priorReceiptId);
  const receiptEffect = reverified.mission.receipt?.effects?.find(
    (effect) => effect.effectId === effectId,
  );
  if (receiptEffect?.status !== 'confirmed') {
    throw new Error('The refreshed Outcome Receipt did not include the confirmed external Effect.');
  }
  const finalHead = reverified.mission.headHash;
  const finalReceiptId = reverified.mission.receipt.receiptId;
  await app.close();
  app = undefined;

  restarted = await startMissionBraidApp({ stateDir, port: 0, engineFactory });
  const callsBeforePersistedRead = fixture.calls().length;
  const persisted = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(missionId)}/external-effects/${encodeURIComponent(effectId)}/coordinate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
  );
  const finalDetail = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(missionId)}`,
  );
  if (
    persisted.outcome?.source !== 'persisted' ||
    fixture.calls().length !== callsBeforePersistedRead ||
    finalDetail.mission.headHash !== finalHead ||
    finalDetail.mission.receipt?.receiptId !== finalReceiptId
  ) {
    throw new Error('Confirmed external Effect was not stable and side-effect-free after restart.');
  }

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-4-external-effect/v1',
    evidenceLevel: 'same-host-local-real-http-target-and-controller-sigkill',
    recordedOn: new Date().toISOString().slice(0, 10),
    productEntry: 'versioned local external Effect coordination API plus Workbench timeline',
    missionId,
    attemptId,
    effectId,
    target: {
      targetId,
      idempotencyKey,
      postCount: fixture.postCount(),
      callOrder: fixture.calls(),
      receipt: fixture.receipt(idempotencyKey),
    },
    injectedCrash: {
      signal: 'SIGKILL',
      afterTargetAccepted: true,
      beforeExecutedTransitionPersisted: true,
      durableStatusBeforeRestart: 'dispatch_started',
      staleLeaseRecoveryDelayMs: leaseRecoveryDelayMs,
    },
    reconciliation: {
      source: reconciled.outcome.source,
      lookupBeforeAnyRetry: true,
      duplicateDispatches: 0,
      intendedSeq: intended.seq,
      dispatchStartedSeq: dispatchStarted.seq,
      reconcileStartedSeq: reconcileStarted.seq,
      confirmedSeq: confirmed.seq,
    },
    refreshedReceipt: { commandId: verify.commandId, receiptId: finalReceiptId },
    restartRecovery: { source: persisted.outcome.source, targetCallsAdded: 0 },
    claimBoundary:
      'This proves a registered queryable HTTP Effect target accepted one request after intended and dispatch_started were durable, the controller was killed before the local result transition, and a restarted Workbench reconciled by target lookup without a second dispatch. The refreshed Receipt includes the confirmed Effect and another restart returns persisted state without target traffic. It does not prove arbitrary non-queryable services, compensation policy, organizational authorization, production use, or independent external reproduction.',
    proofRoot: toolEvidence.proofRoot,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputFile === undefined) process.stdout.write(serialized);
  else writeFileSync(outputFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  progress('Iteration 4 external Effect crash reconciliation evidence complete.');
} finally {
  if (crashingController !== undefined) crashingController.process.kill('SIGKILL');
  if (app !== undefined) await app.close();
  if (restarted !== undefined) await restarted.close();
  await fixture.close();
}

async function startCrashingController(stateDir, targetUrl, targetId) {
  const child = spawn(
    process.execPath,
    [resolve('scripts/i4-external-effect-controller.mjs'), stateDir, targetUrl, targetId],
    { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] },
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
    throw new Error(
      `Crash controller unexpectedly returned ${String(requestResult.response.status)}.`,
    );
  }
  if (controller.signal !== 'SIGKILL') {
    throw new Error(`Controller did not exit through SIGKILL: ${JSON.stringify(controller)}`);
  }
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
    respondJson(response, 404, { detail: 'not found' });
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
    receipt: (key) => records.get(key),
    close: async () =>
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error === undefined ? resolveClose() : reject(error))),
      ),
  };
}

async function waitForReceipt(baseUrl, missionId, priorReceiptId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    if (
      detail.mission.status === 'succeeded' &&
      detail.mission.receipt?.receiptId !== undefined &&
      detail.mission.receipt.receiptId !== priorReceiptId
    ) {
      return detail;
    }
    await wait(100);
  }
  throw new Error('Mission did not issue a refreshed Receipt after Effect reconciliation.');
}

function timeline(detail, transition, effectId) {
  return detail.timeline.find(
    (entry) =>
      entry.kind === 'external-effect.transition' &&
      entry.data?.transition === transition &&
      entry.data?.effectId === effectId,
  );
}

async function requestJson(url, options, expectedStatus = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = JSON.parse(text);
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${String(response.status)}: ${text.slice(0, 500)}`);
  }
  return body;
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

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function progress(message) {
  process.stderr.write(`[iteration-4] ${message}\n`);
}
