import { readFile } from 'node:fs/promises';

import { lookupPolicy } from './tools/policy-lookup.mjs';

export async function triageIncident(incident) {
  const tool = await lookupPolicy(incident);
  const prompt = await readFile(new URL('../prompts/triage.md', import.meta.url), 'utf8');
  const result = {
    classification: tool.decision,
    rationale: tool.rationale,
  };
  if (/"evidenceSource"\s*:\s*"tool\.evidenceRefs"/u.test(prompt)) {
    result.evidenceSource = tool.evidenceRefs;
  }
  return result;
}
