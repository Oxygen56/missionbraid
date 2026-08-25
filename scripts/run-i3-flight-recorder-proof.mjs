#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
if (!existsSync(builtApp)) throw new Error('Run `pnpm build` before the Iteration 3 proof.');

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i3-proof-'));
const stateDir = join(proofRoot, 'state');
const fakeCredential = 'sk-proj-MISSIONBRAIDFAKE123456789';
const runtimePlans = [
  {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    permissionMode: 'workspace-write',
  },
  {
    harness: 'claude',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'medium',
    permissionMode: 'bypassPermissions',
  },
];

const { startMissionBraidApp } = await import('../dist/src/app.js');
let app;
let restarted;
const browsers = [];
try {
  app = await startMissionBraidApp({ stateDir, port: 0 });
  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const results = [];
  for (const plan of runtimePlans) {
    const runtime = inventory.runtimes.find((candidate) => candidate.id === plan.harness);
    if (runtime?.status !== 'ready-supported') {
      throw new Error(`${plan.harness} is not execution-ready: ${runtime?.reason ?? 'missing'}`);
    }
    const workspace = join(proofRoot, `workspace-${plan.harness}`);
    run(process.execPath, [join(repositoryRoot, 'scripts', 'prepare-i3-fixture.mjs'), workspace]);
    const create = await requestJson(
      `${app.url}/api/v1/missions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(missionInput(workspace, plan)),
      },
      202,
    );
    progress(`${plan.harness}: Mission ${create.missionId} accepted`);
    const liveController = new AbortController();
    const livePromise = observeLiveEvent(app.url, create.missionId, liveController.signal);
    const browser = await launchChrome(app.url, join(proofRoot, `chrome-${plan.harness}`));
    browsers.push(browser);
    const browserPromise = observeBrowserBeforeFinish(app.url, create.missionId, browser);
    const completed = await waitForMission(app.url, create.missionId, 20 * 60_000);
    liveController.abort();
    const live = await livePromise;
    const rendered = await browserPromise;
    await browser.close();
    browsers.splice(browsers.indexOf(browser), 1);

    if (
      completed.mission.status !== 'succeeded' ||
      completed.mission.receipt?.outcome !== 'verified'
    ) {
      throw new Error(`${plan.harness} Mission did not reach a verified Receipt.`);
    }
    const runtimeEvents = entries(completed, 'runtime.event').map((entry) => entry.data);
    const failedTestFact = runtimeEvents
      .flatMap((event) => semanticFacts(event).map((fact) => ({ event, fact })))
      .find(({ fact }) => fact.kind === 'test_run' && fact.status === 'failed');
    if (failedTestFact === undefined) {
      throw new Error(
        `${plan.harness} did not expose the deliberately failed test as a semantic fact.`,
      );
    }
    const contextEvent = entries(completed, 'context.controller_prompt').find(
      (entry) => entry.attemptId === failedTestFact.event.attemptId,
    );
    if (contextEvent === undefined)
      throw new Error('Observable controller context was not recorded.');
    const testObservation = completed.contextGraph.edges.find(
      (edge) =>
        edge.kind === 'event-observation' &&
        edge.fromNodeId === `runtime-event:${failedTestFact.event.runtimeEventId}` &&
        completed.contextGraph.nodes.some(
          (node) => node.nodeId === edge.toNodeId && node.kind === 'test',
        ),
    );
    const testNode = completed.contextGraph.nodes.find(
      (node) => node.nodeId === testObservation?.toNodeId,
    );
    const promptNode = completed.contextGraph.nodes.find(
      (node) => node.kind === 'context-item' && node.label.startsWith('controller prompt'),
    );
    if (testNode === undefined || promptNode === undefined) {
      throw new Error('Context Graph did not retain the failed test and visible prompt boundary.');
    }
    const promptBinding = completed.contextGraph.edges.find(
      (edge) =>
        edge.basis === 'controller-prompt-binding' &&
        edge.fromNodeId === `runtime-event:${failedTestFact.event.runtimeEventId}` &&
        edge.toNodeId === promptNode.nodeId,
    );
    if (promptBinding === undefined) {
      throw new Error('Failed test source event is not bound to the visible controller prompt.');
    }
    for (const boundary of [
      'hidden-model-state',
      'provider-kv-cache',
      'model-context-unavailable',
    ]) {
      if (!completed.contextGraph.unavailable.some((item) => item.kind === boundary)) {
        throw new Error(`Context Graph did not preserve ${boundary}.`);
      }
    }
    const promptArtifact = await requestJson(
      `${app.url}/api/v1/artifacts/${encodeURIComponent(contextEvent.data.nativeArtifact.artifactId)}`,
    );
    const failedArtifact = await requestJson(
      `${app.url}/api/v1/artifacts/${encodeURIComponent(failedTestFact.event.nativeArtifact.artifactId)}`,
    );
    const redactedRuntimeEvent = runtimeEvents.find(
      (event) => event.nativeArtifact.redactionCount > 0,
    );
    if (redactedRuntimeEvent === undefined) {
      throw new Error('No native Runtime artifact demonstrated credential-like redaction.');
    }
    const redactedRuntimeArtifact = await requestJson(
      `${app.url}/api/v1/artifacts/${encodeURIComponent(redactedRuntimeEvent.nativeArtifact.artifactId)}`,
    );
    if (
      promptArtifact.content.includes(fakeCredential) ||
      failedArtifact.content.includes(fakeCredential) ||
      redactedRuntimeArtifact.content.includes(fakeCredential)
    ) {
      throw new Error('Credential-like fixture material survived artifact redaction.');
    }
    if (sha256(promptArtifact.content) !== promptArtifact.sha256) {
      throw new Error('Controller prompt artifact failed its content hash.');
    }
    results.push({
      plan,
      runtimeVersion: runtime.version,
      workspace,
      missionId: create.missionId,
      finalHeadHash: completed.mission.headHash,
      receiptId: completed.mission.receipt.receiptId,
      sourceProtocol: failedTestFact.event.sourceProtocol,
      runtimeEventCount: runtimeEvents.length,
      semanticFactKinds: [
        ...new Set(runtimeEvents.flatMap((event) => semanticFacts(event).map((fact) => fact.kind))),
      ],
      failedTestRuntimeEventId: failedTestFact.event.runtimeEventId,
      failedTestArtifactId: failedTestFact.event.nativeArtifact.artifactId,
      promptContextSnapshotId: contextEvent.data.contextSnapshotId,
      promptArtifactId: promptArtifact.artifactId,
      promptRedactionCount: contextEvent.data.nativeArtifact.redactionCount,
      redactedRuntimeEventId: redactedRuntimeEvent.runtimeEventId,
      redactedRuntimeArtifactId: redactedRuntimeArtifact.artifactId,
      graphIdentity: stableGraph(completed.contextGraph),
      live,
      rendered,
    });
  }

  await app.close();
  app = undefined;
  restarted = await startMissionBraidApp({ stateDir, port: 0 });
  for (const result of results) {
    const restored = await requestJson(
      `${restarted.url}/api/v1/missions/${encodeURIComponent(result.missionId)}`,
    );
    if (
      restored.mission.headHash !== result.finalHeadHash ||
      restored.mission.receipt?.receiptId !== result.receiptId ||
      JSON.stringify(stableGraph(restored.contextGraph)) !== JSON.stringify(result.graphIdentity)
    ) {
      throw new Error(`${result.plan.harness} live evidence changed after restart.`);
    }
  }

  const sourceProtocols = [...new Set(results.map((result) => result.sourceProtocol))];
  if (sourceProtocols.length !== 2)
    throw new Error('Two distinct native protocols were not proven.');
  const latencies = results.flatMap((result) => result.live.latencySamplesMs).sort((a, b) => a - b);
  const endedAt = new Date();
  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-3/v1',
    evidenceLevel: 'same-host-local-real-runtime-and-browser',
    recordedOn: endedAt.toISOString().slice(0, 10),
    implementation: {
      revision: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
      dirtyBeforeRun: git(['status', '--porcelain']).length > 0,
      nodeVersion: process.version,
    },
    productEntry: 'local Workbench page plus durable SSE event stream',
    nativeProtocols: sourceProtocols,
    runs: results.map((result) => ({
      harness: result.plan.harness,
      runtimeVersion: result.runtimeVersion,
      missionId: result.missionId,
      receiptId: result.receiptId,
      sourceProtocol: result.sourceProtocol,
      runtimeEventCount: result.runtimeEventCount,
      semanticFactKinds: result.semanticFactKinds,
      failedTestRuntimeEventId: result.failedTestRuntimeEventId,
      failedTestArtifactId: result.failedTestArtifactId,
      promptContextSnapshotId: result.promptContextSnapshotId,
      promptArtifactId: result.promptArtifactId,
      promptRedactionCount: result.promptRedactionCount,
      redactedRuntimeEventId: result.redactedRuntimeEventId,
      redactedRuntimeArtifactId: result.redactedRuntimeArtifactId,
      eventDeliveredBeforeProcessFinished: result.live.beforeProcessFinished,
      browserRenderedBeforeProcessFinished: result.rendered.beforeProcessFinished,
      browserTimelineText: result.rendered.timelineText,
      browserContextVisible: result.rendered.contextVisible,
    })),
    latency: {
      sampleCount: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      measurement: 'durable journal recordedAt to Node EventSource consumer receive time',
      releaseTarget: 'p95 <= 1000 ms on the retained same-host fixture',
    },
    restartRecovery: {
      sameMissionHeads: true,
      sameReceipts: true,
      sameContextGraphs: true,
    },
    redaction: {
      injectedCredentialLikeFixtureRemoved: true,
      promptArtifactHashesVerified: true,
    },
    claimBoundary:
      'This proves same-host live durable event delivery and browser rendering before process completion for real Codex and Claude Code native protocols, visible controller-prompt provenance, structured test failure evidence, explicit unavailable hidden context, redaction, and restart-stable Context Graph reconstruction. It does not prove complete provider context, global native ordering, pre-tool control, production latency, or independent external reproduction.',
    proofRoot,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputFile === undefined) process.stdout.write(serialized);
  else writeFileSync(outputFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  progress('Iteration 3 real Runtime and browser evidence complete.');
} finally {
  for (const browser of browsers) await browser.close().catch(() => undefined);
  if (app !== undefined) await app.close();
  if (restarted !== undefined) await restarted.close();
}

function missionInput(workspace, plan) {
  return {
    title: `Debug one Agent behavior with ${plan.harness}`,
    objective:
      'Observe the failing Agent behavior test, correct the visible Agent configuration, rerun the test, and satisfy the independent verifier.',
    workspace,
    constraints: [
      'Run node --test before changing agent-config.json and run it again afterward',
      'Change only agent-config.json',
    ],
    verifier: { executable: 'node', args: ['verify.mjs'], timeoutMs: 30_000 },
    stages: [
      {
        stageId: `${plan.harness}-agent-debug`,
        harness: plan.harness,
        model: plan.model,
        reasoningEffort: plan.reasoningEffort,
        permissionMode: plan.permissionMode,
        injectionBudgetTokens: 1_600,
        instruction:
          'Follow AGENTS.md. First run node --test and observe the failure. Then change only agent-config.json so the behavior contract passes, and run node --test again.',
      },
    ],
  };
}

async function observeLiveEvent(baseUrl, missionId, signal) {
  const response = await fetch(
    `${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}/events?after=0`,
    { signal },
  );
  if (!response.ok || response.body === null) throw new Error('Live event stream did not open.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const latencySamplesMs = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Live event stream ended before a Runtime event arrived.');
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = packet.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine === undefined || !packet.includes('event: timeline')) continue;
        const payload = JSON.parse(dataLine.slice(6));
        const latency = Math.max(0, Date.now() - Date.parse(payload.entry.recordedAt));
        latencySamplesMs.push(latency);
        if (payload.entry.kind !== 'runtime.event') continue;
        const detail = await requestJson(
          `${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`,
        );
        const processFinished = entries(detail, 'runtime.process_finished').length > 0;
        if (!processFinished && detail.operation?.phase === 'running') {
          return {
            beforeProcessFinished: true,
            runtimeEventSeq: payload.entry.seq,
            receivedAt: new Date().toISOString(),
            latencySamplesMs,
          };
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function observeBrowserBeforeFinish(baseUrl, missionId, browser) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const view = await browser.evaluate(`(() => {
      const live = document.querySelector('.timeline-live');
      const context = document.querySelector('.context-graph');
      return {
        timelineText: live ? live.textContent : '',
        timelineItems: document.querySelectorAll('.timeline-item').length,
        contextVisible: Boolean(context && context.textContent.includes('controller prompt')),
      };
    })()`);
    if (
      view.timelineItems > 0 &&
      view.contextVisible &&
      /LIVE|\u5b9e\u65f6/.test(view.timelineText)
    ) {
      const detail = await requestJson(
        `${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`,
      );
      if (entries(detail, 'runtime.process_finished').length === 0) {
        return { ...view, beforeProcessFinished: true, renderedAt: new Date().toISOString() };
      }
    }
    await wait(200);
  }
  throw new Error('Browser did not render live Context Graph evidence before process completion.');
}

async function launchChrome(url, userDataDir) {
  const port = await freePort();
  const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const process = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 20_000;
  let target;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
      target = targets.find((candidate) => candidate.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
    await wait(100);
  }
  if (!target?.webSocketDebuggerUrl) {
    process.kill('SIGTERM');
    throw new Error('Chrome DevTools endpoint did not become ready.');
  }
  const client = await cdp(target.webSocketDebuggerUrl);
  return {
    evaluate: async (expression) => {
      const result = await client.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
      return result.result.value;
    },
    close: async () => {
      client.close();
      process.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => process.once('exit', resolveExit)),
        wait(2_000),
      ]);
    },
  };
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (port === undefined) throw new Error('Could not allocate a browser debugging port.');
  return port;
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

async function requestJson(url, options, expectedStatus = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = JSON.parse(text);
  if (response.status !== expectedStatus) {
    throw new Error(`${url} returned ${String(response.status)}: ${text.slice(0, 500)}`);
  }
  return body;
}

function semanticFacts(event) {
  return Array.isArray(event.normalized?.semanticFacts) ? event.normalized.semanticFacts : [];
}

function entries(detail, kind) {
  return detail.timeline.filter((entry) => entry.kind === kind);
}

function stableGraph(graph) {
  return {
    nodes: graph.nodes.map((node) => node.nodeId),
    edges: graph.edges.map((edge) => [edge.edgeId, edge.fromNodeId, edge.toNodeId, edge.basis]),
    contextDiffs: graph.contextDiffs.map((diff) => diff.diffId),
    unavailable: graph.unavailable.map((boundary) => boundary.boundaryId),
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function git(args) {
  return run('git', ['-C', repositoryRoot, ...args]).stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function progress(message) {
  process.stderr.write(`[iteration-3] ${message}\n`);
}
