#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { launchHeadlessWorkbench, wait } from './headless-workbench.mjs';

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
  const sidecarAbsentFromPackage = !packedPaths.includes(
    'evidence/iteration-10-package-smoke-local-2026-08-26.json',
  );
  assert(sidecarAbsentFromPackage, 'Standard package must exclude its own hash sidecar evidence');
  const extractedPackageRoot = await extractTarball(tarballPath, smokeRoot, 'standard-package');
  const markdownLinks = await assertPackagedMarkdownLinks(extractedPackageRoot);
  const sourceBundlePath = join(packDirectory, 'missionbraid-1.0.0-source-candidate-a.tgz');
  const sourceBundlePathSecond = join(packDirectory, 'missionbraid-1.0.0-source-candidate-b.tgz');
  const buildSourceBundle = async (outputPath) =>
    await run(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'scripts', 'build-source-candidate.mjs'),
        tarballPath,
        join(REPOSITORY_ROOT, 'pnpm-lock.yaml'),
        outputPath,
      ],
      { cwd: REPOSITORY_ROOT },
    );
  const [sourceBundleBuild, sourceBundleBuildSecond] = await Promise.all([
    buildSourceBundle(sourceBundlePath),
    buildSourceBundle(sourceBundlePathSecond),
  ]);
  const sourceBundleMetadata = JSON.parse(sourceBundleBuild.stdout);
  const sourceBundleMetadataSecond = JSON.parse(sourceBundleBuildSecond.stdout);
  assert(
    sourceBundleMetadata.bundleSha256 === sourceBundleMetadataSecond.bundleSha256 &&
      createHash('sha256')
        .update(await readFile(sourceBundlePath))
        .digest('hex') ===
        createHash('sha256')
          .update(await readFile(sourceBundlePathSecond))
          .digest('hex'),
    'Source-candidate rebuild was not byte-identical',
  );
  const extractedSourceRoot = await extractTarball(sourceBundlePath, smokeRoot, 'source-candidate');
  const sourceReproduction = await exerciseExtractedSourceTarball(extractedSourceRoot);

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
  const adapterExamples = await exerciseAdapterExamples(consumerDirectory, installedPackageRoot);
  const externalConsumer = await prepareExternalConsumerAdapter(consumerDirectory);
  const installedBin = join(consumerDirectory, 'node_modules', '.bin', 'missionbraid');
  const cliHelp = await run(installedBin, ['--help'], { cwd: consumerDirectory });
  assert(
    cliHelp.stdout.includes('missionbraid app'),
    `Installed CLI help is incomplete: ${cliHelp.stdout || cliHelp.stderr}`,
  );

  const storeMigration = await exerciseInstalledStoreMigration({
    installedBin,
    consumerDirectory,
    adapterPath: externalConsumer.adapterPath,
    adapterId: externalConsumer.adapterId,
    root: smokeRoot,
  });

  const cliMission = await exerciseInstalledCliMission({
    installedBin,
    consumerDirectory,
    adapterPath: externalConsumer.adapterPath,
    adapterId: externalConsumer.adapterId,
    harnessId: externalConsumer.harnessId,
    root: smokeRoot,
  });

  const stateDirectory = join(smokeRoot, 'state');
  daemon = await startWorkbench(
    installedBin,
    stateDirectory,
    consumerDirectory,
    externalConsumer.adapterPath,
  );
  const rootResponse = await fetch(daemon.url);
  const rootHtml = await rootResponse.text();
  assert(rootResponse.status === 200, `Workbench root returned HTTP ${rootResponse.status}`);
  assert(rootHtml.includes('MissionBraid'), 'Workbench root did not contain the product shell');
  const missionResponse = await fetch(`${daemon.url}/api/v1/missions`);
  const missionList = await missionResponse.json();
  assert(missionResponse.status === 200, `Mission API returned HTTP ${missionResponse.status}`);
  assert(Array.isArray(missionList.missions), 'Mission API did not return its missions array');
  const runtimeResponse = await fetch(`${daemon.url}/api/v1/runtimes`);
  const runtimeInventory = await runtimeResponse.json();
  assert(
    runtimeInventory.adapters?.some((adapter) => adapter.adapterId === externalConsumer.adapterId),
    'Installed Workbench did not inventory the external Adapter',
  );
  const workbenchMission = await exerciseInstalledWorkbenchMission({
    daemonUrl: daemon.url,
    consumerDirectory,
    adapterId: externalConsumer.adapterId,
    harnessId: externalConsumer.harnessId,
    root: smokeRoot,
  });
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
      sidecarAbsentFromPackage,
      markdownLocalLinks: markdownLinks,
      sourceCandidateBundle: {
        ...sourceBundleMetadata,
        filename: 'missionbraid-1.0.0-source-candidate.tgz',
        deterministicRebuildVerified: true,
        rebuildHashes: [sourceBundleMetadata.bundleSha256, sourceBundleMetadataSecond.bundleSha256],
        artifactRetention:
          'not-retained; reproducible from the public standard tarball and lockfile',
        reproduction: sourceReproduction,
      },
      manifestContract: contractReport,
    },
    publicExports: publicImportReport,
    adapterExamples,
    cleanContextExternalConsumer: {
      evidenceLevel: 'internal-clean-context-external-consumer-style',
      adapterId: externalConsumer.adapterId,
      harnessId: externalConsumer.harnessId,
      conformancePassed: externalConsumer.conformance.passed,
      sourceImportsOnlyInstalledPackage: true,
      cliMission,
      workbenchMission,
    },
    installedProduct: {
      cliHelp: 'passed',
      daemonStartedFromInstalledBin: true,
      workbenchHttpStatus: rootResponse.status,
      missionApiHttpStatus: missionResponse.status,
      runtimeInventoryHttpStatus: runtimeResponse.status,
      externalAdapterInventoried: true,
      adapterMissionExecutedOverHttp: true,
      adapterMissionCreatedFromWorkbenchForm: true,
      externalAdapterExecutionFork: workbenchMission.executionFork.receiptOutcome,
      storeMigration,
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
    'dist/src/process-provider.js',
    'dist/src/process-provider.d.ts',
    'docs/adapter-sdk.md',
    'docs/architecture.md',
    'docs/roadmap.md',
    'docs/source-candidate-1.0.md',
    'evidence/v1-flagship-local-2026-08-26.json',
    'examples/minimal-adapter.ts',
    'README.md',
    'README.zh-CN.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.build.json',
    'vitest.config.ts',
    '.prettierrc.json',
    '.nvmrc',
    'examples/acp-adapter/adapter.mjs',
    'examples/acp-adapter/fixture-agent.mjs',
    'examples/acp-adapter/verify.mjs',
    'examples/process-provider-adapter/provider.mjs',
    'examples/process-provider-adapter/worker.mjs',
    'examples/process-provider-adapter/verify.mjs',
    'examples/third-party-adapter/adapter.mjs',
    'examples/third-party-adapter/verify.mjs',
    'LICENSE',
    'NOTICE',
  ];
  for (const requiredPath of required) {
    assert(paths.includes(requiredPath), `Package is missing ${requiredPath}`);
  }
}

async function extractTarball(tarballPath, root, name) {
  const extractRoot = join(root, `tarball-${name}`);
  await mkdir(extractRoot, { recursive: true });
  await run('tar', ['-xzf', tarballPath, '-C', extractRoot], { cwd: root });
  return join(extractRoot, 'package');
}

async function exerciseExtractedSourceTarball(packageRoot) {
  const install = await run('pnpm', ['install', '--frozen-lockfile'], { cwd: packageRoot });
  const typecheck = await run('pnpm', ['typecheck'], { cwd: packageRoot });
  const build = await run('pnpm', ['build'], { cwd: packageRoot });
  const tests = await run('pnpm', ['vitest', 'run'], { cwd: packageRoot });
  const testSummary = stripAnsi(`${tests.stdout}\n${tests.stderr}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:Test Files|Tests)\s+/u.test(line));
  assert(testSummary.length >= 2, 'Extracted source Vitest output had no pass summary');
  return {
    root: 'extracted-tarball/package',
    frozenInstall: {
      command: 'pnpm install --frozen-lockfile',
      exitCode: 0,
      lockfile: 'pnpm-lock.yaml',
      summary: lastNonEmptyLine(install.stdout),
    },
    typecheck: {
      command: 'pnpm typecheck',
      exitCode: 0,
      summary: lastNonEmptyLine(typecheck.stdout) || 'tsc completed without diagnostics',
    },
    build: {
      command: 'pnpm build',
      exitCode: 0,
      summary: lastNonEmptyLine(build.stdout) || 'package build completed',
    },
    vitest: { command: 'pnpm vitest run', exitCode: 0, summary: testSummary },
    repositoryFallbackUsed: false,
  };
}

function lastNonEmptyLine(output) {
  return (
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}

async function assertPackagedMarkdownLinks(packageRoot) {
  const markdownFiles = (await walkFiles(packageRoot)).filter((path) => path.endsWith('.md'));
  const broken = [];
  let checkedLinkCount = 0;
  for (const markdownFile of markdownFiles) {
    const source = await readFile(markdownFile, 'utf8');
    const links = [
      ...source.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['"][^)]*['"])?\)/gu),
    ];
    for (const match of links) {
      const raw = match[1] ?? match[2] ?? '';
      if (
        raw.length === 0 ||
        raw.startsWith('#') ||
        /^(?:https?:|mailto:|tel:|data:)/iu.test(raw)
      ) {
        continue;
      }
      checkedLinkCount += 1;
      const pathPart = decodeURIComponent(raw.split('#', 1)[0].split('?', 1)[0]);
      const target = pathPart.startsWith('/')
        ? join(packageRoot, pathPart.slice(1))
        : resolve(dirname(markdownFile), pathPart);
      if (!target.startsWith(`${packageRoot}/`) && target !== packageRoot) {
        broken.push(`${markdownFile.slice(packageRoot.length + 1)} -> ${raw} (outside package)`);
        continue;
      }
      try {
        await stat(target);
      } catch {
        broken.push(`${markdownFile.slice(packageRoot.length + 1)} -> ${raw}`);
      }
    }
  }
  assert(
    broken.length === 0,
    `Packaged Markdown has unresolved local links:\n${broken.join('\n')}`,
  );
  return {
    markdownFileCount: markdownFiles.length,
    checkedLocalLinkCount: checkedLinkCount,
    unresolvedLocalLinkCount: broken.length,
  };
}

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
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
      `import * as processProvider from 'missionbraid/process-provider';\n` +
      `import * as processProviderV1 from 'missionbraid/process-provider/v1';\n` +
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
      `  processProvider: processProvider.PROCESS_PROVIDER_API_VERSION,\n` +
      `  processProviderV1: processProviderV1.PROCESS_PROVIDER_API_VERSION,\n` +
      `  packageContract: contract.PACKAGE_CONTRACT_SCHEMA_VERSION,\n` +
      `  outcomeStudio: studio.OUTCOME_CI_RESULT_SCHEMA_VERSION,\n` +
      `  missionPlan: plan.MISSION_PLAN_SCHEMA_VERSION,\n` +
      `  missionPlanRuntime: planRuntime.MISSION_PLAN_RUNTIME_SCHEMA_VERSION,\n` +
      `};\n` +
      `process.stdout.write(JSON.stringify(report));\n`,
  );
  const probe = await run(process.execPath, [probePath], { cwd: consumerDirectory });
  const report = JSON.parse(probe.stdout);
  for (const value of [
    report.root,
    report.rootV1,
    report.sdk,
    report.sdkV1,
    report.processProvider,
    report.processProviderV1,
  ]) {
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

async function exerciseAdapterExamples(consumerDirectory, installedPackageRoot) {
  const examples = [
    { name: 'direct', directory: 'third-party-adapter' },
    { name: 'acp', directory: 'acp-adapter' },
    { name: 'provider-backed', directory: 'process-provider-adapter' },
  ];
  const reports = {};
  for (const example of examples) {
    const sourceDirectory = join(installedPackageRoot, 'examples', example.directory);
    const adapterDirectory = join(consumerDirectory, 'examples', example.directory);
    await cp(sourceDirectory, adapterDirectory, { recursive: true });
    const conformance = await run(process.execPath, [join(adapterDirectory, 'verify.mjs')], {
      cwd: consumerDirectory,
    });
    const report = JSON.parse(conformance.stdout);
    assert(report.passed === true, `${example.name} Adapter example did not pass conformance`);
    assert(
      report.independentExternalReproduction?.status === 'not-established',
      `${example.name} Adapter conformance overstated independent reproduction`,
    );
    reports[example.name] = {
      adapterId: report.adapterId,
      transport: report.transport,
      passed: report.passed,
      evidenceLevel: report.evidenceLevel,
      eventStream: report.checks.find((check) => check.checkId === 'event-stream')?.detail,
    };
  }
  return reports;
}

async function prepareExternalConsumerAdapter(consumerDirectory) {
  const adapterDirectory = join(consumerDirectory, 'external-consumer-adapter');
  const conformanceWorkspace = join(adapterDirectory, 'conformance-workspace');
  await mkdir(conformanceWorkspace, { recursive: true });
  const adapterPath = join(adapterDirectory, 'adapter.mjs');
  await writeFile(adapterPath, externalConsumerAdapterSource());
  const verifierPath = join(adapterDirectory, 'verify.mjs');
  await writeFile(
    verifierPath,
    `import adapter from './adapter.mjs';\n` +
      `import { runAdapterConformanceSuiteV1 } from 'missionbraid/adapter-conformance/v1';\n` +
      `const report = await runAdapterConformanceSuiteV1(adapter, {\n` +
      `  discoveryRequest: { observedAt: new Date().toISOString() },\n` +
      `  runRequest: {\n` +
      `    identity: { executionId: 'execution-clean-consumer', missionId: 'mission-clean-consumer', branchId: 'branch-clean-consumer', attemptId: 'attempt-clean-consumer', bindingId: 'binding-clean-consumer' },\n` +
      `    workspace: { kind: 'local', workspaceKey: 'workspace-clean-consumer', absolutePath: ${JSON.stringify(conformanceWorkspace)}, access: 'read-write' },\n` +
      `    profile: { profileId: 'profile-clean-consumer', configurationDigest: 'sha256:clean-consumer' },\n` +
      `    instruction: 'Write the clean consumer result.'\n` +
      `  },\n` +
      `  timeoutMs: 5000,\n` +
      `});\n` +
      `process.stdout.write(JSON.stringify(report));\n` +
      `if (!report.passed) process.exitCode = 1;\n`,
  );
  const conformanceRun = await run(process.execPath, [verifierPath], { cwd: consumerDirectory });
  const conformance = JSON.parse(conformanceRun.stdout);
  assert(conformance.passed === true, 'Clean consumer Adapter did not pass conformance');
  return {
    adapterPath,
    adapterId: 'consumer.clean-write-file',
    harnessId: 'consumer-harness',
    conformance,
  };
}

async function exerciseInstalledStoreMigration(options) {
  const stateDirectory = join(options.root, 'migration-v1-state');
  const databasePath = join(stateDirectory, 'kernel.sqlite');
  await mkdir(stateDirectory, { recursive: true });
  const legacy = seedLegacyStoreV1(databasePath);

  const migrationDaemon = await startWorkbench(
    options.installedBin,
    stateDirectory,
    options.consumerDirectory,
    options.adapterPath,
  );
  try {
    const listResponse = await fetch(`${migrationDaemon.url}/api/v1/missions`);
    const listed = await listResponse.json();
    assert(listResponse.status === 200, `Migrated Mission list returned ${listResponse.status}`);
    const listedMission = listed.missions?.find(
      (mission) => mission.missionId === legacy.missionId,
    );
    assert(listedMission !== undefined, 'Migrated schema-v1 Mission was absent from the API');
    assert(listedMission.status === 'pending', 'Migrated Mission status changed');
    assert(listedMission.lastSeq === 1, 'Migrated Mission sequence changed');
    assert(listedMission.headHash === legacy.eventHash, 'Migrated Mission head hash changed');

    const detailResponse = await fetch(
      `${migrationDaemon.url}/api/v1/missions/${legacy.missionId}`,
    );
    const detail = await detailResponse.json();
    assert(
      detailResponse.status === 200,
      `Migrated Mission detail returned ${detailResponse.status}: ${JSON.stringify(detail)}`,
    );
    assert(detail.chainValid === true, 'Migrated Mission event chain is invalid');
    assert(detail.eventCount === 1, 'Migrated Mission event count changed');
    assert(
      detail.timeline?.[0]?.kind === 'mission.created',
      'Migrated Mission timeline was not readable',
    );
  } finally {
    const exit = await stopWorkbench(migrationDaemon.child);
    assert(exit.code === 0, `Migration Workbench exited with ${renderExit(exit)}`);
  }

  const migrated = inspectMigratedStore(databasePath, legacy);
  return {
    sourceSchemaVersion: 1,
    targetSchemaVersion: migrated.schemaVersion,
    missionId: legacy.missionId,
    missionPreserved: true,
    eventChainPreserved: true,
    originalEventCount: 1,
    migratedEventCount: migrated.eventCount,
    originalHeadHash: legacy.eventHash,
    migratedHeadHash: migrated.headHash,
    workbenchMissionListRead: true,
    workbenchMissionDetailRead: true,
    startedFromInstalledBin: true,
  };
}

function seedLegacyStoreV1(databasePath) {
  const missionId = 'mission-installed-migration-v1';
  const workspaceKey = 'workspace-installed-migration-v1';
  const occurredAt = '2026-08-26T00:00:00.000Z';
  const recordedAt = '2026-08-26T00:00:01.000Z';
  const contract = {
    schemaVersion: 1,
    contractId: 'contract-installed-migration-v1',
    objective: 'Preserve one schema-v1 Mission through installed-package migration.',
    acceptanceCriteria: [
      {
        criterionId: 'event-chain-preserved',
        description: 'The original event and projection remain queryable.',
        verifier: { kind: 'kernel-query', configuration: { minimumEvents: 1 } },
      },
    ],
    createdAt: occurredAt,
  };
  const profile = {
    schemaVersion: 1,
    profileId: 'profile-installed-migration-v1',
    harness: 'codex',
    model: 'legacy-fixture',
    reasoningEffort: 'medium',
    capabilities: ['workspace-write'],
    configurationDigest: 'a'.repeat(64),
  };
  const mission = {
    schemaVersion: 1,
    missionId,
    title: 'Installed schema-v1 migration fixture',
    workspaceKey,
    contractId: contract.contractId,
    initialProfileId: profile.profileId,
    status: 'pending',
    createdAt: occurredAt,
  };
  const payload = { mission, contract, profile };
  const payloadJson = canonicalJson(payload);
  const payloadHash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
  const eventIdentity = {
    schemaVersion: 1,
    eventId: 'event-installed-migration-v1',
    missionId,
    attemptId: null,
    seq: 1,
    type: 'mission.created',
    occurredAt,
    recordedAt,
    payloadHash,
    prevHash: null,
  };
  const eventHash = createHash('sha256').update(canonicalJson(eventIdentity), 'utf8').digest('hex');

  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE mission_events (
        schema_version INTEGER NOT NULL, event_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL,
        attempt_id TEXT, seq INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        prev_hash TEXT, event_hash TEXT NOT NULL, UNIQUE (mission_id, seq)
      ) STRICT;
      CREATE TABLE missions (
        mission_id TEXT PRIMARY KEY, workspace_key TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, contract_json TEXT NOT NULL, profile_json TEXT NOT NULL,
        receipt_json TEXT, last_seq INTEGER NOT NULL, head_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE workspace_leases (
        workspace_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
        acquired_at_ms INTEGER NOT NULL, lease_until_ms INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    database
      .prepare(
        `INSERT INTO mission_events VALUES (?, ?, ?, NULL, 1, 'mission.created', ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        1,
        eventIdentity.eventId,
        missionId,
        occurredAt,
        recordedAt,
        payloadJson,
        payloadHash,
        eventHash,
      );
    database
      .prepare(`INSERT INTO missions VALUES (?, ?, ?, 'pending', ?, ?, NULL, 1, ?, ?, ?)`)
      .run(
        missionId,
        workspaceKey,
        mission.title,
        canonicalJson(contract),
        canonicalJson(profile),
        eventHash,
        occurredAt,
        recordedAt,
      );
  } finally {
    database.close();
  }
  return { missionId, eventHash, payloadJson };
}

function inspectMigratedStore(databasePath, legacy) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = database.prepare('PRAGMA user_version').get().user_version;
    assert(version === 2, `Installed package migrated the store to schema ${String(version)}`);
    const missionColumns = database.prepare('PRAGMA table_info(missions)').all();
    assert(
      missionColumns.some((column) => column.name === 'root_branch_id'),
      'Migrated missions table has no root_branch_id column',
    );
    const commandTable = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_commands'`)
      .get();
    assert(commandTable?.name === 'mission_commands', 'Migrated store has no command outbox table');
    const mission = database
      .prepare(
        `SELECT mission_id, status, last_seq, head_hash, root_branch_id FROM missions WHERE mission_id = ?`,
      )
      .get(legacy.missionId);
    assert(mission?.status === 'pending', 'Migrated projection status changed');
    assert(mission?.last_seq === 1, 'Migrated projection sequence changed');
    assert(mission?.head_hash === legacy.eventHash, 'Migrated projection head changed');
    assert(mission?.root_branch_id === null, 'Migration invented a legacy root Branch');
    const events = database
      .prepare(
        `SELECT payload_json, event_hash FROM mission_events WHERE mission_id = ? ORDER BY seq`,
      )
      .all(legacy.missionId);
    assert(events.length === 1, 'Migration changed the legacy event count');
    assert(
      events[0]?.payload_json === legacy.payloadJson,
      'Migration changed the legacy event payload',
    );
    assert(events[0]?.event_hash === legacy.eventHash, 'Migration changed the legacy event hash');
    return { schemaVersion: version, eventCount: events.length, headHash: mission.head_hash };
  } finally {
    database.close();
  }
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

async function exerciseInstalledCliMission(options) {
  const workspace = await createConsumerWorkspace(options.root, 'cli-consumer-workspace');
  const missionFile = await writeConsumerMission(
    options.root,
    'cli-consumer-mission.yaml',
    workspace,
    'consumer.clean-write-file',
    options.harnessId,
  );
  const stateDir = join(options.root, 'cli-consumer-state');
  const executed = await run(
    options.installedBin,
    [
      'run',
      missionFile,
      '--workspace',
      workspace,
      '--state-dir',
      stateDir,
      '--adapter',
      options.adapterPath,
    ],
    { cwd: options.consumerDirectory },
  );
  const result = JSON.parse(executed.stdout);
  assert(result.status === 'succeeded', 'Installed CLI external Adapter Mission did not succeed');
  assert(result.receipt?.outcome === 'verified', 'Installed CLI did not issue a verified Receipt');
  const runtimeEcho = JSON.parse(
    await readFile(join(workspace, 'consumer-runtime-binding.json'), 'utf8'),
  );
  assert(
    result.receipt?.runtimeBindings?.[0]?.profileId === runtimeEcho.profileId,
    'Installed CLI Receipt ProfileId differs from Adapter request',
  );
  assert(
    result.receipt?.runtimeBindings?.[0]?.adapterId === options.adapterId,
    'Installed CLI Receipt lost Adapter identity',
  );
  assert(
    (await readFile(join(workspace, 'consumer-result.txt'), 'utf8')) === 'consumer-verified\n',
    'Installed CLI external Adapter did not write the accepted result',
  );
  return {
    missionId: result.missionId,
    status: result.status,
    receiptOutcome: result.receipt.outcome,
    identityChain: {
      adapterEcho: runtimeEcho,
      receiptRuntimeBinding: result.receipt.runtimeBindings[0],
      equalityChecks: {
        adapterIdMatches: result.receipt.runtimeBindings[0].adapterId === runtimeEcho.adapterId,
        profileIdMatches: result.receipt.runtimeBindings[0].profileId === runtimeEcho.profileId,
        attemptIdMatches: result.receipt.runtimeBindings[0].attemptId === runtimeEcho.attemptId,
      },
    },
    startedFromInstalledBin: true,
  };
}

async function exerciseInstalledWorkbenchMission(options) {
  const workspace = await createConsumerWorkspace(options.root, 'workbench-consumer-workspace');
  const title = 'Installed Workbench external Adapter Mission';
  const browser = await launchHeadlessWorkbench(
    options.daemonUrl,
    join(options.root, 'workbench-browser-profile'),
  );
  let created;
  try {
    const routeValue = `adapter:${options.adapterId}`;
    const readyDeadline = Date.now() + 20_000;
    let adapterVisible = false;
    while (Date.now() < readyDeadline) {
      adapterVisible = await browser.evaluate(
        `Boolean(document.querySelector('input[value=${JSON.stringify(routeValue)}]')) && document.body.textContent.includes('Clean Consumer Write File Adapter')`,
      );
      if (adapterVisible) break;
      await wait(50);
    }
    assert(adapterVisible, 'Installed Workbench did not render the external Adapter route');
    await browser.evaluate(`(() => {
      const set = (selector, value) => {
        const field = document.querySelector(selector);
        if (!field) throw new Error('Missing Workbench field ' + selector);
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('#mission-title', ${JSON.stringify(title)});
      set('#mission-objective', 'Run a consumer-authored Adapter through the installed Workbench form.');
      set('#mission-workspace', ${JSON.stringify(workspace)});
      set('#verifier-executable', 'node');
      set('#verifier-args', 'verify.mjs');
      const route = document.querySelector('input[value=${JSON.stringify(routeValue)}]');
      if (!route) throw new Error('External Adapter route is absent');
      route.click();
      document.querySelector('#mission-form').requestSubmit();
      return true;
    })()`);
    created = await waitForMissionByTitle(options.daemonUrl, title);
  } finally {
    await browser.close();
  }
  assert(created !== undefined, 'Workbench form did not return a created Mission');
  const detail = await waitForMission(options.daemonUrl, created.missionId);
  assert(
    detail.mission.status === 'succeeded',
    'Workbench external Adapter Mission did not succeed',
  );
  assert(
    detail.timeline.some((entry) => entry.kind === 'receipt.issued'),
    'Workbench external Adapter Mission issued no Receipt',
  );
  assert(
    (await readFile(join(workspace, 'consumer-result.txt'), 'utf8')) === 'consumer-verified\n',
    'Workbench external Adapter did not write the accepted result',
  );
  assert(
    detail.attempts?.some((attempt) => attempt.harness === options.harnessId),
    'Workbench timeline did not retain the external Harness identity',
  );
  assert(
    !detail.attempts?.some((attempt) => ['codex', 'qoder', 'claude'].includes(attempt.harness)),
    'External Adapter Mission fell back to a built-in Harness',
  );
  const normalAttempt = detail.attempts?.[0];
  const normalBinding = detail.timeline?.find(
    (entry) => entry.kind === 'attempt.bound' && entry.attemptId === normalAttempt?.attemptId,
  )?.data;
  const normalReceipt = detail.timeline?.find((entry) => entry.kind === 'receipt.issued')?.data;
  const normalEcho = JSON.parse(
    await readFile(join(workspace, 'consumer-runtime-binding.json'), 'utf8'),
  );
  assert(
    detail.mission.activeProfile?.adapter?.adapterId === options.adapterId,
    'Profile Snapshot lost Adapter identity',
  );
  assert(
    detail.mission.activeProfile.adapter.adapterVersion === '1.0.0' &&
      detail.mission.activeProfile.adapter.transport === 'direct' &&
      detail.mission.activeProfile.adapter.nativeProtocol === 'clean-consumer/v1',
    'Profile Snapshot manifest identity is incomplete',
  );
  assert(
    normalEcho.profileId === detail.mission.activeProfile?.profileId,
    'Adapter did not receive the Kernel ProfileId',
  );
  assert(
    normalBinding?.runtimeBinding?.adapterId === options.adapterId,
    'AttemptBinding lost Adapter identity',
  );
  assert(
    normalAttempt?.attemptId === normalEcho.attemptId,
    'Adapter received a different AttemptId',
  );
  assert(
    normalReceipt?.runtimeBindings?.[0]?.profileId === normalEcho.profileId,
    'Workbench Receipt ProfileId differs from Adapter request',
  );

  await run('git', ['add', '-A'], { cwd: workspace });
  await run(
    'git',
    [
      '-c',
      'user.name=MissionBraid',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'installed Adapter checkpoint',
    ],
    { cwd: workspace },
  );
  const attemptId = detail.attempts?.[0]?.attemptId;
  assert(typeof attemptId === 'string', 'Workbench external Adapter Attempt was not persisted');
  const checkpointResponse = await fetch(
    `${options.daemonUrl}/api/v1/missions/${created.missionId}/checkpoints`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId }),
    },
  );
  const checkpointPayload = await checkpointResponse.json();
  assert(
    checkpointResponse.status === 201,
    `Installed Workbench could not create the external Adapter Checkpoint: ${JSON.stringify(checkpointPayload)}`,
  );
  const checkpointId = checkpointPayload.checkpoint?.checkpointId;
  const forkResponse = await fetch(
    `${options.daemonUrl}/api/v1/missions/${created.missionId}/checkpoints/${checkpointId}/forks`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        childBranchId: 'branch-installed-external-adapter-fork',
        intervention: {
          interventionId: 'intervention-installed-external-adapter-fork',
          kind: 'guidance',
          targetRef: 'stage:adapter-primary',
          beforeDigest: 'sha256:installed-guidance-a',
          afterDigest: 'sha256:installed-guidance-b',
          description: 'Create the Installed Execution Fork result with the same external Adapter.',
          authorityChange: 'unchanged',
        },
      }),
    },
  );
  const forkPayload = await forkResponse.json();
  assert(
    forkResponse.status === 201,
    `Installed external Adapter Execution Fork failed: ${JSON.stringify(forkPayload)}`,
  );
  assert(
    forkPayload.receipt?.outcome === 'verified',
    'Installed external Adapter Execution Fork did not issue a verified Receipt',
  );
  const isolatedWorktreePath = forkPayload.executionFork?.lineage?.isolatedWorktreePath;
  assert(typeof isolatedWorktreePath === 'string', 'Execution Fork returned no isolated worktree');
  assert(
    (await readFile(join(isolatedWorktreePath, 'consumer-fork-result.txt'), 'utf8')) ===
      'consumer-fork-verified\n',
    'External Adapter did not execute in the isolated Fork worktree',
  );
  await assertMissing(join(workspace, 'consumer-fork-result.txt'));
  const forkEcho = JSON.parse(
    await readFile(join(isolatedWorktreePath, 'consumer-runtime-binding.json'), 'utf8'),
  );
  const forkBinding = forkPayload.receipt?.runtimeBindings?.[0];
  assert(
    forkEcho.profileId === forkBinding?.profileId,
    'Fork Adapter ProfileId differs from Receipt',
  );
  assert(
    forkEcho.attemptId === forkBinding?.attemptId,
    'Fork Adapter AttemptId differs from Receipt',
  );
  assert(forkBinding?.adapterId === options.adapterId, 'Fork Receipt lost Adapter identity');
  assert(
    forkPayload.executionFork?.lineage?.runtimeBinding?.profileId === forkEcho.profileId,
    'Fork lineage ProfileId differs from Adapter request',
  );
  assert(
    forkPayload.executionFork?.lineage?.runtimeBinding?.attemptId === forkEcho.attemptId,
    'Fork lineage AttemptId differs from Adapter request',
  );
  const afterFork = await fetch(`${options.daemonUrl}/api/v1/missions/${created.missionId}`).then(
    (response) => response.json(),
  );
  assert(
    afterFork.attempts?.filter((attempt) => attempt.harness === options.harnessId).length >= 2,
    'Execution Fork did not invoke the same external Adapter Harness',
  );
  return {
    missionId: created.missionId,
    status: detail.mission.status,
    receiptIssued: true,
    startedFromInstalledBin: true,
    createdFromWorkbenchForm: true,
    harnessId: options.harnessId,
    ordinaryIdentityChain: {
      adapter: detail.mission.activeProfile.adapter,
      profileDefinitionId: detail.mission.activeProfile.definition?.definitionId,
      profileSnapshotId: detail.mission.activeProfile.profileId,
      attemptId: normalAttempt.attemptId,
      bindingId: normalBinding.bindingId,
      attemptRuntimeBinding: normalBinding.runtimeBinding,
      adapterEcho: normalEcho,
      receiptRuntimeBinding: normalReceipt.runtimeBindings[0],
      equalityChecks: {
        manifestMatchesProfile:
          detail.mission.activeProfile.adapter.adapterId === options.adapterId &&
          detail.mission.activeProfile.adapter.adapterVersion === '1.0.0' &&
          detail.mission.activeProfile.adapter.transport === 'direct' &&
          detail.mission.activeProfile.adapter.nativeProtocol === 'clean-consumer/v1',
        profileIdMatchesAdapterEcho:
          detail.mission.activeProfile.profileId === normalEcho.profileId,
        attemptIdMatchesAdapterEcho: normalAttempt.attemptId === normalEcho.attemptId,
        bindingMatchesAdapterEcho:
          normalBinding.runtimeBinding.profileId === normalEcho.profileId &&
          normalBinding.runtimeBinding.attemptId === normalEcho.attemptId,
        receiptMatchesAdapterEcho:
          normalReceipt.runtimeBindings[0].profileId === normalEcho.profileId &&
          normalReceipt.runtimeBindings[0].attemptId === normalEcho.attemptId,
      },
    },
    executionFork: {
      checkpointId,
      childBranchId: 'branch-installed-external-adapter-fork',
      receiptOutcome: forkPayload.receipt.outcome,
      sameAdapterHarnessObserved: true,
      identityChain: {
        adapterEcho: forkEcho,
        receiptRuntimeBinding: forkBinding,
        targetLineage: {
          targetProfileId: forkPayload.executionFork.lineage.targetProfileId,
          runtimeBinding: forkPayload.executionFork.lineage.runtimeBinding,
        },
        equalityChecks: {
          adapterIdMatches: forkBinding.adapterId === options.adapterId,
          profileIdMatches:
            forkBinding.profileId === forkEcho.profileId &&
            forkPayload.executionFork.lineage.targetProfileId === forkEcho.profileId &&
            forkPayload.executionFork.lineage.runtimeBinding.profileId === forkEcho.profileId,
          attemptIdMatches:
            forkBinding.attemptId === forkEcho.attemptId &&
            forkPayload.executionFork.lineage.runtimeBinding.attemptId === forkEcho.attemptId,
        },
      },
      isolatedWorkspaceMutation: true,
    },
  };
}

async function createConsumerWorkspace(root, name) {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), 'Clean installed-package consumer.\n');
  await writeFile(
    join(workspace, 'verify.mjs'),
    `import { readFileSync } from 'node:fs';\n` +
      `if (readFileSync(new URL('./consumer-result.txt', import.meta.url), 'utf8') !== 'consumer-verified\\n') process.exit(1);\n`,
  );
  await run('git', ['init', '-q'], { cwd: workspace });
  await run('git', ['add', '.'], { cwd: workspace });
  await run(
    'git',
    [
      '-c',
      'user.name=MissionBraid',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: workspace },
  );
  return workspace;
}

async function writeConsumerMission(root, name, workspace, adapterId, harnessId) {
  const missionFile = join(root, name);
  await writeFile(
    missionFile,
    `schemaVersion: missionbraid.dev/mission/v1\n` +
      `title: Installed CLI external Adapter Mission\n` +
      `objective: Run a consumer-authored Adapter from the installed package.\n` +
      `workspace: ${JSON.stringify(workspace)}\n` +
      `acceptanceCriteria:\n` +
      `  - id: consumer-result\n` +
      `    description: The external Adapter writes the accepted result.\n` +
      `    verifier:\n` +
      `      kind: command\n` +
      `      executable: node\n` +
      `      args: [verify.mjs]\n` +
      `      cwd: ${JSON.stringify(workspace)}\n` +
      `      timeoutMs: 5000\n` +
      `attemptPlan:\n` +
      `  - stageId: external-adapter\n` +
      `    profile:\n` +
      `      harness: ${harnessId}\n` +
      `      adapterId: ${adapterId}\n` +
      `      model: default\n` +
      `      permissionMode: workspace-write\n` +
      `      injectionBudgetTokens: 4000\n` +
      `    instruction: Write consumer-result.txt with the accepted value.\n` +
      `    onFailure: stop\n`,
  );
  return missionFile;
}

async function waitForMission(daemonUrl, missionId) {
  const deadline = Date.now() + 20_000;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(`${daemonUrl}/api/v1/missions/${missionId}`);
    last = await response.json();
    if (last.mission?.status === 'succeeded') return last;
    if (last.mission?.status === 'failed') {
      throw new Error(`Workbench external Adapter Mission failed: ${JSON.stringify(last)}`);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  throw new Error(`Workbench external Adapter Mission timed out: ${JSON.stringify(last)}`);
}

async function waitForMissionByTitle(daemonUrl, title) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${daemonUrl}/api/v1/missions`);
    const payload = await response.json();
    const mission = payload.missions?.find((candidate) => candidate.title === title);
    if (mission) return mission;
    await wait(25);
  }
  throw new Error(`Workbench form did not create Mission ${title}`);
}

function externalConsumerAdapterSource() {
  return `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  defineAdapterV1,
  validateAdapterRunRequestV1,
} from 'missionbraid/adapter-sdk/v1';

const unsupported = (detail) => ({ status: 'unsupported', fidelity: 'unsupported', detail });
const manifest = {
  schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
  apiVersion: ADAPTER_API_VERSION,
  adapterId: 'consumer.clean-write-file',
  harnessId: 'consumer-harness',
  displayName: 'Clean Consumer Write File Adapter',
  adapterVersion: '1.0.0',
  transport: 'direct',
  nativeProtocol: 'clean-consumer/v1',
  capabilities: {
    discover: { status: 'supported', fidelity: 'controller', detail: 'Discovers the clean consumer Runtime.' },
    observe: { status: 'supported', fidelity: 'controller', detail: 'Emits ordered workspace evidence.' },
    'context-capture': unsupported('No context channel.'),
    steer: unsupported('No live session.'),
    interrupt: unsupported('No live session.'),
    'pre-tool-gate': unsupported('No tool gateway.'),
    resume: unsupported('No live session.'),
    'native-fork': unsupported('No native Fork.'),
    'workspace-bind': { status: 'supported', fidelity: 'controller', detail: 'Uses the host-supplied workspace.' },
    'workspace-restore': unsupported('No restore.'),
    'external-effect-control': unsupported('No external Effects.'),
  },
};

export default defineAdapterV1({
  manifest,
  async discover(request) {
    return {
      adapterId: manifest.adapterId,
      transport: manifest.transport,
      status: 'ready',
      runtimeVersion: { status: 'known', value: '1.0.0', source: 'clean-consumer' },
      authentication: { status: 'unsupported', reason: 'No credentials.' },
      binding: { kind: 'direct', executableRef: 'consumer:clean-write-file', processOwnership: 'adapter' },
      observedAt: request.observedAt,
      evidenceRefs: ['clean-consumer:discovery'],
    };
  },
  async run(request, ports) {
    validateAdapterRunRequestV1(manifest, request);
    if (request.workspace.kind !== 'local') throw new Error('Expected a local workspace.');
    await writeFile(join(request.workspace.absolutePath, 'consumer-result.txt'), 'consumer-verified\\n');
    await writeFile(
      join(request.workspace.absolutePath, 'consumer-runtime-binding.json'),
      JSON.stringify({
        adapterId: manifest.adapterId,
        profileId: request.profile.profileId,
        attemptId: request.identity.attemptId,
      }),
    );
    if (request.instruction.includes('Installed Execution Fork')) {
      await writeFile(
        join(request.workspace.absolutePath, 'consumer-fork-result.txt'),
        'consumer-fork-verified\\n',
      );
    }
    const runId = \`run-\${request.identity.executionId}\`;
    await ports.evidence.append({
      schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
      apiVersion: ADAPTER_API_VERSION,
      adapterId: manifest.adapterId,
      runId,
      sequence: 1,
      sourceId: 'clean-consumer-source',
      sourceProtocol: manifest.nativeProtocol,
      nativeEventType: 'workspace.file-written',
      semanticHint: 'workspace',
      observedAt: new Date().toISOString(),
      fidelity: 'native',
      payload: { path: 'consumer-result.txt', profileId: request.profile.profileId, attemptId: request.identity.attemptId },
      sanitized: true,
      evidenceRefs: ['clean-consumer:event:file-written'],
    });
    await ports.evidence.append({
      schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
      apiVersion: ADAPTER_API_VERSION,
      adapterId: manifest.adapterId,
      runId,
      sequence: 2,
      sourceId: 'clean-consumer-source',
      sourceProtocol: manifest.nativeProtocol,
      nativeEventType: 'tool_result',
      semanticHint: 'tool',
      observedAt: new Date().toISOString(),
      fidelity: 'native',
      payload: { type: 'tool_result', status: 'completed', tool_call_id: 'clean-consumer-write', is_error: false },
      sanitized: true,
      evidenceRefs: ['clean-consumer:event:tool-result'],
    });
    return {
      adapterId: manifest.adapterId,
      runId,
      transport: manifest.transport,
      binding: { kind: 'direct', executableRef: 'consumer:clean-write-file', processOwnership: 'adapter' },
      status: 'completed',
      exitCode: 0,
      nativeSession: { status: 'unavailable', reason: 'One-shot consumer Adapter.' },
      evidenceRefs: ['clean-consumer:run:completed'],
    };
  },
});
`;
}

async function startWorkbench(installedBin, stateDirectory, cwd, adapterPath) {
  const child = spawn(
    installedBin,
    ['app', '--state-dir', stateDirectory, '--port', '0', '--adapter', adapterPath],
    {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
      `${command} ${args.join(' ')} failed (${renderExit(exit)})\n${stderr}\n${stdout}`,
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

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertMissing(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Expected ${path} to remain absent`);
}
