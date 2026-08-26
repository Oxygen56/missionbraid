# Policy Triage Agent flagship fixture

The ordinary route creates a complete revision-1 baseline. A later explicit
Plan refactors the tool, evolves the prompt from revision 1 to revision 2, and
consolidates independently verified Artifacts.

Revision-1 integration summary:

```json
{
  "schemaVersion": "missionbraid.dev/flagship-consolidation-summary/v1",
  "contractRevisionNumber": 1,
  "sourceOutputs": {
    "bootstrap": [
      "agent-config.json",
      "src/tools/policy-lookup.mjs",
      "prompts/triage.md",
      "skills/triage/SKILL.md"
    ]
  }
}
```

Revision-2 integration summary:

```json
{
  "schemaVersion": "missionbraid.dev/flagship-consolidation-summary/v1",
  "contractRevisionNumber": 2,
  "sourceOutputs": {
    "tool-implementation": ["agent-config.json", "src/tools/policy-lookup.mjs"],
    "prompt-skill": ["prompts/triage.md", "skills/triage/SKILL.md"]
  }
}
```
