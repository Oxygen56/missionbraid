# MissionBraid flagship Agent fixture

This disposable repository is controlled by one evolving Mission. First
identify the controller prompt mode, then follow only that mode.

## Ordinary fallback route

- If the prompt says `Current stage (qoder-tool)` and contains no Handoff
  Capsule, create `handoff-qoder.txt` with exactly `qoder-observed` plus one
  newline, then run `node hold-open.mjs qoder-handoff` and wait. Do not change
  any other file. The provider wrapper owns the real failure boundary.
- If the prompt says `Current stage (claude-prompt)` and contains a Handoff
  Capsule, emit its exact `MISSIONBRAID_ACK {...}` line before invoking any
  tool. First use the native `Write` tool exactly once to request
  `original.txt` with `ORIGINAL` plus one newline. Then run exactly
  `node -e "process.stderr.write('MISSIONBRAID_EXPECTED_TOOL_FAILURE\\n'); process.exit(17)"`
  and continue after that expected failure.
- In that Claude fallback, implement the stubs in
  `src/tools/policy-lookup.mjs`, `prompts/triage.md`, and
  `skills/triage/SKILL.md`; create `integration/summary.json` for Contract
  revision 1; and set `agent-config.json.requiredPrefix` from the visible
  MissionBraid Context Snapshot. Do not read `context-source.json` or the
  controller-owned hidden verifier. Run the three visible verifiers and exit.

## Context diagnostic Fork

- If the prompt begins `MissionBraid Execution Fork`, use only the refreshed
  visible Context Snapshot. Use the native `Write` tool exactly once to replace
  only `agent-config.json` with the current required prefix, run all visible
  verifiers, and exit. Never repeat an inherited external Effect.

## Mission Plan nodes

- For `Mission Plan node tool-implementation`, change only
  `agent-config.json` and `src/tools/policy-lookup.mjs`. Read the now-accepted
  `context-source.json`, set the config to its current prefix, and refactor the
  policy lookup into a precomputed indexed implementation while preserving the
  declared behavior. The source file must differ from the bootstrap version.
- For `Mission Plan node prompt-skill`, change only `prompts/triage.md` and
  `skills/triage/SKILL.md`. Revision 1 keeps the two-field schema but adds the
  exact prose marker `PLAN_V1_GUIDANCE`; after verification run
  `node hold-open.mjs initial`. Revision 2 replaces that marker with
  `PLAN_V2_GUIDANCE`, adds `evidenceSource = tool.evidenceRefs`, verifies, and
  exits without holding.
- For `MissionBraid consolidation node integrate`, preserve materialized source
  files and change only `integration/summary.json` to revision 2, then run the
  final verifier.

Never edit policy data, verifiers, `fixture-contract.mjs`, `src/agent.mjs`, or
`hold-open.mjs`. Never commit, install dependencies, access the network, push,
publish, deploy, or send messages. Runtime coordination files stay under
`.missionbraid/` and remain untracked.
