# Policy Triage Agent controlled fixture

This disposable repository makes one mid-Mission requirement revision
observable without asking two Agents to solve the same task.

- `qoder-tool` implements only `src/tools/policy-lookup.mjs`.
- `claude-prompt` owns only the prompt and Skill schema.
- The initial prompt Contract has two fields. The accepted revision adds
  `evidenceSource = tool.evidenceRefs`; it does not change tool behavior.
- `qoder-integrate` receives verifier-backed source artifacts in a new
  consolidation workspace. It never rewrites either source Branch.

Before a node starts, the controller writes the active immutable Contract
revision to `.missionbraid/contract-revision.json`. Verifiers read that file
through `MISSIONBRAID_TARGET_WORKSPACE`; callers do not choose the expected
schema with a command-line flag. Revision 1 requires two prompt fields. Revision
2 changes only `acceptance-prompt-schema` and adds
`evidenceSource = tool.evidenceRefs`.

The consolidation node creates `integration/summary.json` with exactly this
data (JSON key order is irrelevant):

```json
{
  "schemaVersion": "missionbraid.dev/i8-consolidation-summary/v1",
  "contractRevisionNumber": 2,
  "sourceOutputs": {
    "tool-implementation": ["src/tools/policy-lookup.mjs"],
    "prompt-skill": ["prompts/triage.md", "skills/triage/SKILL.md"]
  }
}
```

The initial prompt files and policy lookup are deliberate stubs. Useful local
checks are:

```sh
MISSIONBRAID_TARGET_WORKSPACE="$PWD" node verify-tool-node.mjs
MISSIONBRAID_TARGET_WORKSPACE="$PWD" node verify-prompt-node.mjs
MISSIONBRAID_TARGET_WORKSPACE="$PWD" node verify-final.mjs
```

`hold-open.mjs` is a controller synchronization boundary for the first Claude
Attempt. It records readiness under `.missionbraid/` and waits to be
interrupted; it is not part of product behavior.
