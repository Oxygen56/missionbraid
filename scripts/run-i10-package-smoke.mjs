#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
const PACKAGE_SMOKE_SCHEMA_VERSION = 'missionbraid.dev/package-smoke/v1';
const PUBLIC_API_VERSION = '1.0.0';
const options = parseArguments(process.argv.slice(2));
const smokeRoot = await mkdtemp(join(tmpdir(), 'missionbraid-package-smoke-'));
let daemon;

try {
  await run('pnpm', ['build'], { cwd: REPOSITORY_ROOT });

  const packageManifest = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const packageContract = await import(
    new URL('../dist/src/package-contract.js', import.meta.url).href
  );
  const contractReport = packageContract.validatePackageManifestV1(packageManifest);
  assert(
    contractReport.conforms,
    `Package manifest is not wired: ${JSON.stringify(contractReport.issues)}`,
  );

  const packDirectory = join(smokeRoot, 'pack');
  await mkdir(packDirectory, { recursive: true });
  const pack = await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
    { cwd: REPOSITORY_ROOT },
  );
  const packReport = parsePackReport(pack.stdout);
  const tarballPath = join(packDirectory, packReport.filename);
  const tarballDigest = createHash('sha256')
    .update(await readFile(tarballPath))
    .digest('hex');
  const packedPaths = packReport.files.map((file) => file.path).sort();
  assertRequiredPackagePaths(packedPaths);
  assertNoPrivateRuntimeState(packedPaths);

  const consumerDirectory = join(smokeRoot, 'consumer');
  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'missionbraid-clean-install-smoke',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--loglevel=error',
      tarballPath,
    ],
    { cwd: consumerDirectory },
  );

  const installedPackageRoot = join(consumerDirectory, 'node_modules', 'missionbraid');
  const installedManifest = JSON.parse(
    await readFile(join(installedPackageRoot, 'package.json'), 'utf8'),
  );
  assert(installedManifest.version === '1.0.0', 'Installed package version is not 1.0.0');

  const publicImportReport = await exercisePublicImports(consumerDirectory);
  const adapterConformance = await exerciseThirdPartyAdapter(
    consumerDirectory,
    installedPackageRoot,
  );
  const installedBin = join(consumerDirectory, 'node_modules', '.bin', 'missionbraid');
  const cliHelp = await run(installedBin, ['--help'], { cwd: consumerDirectory });
  assert(
    cliHelp.stdout.includes('missionbraid app'),
    `Installed CLI help is incomplete: ${cliHelp.stdout || cliHelp.stderr}`,
  );

  const stateDirectory = join(smokeRoot, 'state');
  daemon = await startWorkbench(installedBin, stateDirectory, consumerDirectory);
  const rootResponse = await fetch(daemon.url);
  const rootHtml = await rootResponse.text();
  assert(rootResponse.status === 200, `Workbench root returned HTTP ${rootResponse.status}`);
  assert(rootHtml.includes('MissionBraid'), 'Workbench root did not contain the product shell');
  const missionResponse = await fetch(`${daemon.url}/api/v1/missions`);
  const missionList = await missionResponse.json();
  assert(missionResponse.status === 200, `Mission API returned HTTP ${missionResponse.status}`);
  assert(Array.isArray(missionList.missions), 'Mission API did not return its missions array');
  const daemonExit = await stopWorkbench(daemon.child);
  daemon = undefined;
  assert(daemonExit.code === 0, `Workbench exited with ${renderExit(daemonExit)}`);
  const stateStat = await stat(stateDirectory);
  assert(stateStat.isDirectory(), 'Workbench did not initialize its supplied state directory');

  const result = {
    schemaVersion: PACKAGE_SMOKE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'internal-clean-install',
    package: {
      name: installedManifest.name,
      version: installedManifest.version,
      tarballSha256: tarballDigest,
      packedFileCount: packedPaths.length,
      manifestContract: contractReport,
    },
    publicExports: publicImportReport,
    adapterConformance: {
      passed: adapterConformance.passed,
      adapterId: adapterConformance.adapterId,
      adapterVersion: adapterConformance.adapterVersion,
      evidenceLevel: adapterConformance.evidenceLevel,
      failedChecks: adapterConformance.checks
        .filter((check) => check.status === 'failed')
        .map((check) => check.checkId),
    },
    installedProduct: {
      cliHelp: 'passed',
      daemonStartedFromInstalledBin: true,
      workbenchHttpStatus: rootResponse.status,
      missionApiHttpStatus: missionResponse.status,
      cleanShutdown: true,
      suppliedStateDirectoryInitialized: true,
    },
    claims: {
      registryPublication: 'not-performed',
      independentExternalReproduction: 'not-established',
    },
  };

  if (options.output !== undefined) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (daemon !== undefined) await stopWorkbench(daemon.child).catch(() => undefined);
  if (!options.keep) await rm(smokeRoot, { recursive: true, force: true });
}

function parseArguments(argv) {
  let output;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--keep') {
      keep = true;
      continue;
    }
    if (argument !== '--output') throw new Error(`Unknown option ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--output requires a path');
    }
    output = resolve(value);
    index += 1;
  }
  return { output, keep };
}

function parsePackReport(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const report = Array.isArray(parsed) ? parsed[0] : undefined;
  if (report === undefined || typeof report.filename !== 'string' || !Array.isArray(report.files)) {
    throw new Error('npm pack returned an incomplete report');
  }
  return report;
}

function assertRequiredPackagePaths(paths) {
  const required = [
    'package.json',
    'dist/src/cli.js',
    'dist/src/public-api.js',
    'dist/src/public-api.d.ts',
    'dist/src/adapter-sdk.js',
    'dist/src/adapter-sdk.d.ts',
    'dist/src/adapter-conformance.js',
    'dist/src/adapter-conformance.d.ts',
    'docs/adapter-sdk.md',
    'examples/third-party-adapter/adapter.mjs',
    'examples/third-party-adapter/verify.mjs',
    'LICENSE',
    'NOTICE',
  ];
  for (const requiredPath of required) {
    assert(paths.includes(requiredPath), `Package is missing ${requiredPath}`);
  }
}

function assertNoPrivateRuntimeState(paths) {
  const forbidden = paths.filter(
    (path) =>
      path.includes('/.missionbraid/') ||
      path.startsWith('.missionbraid/') ||
      path.endsWith('.db') ||
      path.endsWith('.db-wal') ||
      path.endsWith('.db-shm') ||
      /(^|\/)\.env(?:\.|$)/.test(path) ||
      /\.test\.(?:js|d\.ts)$/.test(path),
  );
  assert(
    forbidden.length === 0,
    `Package contains private or test artifacts: ${forbidden.join(', ')}`,
  );
}

async function exercisePublicImports(consumerDirectory) {
  const probePath = join(consumerDirectory, 'public-import-smoke.mjs');
  await writeFile(
    probePath,
    `import * as root from 'missionbraid';\n` +
      `import * as rootV1 from 'missionbraid/v1';\n` +
      `import * as sdk from 'missionbraid/adapter-sdk';\n` +
      `import * as sdkV1 from 'missionbraid/adapter-sdk/v1';\n` +
      `import * as conformance from 'missionbraid/adapter-conformance';\n` +
      `import * as conformanceV1 from 'missionbraid/adapter-conformance/v1';\n` +
      `import * as contract from 'missionbraid/package-contract';\n` +
      `import * as studio from 'missionbraid/outcome-studio/v1';\n` +
      `import * as plan from 'missionbraid/mission-plan/v1';\n` +
      `import * as planRuntime from 'missionbraid/mission-plan-runtime/v1';\n` +
      `const report = {\n` +
      `  root: root.MISSIONBRAID_PUBLIC_API_VERSION,\n` +
      `  rootV1: rootV1.MISSIONBRAID_PUBLIC_API_VERSION,\n` +
      `  sdk: sdk.ADAPTER_API_VERSION,\n` +
      `  sdkV1: sdkV1.ADAPTER_API_VERSION,\n` +
      `  conformance: conformance.ADAPTER_CONFORMANCE_SCHEMA_VERSION,\n` +
      `  conformanceV1: conformanceV1.ADAPTER_CONFORMANCE_SCHEMA_VERSION,\n` +
      `  packageContract: contract.PACKAGE_CONTRACT_SCHEMA_VERSION,\n` +
      `  outcomeStudio: studio.OUTCOME_CI_RESULT_SCHEMA_VERSION,\n` +
      `  missionPlan: plan.MISSION_PLAN_SCHEMA_VERSION,\n` +
      `  missionPlanRuntime: planRuntime.MISSION_PLAN_RUNTIME_SCHEMA_VERSION,\n` +
      `};\n` +
      `process.stdout.write(JSON.stringify(report));\n`,
  );
  const probe = await run(process.execPath, [probePath], { cwd: consumerDirectory });
  const report = JSON.parse(probe.stdout);
  for (const value of [report.root, report.rootV1, report.sdk, report.sdkV1]) {
    assert(value === PUBLIC_API_VERSION, 'Installed public export version mismatch');
  }
  assert(
    report.outcomeStudio === 'missionbraid.dev/outcome-ci-result/v1',
    'Installed Outcome Studio export is missing',
  );
  assert(
    report.missionPlan === 'missionbraid.dev/mission-plan/v1',
    'Installed Mission Plan export is missing',
  );
  assert(
    report.missionPlanRuntime === 'missionbraid.dev/mission-plan-runtime/v1',
    'Installed Mission Plan runtime export is missing',
  );
  return report;
}

async function exerciseThirdPartyAdapter(consumerDirectory, installedPackageRoot) {
  const sourceDirectory = join(installedPackageRoot, 'examples', 'third-party-adapter');
  const adapterDirectory = join(consumerDirectory, 'third-party-adapter');
  await mkdir(adapterDirectory, { recursive: true });
  await Promise.all(
    ['adapter.mjs', 'verify.mjs'].map(
      async (name) => await copyFile(join(sourceDirectory, name), join(adapterDirectory, name)),
    ),
  );
  const conformance = await run(process.execPath, [join(adapterDirectory, 'verify.mjs')], {
    cwd: consumerDirectory,
  });
  const report = JSON.parse(conformance.stdout);
  assert(report.passed === true, 'Copied third-party Adapter did not pass conformance');
  assert(
    report.independentExternalReproduction?.status === 'not-established',
    'Conformance report overstated independent reproduction',
  );
  return report;
}

async function startWorkbench(installedBin, stateDirectory, cwd) {
  const child = spawn(installedBin, ['app', '--state-dir', stateDirectory, '--port', '0'], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const url = await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Installed Workbench did not start in time: ${stderr || stdout}`));
    }, 15_000);
    const inspect = () => {
      const match = stdout.match(/MissionBraid is ready at (http:\/\/[^\s]+)/);
      if (match?.[1] !== undefined) {
        clearTimeout(timeout);
        resolveReady(match[1]);
      }
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Installed Workbench exited before ready (${renderExit({ code, signal })}): ${stderr || stdout}`,
        ),
      );
    });
    inspect();
  });
  return { child, url };
}

async function stopWorkbench(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  child.kill('SIGTERM');
  return await waitForExit(child, 10_000);
}

async function run(command, args, { cwd }) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const exit = await waitForExit(child, 120_000);
  if (exit.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${renderExit(exit)})\n${stderr || stdout}`,
    );
  }
  return { stdout, stderr };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`Process ${String(child.pid)} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectExit(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

function renderExit(exit) {
  return exit.signal === null ? `code ${String(exit.code)}` : `signal ${String(exit.signal)}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
