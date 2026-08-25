#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchHeadlessWorkbench, wait } from './headless-workbench.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtApp = join(repositoryRoot, 'dist', 'src', 'app.js');
if (!existsSync(builtApp)) throw new Error('Run `pnpm build` before the Iteration 4 proof.');

const outputFile = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
const proofRoot = mkdtempSync(join(tmpdir(), 'missionbraid-i4-tool-gateway-'));
const stateDir = join(proofRoot, 'state');
const workspace = join(proofRoot, 'workspace');
const originalFile = join(workspace, 'original.txt');
const approvedFile = join(workspace, 'approved.txt');
run(process.execPath, [join(repositoryRoot, 'scripts', 'prepare-i4-fixture.mjs'), workspace]);

const { startMissionBraidApp } = await import('../dist/src/app.js');
let app;
let restarted;
let browser;
try {
  app = await startMissionBraidApp({ stateDir, port: 0 });
  const inventory = await requestJson(`${app.url}/api/v1/runtimes`);
  const runtime = inventory.runtimes.find((candidate) => candidate.id === 'claude');
  if (runtime?.status !== 'ready-supported') {
    throw new Error(`Claude Code is not execution-ready: ${runtime?.reason ?? 'missing'}`);
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
  progress(`Mission ${created.missionId} accepted`);
  browser = await launchHeadlessWorkbench(app.url, join(proofRoot, 'chrome'));

  const handled = new Set();
  const browserDecisions = [];
  let modified;
  let completed;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const detail = await requestJson(
      `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
    );
    if (
      detail.mission.status === 'failed' ||
      (detail.mission.status === 'succeeded' && detail.mission.receipt !== undefined)
    ) {
      completed = detail;
      break;
    }
    for (const gate of detail.toolGates ?? []) {
      if (handled.has(gate.gateId)) continue;
      await waitForBrowserGate(browser, gate.gateId);
      if (gate.toolName === 'Write' && modified === undefined) {
        if (existsSync(originalFile) || existsSync(approvedFile)) {
          throw new Error('The Write side effect occurred before the Workbench decision.');
        }
        const updatedInput = modifiedWriteInput(gate.toolInput, approvedFile);
        const click = await clickGate(browser, gate.gateId, 'modify', updatedInput);
        if (!click.clicked) throw new Error('Workbench could not apply the edited tool input.');
        modified = {
          attemptId: gate.attemptId,
          gateId: gate.gateId,
          effectId: gate.effectId,
          requestSha256: gate.requestSha256,
          originalInput: gate.toolInput,
          updatedInput,
          originalSideEffectAbsentBeforeDecision: true,
          workbenchCardText: click.cardText,
        };
        browserDecisions.push({ gateId: gate.gateId, decision: 'modify' });
      } else {
        const decision = gate.toolName === 'Write' ? 'reject' : 'approve';
        const click = await clickGate(browser, gate.gateId, decision);
        if (!click.clicked) throw new Error(`Workbench could not ${decision} ${gate.toolName}.`);
        browserDecisions.push({ gateId: gate.gateId, decision, toolName: gate.toolName });
      }
      handled.add(gate.gateId);
    }
    await wait(100);
  }
  if (completed === undefined) throw new Error('Tool Gateway Mission timed out.');
  if (modified === undefined) throw new Error('No native Write request reached the Workbench.');
  if (
    completed.mission.status !== 'succeeded' ||
    completed.mission.receipt?.outcome !== 'verified'
  ) {
    throw new Error('The modified native tool Mission did not reach a verified Receipt.');
  }
  if (existsSync(originalFile)) throw new Error('The original side effect unexpectedly exists.');
  if (readFileSync(approvedFile, 'utf8') !== 'APPROVED\n') {
    throw new Error('The modified Write input did not produce the approved file.');
  }
  const requested = timeline(completed, 'tool.gate.requested').find(
    (entry) => entry.data?.gateId === modified.gateId,
  );
  const decided = timeline(completed, 'tool.gate.decided').find(
    (entry) => entry.data?.gateId === modified.gateId && entry.data?.decision === 'modify',
  );
  const result = timeline(completed, 'tool.gate.result').find(
    (entry) => entry.data?.gateId === modified.gateId && entry.data?.outcome === 'succeeded',
  );
  const dispatch = timeline(completed, 'effect.status_changed').find(
    (entry) =>
      entry.data?.effectId === modified.effectId && entry.data?.status === 'dispatch_started',
  );
  const confirmed = timeline(completed, 'effect.status_changed').find(
    (entry) => entry.data?.effectId === modified.effectId && entry.data?.status === 'confirmed',
  );
  if (
    requested === undefined ||
    decided === undefined ||
    result === undefined ||
    dispatch === undefined ||
    confirmed === undefined ||
    !(requested.seq < decided.seq && decided.seq < dispatch.seq && dispatch.seq < result.seq)
  ) {
    throw new Error('The native gate decision and Effect evidence are incomplete or misordered.');
  }
  const finalHead = completed.mission.headHash;
  const receiptId = completed.mission.receipt.receiptId;

  await browser.close();
  browser = undefined;
  await app.close();
  app = undefined;
  restarted = await startMissionBraidApp({ stateDir, port: 0 });
  const restored = await requestJson(
    `${restarted.url}/api/v1/missions/${encodeURIComponent(created.missionId)}`,
  );
  if (
    restored.mission.headHash !== finalHead ||
    restored.mission.receipt?.receiptId !== receiptId ||
    timeline(restored, 'tool.gate.decided').find(
      (entry) => entry.data?.gateId === modified.gateId && entry.data?.decision === 'modify',
    ) === undefined
  ) {
    throw new Error('The Tool Gateway evidence did not survive restart.');
  }

  const evidence = {
    schemaVersion: 'missionbraid.dev/evidence/iteration-4-tool-gateway/v1',
    evidenceLevel: 'same-host-local-real-native-hook-and-browser',
    recordedOn: new Date().toISOString().slice(0, 10),
    implementation: {
      revision: git(['rev-parse', 'HEAD']),
      tree: git(['write-tree']),
      dirtyBeforeRun: git(['status', '--porcelain']).length > 0,
      nodeVersion: process.version,
    },
    runtime: { harness: 'claude', version: runtime.version, source: runtime.source },
    productEntry: 'local Workbench native pre-tool decision card',
    missionId: created.missionId,
    receiptId,
    modifiedGate: {
      ...modified,
      requestedSeq: requested.seq,
      decidedSeq: decided.seq,
      dispatchStartedSeq: dispatch.seq,
      resultSeq: result.seq,
      confirmedSeq: confirmed.seq,
    },
    browserDecisions,
    filesystemResult: {
      originalFileAbsent: !existsSync(originalFile),
      approvedFileContent: readFileSync(approvedFile, 'utf8'),
    },
    restartRecovery: { sameMissionHead: true, sameReceipt: true, sameDecisionEvidence: true },
    claimBoundary:
      'This proves a real Claude Code native PreToolUse hook blocked a mutable Write before dispatch, the normal Workbench displayed the sanitized request, a browser user changed its supported input, the Kernel persisted the decision before release, the changed operation executed, and the same Mission reached a verified Receipt with restart-stable evidence. It does not yet prove MCP proxy coverage, arbitrary Harness pre-tool control, hostile child-process containment, external Effect crash reconciliation, production use, or independent external reproduction.',
    proofRoot,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outputFile === undefined) process.stdout.write(serialized);
  else writeFileSync(outputFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  progress('Iteration 4 native Tool Gateway evidence complete.');
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  if (app !== undefined) await app.close();
  if (restarted !== undefined) await restarted.close();
}

function missionInput(workspacePath) {
  return {
    title: 'Modify one Agent tool request before dispatch',
    objective:
      'Create the requested file through the native Write tool, allow the developer to revise that request before dispatch, then verify the actual workspace result.',
    workspace: workspacePath,
    constraints: [
      'Follow AGENTS.md exactly',
      'Use the native Write tool before any mutable shell command',
      'Do not access the network or external services',
    ],
    verifier: { executable: 'node', args: ['verify.mjs'], timeoutMs: 30_000 },
    stages: [
      {
        stageId: 'claude-live-tool-debug',
        harness: 'claude',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'medium',
        permissionMode: 'bypassPermissions',
        injectionBudgetTokens: 1_600,
        breakpoint: 'mutable-tools',
        instruction:
          'Follow AGENTS.md. Use the native Write tool exactly as requested there, observe its actual result, then run node verify.mjs. Stop when verification passes.',
      },
    ],
  };
}

function modifiedWriteInput(value, approvedPath) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Write input is not an object.');
  }
  const updated = { ...value };
  if (typeof updated.file_path === 'string') updated.file_path = approvedPath;
  else if (typeof updated.path === 'string') updated.path = approvedPath;
  else throw new Error('Native Write input exposes no supported path field.');
  if (typeof updated.content !== 'string')
    throw new Error('Native Write input exposes no content.');
  updated.content = 'APPROVED\n';
  return updated;
}

async function waitForBrowserGate(browserClient, gateId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const visible = await browserClient.evaluate(`(() => Array.from(
      document.querySelectorAll('.tool-gate-card')
    ).some((card) => card.dataset.gateId === ${JSON.stringify(gateId)}))()`);
    if (visible) return;
    await wait(100);
  }
  throw new Error(`Workbench did not render pending gate ${gateId}.`);
}

async function clickGate(browserClient, gateId, decision, updatedInput) {
  return await browserClient.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.tool-gate-card')).find(
      (candidate) => candidate.dataset.gateId === ${JSON.stringify(gateId)}
    );
    if (!card) return { clicked: false, cardText: '' };
    const editor = card.querySelector('textarea');
    if (${JSON.stringify(decision)} === 'modify') {
      editor.value = ${JSON.stringify(JSON.stringify(updatedInput, null, 2))};
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const button = card.querySelector(
      '[data-tool-gate-decision="' + ${JSON.stringify(decision)} + '"]'
    );
    if (!button) return { clicked: false, cardText: card.textContent || '' };
    const cardText = card.textContent || '';
    button.click();
    return { clicked: true, cardText };
  })()`);
}

function timeline(detail, kind) {
  return detail.timeline.filter((entry) => entry.kind === kind);
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

function git(args) {
  return run('git', ['-C', repositoryRoot, ...args]).stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result;
}

function progress(message) {
  process.stderr.write(`[iteration-4] ${message}\n`);
}
