# Controlled E1 fixture

This directory defines the disposable task used to test MissionBraid's thin E1
handoff from Codex to Qoder. It is deliberately small enough that the handoff,
rather than framework setup, remains the subject of the evidence.

The task is to finish a single-writer JSONL Effect Ledger with one narrow crash
recovery guarantee: an interrupted, non-newline-terminated final record is
discarded before replay or append.

- Codex implements record, replay, and same-payload idempotency, creating the
  stage-owned `src/effect-core.mjs` module.
- Qoder continues from that workspace and implements the CLI, payload-conflict
  handling, and incomplete-tail recovery without changing that module.
- the final verifier runs the public tests from the target workspace together
  with independent checks kept outside that workspace.

`template/` is intentionally incomplete and contains no reference solution.
Its tests must fail before the runtime Attempts begin. `hidden-verifier/` uses
the target workspace named by `MISSIONBRAID_TARGET_WORKSPACE` and the
controller-owned manifest named by `MISSIONBRAID_PROVENANCE_FILE`. Generated
code runs only in child processes with a clean environment and Node's
filesystem, child-process, and network permissions denied by default.

The behavior verifier alone cannot establish which runtime made a change. E1
provenance comes from MissionBraid's external Attempt/checkpoint manifest; the
verifier binds that manifest to final file hashes. This is a controlled
continuity fixture, not MissionBraid's production Effect Ledger, a power-loss
durability test, or evidence that arbitrary projects or runtimes are supported.

## Ledger contract

The target module exports `EffectLedger`, `EffectConflictError`, and
`LedgerCorruptionError` from `src/ledger.mjs`.

```js
const ledger = new EffectLedger('/absolute/or/relative/effects.jsonl');
await ledger.record({ key: 'publish:demo', payload: { revision: 'abc' } });
await ledger.replay();
```

Each committed line is deterministic JSON with this exact top-level field order
and recursively sorted payload object keys:

```json
{ "schemaVersion": 1, "key": "publish:demo", "payload": { "revision": "abc" } }
```

The terminating newline is the commit marker. A final fragment without that
marker is discarded during recovery; malformed committed lines are corruption
and must not be silently ignored. The fixture assumes one writer and makes no
claim about concurrent writers or sudden power loss.
