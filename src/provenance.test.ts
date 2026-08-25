import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PROVENANCE_SCHEMA_VERSION, writeProvenanceManifest } from './provenance.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('writeProvenanceManifest', () => {
  it('writes a stable, private projection outside the target workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missionbraid-provenance-'));
    roots.push(root);
    const file = join(root, 'state', 'provenance.json');
    await writeProvenanceManifest(file, {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      missionId: 'mission-1',
      rootBranchId: 'branch-root-1',
      stages: [],
    });
    expect(await readFile(file, 'utf8')).toBe(
      '{"missionId":"mission-1","rootBranchId":"branch-root-1","schemaVersion":"missionbraid.dev/provenance/v1","stages":[]}\n',
    );
  });
});
