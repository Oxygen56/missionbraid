import { lookupPolicy } from './tools/policy-lookup.mjs';

export async function triageIncident(incident) {
  const tool = await lookupPolicy(incident);
  return {
    classification: tool.decision,
    rationale: tool.rationale,
    evidenceSource: tool.evidenceRefs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = process.argv[2];
  if (raw === undefined) {
    process.stderr.write('Usage: node src/agent.mjs <incident-json>\n');
    process.exitCode = 2;
  } else {
    const result = await triageIncident(JSON.parse(raw));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
