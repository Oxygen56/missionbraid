import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from './adapters/claude.js';
import { NativeArtifactStore } from './artifact-store.js';
import {
  ClaudeModelOnlyResamplePort,
  NativeArtifactReplayResolver,
} from './model-only-resample.js';
import type { ModelOnlyResampleInputV1, ReplayArtifactRefV1 } from './checkpoint-replay.js';

const disposable: string[] = [];

afterEach(async () => {
  await Promise.all(disposable.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Claude model-only resampling', () => {
  it('runs with native tools disabled and retains model evidence as replay-safe Artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-model-only-'));
    disposable.push(root);
    const command = join(root, 'fake-claude');
    await writeFile(
      command,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (args[args.indexOf('--tools') + 1] !== '' || !args.includes('--safe-mode')) process.exit(19);
  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'revised'}]}}) + '\\n');
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'revised',usage:{output_tokens:3}}) + '\\n');
});
`,
      'utf8',
    );
    await chmod(command, 0o755);
    const artifacts = new NativeArtifactStore(join(root, 'state'));
    const context = await artifacts.putLine('cached context');
    const intervention = await artifacts.putLine('replacement instruction');
    const port = new ClaudeModelOnlyResamplePort({
      adapter: new ClaudeAdapter({ command }),
      artifacts,
      sandboxDirectory: join(root, 'empty-sandbox'),
    });

    const result = await port.resample(input(context, intervention));

    expect(result.status).toBe('completed');
    expect(result.toolRequestEvidenceRefs).toEqual([]);
    expect(result.effectEvidenceRefs).toEqual([]);
    expect(result.workspaceEvidenceRefs).toEqual([]);
    expect(result.modelEvidence.some((candidate) => candidate.kind === 'model-output')).toBe(true);
    expect(result.modelEvidence.every((candidate) => candidate.artifactRefs.length === 1)).toBe(
      true,
    );
  });

  it('reports the actual persisted digest to the replay resolver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-replay-resolver-'));
    disposable.push(root);
    const artifacts = new NativeArtifactStore(join(root, 'state'));
    const artifact = await artifacts.putLine('retained');
    const resolver = new NativeArtifactReplayResolver(artifacts);
    const resolved = await resolver.resolve({
      artifactId: artifact.artifactId,
      contentDigest: 'sha256:' + '0'.repeat(64),
      fidelity: 'exact-replay-safe',
      evidenceRefs: ['fixture'],
    });
    expect(resolved).toMatchObject({
      status: 'found',
      contentDigest: `sha256:${artifact.sha256}`,
    });
  });
});

function input(
  context: { readonly artifactId: string; readonly sha256: string },
  intervention: { readonly artifactId: string; readonly sha256: string },
): ModelOnlyResampleInputV1 {
  const contextRef: ReplayArtifactRefV1 = {
    artifactId: context.artifactId,
    contentDigest: `sha256:${context.sha256}`,
    fidelity: 'exact-replay-safe',
    evidenceRefs: ['fixture-context'],
  };
  return {
    replayId: 'replay-fixture',
    missionId: 'mission-fixture',
    contractId: 'contract-fixture',
    parentBranchId: 'branch-parent',
    childBranchId: 'branch-child',
    parentCheckpointId: 'checkpoint-parent',
    cachedContext: {
      schemaVersion: 'missionbraid.dev/checkpoint-replay-source/v1',
      bundleId: 'bundle-fixture',
      manifestDigest: 'sha256:' + '1'.repeat(64),
      checkpointId: 'checkpoint-parent',
      contextDigest: 'sha256:' + '2'.repeat(64),
      artifactRefs: [contextRef],
      targetDigests: [
        { targetRef: 'instruction:system', contentDigest: 'sha256:' + '3'.repeat(64) },
      ],
      evidenceRefs: ['fixture-context'],
    },
    intervention: {
      interventionId: 'intervention-fixture',
      kind: 'context',
      targetRef: 'instruction:system',
      beforeDigest: 'sha256:' + '3'.repeat(64),
      afterDigest: `sha256:${intervention.sha256}`,
      description: 'Replace the visible instruction',
      authorityChange: 'unchanged',
    },
    interventionArtifact: {
      artifactId: intervention.artifactId,
      contentDigest: `sha256:${intervention.sha256}`,
      fidelity: 'exact-replay-safe',
      evidenceRefs: ['fixture-intervention'],
      targetRef: 'instruction:system',
    },
    inheritedExternalEffectFrontier: [],
    externalEffectDecisions: [],
    liveToolAccess: 'forbidden',
    liveWorkspaceAccess: 'forbidden',
  };
}
