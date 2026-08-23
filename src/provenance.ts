import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalJson } from './store.js';

export const PROVENANCE_SCHEMA_VERSION = 'missionbraid.dev/provenance/v1' as const;

export interface ProvenanceChangedPathV1 {
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
}

export interface ProvenanceStageV1 {
  readonly checkpointId: string;
  readonly stageId: string;
  readonly harness: 'codex' | 'qoder';
  readonly attemptId: string;
  readonly status: 'succeeded' | 'handed_off' | 'failed';
  readonly origin: 'runtime-completion' | 'controller-recovery';
  readonly beforeWorkspaceDigest: string;
  readonly afterWorkspaceDigest: string;
  readonly changedPaths: readonly ProvenanceChangedPathV1[];
}

export interface ProvenanceManifestV1 {
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly missionId: string;
  readonly stages: readonly ProvenanceStageV1[];
}

export async function writeProvenanceManifest(
  file: string,
  manifest: ProvenanceManifestV1,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${canonicalJson(manifest)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryFile, file);
}
