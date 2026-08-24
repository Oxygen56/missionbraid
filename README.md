# MissionBraid

**One mission. Many runtimes. Verifiable outcomes.**

MissionBraid is a pre-alpha, mission-centric control plane for long-running
coding agents.

> **Project status:** pre-alpha. The thin direct-adapter E0/E1 paths are
> implemented in code. One controlled local E0 run is verified against
> implementation commit `9d5b4d3`. One controlled local E1 run is verified
> against commit `b16bd0b`: Codex was interrupted after meaningful work, Qoder
> acknowledged the Capsule while its workspace still matched the recorded
> handoff baseline, continued there, and the original Contract produced a
> verified Receipt. A second E1 run from a clean public clone of commit
> `f73bc24` reproduced that path in a separate task context on the same host;
> host-level Harness configuration may still have been reused. A separate local
> check against Kandev v0.91.0 first created a fresh task, session, and worktree,
> then reconciled them on rerun while retiring a distinct custom process each
> time. These results do not establish a Kandev-backed Mission, third-party reproduction,
> broad runtime compatibility, or production readiness.

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

## Try the controlled fixtures

Common requirements: Node.js 24–26, pnpm, and Git. The commands below target a
POSIX shell on macOS, Linux, or WSL; native Windows reproduction is not yet
documented or verified.

```sh
pnpm install --frozen-lockfile
pnpm build
```

### E0 process recovery

E0 requires an installed and authenticated `codex` CLI that can access the
profile in the Mission file.

```sh
RUN_ROOT="$(mktemp -d)"
WORKSPACE_DIR="$RUN_ROOT/workspace"
STATE_DIR="$RUN_ROOT/control/.missionbraid"
printf 'WORKSPACE_DIR=%s\nSTATE_DIR=%s\n' "$WORKSPACE_DIR" "$STATE_DIR"
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
```

Wait for the original `run` command to return a waiting result and release its
workspace lease. Then resume the same Mission:

```sh
node dist/src/cli.js resume "$MISSION_ID" --state-dir "$STATE_DIR"
```

### E1 Codex-to-Qoder handoff

E1 requires both installed CLIs, valid local authentication, and access to the
models fixed in the Mission file:

```sh
command -v codex
codex --version
command -v qodercli
qodercli --version
```

In the first terminal, create fresh, disjoint workspace and controller paths,
then start the E1 Mission. Keep this `run` process alive:

```sh
RUN_ROOT="$(mktemp -d)"
WORKSPACE_DIR="$RUN_ROOT/workspace"
STATE_DIR="$RUN_ROOT/control/.missionbraid"
printf 'WORKSPACE_DIR=%s\nSTATE_DIR=%s\n' "$WORKSPACE_DIR" "$STATE_DIR"

node scripts/prepare-e1-fixture.mjs "$WORKSPACE_DIR"
node dist/src/cli.js run examples/e1-fixture/mission.yaml \
  --workspace "$WORKSPACE_DIR" \
  --state-dir "$STATE_DIR"
```

In a second terminal, reuse the two printed absolute paths. Wait until `list`
shows the single fresh Mission, then let the fixture helper enforce the exact
Codex checkpoint boundary and signal only its persisted runtime PID:

```sh
WORKSPACE_DIR='/absolute/run-root/workspace'
STATE_DIR='/absolute/run-root/control/.missionbraid'

node dist/src/cli.js list --state-dir "$STATE_DIR"
node scripts/interrupt-e1-at-checkpoint.mjs \
  --workspace "$WORKSPACE_DIR" \
  --state-dir "$STATE_DIR"
```

The original `run` controller automatically checkpoints Codex, projects the
Capsule, and starts Qoder. Do **not** launch a concurrent `resume`. Wait for the
first terminal to return `status: "succeeded"` with
`receipt.outcome: "verified"`, then replay the original verifier:

```sh
MISSION_ID='paste missionId from the succeeded run output'
node dist/src/cli.js status "$MISSION_ID" --state-dir "$STATE_DIR"
node dist/src/cli.js verify "$MISSION_ID" --state-dir "$STATE_DIR"
```

`resume` is only for a controller that has exited or returned a waiting result
and no longer owns the workspace lease. The E1 fixture's normal SIGTERM path
does not require it. Only use the included disposable fixtures; controller
state must remain outside the target workspace.

### Kandev v0.91.0 public-interface check

MissionBraid includes a narrow development command for the separately installed
[Kandev v0.91.0 release](https://github.com/kdlbs/kandev/releases/tag/v0.91.0).
It pins the release commit, creates or reconciles one prepared Kandev task by
`external_id`, observes its worktree binding, starts one preconfigured custom
process, and requires the public process GET and list endpoints to stop exposing
that process after a stop request.

Run this only against an isolated disposable Kandev workspace. Configure the
selected repository with a no-side-effect probe script that remains alive long
enough to be observed, such as `pwd; sleep 600`; use a disposable agent profile
and executor because session preparation may instantiate them. Then copy and complete
[`config.example.json`](examples/kandev-provider-check/config.example.json).
Authentication, when enabled, is read only from
`MISSIONBRAID_KANDEV_TOKEN`; it is never accepted in the config or written to
the result.

```sh
node dist/src/cli.js provider-check kandev /absolute/path/to/config.json \
  --output /absolute/path/to/result.json
```

This command is deliberately outside the Mission Kernel. A compatible result
is evidence only for the checked v0.91.0 public task, worktree, and custom-process
lifecycle endpoints in that run. It is not an Outcome Receipt, a Kandev-backed
Mission, Kandev Session or Agent lifecycle control, broad provider support,
proof of operating-system process termination, or production readiness.
MissionBraid remains independent and does not fork Kandev or read its internal
database.

## Evidence status

- [E0 local real-runtime evidence](evidence/e0-local-2026-08-24.json): a
  controlled controller `SIGKILL` was recovered by Mission ID alone, the
  original Contract passed, and a verified Receipt was issued against
  implementation commit `9d5b4d3`.
- [E1 local real-runtime evidence](evidence/e1-local-2026-08-24.json): Codex was
  interrupted with `SIGTERM` after meaningful stage-owned changes,
  MissionBraid captured its checkpoint and projected a Capsule, Qoder
  acknowledged that Capsule while its workspace digest still matched the
  recorded handoff baseline, completed the remaining files, and the original
  Contract issued a verified Receipt against commit `b16bd0b`.
- [E1 task-context-isolated local reproduction](evidence/e1-context-isolated-reproduction-local-2026-08-24.json):
  a separate task context used a clean public clone and fresh state/workspace,
  reproduced the Codex-to-Qoder handoff against commit `f73bc24`, and replayed
  the original verifier to issue a second verified Receipt.
- [E1 checkpoint-helper local validation](evidence/e1-checkpoint-helper-local-2026-08-24.json):
  the exact helper content bound the public E1 spec, clean baseline, Codex
  process, and renewed controller lease before signaling; the resulting real
  Codex-to-Qoder run and explicit reverification both issued verified Receipts.
- [Earlier blocked E1 evidence](evidence/e1-blocked-local-2026-08-24.json) is
  retained as failure history: the prior Qoder account session stopped before
  acknowledgement, and MissionBraid issued no false Receipt.
- [Kandev v0.91.0 local provider-interface check](evidence/kandev-v0.91.0-provider-check-local-2026-08-24.json):
  a clean-clone run created a fresh task, session, and worktree; its rerun
  reconciled the same identities. Both started distinct custom processes,
  accepted stop requests, and observed each exact process retire from the public
  API. This is compatibility evidence for those endpoints, not a Kandev-backed
  Mission or Session/Agent lifecycle support.

These are local, revision- or content-hash-bound records. The fresh-clone
reproduction isolated the task context, Mission state, and workspace, but reused
the same host and its authenticated runtime installations; user-level Harness
instructions, Skills, MCP, and other configuration may also have been reused.
It is not third-party or cross-host reproduction, hostile-runtime isolation,
production deployment, or broad compatibility evidence.

## Current scope

The evidence scope is deliberately narrow:

- **E0 gate:** one real Mission survives a runtime or controller interruption,
  resumes without task restatement, and closes with a verified Receipt;
- **E1 gate:** the same real Mission crosses two runtime profiles without manual
  context transfer and closes with a verified Receipt.

E0 and E1 are locally satisfied for the controlled runs bound to commits
`9d5b4d3` and `b16bd0b`. A same-host, task-context-isolated fresh-clone run
bound to `f73bc24` reproduced E1; third-party or cross-host reproduction remains
open.

This repository should still be read as a pre-alpha local vertical slice. The
verified Codex-to-Qoder fixture is evidence for that exact path, not a production
system or a claim about arbitrary projects and runtimes.

## License

MissionBraid is licensed under the [Apache License 2.0](LICENSE).
