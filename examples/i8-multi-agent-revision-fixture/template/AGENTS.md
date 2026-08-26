# Controlled Policy Triage Agent fixture

- Work only inside this disposable workspace.
- Read `README.md` and the relevant deterministic verifier before editing.
- The `qoder-tool` node may change only `src/tools/policy-lookup.mjs`.
- The `claude-prompt` node may change only `prompts/triage.md` and
  `skills/triage/SKILL.md`.
- The `qoder-integrate` node may create only `integration/summary.json`; its
  three source files are immutable verifier-backed inputs.
- Never edit `policy.json`, `src/agent.mjs`, a verifier, or `hold-open.mjs`.
- Preserve the `TRIAGE_SCHEMA_START` and `TRIAGE_SCHEMA_END` markers in both
  prompt files. The JSON object between them is the authoritative output map.
- The initial Contract has exactly two output fields: `classification` and
  `rationale`.
- A revised Contract has exactly three output fields: `classification`,
  `rationale`, and `evidenceSource`; the last value must be exactly
  `tool.evidenceRefs`.
- Use only Node.js built-ins. Do not install dependencies or access the network.
- Do not push, publish, deploy, send messages, or create any external mutable
  effect.
- Runtime coordination files belong under `.missionbraid/` and remain
  untracked.
- Verifiers derive the active schema from
  `$MISSIONBRAID_TARGET_WORKSPACE/.missionbraid/contract-revision.json`; never
  infer or overwrite that controller-owned Contract record.
