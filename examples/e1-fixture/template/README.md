# Effect Ledger continuity task

Finish a dependency-free, single-writer JSONL Effect Ledger. The starting code
is intentionally incomplete. Its crash-recovery scope is limited to discarding
an interrupted final record that lacks a newline commit marker; this is not a
power-loss or concurrent-writer durability exercise.

## Stage-owned core

The first runtime creates `src/effect-core.mjs` and uses it from
`src/ledger.mjs`. It exports:

- `canonicalJson(value)`, recursively sorting object keys while preserving
  array order;
- `createEffect({ key, payload })`, returning the validated V1 effect;
- `payloadsEqual(left, right)`, comparing JSON payloads canonically;
- `serializeEffect(effect)`, returning deterministic JSON with top-level field
  order `schemaVersion`, `key`, `payload` and recursively sorted payload keys.

The second runtime must keep `src/effect-core.mjs` byte-for-byte unchanged and
extend the ledger and CLI around it.

## Module API

`src/ledger.mjs` must export:

- `EffectLedger`
  - `new EffectLedger(filePath)`
  - `await record({ key, payload })` returns
    `{ status: "recorded" | "replayed", effect }`
  - `await replay()` returns committed effects in append order
- `EffectConflictError` with code `EFFECT_PAYLOAD_CONFLICT`
- `LedgerCorruptionError` with code `LEDGER_CORRUPT`

An effect has exactly this logical shape:

```js
{ schemaVersion: 1, key: "resource:operation", payload: { /* JSON */ } }
```

Keys are non-empty strings. Payloads are finite JSON objects: no `undefined`,
functions, symbols, bigint values, non-finite numbers, cycles, sparse arrays,
or non-plain objects. Object-key ordering is not significant, so equivalent
payloads are idempotent. Reusing a key with a different payload is a conflict
and must not append another line.

Every committed JSONL record ends with `\n`; the newline is its commit marker.
Before replaying or appending, discard only a non-empty final fragment that has
no newline. A newline-terminated line with malformed JSON, an unknown schema,
or an invalid effect shape is committed corruption and must raise
`LedgerCorruptionError`. This controlled task assumes a single writer.

## CLI

```text
node src/cli.mjs record <ledger-file> <key> <payload-json>
node src/cli.mjs replay <ledger-file>
```

`record` prints its result as one JSON line. `replay` prints one effect per line
in ledger order. A payload conflict exits with status 2 and writes a JSON error
with code `EFFECT_PAYLOAD_CONFLICT` to stderr. Usage or invalid JSON exits with
status 64. Unexpected failures exit with status 1.

For public testing, `src/cli.mjs` also exports `main(argv, io)`, where `io`
contains `stdout` and `stderr` objects with `write(string)` methods. It resolves
to the same numeric status that the direct process entry point assigns to
`process.exitCode`.

Run the public tests with:

```text
node --test
```
