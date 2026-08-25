import { readFile } from 'node:fs/promises';

export async function answer(question) {
  const config = JSON.parse(
    await readFile(new URL('../agent-config.json', import.meta.url), 'utf8'),
  );
  return `${config.requiredPrefix} ${question}`;
}
