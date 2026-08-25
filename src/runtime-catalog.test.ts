import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CODEX_ADAPTER_CAPABILITIES } from './adapters/codex.js';
import type { RuntimeDetection, RuntimeId } from './adapters/types.js';
import {
  createCommandVersionProbe,
  discoverRuntimeCatalog,
  type CommandProbe,
  type CommandProbeResult,
} from './runtime-catalog.js';

const FIXED_TIME = '2026-08-24T02:00:00.000Z';
const disposableDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    disposableDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('discoverRuntimeCatalog', () => {
  it('returns a stable catalog and keeps unsupported runtimes out of ready state', async () => {
    const probes: Record<string, CommandProbeResult> = {
      claude: readyProbe('claude', '/opt/bin/claude', '2.1.241'),
      opencode: readyProbe('opencode', '/opt/bin/opencode', '1.18.21'),
      hermes: readyProbe('hermes', '/opt/bin/hermes', '0.19.0'),
      dsh: missingProbe('dsh'),
    };
    const commandProbe = mappedProbe(probes);

    const catalog = await discoverRuntimeCatalog({
      codexAdapter: adapterDetection(readyDetection('codex', '/opt/bin/codex', '0.149.0')),
      qoderAdapter: adapterDetection(readyDetection('qoder', '/opt/bin/qodercli', '1.1.6')),
      claudeAdapter: adapterDetection(readyDetection('claude', '/opt/bin/claude', '2.1.241')),
      commandProbe,
      pathExists: async (path) => path === '/Applications/DeepSeek Harness.app',
      now: () => new Date(FIXED_TIME),
    });

    expect(catalog.map((entry) => entry.id)).toEqual([
      'codex',
      'qoder',
      'claude',
      'opencode',
      'hermes',
      'deepseek-harness',
    ]);
    expect(catalog[0]).toEqual({
      id: 'codex',
      displayName: 'Codex',
      status: 'ready-supported',
      support: 'supported',
      path: '/opt/bin/codex',
      version: '0.149.0',
      reason: 'Supported adapter detected and version probe succeeded.',
      capabilities: [
        'non-interactive',
        'jsonl-events',
        'workspace',
        'model-selection',
        'reasoning-effort',
      ],
      capabilityDeclarations: CODEX_ADAPTER_CAPABILITIES,
      checkedAt: FIXED_TIME,
    });
    expect(catalog.find((entry) => entry.id === 'claude')).toMatchObject({
      status: 'ready-supported',
      support: 'supported',
      path: '/opt/bin/claude',
      version: '2.1.241',
      capabilities: expect.arrayContaining(['stream-json-events', 'hook-events']),
      capabilityDeclarations: {
        observe: expect.objectContaining({ status: 'supported', control: 'native' }),
        context_capture: expect.objectContaining({ status: 'unknown' }),
        interrupt: expect.objectContaining({ status: 'supported', control: 'controller' }),
        pre_tool_gate: expect.objectContaining({ status: 'unsupported' }),
        steer: expect.any(Object),
        resume: expect.any(Object),
        native_fork: expect.any(Object),
        workspace_restore: expect.any(Object),
        external_effect_control: expect.any(Object),
      },
    });
    expect(catalog.find((entry) => entry.id === 'deepseek-harness')).toMatchObject({
      status: 'needs-bootstrap',
      support: 'unsupported',
      path: '/Applications/DeepSeek Harness.app',
      version: null,
    });
    expect(catalog.every((entry) => entry.checkedAt === FIXED_TIME)).toBe(true);
    expect(catalog.some((entry) => entry.id === ('kandev' as never))).toBe(false);
    expect(
      catalog
        .filter((entry) => entry.support === 'unsupported')
        .every((entry) => {
          return entry.status !== 'ready-supported';
        }),
    ).toBe(true);
  });

  it('distinguishes missing, unavailable, unsupported, and bootstrap states', async () => {
    const catalog = await discoverRuntimeCatalog({
      codexAdapter: adapterDetection(missingDetection('codex')),
      qoderAdapter: adapterDetection({
        ...readyDetection('qoder', '/opt/bin/qodercli', '1.1.6'),
        responsive: false,
        status: 'present-unresponsive',
        probeExitCode: null,
        probeSignal: 'SIGTERM',
      }),
      claudeAdapter: adapterDetection({
        ...readyDetection('claude', '/opt/bin/claude', '2.1.241'),
        responsive: false,
        status: 'present-error',
        probeExitCode: 1,
      }),
      commandProbe: mappedProbe({
        claude: {
          command: 'claude',
          status: 'present-error',
          path: '/opt/bin/claude',
          version: null,
        },
        opencode: missingProbe('opencode'),
        hermes: missingProbe('hermes'),
        dsh: missingProbe('dsh'),
      }),
      pathExists: async (path) => path === '/Applications/DeepSeek Harness.app',
      now: () => new Date(FIXED_TIME),
    });

    expect(catalog.find((entry) => entry.id === 'codex')).toMatchObject({
      status: 'missing',
      support: 'supported',
    });
    expect(catalog.find((entry) => entry.id === 'qoder')).toMatchObject({
      status: 'installed-unavailable',
      support: 'supported',
    });
    expect(catalog.find((entry) => entry.id === 'claude')).toMatchObject({
      status: 'installed-unavailable',
      support: 'supported',
    });
    expect(catalog.find((entry) => entry.id === 'opencode')).toMatchObject({
      status: 'missing',
      support: 'unsupported',
    });
    expect(catalog.find((entry) => entry.id === 'deepseek-harness')).toMatchObject({
      status: 'needs-bootstrap',
      support: 'unsupported',
    });
    expect(catalog.filter((entry) => entry.status === 'ready-supported')).toHaveLength(0);
  });

  it('marks a PATH-discoverable dsh as installed but unsupported', async () => {
    const catalog = await discoverRuntimeCatalog({
      codexAdapter: adapterDetection(missingDetection('codex')),
      qoderAdapter: adapterDetection(missingDetection('qoder')),
      claudeAdapter: adapterDetection(missingDetection('claude')),
      commandProbe: mappedProbe({
        claude: missingProbe('claude'),
        opencode: missingProbe('opencode'),
        hermes: missingProbe('hermes'),
        dsh: readyProbe('dsh', '/opt/bin/dsh', '0.1.0-rc.6'),
      }),
      pathExists: async () => {
        throw new Error('wrapper lookup must not run when dsh is installed');
      },
      now: () => new Date(FIXED_TIME),
    });

    expect(catalog.find((entry) => entry.id === 'deepseek-harness')).toMatchObject({
      status: 'installed-unsupported',
      support: 'unsupported',
      path: '/opt/bin/dsh',
      version: '0.1.0-rc.6',
    });
  });

  it('marks DeepSeek Harness missing when neither dsh nor a wrapper exists', async () => {
    const catalog = await discoverRuntimeCatalog({
      codexAdapter: adapterDetection(missingDetection('codex')),
      qoderAdapter: adapterDetection(missingDetection('qoder')),
      claudeAdapter: adapterDetection(missingDetection('claude')),
      commandProbe: mappedProbe({
        claude: missingProbe('claude'),
        opencode: missingProbe('opencode'),
        hermes: missingProbe('hermes'),
        dsh: missingProbe('dsh'),
      }),
      pathExists: async () => false,
      now: () => new Date(FIXED_TIME),
    });

    expect(catalog.find((entry) => entry.id === 'deepseek-harness')).toMatchObject({
      status: 'missing',
      support: 'unsupported',
      path: null,
      version: null,
    });
  });
});

describe('createCommandVersionProbe', () => {
  it('invokes an installed command with only --version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'missionbraid-runtime-catalog-'));
    disposableDirectories.push(directory);
    const executable = join(directory, 'version-only');
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(9);
process.stdout.write('fixture 7.8.9-test.1\\n');
`,
      'utf8',
    );
    await chmod(executable, 0o755);

    const result = await createCommandVersionProbe({ cwd: directory })(executable);
    const canonicalExecutable = await realpath(executable);

    expect(result).toEqual({
      command: executable,
      status: 'ready',
      path: canonicalExecutable,
      version: '7.8.9-test.1',
    });
  });
});

function adapterDetection(detection: RuntimeDetection): { detect(): Promise<RuntimeDetection> } {
  return {
    detect: async () => detection,
  };
}

function readyDetection(
  runtime: RuntimeId,
  executablePath: string,
  version: string,
): RuntimeDetection {
  return {
    runtime,
    command: runtime === 'qoder' ? 'qodercli' : runtime,
    executablePath,
    available: true,
    responsive: true,
    status: 'ready',
    version,
    versionSource: 'output',
    checkedAt: FIXED_TIME,
    durationMs: 1,
    probeExitCode: 0,
    probeSignal: null,
  };
}

function missingDetection(runtime: RuntimeId): RuntimeDetection {
  return {
    runtime,
    command: runtime === 'qoder' ? 'qodercli' : runtime,
    executablePath: null,
    available: false,
    responsive: false,
    status: 'missing',
    version: null,
    versionSource: null,
    checkedAt: FIXED_TIME,
    durationMs: 1,
    probeExitCode: null,
    probeSignal: null,
  };
}

function readyProbe(command: string, path: string, version: string): CommandProbeResult {
  return {
    command,
    status: 'ready',
    path,
    version,
  };
}

function missingProbe(command: string): CommandProbeResult {
  return {
    command,
    status: 'missing',
    path: null,
    version: null,
  };
}

function mappedProbe(results: Readonly<Record<string, CommandProbeResult>>): CommandProbe {
  return async (command) => {
    const result = results[command];
    if (result === undefined) throw new Error(`Unexpected command probe: ${command}`);
    return result;
  };
}
