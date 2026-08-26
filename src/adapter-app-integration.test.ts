import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ADAPTER_API_VERSION,
  ADAPTER_EVENT_SCHEMA_VERSION,
  ADAPTER_MANIFEST_SCHEMA_VERSION,
  AdapterRegistryV1,
  defineAdapterV1,
  validateAdapterRunRequestV1,
  type AdapterCapabilitiesV1,
} from './adapter-sdk.js';
import { startMissionBraidApp } from './app.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Workbench public Adapter integration', () => {
  it('inventories an Adapter and runs its Mission through the HTTP product path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-adapter-app-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const stateDir = join(root, 'state');
    await mkdir(workspace);
    await writeFile(join(workspace, 'README.md'), 'adapter app fixture\n');
    await writeFile(
      join(workspace, 'verify.mjs'),
      `import { readFileSync } from 'node:fs';\n` +
        `if (readFileSync(new URL('./app-adapter-result.txt', import.meta.url), 'utf8') !== 'verified\\n') process.exit(1);\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync(
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

    const registry = new AdapterRegistryV1();
    registry.register(writeFileAdapter());
    const app = await startMissionBraidApp({
      stateDir,
      port: 0,
      adapterRegistry: registry,
      discoverRuntimes: async () => [],
    });
    try {
      const inventoryResponse = await fetch(`${app.url}/api/v1/runtimes`);
      const inventory = (await inventoryResponse.json()) as {
        adapters: Array<{ adapterId: string }>;
      };
      expect(inventory.adapters.map((adapter) => adapter.adapterId)).toEqual([
        'consumer.app-write-file',
      ]);

      const createResponse = await fetch(`${app.url}/api/v1/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Workbench Adapter Mission',
          objective: 'Run a registered external Adapter.',
          workspace,
          verifier: { executable: 'node', args: ['verify.mjs'], timeoutMs: 5_000 },
          stages: [
            {
              stageId: 'external-adapter',
              harness: 'consumer-app-harness',
              adapterId: 'consumer.app-write-file',
              model: 'default',
              permissionMode: 'workspace-write',
              injectionBudgetTokens: 4_000,
              instruction: 'Write app-adapter-result.txt with the accepted value.',
            },
          ],
        }),
      });
      expect(createResponse.status).toBe(202);
      const created = (await createResponse.json()) as { missionId: string };
      const detail = await waitFor(async () => {
        const response = await fetch(`${app.url}/api/v1/missions/${created.missionId}`);
        if (!response.ok) return undefined;
        const body = (await response.json()) as {
          mission: { status: string };
          timeline: Array<{ kind: string }>;
        };
        return body.mission.status === 'succeeded' ? body : undefined;
      });
      expect(detail.mission.status).toBe('succeeded');
      expect(detail.timeline.map((entry) => entry.kind)).toContain('receipt.issued');
    } finally {
      await app.close();
    }
  });
});

function writeFileAdapter() {
  const manifest = {
    schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
    apiVersion: ADAPTER_API_VERSION,
    adapterId: 'consumer.app-write-file',
    harnessId: 'consumer-app-harness',
    displayName: 'Consumer App Write File Adapter',
    adapterVersion: '1.0.0',
    transport: 'direct',
    nativeProtocol: 'consumer-app-write-file/v1',
    capabilities: baselineCapabilities(),
  } as const;
  return defineAdapterV1({
    manifest,
    async discover(request) {
      return {
        adapterId: manifest.adapterId,
        transport: manifest.transport,
        status: 'ready' as const,
        runtimeVersion: { status: 'known' as const, value: '1.0.0', source: 'fixture' },
        authentication: { status: 'unsupported' as const, reason: 'No credentials.' },
        binding: {
          kind: 'direct' as const,
          executableRef: 'consumer:app-write-file',
          processOwnership: 'adapter' as const,
        },
        observedAt: request.observedAt,
        evidenceRefs: ['consumer-app:discovery'],
      };
    },
    async run(request, ports) {
      validateAdapterRunRequestV1(manifest, request);
      if (request.workspace.kind !== 'local') throw new Error('Expected local workspace');
      await writeFile(join(request.workspace.absolutePath, 'app-adapter-result.txt'), 'verified\n');
      const runId = `run-${request.identity.executionId}`;
      await ports.evidence.append({
        schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
        apiVersion: ADAPTER_API_VERSION,
        adapterId: manifest.adapterId,
        runId,
        sequence: 1,
        sourceId: 'consumer-app-source',
        sourceProtocol: manifest.nativeProtocol,
        nativeEventType: 'workspace.file-written',
        semanticHint: 'workspace',
        observedAt: new Date().toISOString(),
        fidelity: 'native',
        payload: { path: 'app-adapter-result.txt' },
        sanitized: true,
        evidenceRefs: ['consumer-app:event:file-written'],
      });
      return {
        adapterId: manifest.adapterId,
        runId,
        transport: manifest.transport,
        binding: {
          kind: 'direct' as const,
          executableRef: 'consumer:app-write-file',
          processOwnership: 'adapter' as const,
        },
        status: 'completed' as const,
        exitCode: 0,
        nativeSession: { status: 'unavailable' as const, reason: 'One-shot fixture.' },
        evidenceRefs: ['consumer-app:run:completed'],
      };
    },
  });
}

function baselineCapabilities(): AdapterCapabilitiesV1 {
  const unsupported = (detail: string) => ({
    status: 'unsupported' as const,
    fidelity: 'unsupported' as const,
    detail,
  });
  return {
    discover: { status: 'supported', fidelity: 'controller', detail: 'Discovers the fixture.' },
    observe: { status: 'supported', fidelity: 'controller', detail: 'Emits one event.' },
    'context-capture': unsupported('No context channel.'),
    steer: unsupported('No live session.'),
    interrupt: unsupported('No live session.'),
    'pre-tool-gate': unsupported('No tool gateway.'),
    resume: unsupported('No live session.'),
    'native-fork': unsupported('No native Fork.'),
    'workspace-bind': {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Uses the host workspace.',
    },
    'workspace-restore': unsupported('No restore.'),
    'external-effect-control': unsupported('No external Effects.'),
  };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms`);
}
