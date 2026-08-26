import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { AdapterHostV1 } from './adapter-host.js';
import { MissionEngine } from './engine.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('public Adapter Mission integration', () => {
  it('executes a newly registered direct Adapter through the unchanged Mission and Receipt path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-adapter-engine-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const missionSource = join(root, 'mission-source');
    const stateDir = join(root, 'state');
    await mkdir(workspace);
    await mkdir(missionSource);
    await writeFile(join(workspace, 'README.md'), 'clean consumer fixture\n');
    await writeFile(
      join(workspace, 'verify.mjs'),
      `import { readFileSync } from 'node:fs';\n` +
        `import { join } from 'node:path';\n` +
        `const workspace = process.env.MISSIONBRAID_TARGET_WORKSPACE;\n` +
        `if (!workspace) process.exit(2);\n` +
        `if (readFileSync(join(workspace, 'adapter-result.txt'), 'utf8') !== 'verified\\n') process.exit(3);\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', ['add', 'README.md'], { cwd: workspace });
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

    const manifest = {
      schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
      apiVersion: ADAPTER_API_VERSION,
      adapterId: 'consumer.write-file',
      harnessId: 'consumer-harness',
      displayName: 'Consumer Write File Adapter',
      adapterVersion: '1.0.0',
      transport: 'direct',
      nativeProtocol: 'consumer-write-file/v1',
      capabilities: baselineCapabilities(),
    } as const;
    const receivedProfiles: Array<{ profileId: string; attemptId: string }> = [];
    const adapter = defineAdapterV1({
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
            executableRef: 'consumer:write-file',
            processOwnership: 'adapter' as const,
          },
          observedAt: request.observedAt,
          evidenceRefs: ['consumer:discovery'],
        };
      },
      async run(request, ports) {
        validateAdapterRunRequestV1(manifest, request);
        receivedProfiles.push({
          profileId: request.profile.profileId,
          attemptId: request.identity.attemptId,
        });
        if (request.workspace.kind !== 'local') throw new Error('Expected local workspace');
        await writeFile(join(request.workspace.absolutePath, 'adapter-result.txt'), 'verified\n');
        if (request.instruction.includes('Branch-B-only')) {
          await writeFile(
            join(request.workspace.absolutePath, 'consumer-fork-result.txt'),
            'isolated-adapter-fork\n',
          );
        }
        const runId = `run-${request.identity.executionId}`;
        await ports.evidence.append({
          schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
          apiVersion: ADAPTER_API_VERSION,
          adapterId: manifest.adapterId,
          runId,
          sequence: 1,
          sourceId: `source-${request.identity.executionId}`,
          sourceProtocol: manifest.nativeProtocol,
          nativeEventType: 'workspace.file-written',
          semanticHint: 'workspace',
          observedAt: '2026-08-26T00:00:00.000Z',
          fidelity: 'native',
          payload: { path: 'adapter-result.txt' },
          sanitized: true,
          evidenceRefs: ['consumer:event:file-written'],
        });
        await ports.evidence.append({
          schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
          apiVersion: ADAPTER_API_VERSION,
          adapterId: manifest.adapterId,
          runId,
          sequence: 2,
          sourceId: `source-${request.identity.executionId}`,
          sourceProtocol: manifest.nativeProtocol,
          nativeEventType: 'tool_result',
          semanticHint: 'tool',
          observedAt: '2026-08-26T00:00:00.001Z',
          fidelity: 'native',
          payload: {
            type: 'tool_result',
            status: 'completed',
            tool_call_id: 'consumer-write-file',
            is_error: false,
          },
          sanitized: true,
          evidenceRefs: ['consumer:event:tool-result'],
        });
        return {
          adapterId: manifest.adapterId,
          runId,
          transport: manifest.transport,
          binding: {
            kind: 'direct' as const,
            executableRef: 'consumer:write-file',
            processOwnership: 'adapter' as const,
          },
          status: 'completed' as const,
          exitCode: 0,
          nativeSession: { status: 'unavailable' as const, reason: 'One-shot fixture.' },
          evidenceRefs: ['consumer:run:completed'],
        };
      },
    });
    const registry = new AdapterRegistryV1();
    registry.register(adapter);

    const missionFile = join(missionSource, 'mission.yaml');
    await writeFile(
      missionFile,
      `schemaVersion: missionbraid.dev/mission/v1
title: External Adapter Mission
objective: Run a clean consumer Adapter through the Mission lifecycle.
workspace: '\${WORKSPACE}'
acceptanceCriteria:
  - id: adapter-result
    description: The Adapter creates the verified result.
    verifier:
      kind: command
      executable: node
      args: [verify.mjs]
      cwd: '\${WORKSPACE}'
      timeoutMs: 5000
attemptPlan:
  - stageId: external-adapter
    profile:
      harness: consumer-harness
      adapterId: consumer.write-file
      model: default
      permissionMode: workspace-write
      injectionBudgetTokens: 4000
    instruction: Create adapter-result.txt with the accepted value.
    onFailure: stop
`,
    );

    const engine = new MissionEngine({ stateDir, adapterRegistry: registry });
    try {
      const result = await engine.run(missionFile, { workspace });

      expect(result).toMatchObject({ status: 'succeeded', receipt: { outcome: 'verified' } });
      const normalStatus = engine.status(result.missionId);
      expect(normalStatus.attempts).toMatchObject([
        { harness: 'consumer-harness', stageId: 'external-adapter', status: 'succeeded' },
      ]);
      expect(normalStatus.mission.activeProfile).toMatchObject({
        adapter: {
          adapterId: manifest.adapterId,
          adapterVersion: manifest.adapterVersion,
          transport: manifest.transport,
          nativeProtocol: manifest.nativeProtocol,
        },
        definition: {
          adapter: {
            adapterId: manifest.adapterId,
            adapterVersion: manifest.adapterVersion,
            transport: manifest.transport,
            nativeProtocol: manifest.nativeProtocol,
          },
        },
        adapterCapabilities: {
          observe: 'controller',
          interrupt: 'unsupported',
          workspaceRestore: 'unsupported',
        },
      });
      expect(normalStatus.mission.activeProfile.capabilities).toContain(
        'adapter:consumer.write-file',
      );
      expect(normalStatus.mission.activeProfile.capabilities).not.toContain('command-execution');
      expect(receivedProfiles[0]?.profileId).toBe(normalStatus.mission.activeProfile.profileId);
      const normalAttemptId = normalStatus.attempts[0]!.attemptId;
      const normalBinding = engine
        .timeline(result.missionId)
        .find(
          (entry) => entry.kind === 'attempt.bound' && entry.attemptId === normalAttemptId,
        )?.data;
      expect(normalBinding).toMatchObject({
        attemptId: normalAttemptId,
        profileId: normalStatus.mission.activeProfile.profileId,
        runtimeBinding: {
          attemptId: normalAttemptId,
          profileId: normalStatus.mission.activeProfile.profileId,
          harness: manifest.harnessId,
          adapterId: manifest.adapterId,
        },
      });
      expect(result.receipt).toMatchObject({
        runtimeBindings: [
          {
            attemptId: normalAttemptId,
            profileId: normalStatus.mission.activeProfile.profileId,
            harness: manifest.harnessId,
            adapterId: manifest.adapterId,
          },
        ],
        runtimeBindingsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(
        engine
          .timeline(result.missionId)
          .filter((entry) => entry.kind === 'runtime.event')
          .map((entry) => entry.data),
      ).toHaveLength(3);

      execFileSync('git', ['add', '-A'], { cwd: workspace });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=MissionBraid',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'external adapter checkpoint',
        ],
        { cwd: workspace },
      );
      const attemptId = result.receipt?.attemptIds?.[0];
      expect(attemptId).toBeDefined();
      const checkpoint = await engine.createCompositeCheckpoint(result.missionId, attemptId!);
      const forked = await engine.executeFork(result.missionId, {
        checkpointId: checkpoint.checkpointId,
        childBranchId: 'branch-external-adapter-fork',
        intervention: {
          interventionId: 'intervention-external-adapter-fork',
          kind: 'guidance',
          targetRef: 'stage:external-adapter',
          beforeDigest: 'sha256:consumer-guidance-a',
          afterDigest: 'sha256:consumer-guidance-b',
          description: 'Create the Branch-B-only external Adapter result.',
          authorityChange: 'unchanged',
        },
      });
      expect(forked.receipt).toMatchObject({
        branchId: 'branch-external-adapter-fork',
        outcome: 'verified',
        runtimeBindings: [
          {
            attemptId: expect.stringMatching(/^fork-attempt-/),
            profileId: normalStatus.mission.activeProfile.profileId,
            harness: manifest.harnessId,
            adapterId: manifest.adapterId,
          },
        ],
        runtimeBindingsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(receivedProfiles[1]).toMatchObject({
        attemptId: forked.receipt.attemptIds?.[0],
        profileId: forked.receipt.runtimeBindings?.[0]?.profileId,
      });
      expect(forked.record.lineage).toMatchObject({
        targetProfileId: forked.receipt.runtimeBindings?.[0]?.profileId,
        runtimeBinding: forked.receipt.runtimeBindings?.[0],
      });
      expect(
        await readFile(
          join(forked.record.lineage.isolatedWorktreePath, 'consumer-fork-result.txt'),
          'utf8',
        ),
      ).toBe('isolated-adapter-fork\n');
      await expect(
        readFile(join(workspace, 'consumer-fork-result.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      engine.close();
    }
  });

  it('fails the Runtime outcome when an Adapter changes its evidence sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-adapter-host-invalid-'));
    roots.push(root);
    const manifest = {
      schemaVersion: ADAPTER_MANIFEST_SCHEMA_VERSION,
      apiVersion: ADAPTER_API_VERSION,
      adapterId: 'consumer.invalid-sequence',
      harnessId: 'invalid-sequence-harness',
      displayName: 'Invalid Sequence Adapter',
      adapterVersion: '1.0.0',
      transport: 'direct',
      nativeProtocol: 'invalid-sequence/v1',
      capabilities: baselineCapabilities(),
    } as const;
    const registry = new AdapterRegistryV1();
    registry.register(
      defineAdapterV1({
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
              executableRef: 'consumer:invalid-sequence',
              processOwnership: 'adapter' as const,
            },
            observedAt: request.observedAt,
            evidenceRefs: ['invalid-sequence:discovery'],
          };
        },
        async run(request, ports) {
          const event = {
            schemaVersion: ADAPTER_EVENT_SCHEMA_VERSION,
            apiVersion: ADAPTER_API_VERSION,
            adapterId: manifest.adapterId,
            runId: 'run-invalid-sequence',
            sequence: 1,
            sourceId: 'invalid-source',
            sourceProtocol: manifest.nativeProtocol,
            nativeEventType: 'runtime.event',
            semanticHint: 'runtime' as const,
            observedAt: '2026-08-26T00:00:00.000Z',
            fidelity: 'native' as const,
            payload: { value: 1 },
            sanitized: true as const,
            evidenceRefs: ['invalid-sequence:event'],
          };
          await ports.evidence.append(event);
          await ports.evidence.append(event);
          return {
            adapterId: manifest.adapterId,
            runId: event.runId,
            transport: manifest.transport,
            binding: {
              kind: 'direct' as const,
              executableRef: 'consumer:invalid-sequence',
              processOwnership: 'adapter' as const,
            },
            status: 'completed' as const,
            nativeSession: { status: 'unavailable' as const, reason: 'Fixture.' },
            evidenceRefs: ['invalid-sequence:run'],
          };
        },
      }),
    );
    const host = new AdapterHostV1({ registry });

    const result = await host.run({
      identity: {
        executionId: 'execution-invalid-sequence',
        missionId: 'mission-invalid-sequence',
        branchId: 'branch-invalid-sequence',
        attemptId: 'attempt-invalid-sequence',
        bindingId: 'binding-invalid-sequence',
      },
      profile: {
        profileId: 'profile-invalid-sequence',
        adapterId: manifest.adapterId,
        harness: 'invalid-sequence-harness',
        model: 'default',
        configurationDigest: 'sha256:invalid-sequence',
      },
      workspaceKey: 'workspace-invalid-sequence',
      localWorkspace: root,
      instruction: 'Run the invalid evidence fixture.',
      onOutput: async () => undefined,
    });

    expect(result.process.spawnError?.message).toContain('strictly increasing');
    expect(result.process.exitCode).toBeNull();
  });
});

function baselineCapabilities(): AdapterCapabilitiesV1 {
  const unsupported = (detail: string) => ({
    status: 'unsupported' as const,
    fidelity: 'unsupported' as const,
    detail,
  });
  return {
    discover: {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Discovers the clean consumer fixture.',
    },
    observe: {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Emits one ordered workspace event.',
    },
    'context-capture': unsupported('No context channel.'),
    steer: unsupported('No live session.'),
    interrupt: unsupported('No live session.'),
    'pre-tool-gate': unsupported('No tool gateway.'),
    resume: unsupported('No live session.'),
    'native-fork': unsupported('No native Fork.'),
    'workspace-bind': {
      status: 'supported',
      fidelity: 'controller',
      detail: 'Uses the host-supplied local workspace.',
    },
    'workspace-restore': unsupported('No workspace restore.'),
    'external-effect-control': unsupported('No external Effects.'),
  };
}
