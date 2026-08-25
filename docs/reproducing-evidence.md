# Reproducing MissionBraid Evidence Paths

These procedures exercise the deeper interruption, cross-Runtime, and provider
compatibility paths. Start with the root README's Workbench path if you only
want to understand the product.

Common requirements: Node.js 24–26, pnpm, and Git. The commands target a POSIX
shell on macOS, Linux, or WSL; native Windows reproduction is not yet documented
or verified.

```sh
pnpm install --frozen-lockfile
pnpm build
```

Use only the included disposable fixtures. Controller state must remain outside
the target workspace.

## E0 Runtime-process interruption path

This procedure interrupts the owned Runtime PID and exercises the E0 recovery
gate. It is not a step-by-step reproduction of the published E0 record, which
used a controller `SIGKILL`; the two runs cover different interruption shapes.

E0 requires an installed and authenticated `codex` CLI that can access the
profile in the Mission file.

```sh
MISSIONBRAID_RUN_ROOT="$(mktemp -d)"
MISSIONBRAID_WORKSPACE="$MISSIONBRAID_RUN_ROOT/workspace"
MISSIONBRAID_STATE="$MISSIONBRAID_RUN_ROOT/control/.missionbraid"
printf 'WORKSPACE=%s\nSTATE=%s\n' "$MISSIONBRAID_WORKSPACE" "$MISSIONBRAID_STATE"
node scripts/prepare-e1-fixture.mjs "$MISSIONBRAID_WORKSPACE"
node dist/src/cli.js run examples/e0-fixture/mission.yaml \
  --workspace "$MISSIONBRAID_WORKSPACE" \
  --state-dir "$MISSIONBRAID_STATE"
```

In another terminal, `list` reveals the Mission ID and `status` reveals the
owned Runtime PID. Reuse the two absolute paths, interrupt that Runtime only
after the disposable worktree contains a meaningful change, then continue
without restating the task:

```sh
MISSIONBRAID_STATE='/absolute/path/from/the/first/terminal'
MISSIONBRAID_MISSION_ID='paste missionId from list output'
MISSIONBRAID_RUNTIME_PID='paste activeProcess.pid from status output'

node dist/src/cli.js list --state-dir "$MISSIONBRAID_STATE"
node dist/src/cli.js status "$MISSIONBRAID_MISSION_ID" --state-dir "$MISSIONBRAID_STATE"
kill -TERM "$MISSIONBRAID_RUNTIME_PID"
```

Wait for the original `run` command to return a waiting result and release its
workspace lease. Then resume the same Mission:

```sh
node dist/src/cli.js resume "$MISSIONBRAID_MISSION_ID" --state-dir "$MISSIONBRAID_STATE"
```

## E1 Codex-to-Qoder handoff

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
MISSIONBRAID_RUN_ROOT="$(mktemp -d)"
MISSIONBRAID_WORKSPACE="$MISSIONBRAID_RUN_ROOT/workspace"
MISSIONBRAID_STATE="$MISSIONBRAID_RUN_ROOT/control/.missionbraid"
printf 'WORKSPACE=%s\nSTATE=%s\n' "$MISSIONBRAID_WORKSPACE" "$MISSIONBRAID_STATE"

node scripts/prepare-e1-fixture.mjs "$MISSIONBRAID_WORKSPACE"
node dist/src/cli.js run examples/e1-fixture/mission.yaml \
  --workspace "$MISSIONBRAID_WORKSPACE" \
  --state-dir "$MISSIONBRAID_STATE"
```

In a second terminal, reuse the two printed absolute paths. Wait until `list`
shows the single fresh Mission, then let the fixture helper enforce the exact
Codex checkpoint boundary and signal only its persisted Runtime PID:

```sh
MISSIONBRAID_WORKSPACE='/absolute/run-root/workspace'
MISSIONBRAID_STATE='/absolute/run-root/control/.missionbraid'

node dist/src/cli.js list --state-dir "$MISSIONBRAID_STATE"
node scripts/interrupt-e1-at-checkpoint.mjs \
  --workspace "$MISSIONBRAID_WORKSPACE" \
  --state-dir "$MISSIONBRAID_STATE"
```

The original controller automatically checkpoints Codex, projects the Capsule,
and starts Qoder. Do **not** launch a concurrent `resume`. Wait for the first
terminal to return `status: "succeeded"` with
`receipt.outcome: "verified"`, then replay the original verifier:

```sh
MISSIONBRAID_MISSION_ID='paste missionId from the succeeded run output'
node dist/src/cli.js status "$MISSIONBRAID_MISSION_ID" --state-dir "$MISSIONBRAID_STATE"
node dist/src/cli.js verify "$MISSIONBRAID_MISSION_ID" --state-dir "$MISSIONBRAID_STATE"
```

`resume` is only for a controller that has exited or returned a waiting result
and no longer owns the workspace lease. The E1 fixture's normal SIGTERM path
does not require it.

## Iteration 5 same-host Execution Fork path

The published result is the
[Iteration 5 machine-readable record](../evidence/iteration-5-execution-fork-local-2026-08-26.json).
This path requires an installed and authenticated `codex` CLI with access to
the configured model, plus a local headless browser available to the Workbench
proof runner.

```sh
command -v codex
codex --version

MISSIONBRAID_I5_RESULT_ROOT="$(mktemp -d)"
node scripts/run-i5-execution-fork-proof.mjs \
  "$MISSIONBRAID_I5_RESULT_ROOT/iteration-5-execution-fork.json"
```

The output path must not already exist. The proof runner creates its own
disposable repository, Mission state, isolated fork worktree, browser session,
and queryable local HTTP Effect target. It runs a real Codex parent Attempt,
verifies the resulting one-file delta, creates a Composite Checkpoint through
the browser, starts a fresh real Codex process in Branch B, runs the bound
verifier, checks that Branch A stayed unchanged and the inherited external
Effect was not repeated, then restarts the Workbench and checks restoration.

The parent Runtime does **not** author the Git boundary commit. The local proof
controller first inspects the exact Codex-produced delta and then commits it
because the Codex workspace sandbox cannot write Git metadata. The child is a
fresh native process in an isolated Git worktree, not a native Codex session
fork or resume. The separate [Replay record](../evidence/iteration-5-checkpoint-replay-local-2026-08-26.json)
proves that Playback is projection-only, cached replay consumes persisted future
Artifacts without starting a Runtime, and Counterfactual Resampling runs a real
model-only process with tools disabled and leaves the outcome unknown. Those
three modes do not continue a real workspace.

A successful rerun is still same-host local evidence and may inherit the
operator's authenticated Runtime installation, instructions, Skills, MCP
configuration, and other user-level state. It is not cross-host, independent
external reproduction, or production evidence.

## Kandev v0.91.0 public-interface check

MissionBraid includes a narrow development command for the separately installed
[Kandev v0.91.0 release](https://github.com/kdlbs/kandev/releases/tag/v0.91.0).
It pins the release commit, creates or reconciles one prepared Kandev task by
`external_id`, observes its worktree binding, starts one preconfigured custom
process, and requires the public process GET and list endpoints to stop exposing
that process after a stop request.

Run this only against an isolated disposable Kandev workspace. Configure the
selected repository with a no-side-effect probe script that remains alive long
enough to be observed, such as `pwd; sleep 600`; use a disposable agent profile
and executor because session preparation may instantiate them. Then copy and
complete
[`config.example.json`](../examples/kandev-provider-check/config.example.json).
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

## Interpreting results

Compare each result with the [evidence index](../evidence/README.md). A local
success does not establish third-party reproduction, arbitrary task coverage,
or production readiness. A failed or unknown result must not be rewritten as a
verified outcome.
