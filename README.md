# MissionBraid

**One mission. Many runtimes. Verifiable outcomes.**

MissionBraid is a pre-alpha, mission-centric control plane for long-running
coding agents.

> **Project status:** pre-alpha. The thin direct-adapter E0/E1 paths are
> implemented in code. One controlled local E0 run is verified against
> implementation commit `9d5b4d3`; E1 reached a real Codex-to-Qoder boundary
> but stopped before target acknowledgement or a Receipt. MissionBraid does not
> yet claim verified cross-runtime continuity or production readiness.

## Why MissionBraid

A long coding task should not belong to one model, one CLI, or one session.
When a runtime exits, becomes unavailable, or stops fitting the task, users
should not have to reconstruct the objective, move context by hand, guess which
external actions already happened, and decide whether the work is actually
done.

MissionBraid is being built around one principle:

> **The mission outlives the runtime.**

The user submits a Mission with an Outcome Contract. A runtime executes one
Attempt. If execution must move, MissionBraid is designed to preserve the
mission's authoritative state, reconcile mutable effects, project a bounded
handoff capsule into the next runtime, and verify the original contract before
issuing an outcome receipt.

```text
Outcome Contract
  → Runtime Profile
  → deterministic planning
  → bounded evidence handoff
  → effect reconciliation
  → verified Outcome Receipt
```

## What makes it different

MissionBraid is not intended to reimplement coding-agent CLIs or become another
agent launcher. Existing projects already provide strong runtime, workspace,
session, and workflow capabilities. MissionBraid focuses on the state that must
remain valid **across** those boundaries:

- the Mission and its acceptance contract;
- the chain of runtime-specific Attempts;
- evidence-backed handoff between Attempts;
- conditional protection against repeated mutable actions;
- reproducible planning and failure evidence;
- completion verified independently from an agent's own report.

## Design principles

1. **Mission owns truth.** A runtime is an execution resource, not the owner of
   task state.
2. **Continuity transfers evidence, not chat.** Hidden model state is neither
   portable nor claimed to be portable.
3. **Done is a receipt, not a claim.** Model output alone cannot complete a
   Mission.
4. **Guarantees are explicit.** Enforced, guarded, and advisory controls are
   reported separately.
5. **Unknown is a valid result.** Missing evidence is not converted into false
   certainty.

## Project documents

- [Product architecture](docs/architecture.md)
- [Implementation and evidence roadmap](docs/roadmap.md)
- [Key product and technical questions](docs/key-questions.md)

## Implemented vertical path

The current local CLI implements the narrow path needed to test the product
contract:

- versioned, Kernel-resident Mission snapshots and immutable Outcome Contracts;
- an append-only SQLite event chain with workspace leases and fencing;
- direct Codex and Qoder process adapters with persisted PIDs;
- persisted pre-Attempt baselines, crash-recovered checkpoints, and complete
  stage provenance;
- budgeted Canonical Capsule projection and structured acknowledgement checks;
- advisory workspace Effect identities;
- out-of-process command verification and hash-bound Outcome Receipts;
- `run`, `resume`, `status`, `list`, and `verify` commands.

This is a local vertical slice, not a broad runtime compatibility claim.

## Try the controlled fixture

Requirements: Node.js 24–26, pnpm, Git, and the runtime CLI being tested.

```sh
pnpm install
pnpm build
RUN_ROOT="$(mktemp -d)"
WORKSPACE_DIR="$RUN_ROOT/workspace"
STATE_DIR="$RUN_ROOT/control/.missionbraid"
node scripts/prepare-e1-fixture.mjs "$WORKSPACE_DIR"
node dist/src/cli.js run examples/e0-fixture/mission.yaml \
  --workspace "$WORKSPACE_DIR" \
  --state-dir "$STATE_DIR"
```

In another terminal, `list` reveals the Mission ID and `status` reveals the
owned runtime PID. Reuse the absolute `STATE_DIR` created above, interrupt that
runtime only after the disposable worktree contains a meaningful change, then
continue without restating the task:

```sh
STATE_DIR='/absolute/path/from/the/first/terminal'
MISSION_ID='paste missionId from list output'
RUNTIME_PID='paste activeProcess.pid from status output'

node dist/src/cli.js list --state-dir "$STATE_DIR"
node dist/src/cli.js status "$MISSION_ID" --state-dir "$STATE_DIR"
kill -TERM "$RUNTIME_PID"
node dist/src/cli.js resume "$MISSION_ID" --state-dir "$STATE_DIR"
```

Only use the included disposable fixture for this interruption exercise.
Controller state must remain outside the target workspace.

## Evidence status

- [E0 local real-runtime evidence](evidence/e0-local-2026-08-24.json): a
  controlled controller `SIGKILL` was recovered by Mission ID alone, the
  original Contract passed, and a verified Receipt was issued against
  implementation commit `9d5b4d3`.
- [E1 blocked local real-runtime evidence](evidence/e1-blocked-local-2026-08-24.json):
  MissionBraid captured Codex's workspace changes as a checkpoint and prepared
  a Capsule for Qoder, but Qoder exited before acknowledgement with observed
  provider code `118`, classified as `CREDIT_LIMIT` at the runtime-account
  layer. No Receipt was issued.

These are local, commit-bound records, not an independent reproduction,
hostile-runtime isolation result, production deployment, or verified E1 result.

## Current scope

The evidence scope is deliberately narrow:

- **E0 gate:** one real Mission survives a runtime or controller interruption,
  resumes without task restatement, and closes with a verified Receipt;
- **E1 gate:** the same real Mission crosses two runtime profiles without manual
  context transfer and closes with a verified Receipt.

E0 is locally satisfied for the single controlled run bound to implementation
commit `9d5b4d3`; independent reproduction remains open. E1 is not satisfied.

Until E1 is demonstrated, this repository should be read as a pre-alpha local
vertical slice, not as a production system or a verified multi-runtime product.

## License

MissionBraid is licensed under the [Apache License 2.0](LICENSE).
