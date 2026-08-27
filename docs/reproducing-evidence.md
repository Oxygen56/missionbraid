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
the target workspace. Run source-bound proofs from a clean checkout when the
result is intended for comparison with a retained record. The scripts can
record a dirty tree, but that is a different evidence boundary.

Every command below writes to a fresh absolute path outside the repository.
Keep that rule when adapting the examples: it prevents a generated result from
changing the source fingerprint it is meant to describe, and it avoids
overwriting a retained record.

## Unified v1 flagship Mission

The published result is the
[unified flagship record](../evidence/v1-flagship-local-2026-08-26.json). This is
the primary connected product proof rather than a claim that every possible
Mission follows the same path.

The runner requires installed and authenticated `qodercli` and `claude` CLIs,
access to Qoder `Qwen3.8-Max` and Claude Code `deepseek-v4-pro`, Git, and a
supported local Chrome or Chromium executable. If browser discovery cannot find
Chrome automatically, set `MISSIONBRAID_BROWSER_EXECUTABLE` to its absolute
executable path.

```sh
command -v qodercli
qodercli --version
command -v claude
claude --version

MISSIONBRAID_FLAGSHIP_RESULT_ROOT="$(mktemp -d)"
MISSIONBRAID_FLAGSHIP_OUTPUT="$MISSIONBRAID_FLAGSHIP_RESULT_ROOT/v1-flagship.json"
test ! -e "$MISSIONBRAID_FLAGSHIP_OUTPUT"
node scripts/run-v1-flagship-proof.mjs "$MISSIONBRAID_FLAGSHIP_OUTPUT"
```

The runner creates its own disposable Git workspace, Mission state, browser
profile, hidden verifier, controlled Qoder process boundary, and queryable local
HTTP Effect target. It performs a fresh build and exits nonzero as soon as a
required invariant is absent.

A successful run exits `0` and writes the declared v1 flagship schema with all
of these connected observations:

- a real Qoder Attempt reaches the declared controlled failure, a recorded
  planner override selects the Claude stage, and the Handoff acknowledgement is
  persisted before Claude's first observed tool request;
- a real native Claude Write request is modified before dispatch, the Agent's
  apparent completion is rejected by deterministic verification because the
  bound Context is stale, and the other declared criteria pass;
- a local external Effect is accepted once, the controller is killed, and the
  restarted controller reconciles by lookup without a second POST;
- a Composite Checkpoint and Context-only Execution Fork produce a verified
  diagnostic Branch, confirm the declared stale-Context mechanism, and inherit
  the confirmed Effect as no-repeat;
- three fresh upgraded-Claude Profile-Rebound trials are retained, the positive
  standalone Outcome check exits `0`, and the unresolved-Effect negative check
  exits `1`;
- real Qoder and Claude Plan nodes reach a parallel frontier, a prompt-only
  Contract revision fences the stale Claude work, reuses the unaffected verified
  Qoder Artifact, consolidates in a separate Attempt, and closes with a Receipt
  for the latest revisions; and
- restart preserves the Mission head, Receipt, Checkpoint, Fork, Plan, scenario,
  rerun identities, and external Effect call count.

The run is same-host local evidence for one controlled fixture. Its Qoder
termination and failing tool probe are induced observation boundaries, not
natural failures or a reliability benchmark. The initial Claude target comes
from a persisted manual override request. Branch selection later in the script
is fixture-declared `human` authority data submitted by the proof controller;
it is not evidence of a person making a live selection. The record does not
establish provider-internal Context capture, arbitrary Mission coverage,
cross-host operation, independent third-party reproduction, organizational
approval, npm publication, production adoption, or production reliability.

## Iteration 8 live multi-Agent revision

The published result is the
[Iteration 8 machine-readable record](../evidence/iteration-8-multi-agent-revision-local-2026-08-26.json).
The runner requires installed and authenticated `qodercli` and `claude` CLIs
with access to Qoder `Qwen3.8-Max` and Claude Code `deepseek-v4-pro`.

```sh
command -v qodercli
qodercli --version
command -v claude
claude --version

MISSIONBRAID_I8_RESULT_ROOT="$(mktemp -d)"
MISSIONBRAID_I8_OUTPUT="$MISSIONBRAID_I8_RESULT_ROOT/iteration-8-multi-agent-revision.json"
test ! -e "$MISSIONBRAID_I8_OUTPUT"
node scripts/run-i8-multi-agent-revision-proof.mjs "$MISSIONBRAID_I8_OUTPUT"
```

The script builds the current source, prepares a disposable controlled Git
fixture, and runs the Mission through Workbench HTTP APIs. A successful run
exits `0` and records that:

- the explicit Plan was created and started through the product entry;
- Qoder's tool Artifact verified while the original Claude prompt Attempt was
  still active;
- a prompt-only Contract revision invalidated the affected prompt and join
  nodes, fenced the stale Claude Attempt from further Effects, and preserved the
  unaffected Qoder Artifact without rerunning its node;
- a fresh Claude Attempt completed the revised prompt work, a separate
  consolidation Attempt preserved the source histories, all deterministic
  verifiers passed, and the latest Contract and Plan revisions received a
  verified Receipt with no unresolved items; and
- Workbench restart reconstructed the same Mission head, Receipt, Plan
  execution, and valid Kernel event chain.

The Contract change and its timing are controlled by the proof runner. This is
one same-host run with real Qoder and Claude Code processes in a disposable Git
fixture; it is not independent reproduction, distributed or cross-host
coordination, provider-internal state capture, a natural concurrent-edit
incident, production adoption, or general reliability evidence.

## Iteration 9 Outcome regression

The published outputs are the
[Iteration 9 regression record](../evidence/iteration-9-outcome-regression-local-2026-08-26.json)
and its adjacent
[Outcome CI result](../evidence/iteration-9-outcome-ci-result.json). The runner
requires an installed and authenticated `qodercli` with access to
`Qwen3.8-Max`; it uses medium and high reasoning Profiles declared by the
fixture.

```sh
command -v qodercli
qodercli --version

MISSIONBRAID_I9_RESULT_ROOT="$(mktemp -d)"
MISSIONBRAID_I9_OUTPUT="$MISSIONBRAID_I9_RESULT_ROOT/iteration-9-outcome-regression.json"
test ! -e "$MISSIONBRAID_I9_OUTPUT"
test ! -e "$MISSIONBRAID_I9_RESULT_ROOT/iteration-9-outcome-ci-result.json"
node scripts/run-i9-outcome-regression-proof.mjs "$MISSIONBRAID_I9_OUTPUT"
```

Supplying the output path also writes
`iteration-9-outcome-ci-result.json` beside it. A successful run exits `0` and
records that:

- the original real Qoder process reports success but the out-of-process
  deterministic verifier rejects the stale-Context result;
- a Context-only diagnostic Fork under the same Contract verifies, and Outcome
  Studio keeps the original and revised Agent Revisions distinct;
- the incident is saved as an executable scenario before the trials, with a
  predeclared three-trial, 100% threshold;
- three new Kernel-persisted Branch, Attempt, Binding, and Runtime runs use one
  distinct Planner-selected high-reasoning Qoder Profile and all three verify;
- the standalone checker exits `0` for the retained passed result and exits `1`
  for both generated failed and unknown controls; and
- restart preserves the Mission, executable incident, rerun, and CI result.

The script submits a Branch-selection record whose authority field is `human`,
but the proof controller supplies that field; the run does not observe a live
person making the choice. The accepted Context intervention and the Runtime
Profile both differ from the original Attempt, so the result does not establish
Profile-only causality. It is same-host controlled-fixture evidence, not hosted
CI, provider-internal Context capture, independent or cross-host reproduction,
deployment approval, publication authority, production adoption, or general
production reliability.

## Iteration 10 package and external-Adapter smoke

The published result is the
[Iteration 10 package smoke record](https://github.com/Oxygen56/missionbraid/blob/main/evidence/iteration-10-package-smoke-local-2026-08-26.json).
This runner does not require a native Codex, Qoder, or Claude account. It
requires Node.js 24–26, pnpm, npm, Git, `tar`, a supported Chrome or Chromium
executable, and access to the dependencies pinned by the lockfile through the
local package store or network.

```sh
MISSIONBRAID_I10_RESULT_ROOT="$(mktemp -d)"
MISSIONBRAID_I10_OUTPUT="$MISSIONBRAID_I10_RESULT_ROOT/iteration-10-package-smoke.json"
test ! -e "$MISSIONBRAID_I10_OUTPUT"
pnpm test:package -- --output "$MISSIONBRAID_I10_OUTPUT"
```

The smoke runner builds and packs the local source, checks package contents and
local Markdown links, creates two byte-identical source-candidate bundles,
installs the package into a fresh external-consumer directory, and exercises
the installed CLI and Workbench. It removes its temporary working tree unless
`--keep` is explicitly supplied.

A successful run exits `0` and records that:

- the package manifest contract and stable public v1 exports are usable from a
  clean consumer;
- direct, ACP-over-stdio, and process-provider Adapter examples pass the shipped
  conformance suite;
- one consumer-authored external Adapter is discovered and executes verified
  Missions through both the installed CLI and Workbench, including an isolated
  same-Adapter Execution Fork;
- a schema-v1 store migrates to schema v2 without changing the retained Mission
  event chain;
- the extracted source-candidate bundle completes frozen install, typecheck,
  build, and the full test suite without falling back to the repository; and
- the installed daemon serves the Workbench and Mission APIs, then shuts down
  cleanly with its supplied state directory initialized.

This is an internal clean-install artifact run using controlled example and
consumer-style Adapters. ACP conformance is not universal ACP interoperability,
the process-provider example is not Kandev-backed Mission execution, and the
record does not establish npm registry publication, current-revision source
binding, an independent operator or Adapter implementation, cross-host
installation, production adoption, or production readiness.

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
