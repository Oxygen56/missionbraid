#!/usr/bin/env node

import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { wait } from './headless-workbench.mjs';

const root = mkdtempSync(join(tmpdir(), 'missionbraid-plan-resume-probe-'));
const workspace = join(root, 'workspace');
const stateDir = join(root, 'state');
const fakeCodex = join(root, 'codex');
mkdirSync(workspace, { recursive: true });

writeFileSync(join(workspace, 'README.md'), 'Plan/resume composition probe.\n', 'utf8');
writeFileSync(
  join(workspace, 'verify-task.mjs'),
  `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
if (!existsSync(join(process.cwd(), '.missionbraid', 'contract-revision.json'))) process.exit(0);
if (readFileSync(join(process.cwd(), 'agent-output.txt'), 'utf8') !== 'task-output\\n') process.exit(1);
`,
  'utf8',
);
writeFileSync(
  join(workspace, 'verify-final.mjs'),
  `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
if (!existsSync(join(process.cwd(), '.missionbraid', 'contract-revision.json'))) process.exit(0);
if (readFileSync(join(process.cwd(), 'agent-output.txt'), 'utf8') !== 'task-output\\n') process.exit(1);
if (readFileSync(join(process.cwd(), 'secondary-output.txt'), 'utf8') !== 'secondary-output\\n') process.exit(2);
if (readFileSync(join(process.cwd(), 'integration-summary.txt'), 'utf8') !== 'joined\\n') process.exit(2);
`,
  'utf8',
);
writeFileSync(
  join(workspace, 'verify-secondary.mjs'),
  `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
if (!existsSync(join(process.cwd(), '.missionbraid', 'contract-revision.json'))) process.exit(0);
if (readFileSync(join(process.cwd(), 'secondary-output.txt'), 'utf8') !== 'secondary-output\\n') process.exit(1);
`,
  'utf8',
);
writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') { process.stdout.write('codex-cli composition-probe\\n'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const controlled = existsSync(join(process.cwd(), '.missionbraid', 'contract-revision.json'));
  if (controlled) {
    if (prompt.includes('integration-summary.txt')) {
      writeFileSync(join(process.cwd(), 'integration-summary.txt'), 'joined\\n');
    } else if (prompt.includes('secondary-output.txt')) {
      writeFileSync(join(process.cwd(), 'secondary-output.txt'), 'secondary-output\\n');
    } else {
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'task-output\\n');
    }
  }
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
});
`,
  { encoding: 'utf8', mode: 0o700 },
);
chmodSync(fakeCodex, 0o700);
git(['init', '-q', '-b', 'main']);
git(['add', '.']);
git([
  '-c',
  'user.name=MissionBraid',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'plan resume composition baseline',
]);

const { startMissionBraidApp } = await import('../dist/src/app.js');
const { MissionEngine } = await import('../dist/src/engine.js');
const { CodexAdapter } = await import('../dist/src/adapters/codex.js');
const engineFactory = (directory) =>
  new MissionEngine({
    stateDir: directory,
    codexAdapter: new CodexAdapter({ command: fakeCodex }),
  });

let app;
try {
  app = await startMissionBraidApp({
    stateDir,
    port: 0,
    engineFactory,
    discoverRuntimes: async () => [
      {
        id: 'codex',
        label: 'Codex probe',
        status: 'ready-supported',
        version: 'composition-probe',
        source: fakeCodex,
      },
    ],
  });
  const created = await requestJson(
    `${app.url}/api/v1/missions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(missionDraft()),
    },
    201,
  );
  if (created.operation !== null) throw new Error('Plan Mission unexpectedly auto-started.');

  await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/resume`,
    { method: 'POST' },
    202,
  );
  const fallback = await waitFor(
    app.url,
    created.missionId,
    (detail) => detail.operation?.action === 'resume' && detail.operation?.phase === 'completed',
  );
  if (
    fallback.mission.receipt?.outcome !== 'verified' ||
    fallback.mission.receipt.planRevisionId === undefined
  ) {
    throw new Error('The legacy resume fallback did not issue a verified Receipt.');
  }
  const fallbackReceiptId = fallback.mission.receipt.receiptId;

  await requestJson(
    `${app.url}/api/v1/missions/${encodeURIComponent(created.missionId)}/plan/execute`,
    { method: 'POST' },
    202,
  );
  const planned = await waitFor(
    app.url,
    created.missionId,
    (detail) => detail.operation?.action === 'plan' && detail.operation?.phase === 'completed',
  );
  if (
    planned.operation.resultStatus !== 'succeeded' ||
    planned.mission.receipt?.outcome !== 'verified' ||
    planned.mission.receipt.receiptId === fallbackReceiptId ||
    planned.missionPlan?.execution?.attempts?.length !== 3
  ) {
    throw new Error('The same Mission did not complete its explicit Plan after fallback resume.');
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        missionId: created.missionId,
        legacyResume: {
          receiptId: fallbackReceiptId,
          outcome: fallback.mission.receipt.outcome,
        },
        planExecute: {
          receiptId: planned.mission.receipt.receiptId,
          outcome: planned.mission.receipt.outcome,
          attemptIds: planned.missionPlan.execution.attempts.map((attempt) => attempt.attemptId),
          artifactIds: planned.missionPlan.execution.artifacts.map(
            (record) => record.artifact.artifactId,
          ),
        },
        sameMission: true,
        engineChangesRequired: [],
        proofRoot: root,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (app !== undefined) await app.close().catch(() => undefined);
}

function missionDraft() {
  const stage = {
    harness: 'codex',
    model: 'default',
    reasoningEffort: 'medium',
    permissionMode: 'workspace-write',
    injectionBudgetTokens: 1_000,
  };
  return {
    title: 'Compose fallback resume and explicit Plan execution',
    objective: 'Prove both execution modes can advance one Mission identity.',
    workspace,
    constraints: ['Stay inside the disposable workspace.'],
    acceptanceCriteria: [
      {
        id: 'task-output',
        description: 'The task node produces its declared output.',
        verifier: { executable: 'node', args: ['verify-task.mjs'], timeoutMs: 5_000 },
      },
      {
        id: 'joined-output',
        description: 'The join node consolidates the task output.',
        verifier: { executable: 'node', args: ['verify-final.mjs'], timeoutMs: 5_000 },
      },
      {
        id: 'secondary-output',
        description: 'The second task node produces its declared output.',
        verifier: { executable: 'node', args: ['verify-secondary.mjs'], timeoutMs: 5_000 },
      },
    ],
    stages: [
      {
        stageId: 'task-stage',
        ...stage,
        instruction: 'Create agent-output.txt only when the Plan controller is active.',
      },
      {
        stageId: 'secondary-stage',
        ...stage,
        instruction: 'Create secondary-output.txt only when the Plan controller is active.',
      },
      {
        stageId: 'join-stage',
        ...stage,
        instruction: 'Create integration-summary.txt only for the consolidation Attempt.',
      },
    ],
    plan: {
      nodes: [
        {
          nodeId: 'task',
          kind: 'task',
          title: 'Produce output',
          requirementIds: ['acceptance-task-output'],
          stageId: 'task-stage',
          acceptanceCriterionIds: ['task-output'],
          declaredOutputKeys: ['agent-output.txt'],
          requiredAuthorityScopes: ['workspace'],
        },
        {
          nodeId: 'secondary-task',
          kind: 'task',
          title: 'Produce secondary output',
          requirementIds: ['acceptance-secondary-output'],
          stageId: 'secondary-stage',
          acceptanceCriterionIds: ['secondary-output'],
          declaredOutputKeys: ['secondary-output.txt'],
          requiredAuthorityScopes: ['workspace'],
        },
        {
          nodeId: 'join',
          kind: 'join',
          title: 'Join output',
          requirementIds: ['acceptance-joined-output'],
          stageId: 'join-stage',
          acceptanceCriterionIds: ['joined-output'],
          declaredOutputKeys: ['integration-summary.txt'],
          requiredAuthorityScopes: ['workspace:integrate'],
        },
      ],
      edges: [
        {
          fromNodeId: 'task',
          toNodeId: 'join',
          relation: 'join-input',
          evidenceRefs: ['probe:task-to-join'],
        },
        {
          fromNodeId: 'secondary-task',
          toNodeId: 'join',
          relation: 'join-input',
          evidenceRefs: ['probe:secondary-to-join'],
        },
      ],
    },
  };
}

async function waitFor(baseUrl, missionId, predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const detail = await requestJson(`${baseUrl}/api/v1/missions/${encodeURIComponent(missionId)}`);
    if (detail.operation?.phase === 'failed' || detail.operation?.phase === 'interrupted') {
      throw new Error(`Operation failed: ${detail.operation.error ?? 'unknown error'}`);
    }
    if (predicate(detail)) return detail;
    await wait(50);
  }
  throw new Error('Composition probe timed out.');
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
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}
