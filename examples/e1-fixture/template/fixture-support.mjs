import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function disposableLedger(t) {
  const directory = await mkdtemp(join(tmpdir(), 'missionbraid-e1-public-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return join(directory, 'effects.jsonl');
}

export async function readCommittedLines(filePath) {
  const text = await readFile(filePath, 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}
