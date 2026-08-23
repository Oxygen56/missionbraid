import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVENANCE_SCHEMA = 'missionbraid.dev/provenance/v1';
const SHA256 = /^[a-f0-9]{64}$/;
const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hiddenDirectory = join(fixtureDirectory, 'hidden-verifier');
const baselineDirectory = join(fixtureDirectory, 'template');
const probeSourcePath = join(hiddenDirectory, 'target-probe.mjs');

const protectedFixturePaths = [
  'fixture-support.mjs',
  'test/core.test.mjs',
  'test/conflict-and-recovery.test.mjs',
  'test/cli.test.mjs',
];

async function requiredAbsoluteEnvironment(name) {
  const value = process.env[name];
  assert.ok(value !== undefined && value.trim().length > 0, `${name} is required`);
  assert.ok(isAbsolute(value), `${name} must be an absolute path`);
  return await realpath(resolve(value));
}

function isInside(path, parent) {
  const pathFromParent = relative(parent, path);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function assertDigest(value, label) {
  assert.match(value, SHA256, `${label} must be a lowercase SHA-256 digest`);
}

function changesByPath(stage) {
  const changes = new Map();
  assert.ok(Array.isArray(stage.changedPaths), `${stage.stageId} changedPaths must be an array`);
  assert.ok(stage.changedPaths.length > 0, `${stage.stageId} changedPaths must not be empty`);
  for (const change of stage.changedPaths) {
    assert.equal(typeof change.path, 'string');
    assert.ok(
      !isAbsolute(change.path) &&
        !change.path.startsWith('../') &&
        !change.path.includes('/../') &&
        !change.path.includes('\\'),
      `unsafe changed path: ${change.path}`,
    );
    assert.ok(!changes.has(change.path), `duplicate changed path: ${change.path}`);
    if (change.beforeSha256 !== null) {
      assertDigest(change.beforeSha256, `${change.path} beforeSha256`);
    }
    if (change.afterSha256 !== null) {
      assertDigest(change.afterSha256, `${change.path} afterSha256`);
    }
    assert.notEqual(change.beforeSha256, change.afterSha256, `${change.path} must actually change`);
    changes.set(change.path, change);
  }
  return changes;
}

async function verifyFixtureIntegrity(targetWorkspace) {
  for (const path of protectedFixturePaths) {
    assert.equal(
      await sha256File(join(targetWorkspace, path)),
      await sha256File(join(baselineDirectory, path)),
      `${path} differs from the public fixture baseline`,
    );
  }
}

async function verifyProvenance(targetWorkspace, provenancePath) {
  assert.ok(
    !isInside(provenancePath, targetWorkspace),
    'provenance must be controlled outside the target workspace',
  );
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  assert.equal(provenance.schemaVersion, PROVENANCE_SCHEMA);
  assert.equal(typeof provenance.missionId, 'string');
  assert.ok(provenance.missionId.length > 0);
  assert.ok(Array.isArray(provenance.stages));
  assert.equal(provenance.stages.length, 2);

  const [codex, qoder] = provenance.stages;
  assert.deepEqual(
    [codex.stageId, codex.harness, codex.status],
    ['codex-core', 'codex', 'handed_off'],
  );
  assert.deepEqual(
    [qoder.stageId, qoder.harness, qoder.status],
    ['qoder-completion', 'qoder', 'succeeded'],
  );
  assert.ok(codex.attemptId.length > 0 && qoder.attemptId.length > 0);
  assert.notEqual(codex.attemptId, qoder.attemptId);
  for (const stage of [codex, qoder]) {
    assertDigest(stage.beforeWorkspaceDigest, `${stage.stageId} beforeWorkspaceDigest`);
    assertDigest(stage.afterWorkspaceDigest, `${stage.stageId} afterWorkspaceDigest`);
    assert.notEqual(stage.beforeWorkspaceDigest, stage.afterWorkspaceDigest);
  }
  assert.equal(
    codex.afterWorkspaceDigest,
    qoder.beforeWorkspaceDigest,
    'Qoder must start from the exact Codex checkpoint',
  );

  const codexChanges = changesByPath(codex);
  const qoderChanges = changesByPath(qoder);
  assert.deepEqual([...codexChanges.keys()].sort(), ['src/effect-core.mjs', 'src/ledger.mjs']);
  assert.deepEqual([...qoderChanges.keys()].sort(), ['src/cli.mjs', 'src/ledger.mjs']);

  const core = codexChanges.get('src/effect-core.mjs');
  const codexLedger = codexChanges.get('src/ledger.mjs');
  const qoderLedger = qoderChanges.get('src/ledger.mjs');
  const qoderCli = qoderChanges.get('src/cli.mjs');
  assert.equal(core.beforeSha256, null, 'Codex must create its stage-owned core file');
  assertDigest(core.afterSha256, 'Codex core afterSha256');
  assert.equal(
    codexLedger.beforeSha256,
    await sha256File(join(baselineDirectory, 'src/ledger.mjs')),
  );
  assert.equal(qoderLedger.beforeSha256, codexLedger.afterSha256);
  assert.equal(qoderCli.beforeSha256, await sha256File(join(baselineDirectory, 'src/cli.mjs')));
  assert.equal(
    await sha256File(join(targetWorkspace, 'src/effect-core.mjs')),
    core.afterSha256,
    'Qoder changed the Codex-owned core file',
  );
  assert.equal(await sha256File(join(targetWorkspace, 'src/ledger.mjs')), qoderLedger.afterSha256);
  assert.equal(await sha256File(join(targetWorkspace, 'src/cli.mjs')), qoderCli.afterSha256);
  const finalLedgerSource = await readFile(join(targetWorkspace, 'src/ledger.mjs'), 'utf8');
  assert.match(
    finalLedgerSource,
    /['"]\.\/effect-core\.mjs['"]/,
    'final ledger must retain its dependency on the Codex-owned core',
  );
  return provenance;
}

function childEnvironment(targetWorkspace, scratchDirectory) {
  return {
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    TMPDIR: scratchDirectory,
    TMP: scratchDirectory,
    TEMP: scratchDirectory,
    MISSIONBRAID_TARGET_WORKSPACE: targetWorkspace,
  };
}

function permissionArguments(targetWorkspace, scratchDirectory) {
  return [
    '--permission',
    `--allow-fs-read=${targetWorkspace}`,
    `--allow-fs-read=${scratchDirectory}`,
    `--allow-fs-write=${scratchDirectory}`,
  ];
}

function runGeneratedNode(targetWorkspace, scratchDirectory, entry, args = [], input) {
  return spawnSync(
    process.execPath,
    [...permissionArguments(targetWorkspace, scratchDirectory), entry, ...args],
    {
      cwd: targetWorkspace,
      encoding: 'utf8',
      env: childEnvironment(targetWorkspace, scratchDirectory),
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1_048_576,
      ...(input === undefined ? {} : { input }),
    },
  );
}

function runProbe(targetWorkspace, scratchDirectory, request) {
  const result = runGeneratedNode(
    targetWorkspace,
    scratchDirectory,
    join(scratchDirectory, 'target-probe.mjs'),
    [],
    JSON.stringify(request),
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `probe emitted unexpected output: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function runCli(targetWorkspace, scratchDirectory, args) {
  return runGeneratedNode(
    targetWorkspace,
    scratchDirectory,
    join(targetWorkspace, 'src', 'cli.mjs'),
    args,
  );
}

async function verifyIndependentBehavior(targetWorkspace, scratchDirectory) {
  const exportsResult = runProbe(targetWorkspace, scratchDirectory, { action: 'exports' });
  assert.deepEqual(exportsResult, {
    ok: true,
    value: {
      EffectLedger: 'function',
      EffectConflictError: 'function',
      LedgerCorruptionError: 'function',
    },
  });

  const coreResult = runProbe(targetWorkspace, scratchDirectory, {
    action: 'core',
    value: { z: 1, a: { y: 2, x: 1 }, list: [{ b: 2, a: 1 }] },
    input: { key: 'core:one', payload: { z: 2, a: 1 } },
    left: { nested: { z: 2, a: 1 }, list: [{ y: 2, x: 1 }] },
    right: { list: [{ x: 1, y: 2 }], nested: { a: 1, z: 2 } },
  });
  assert.equal(coreResult.ok, true);
  assert.deepEqual(coreResult.value.exports, {
    canonicalJson: 'function',
    createEffect: 'function',
    payloadsEqual: 'function',
    serializeEffect: 'function',
  });
  assert.equal(coreResult.value.canonical, '{"a":{"x":1,"y":2},"list":[{"a":1,"b":2}],"z":1}');
  assert.equal(coreResult.value.equivalent, true);
  assert.equal(
    coreResult.value.serialized,
    '{"schemaVersion":1,"key":"core:one","payload":{"a":1,"z":2}}',
  );
  assert.deepEqual(runProbe(targetWorkspace, scratchDirectory, { action: 'invalid-payloads' }), {
    ok: true,
    value: [true, true, true, true, true, true, true, true, true, true, true],
  });

  const ledgerPath = join(scratchDirectory, 'canonical.jsonl');
  const first = runProbe(targetWorkspace, scratchDirectory, {
    action: 'record',
    filePath: ledgerPath,
    input: { key: 'effect:one', payload: { z: 2, a: { y: 2, x: 1 } } },
  });
  assert.equal(first.ok, true);
  assert.equal(first.value.status, 'recorded');
  assert.equal(
    await readFile(ledgerPath, 'utf8'),
    '{"schemaVersion":1,"key":"effect:one","payload":{"a":{"x":1,"y":2},"z":2}}\n',
  );

  const replayed = runProbe(targetWorkspace, scratchDirectory, {
    action: 'record',
    filePath: ledgerPath,
    input: { key: 'effect:one', payload: { a: { x: 1, y: 2 }, z: 2 } },
  });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.value.status, 'replayed');
  assert.equal((await readFile(ledgerPath, 'utf8')).trim().split('\n').length, 1);

  const conflict = runProbe(targetWorkspace, scratchDirectory, {
    action: 'record',
    filePath: ledgerPath,
    input: { key: 'effect:one', payload: { a: { x: 1, y: 3 }, z: 2 } },
  });
  assert.equal(conflict.ok, false);
  assert.deepEqual(
    [conflict.error.code, conflict.error.key, conflict.error.isEffectConflict],
    ['EFFECT_PAYLOAD_CONFLICT', 'effect:one', true],
  );
  assert.equal((await readFile(ledgerPath, 'utf8')).trim().split('\n').length, 1);

  const tailPath = join(scratchDirectory, 'tail.jsonl');
  assert.equal(
    runProbe(targetWorkspace, scratchDirectory, {
      action: 'record',
      filePath: tailPath,
      input: { key: 'before', payload: { ordinal: 1 } },
    }).ok,
    true,
  );
  await appendFile(
    tailPath,
    Buffer.concat([
      Buffer.from('{"schemaVersion":1,"key":"partial","payload":{"note":"', 'utf8'),
      Buffer.from([0xe4, 0xb8]),
    ]),
  );
  const recovered = runProbe(targetWorkspace, scratchDirectory, {
    action: 'replay',
    filePath: tailPath,
  });
  assert.deepEqual(
    recovered.value.map((effect) => effect.key),
    ['before'],
  );
  assert.equal(
    runProbe(targetWorkspace, scratchDirectory, {
      action: 'record',
      filePath: tailPath,
      input: { key: 'after', payload: { ordinal: 2 } },
    }).ok,
    true,
  );
  assert.deepEqual(
    runProbe(targetWorkspace, scratchDirectory, {
      action: 'replay',
      filePath: tailPath,
    }).value.map((effect) => effect.key),
    ['before', 'after'],
  );
  assert.equal((await readFile(tailPath, 'utf8')).includes('partial'), false);

  for (const [name, committedLine] of [
    ['malformed', '{"schemaVersion":1,bad}\n'],
    ['unknown-schema', '{"schemaVersion":2,"key":"bad","payload":{}}\n'],
    ['invalid-shape', '{"schemaVersion":1,"key":"","payload":[]}\n'],
    ['extra-field', '{"schemaVersion":1,"key":"bad","payload":{},"unexpected":true}\n'],
  ]) {
    const path = join(scratchDirectory, `${name}.jsonl`);
    await writeFile(path, committedLine, 'utf8');
    const corrupt = runProbe(targetWorkspace, scratchDirectory, {
      action: 'replay',
      filePath: path,
    });
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.error.code, 'LEDGER_CORRUPT');
    assert.equal(corrupt.error.isLedgerCorruption, true);
  }

  const cliLedger = join(scratchDirectory, 'cli.jsonl');
  const cliFirst = runCli(targetWorkspace, scratchDirectory, [
    'record',
    cliLedger,
    'cli:one',
    '{"z":2,"a":1}',
  ]);
  assert.equal(cliFirst.status, 0, cliFirst.stderr);
  assert.equal(cliFirst.stderr, '');
  assert.equal(JSON.parse(cliFirst.stdout).status, 'recorded');
  const cliRepeat = runCli(targetWorkspace, scratchDirectory, [
    'record',
    cliLedger,
    'cli:one',
    '{"a":1,"z":2}',
  ]);
  assert.equal(cliRepeat.status, 0, cliRepeat.stderr);
  assert.equal(JSON.parse(cliRepeat.stdout).status, 'replayed');
  const cliConflict = runCli(targetWorkspace, scratchDirectory, [
    'record',
    cliLedger,
    'cli:one',
    '{"a":2,"z":2}',
  ]);
  assert.equal(cliConflict.status, 2);
  assert.equal(JSON.parse(cliConflict.stderr).error.code, 'EFFECT_PAYLOAD_CONFLICT');
  const cliReplay = runCli(targetWorkspace, scratchDirectory, ['replay', cliLedger]);
  assert.equal(cliReplay.status, 0, cliReplay.stderr);
  assert.deepEqual(
    cliReplay.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).key),
    ['cli:one'],
  );
  assert.equal(runCli(targetWorkspace, scratchDirectory, []).status, 64);
  assert.equal(
    runCli(targetWorkspace, scratchDirectory, ['record', cliLedger, 'bad-json', '{']).status,
    64,
  );
}

function verifyPublicTests(targetWorkspace, scratchDirectory) {
  const publicTests = [
    'test/core.test.mjs',
    'test/conflict-and-recovery.test.mjs',
    'test/cli.test.mjs',
  ];
  const result = spawnSync(
    process.execPath,
    [
      ...permissionArguments(targetWorkspace, scratchDirectory),
      '--test',
      '--test-isolation=none',
      ...publicTests,
    ],
    {
      cwd: targetWorkspace,
      encoding: 'utf8',
      env: childEnvironment(targetWorkspace, scratchDirectory),
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 2_097_152,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

const targetWorkspace = await requiredAbsoluteEnvironment('MISSIONBRAID_TARGET_WORKSPACE');
const provenancePath = await requiredAbsoluteEnvironment('MISSIONBRAID_PROVENANCE_FILE');
const scratchDirectory = await realpath(await mkdtemp(join(tmpdir(), 'missionbraid-e1-verifier-')));

try {
  await copyFile(probeSourcePath, join(scratchDirectory, 'target-probe.mjs'));
  await verifyFixtureIntegrity(targetWorkspace);
  const provenance = await verifyProvenance(targetWorkspace, provenancePath);
  await verifyIndependentBehavior(targetWorkspace, scratchDirectory);
  verifyPublicTests(targetWorkspace, scratchDirectory);
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      missionId: provenance.missionId,
      stages: provenance.stages.map(({ stageId, harness, attemptId, status }) => ({
        stageId,
        harness,
        attemptId,
        status,
      })),
      evidence: {
        publicFixtureIntegrity: true,
        independentBehavior: true,
        provenanceBound: true,
      },
    })}\n`,
  );
} finally {
  await rm(scratchDirectory, { recursive: true, force: true });
}
