# MissionBraid Product Roadmap

> **Plan:** ten major product iterations in total. Iterations 1–6 have
> same-host local evidence records; Iteration 5 covers all four Replay
> semantics, while only its Execution Fork path continues a real workspace.
> Iteration 6 has a controlled-interruption adaptive-Handoff record. Iteration
> 7 now has one same-host stale-Context diagnostic record. Iteration 8 has a
> retained same-host, controlled-Git-fixture record with real local
> Qoder/Qwen3.8-Max and Claude Code/deepseek-v4-pro executions through the
> Workbench HTTP flow. The 1.0 source candidate contains implementation surfaces
> for all ten planned iterations. Iteration 9 has retained same-host evidence for
> a real Qoder upgraded-Profile 3/3 regression plus a fail-closed checker running
> from outside the repository. Iteration 10 has an internal clean-install record
> and a lockfile-bearing source bundle that passes frozen install, typecheck,
> build, and full tests. Independent third-party reproduction, cross-host, npm
> publication, and production evidence remain open.
> The number describes dependency-complete product releases, not calendar
> sprints.

MissionBraid's final scope is the full Agent Runtime Workbench described in the
[architecture](architecture.md) and [product requirements](product-requirements.md).
The sequence below does not narrow that scope. It prevents broad capabilities
from becoming disconnected pages backed by the same passive log.

Every iteration strengthens one flagship user journey:

```text
workspace changes while Agent runs → bind effective Revision → record stale
Context evidence → declare a Context refresh → isolated new Attempt on the
same Harness/Profile/Contract/authority → verifier → save regression → Receipt
                                                  ↘ Handoff only when justified
```

The stale-Context path is now proven once at the same-host local level in
[the Iteration 7 record](../evidence/iteration-7-stale-context-2026-08-26.json),
built on the validated Iteration 3 Flight Recorder and Iteration 5 Execution
Fork. The broader Runtime, Handoff, Mission Plan, and CI capabilities remain
part of the final scope and support this daily loop; provider-internal Context
capture, original-session continuation, multi-layer attribution, general
diagnosis accuracy, and production evidence remain open.

## Shared completion rule

An iteration is complete only when:

- the capability is reachable from the normal Workbench or public CLI/API;
- a real native Runtime, controlled tool boundary, or queryable external Effect
  participates where that iteration requires one;
- the user-visible result survives an application restart;
- the new evidence is attached to the existing Mission and every relevant
  domain identity available in that iteration; later identities such as Branch
  cannot be retroactively required of an earlier baseline;
- one successful path and one failure or honest unknown path are retained;
- public documentation distinguishes target design, implementation, real
  execution, independent reproduction, and production use.

Code, tests, schemas, screenshots, event counts, or Adapter counts are necessary
engineering outputs but cannot complete an iteration by themselves.

## Iteration overview

| Iteration                                       | Product result                                                                            | Status                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1. Mission continuity foundation                | One Mission survives process and Harness changes and closes with a Receipt                | Implemented local slice                                      |
| 2. Runtime intelligence and Event IR            | Effective Profiles and native events share one typed Runtime model                        | Validated local slice                                        |
| 3. Live flight recorder and Context Graph       | Developers see context, tools, files, tests, cost, and subagents while work runs          | Validated local slice                                        |
| 4. Tool gateway and live debugger               | A real mutable tool can be stopped before dispatch and changed or rejected                | Validated local slice                                        |
| 5. Composite checkpoints, Fork, and Replay      | A retained execution boundary becomes an isolated executable comparison Branch            | Implemented locally; same-host proof                         |
| 6. Adaptive planning and cross-Harness handoff  | Profiles are selected explainably and Handoff occurs only when a Runtime change is needed | Validated locally; controlled interruption                   |
| 7. Failure intelligence and diagnostic Branches | Evidence and single-variable probes distinguish likely failure layers                     | Same-host stale-Context proof; broader gate open             |
| 8. Multi-agent Mission Graph and live revisions | Parallel Agents stay attached to one changing Mission and stale work is invalidated       | Same-host real-Runtime proof; controlled fixture             |
| 9. Outcome, Eval, and Incident Studio           | Agent Revisions are compared, saved as regressions, and optionally exported to CI         | Real Qoder upgraded-Profile 3/3; outside-repo checker        |
| 10. Open Runtime Workbench 1.0                  | External developers install, extend, and reproduce the complete workflow                  | Internal clean-install/source bundle; independent proof open |

## Iteration 1 — Mission continuity foundation

### User-visible result

A developer submits a Mission once, runs real Codex and Qoder Attempts in one
workspace, sees the Capsule and Receipt, restarts the Workbench, and recovers
the same result without restating the task.

### Included

- Mission Kernel and immutable Outcome Contract;
- append-only event state, leases, and fencing;
- local Workbench and CLI;
- direct Codex and Qoder process adapters;
- workspace baseline and checkpoint evidence;
- bounded Handoff Capsule and target acknowledgement;
- advisory workspace Effect identities;
- controller-run out-of-process command verifier and Outcome Receipt.

### Completion evidence

The controlled E0, E1, and unified Workbench records in the
[evidence index](../evidence/README.md) satisfy this local baseline. They remain
same-host pre-alpha evidence.

### Not established

Live Agent debugging, tool-level interception, executable Fork/Replay,
automatic routing, broad Harness support, or production readiness.

## Iteration 2 — Runtime intelligence and unified Event IR

### User-visible result

The Runtime Hub shows what each available Agent environment actually contains,
and a third native Harness can execute a Mission while producing the same core
event semantics as Codex and Qoder.

### Included

- Runtime inventory observations separated from Profile definitions and
  immutable Attempt snapshots;
- a default root Branch identity for every new Mission, with append-only history
  but no Fork UI or executable branch semantics yet;
- effective model, reasoning, instructions, Skills, MCP/tools, permissions,
  context, version, session, availability, quota, and cost fields when exposed;
- Adapter capability declarations for observe, interrupt, steer, gate, resume,
  fork, workspace restore, and effect control;
- three-layer event model: authoritative domain events, normalized semantic
  Runtime events, and sanitized native-format artifacts;
- third real execution Adapter chosen to add a new protocol or control boundary;
- durable command/outbox path so restart does not lose accepted execution
  intent.

### Completion evidence

The repository now contains the Iteration 2 implementation:

- direct Codex, Qoder, and Claude Code execution Adapters with explicit
  capability declarations;
- OpenCode, Hermes, and DeepSeek Harness catalog entries without executable
  Mission Adapters;
- a default root Branch for every new Mission;
- separate Runtime Profile Definitions, timestamped Catalog Observations,
  immutable effective Snapshots, and Attempt Bindings;
- source-scoped normalized Runtime events linked to sanitized,
  content-addressed native-format artifacts;
- a durable command/outbox supervisor path that can recover accepted work after
  an application restart;
- a bilingual Workbench with a browser-persisted English/Chinese selection.

The [retained same-host record](../evidence/iteration-2-three-harness-local-2026-08-25.json)
binds a clean revision to successful real Codex, Qoder, and Claude Code
Attempts, 1,066 source-scoped Runtime events and sanitized native artifacts, a
verified Receipt, and stable restart restoration. Both Handoff acknowledgements
precede their target's first observed tool-request event in the corresponding
native source stream. This is cooperative ordering evidence, not a live tool
gate.

At the source-and-test layer, the Claude direct Adapter preserves
non-telemetry event semantics and order while compacting only
`system/thinking_tokens` telemetry. It records the compaction strategy, total
raw/retained/dropped line counts, and a SHA-256 of the full raw stream; dropped
telemetry payloads are not retained. This is not a retained real-Claude
performance benchmark or a claim of private-thinking capture or provider token
accuracy.

Iteration 2 is therefore complete at the same-host local evidence level. It
does not establish automatic routing, executable Fork/Replay, live tool gating,
cross-host reproduction, or production readiness; those boundaries remain in
later iterations.

### Done when

- the Workbench launches the exact Profile it displays or reports the native
  override;
- Codex, Qoder, and the third Harness complete real Attempts with source-linked
  normalized events;
- source sequence, Mission ingest sequence, and causal parents remain stable
  after restart without inventing a native global order;
- unsupported fields remain unknown and native-only semantics remain
  inspectable;
- the same Mission still reaches a Receipt after restart.

### Not done when

Only another CLI card, discovery probe, mock Adapter, or hard-coded event-name
translation exists.

## Iteration 3 — Live flight recorder and Context Graph

### User-visible result

While an Agent is still working, the developer can see its current Runtime,
turns, observable context, model requests, tool calls, file changes, tests,
subagents, usage, and failures in one live timeline.

### Included

- real-time event transport from the durable event journal;
- Context Graph with instruction, Skill, MCP/tool schema, message, tool result,
  file reference, memory, and compaction provenance;
- context diffs between adjacent model calls;
- tool-to-file-to-test causal correlation;
- subagent lineage and concurrent activity;
- local redaction and raw-artifact inspection;
- observed event-to-UI latency baseline and calibrated release target.

### Done when

- at least two different native protocol paths update before their runs finish;
- the developer can trace a real failed tool or test back to the visible model
  input and source event;
- restart preserves the recorded ingest order, source-order metadata, causal
  links, correlations, and redaction without inventing a native global order;
- unavailable hidden or signed provider state is shown as unavailable.

### Not done when

The feature is a streamed stdout panel, a completed-session animation, or a
timeline whose entries cannot be tied back to native evidence.

### Completion evidence

The [retained Iteration 3 record](../evidence/iteration-3-flight-recorder-local-2026-08-26.json)
captures live Codex and Claude Code protocol paths in the normal Workbench,
failed-test causality, local redaction, latency, and restart-stable evidence.

## Iteration 4 — Tool gateway and live debugger

### User-visible result

A real mutable tool request hits a breakpoint before dispatch. The developer can
inspect it, change supported inputs or context, approve, reject, resume, or
terminate the run.

### Included

- Tool Gateway, MCP proxy, native hook, or equivalent owned interception path;
- structural, behavioral, and advisory semantic breakpoint rules;
- pause state and guarantees for parent process, child processes, in-flight
  requests, and pending tools;
- live context injection and permission narrowing where the Runtime supports it;
- tool-level Effect identity and permission decision events;
- Effect scope for branch-local workspace, shared resource, and mission-global
  external actions, with enforced, guarded, advisory, or unknown control;
- explicit enforced, cooperative, interrupt-only, and observe-only capability
  labels.

### Done when

- a real file, shell, MCP, or other mutable operation is blocked before it
  occurs;
- the Workbench proves the original side effect is still absent;
- an approved or modified operation executes and the same Mission continues;
- a queryable external Effect is allowed to dispatch and the controller crashes
  before its result is durably known; after restart MissionBraid reconciles the
  target before any retry and the Effect occurs only once;
- a non-interceptable Adapter displays its weaker guarantee rather than
  simulating a strong breakpoint.

### Not done when

The system alerts after execution, pauses only a UI animation, uses only a mock
tool, or shows an approval dialog that is not on the execution path.

### Completion evidence

The [native Tool Gateway record](../evidence/iteration-4-tool-gateway-local-2026-08-26.json)
and [external Effect recovery record](../evidence/iteration-4-external-effect-local-2026-08-26.json)
capture the two required real paths: a Claude Code `PreToolUse` Write is changed
in the browser before dispatch, and a queryable HTTP Effect is reconciled after
controller `SIGKILL` without a second dispatch. Both remain same-host local
evidence, not production or independent reproduction.

## Iteration 5 — Composite checkpoints, Fork, and Replay

### User-visible result

The developer opens a retained execution boundary, changes one observable
Agent behavior input, and creates an isolated Branch that really continues
while the original Branch remains unchanged. A failure is one useful source of
such a boundary, not a prerequisite for Branching.

### Included

- safe-point Checkpoint manifest over event head, Contract revision, Profile,
  visible context, workspace, permissions, Effect frontier, process status, and
  native session reference;
- per-component portability and recovery classification;
- immutable Branch lineage and isolated worktrees;
- declared Interventions over context, tool result, permission, model/Profile,
  workspace, or new guidance;
- four explicit modes: playback, cached replay, counterfactual resample, and
  execution fork;
- external Effect inheritance, reconciliation, and compensation semantics;
- Branch timeline and initial comparison view.

### Done when

- Branch A preserves the original behavior and evidence boundary;
- Branch B changes one declared variable and performs real subsequent tool
  work;
- both have independent future events, workspace-local Effects, and Receipts,
  while each references the inherited external Effect frontier;
- a descendant Branch cannot blindly repeat the confirmed external Effect from
  Iteration 4 and records reconciliation or explicit compensation;
- an application restart can continue inspecting and operating both Branches;
- replay refuses or blocks when unresolved external state makes continuation
  unsafe or unknowable.

### Not done when

The implementation copies trace rows, performs a Git reset without context and
Effect state, replays an animation, or reruns the task from the beginning while
calling it continuation.

### Completion evidence

The retained
[Iteration 5 record](../evidence/iteration-5-execution-fork-local-2026-08-26.json)
validates the same-host local Execution Fork slice through the real Workbench:

- a real Codex parent Attempt produced a one-file delta and passed its
  deterministic verifier;
- because the Codex workspace sandbox could not write Git metadata, the local
  proof controller inspected exactly that delta and then sealed it as the
  parent Git commit;
- the browser created a Git-backed Composite Checkpoint and submitted one
  declared guidance Intervention;
- a fresh real Codex process continued only in Branch B's isolated Git
  worktree, while Branch A stayed unchanged; both parent and child Receipts are
  retained;
- one confirmed queryable external Effect was inherited as
  `inherit-no-repeat`, with no added target call during Fork or restart;
- the Workbench reconstructed the Branches, Checkpoint, Fork, Effect state, and
  child Receipt after restart.

The UI names all four operation modes honestly. Playback, cached replay, and
counterfactual resampling are implemented with distinct side-effect contracts;
only Execution Fork is a real workspace continuation in this record. Playback
rebuilds a view without writing a Branch, cached replay consumes persisted future
Artifacts without starting a Runtime, and counterfactual resampling starts a
real model-only process with tools disabled and leaves the outcome unknown. The
record is not a native Codex session fork or resume, does not claim Codex
authored the parent commit, and is not cross-host, independent reproduction, or
production evidence.

## Iteration 6 — Adaptive planning and cross-Harness handoff

### User-visible result

The current Runtime remains the default. When it becomes unavailable, lacks a
required capability, no longer fits the Mission, or the developer deliberately
chooses another Runtime, MissionBraid selects or validates an eligible Profile,
explains the decision, compiles a compatibility report and Handoff Capsule, and
continues without manual context copying.

### Included

- explicit Mission capability requirements;
- planner flow: extract, filter, rank, bind, observe, and adapt;
- source and freshness for availability, quota, cost, and historical outcomes;
- recorded rejection reasons, rank inputs, policy version, and manual override;
- frozen requirements, Catalog observations, candidate set, rank vector, and
  decision hash; equal inputs and policy produce the same binding decision;
- Handoff Capsule generated from the composite Checkpoint;
- exact, emulated, summarized, rebound, unavailable, and blocking target-state
  classifications;
- target acknowledgement and first-action validation;
- direct, ACP, or execution-provider binding according to Adapter fidelity.

### Done when

- a real Runtime or Profile becomes unavailable or demonstrably ineligible
  after meaningful work;
- the user does not choose the replacement or copy context;
- MissionBraid records why Profiles were filtered and ranked;
- another native Harness continues from the same Mission frontier and the
  immutable Contract revision bound to that Branch reaches a Receipt;
- confirmed or ambiguous Effects are not blindly repeated.

### Not done when

The route is a fixed Codex-to-Qoder script, health and quota are mocked, a model
only recommends a Runtime in prose, or the target starts a fresh unrelated
task.

### Current implementation evidence

The [controlled adaptive-Handoff record](../evidence/iteration-6-adaptive-handoff-local-2026-08-26.json)
proves the deterministic filter/rank/bind path in the local Workbench: a Codex
provider interruption is injected after a known delta, the planner selects a
fresh eligible Profile, the target acknowledges the Capsule before its first
tool request, and the same Mission reaches a Receipt after restart. It is not a
natural model, quota, network, or Harness failure; it does not prove native
session migration, a restorable target workspace, cross-host continuity, or
production recovery.

## Iteration 7 — Failure intelligence and diagnostic Branches

### User-visible result

The developer sees which layer most likely caused a failure, which evidence
supports that conclusion, what remains unknown, and can launch a bounded
diagnostic Branch that changes one factor.

### Included

- Failure Evidence Graph across model, context, tool, Harness, environment, and
  MissionBraid;
- deterministic anomaly detectors for loops, repeated failures, stale context,
  permission conflicts, tool errors, workspace divergence, and verification
  failure;
- declared Context-source fingerprints and cached/bound versus current
  freshness evidence;
- observed, inferred, confirmed, and unknown conclusion states;
- candidate ordering and counter-evidence;
- discriminating probes implemented as diagnostic Branches;
- model-assisted evidence summaries that preserve source links.

### Done when

- real failures from multiple layers produce different evidence paths;
- at least one single-variable probe changes the evidence enough to confirm a
  mechanism;
- at least one case honestly remains unknown;
- removing decisive evidence downgrades the conclusion;
- the recommended next action maps to the implicated layer.

### Not done when

The result is a model-written root-cause paragraph, keyword label, attractive
causal graph, or fixture-only classifier with no real Runtime evidence.

### Current implementation evidence

The repository contains a persisted-event Failure Evidence Graph, explicit
observed/inferred/confirmed/unknown conclusions, counter-evidence, and a
single-variable diagnostic-Fork request exposed through the Workbench API and
UI. Local tests cover chain and Branch scoping, missing evidence, and request
persistence. The linked record proves one stale-Context path; broader
multi-layer Runtime coverage and diagnosis measurement are still required for
the full iteration gate.

The [Iteration 7 stale-Context record](../evidence/iteration-7-stale-context-2026-08-26.json)
proves one controlled real-Runtime case: stale cached Context caused verifier
rejection; the Workbench then created an isolated child Branch and new Qoder
Attempt/process with the same Harness/Profile, Contract, and authority plus a
declared Context refresh intervention. The verifier passed and the saved
regression scenario remained stable after restart. This is not continuation of
the original native Session, and the structured invariants do not prove every
hidden or unobserved input was identical. The refresh applies only to this
diagnostic Attempt and is not yet portable or persisted for later Attempts.
Only this stale-Context mechanism is confirmed; broader multi-layer coverage
and honest diagnosis-accuracy measurement remain open.

## Iteration 8 — Multi-agent Mission Graph and live revisions

### User-visible result

Several Agents can own distinct Mission Plan nodes or diagnostic Branches, and a
user requirement change stops stale work, preserves unaffected results, and
replans only the invalidated frontier.

### Included

- versioned Mission Plan DAG with task, review, diagnostic, branch, and join
  nodes;
- explicit subagent and parallel Attempt lineage;
- isolated writable workspaces and declared shared-resource coordination;
- Contract revisions and requirement-to-plan/artifact provenance;
- impact analysis and selective invalidation;
- stopping or fencing Agents still executing an obsolete revision;
- joins implemented as new consolidation Attempts over provenance-bound
  artifacts or Checkpoints; Branch history never merges in place;
- workspace integration recorded as a new Effect with conflicts, selected
  inputs, and verifier evidence;
- authority expansion only through an explicit authorized Grant or Contract
  revision, never through inheritance or Agent request;
- plan and consolidation decisions tied to verifier evidence.

### Done when

- at least two real Agents execute distinct plan nodes or Branches;
- a meaningful requirement changes during execution;
- stale work stops, unaffected work remains reusable, and only impacted work is
  replanned;
- a join produces a new consolidation Attempt without rewriting either input
  Branch, and its workspace integration remains auditable;
- every active Agent shows the Contract and plan revision it is following;
- the revised Mission reaches its revised Outcome Contract.

### Not done when

The product merely starts Agents in parallel, appends a new chat message, or
restarts the complete Mission after every requirement change.

### Current implementation evidence

The local API and Workbench can now start an explicit Mission Plan and submit a
Contract revision while it runs. The Engine executes independent ready nodes
concurrently in isolated Git worktrees; every Attempt carries its Contract
revision, Plan revision, node version, Branch, and workspace binding. Only
deterministically verified node Artifacts advance the frontier. A revision
fences affected active work, keeps the unaffected verified result reusable,
re-executes only the invalidated frontier, and creates a separate consolidation
Attempt whose selected source commits are checked for immutability. The verified
Receipt binds the latest Contract and Plan revisions.

A controlled [integration test](../src/mission-plan-execution.test.ts) exercises
that complete sequence through the same Adapter and child-process boundary used
by native Runtimes, using deterministic CLI fixtures rather than authenticated
provider executions. Projection tests
also cover revision filtering, stale history, empty or mismatched verifier
evidence, ready/running/succeeded/failed/blocked/unknown states, and join
readiness.

The retained [Iteration 8 multi-Agent revision record](../evidence/iteration-8-multi-agent-revision-local-2026-08-26.json)
adds a same-host controlled Git fixture with real local Qoder/Qwen3.8-Max and
Claude Code/deepseek-v4-pro. Through Workbench HTTP it creates and starts the
Mission, revises the Contract while work is active, queries the result, and
completes it. The changed node is interrupted and rerun, the unaffected
verifier-backed Artifact is reused without rerunning Qoder, an independent
consolidation Attempt consumes the selected Artifacts, the Receipt binds the
latest Contract and Plan revisions, and restart reconstructs the same result.
This record does not establish production use, cross-host or distributed
execution, independent external reproduction, provider-internal state, or
natural-failure behavior.

## Iteration 9 — Outcome, Eval, and Incident Studio

### User-visible result

The developer compares Agent Revisions and Branches against one Contract,
selects a verified result, and saves useful behavior or a resolved failure as a
repeatable regression scenario. The result can be exported to CI without
turning MissionBraid into a deployment or approval platform.

### Included

- Branch comparison across events, context, tools, files, tests, usage, cost,
  latency, Effects, failures, and criteria;
- extensible criterion runners and evaluator registry;
- strict separation of agent-reported, verified, and accepted completion;
- incident scenario packaging with redacted Checkpoint, Intervention, Profile,
  and expected evidence;
- content-addressed Agent Revision views over model, Prompt, Skill, MCP/tool,
  context/memory, orchestration, permission, Harness, Adapter, and environment
  evidence;
- model, Prompt, Skill, MCP, tool, memory, and Harness regression matrices;
- deterministic-control and stochastic-model result separation;
- repeated trials and predeclared thresholds for stochastic behavior;
- versioned Outcome Receipt, scenario export, and a machine-readable CI result.

### Done when

- an original and revised real Branch are compared under the same Contract and
  exact controlling evaluation artifacts;
- a false Agent success cannot issue a verified Receipt;
- the selected Branch has criterion-level evidence and unresolved items remain
  visible;
- the incident can be rerun against an upgraded Runtime Profile and identifies
  whether the behavior or failure returned;
- an external CI runner can enforce the retained result without MissionBraid
  owning deployment, organizational approval, or artifact publication.

### Not done when

A model-as-judge alone selects the winner, public tests are the only verifier,
one aggregate score hides criterion, Effect, and uncertainty differences, or
the iteration expands into a generic release-governance platform.

### Current implementation evidence

Outcome Studio reconstructs content-addressed Agent Revisions, evaluation
Suites, Branch comparisons, Incident Scenarios, Studio Receipts, and
machine-readable CI results from persisted Mission facts. The Workbench can
save, list, and export redacted scenarios idempotently. The [retained Iteration
9 record](../evidence/iteration-9-outcome-regression-local-2026-08-26.json)
starts with one Agent-reported false success rejected by the deterministic
Suite, selects a revised verified Branch separately, then executes the saved
incident with the accepted Context intervention on one distinct
Planner-selected upgraded Qoder/Qwen3.8-Max Profile. Three new
Kernel-persisted Runtime trials pass the predeclared 3/3
threshold, and the Mission, scenario, rerun, and CI-result projection remain
stable after restart. A standalone checker copied outside the repository
accepts that retained result and exits nonzero for returned or unknown results.
This is not a hosted CI pipeline, third-party reproduction, cross-host proof,
deployment approval, publication authority, or production evidence, and it
does not isolate the Profile as the cause of success.

## Iteration 10 — Open Runtime Workbench 1.0

### User-visible result

An external developer installs MissionBraid from a clean environment, connects
or implements an Adapter, and independently reproduces the complete Runtime
Workbench evidence matrix.

### Included

- packaged local daemon, Workbench, CLI, and migration path;
- typed Adapter SDK and capability conformance suite;
- versioned local API and redacted incident/evidence export;
- a complete execution-provider path, with Kandev as a preferred candidate
  when its public lifecycle can satisfy the contract;
- documentation and examples for direct, ACP, and provider-backed adapters;
- at least one externally implemented or independently maintained Adapter;
- one evolving flagship Agent-development Mission and its Revisions covering
  live observation, pre-tool control, executable Fork, conditional deterministic
  replan/Handoff, failure attribution, Effect reconciliation, multi-Agent
  requirement revision, regression rerun, and verification;
- release notes whose capability claims point to reproducible evidence.

### Done when

- an independent external operator installs the release without
  repository-specific manual storage edits;
- that operator reproduces the full flagship evidence matrix: observe, break,
  Fork, deterministic replan/Handoff, attributed and unknown failures, external
  Effect reconciliation, Mission revision with multi-Agent invalidation,
  incident regression, and Branch-bound verification;
- a new Adapter does not require edits to Mission, Branch, Effect, failure, or
  Receipt state machines;
- public evidence states every remaining environment and production boundary.

### Not done when

Only an internal clean-host run, package, release tag, Docker build, SDK type
definition, compatibility probe, documentation page, or GitHub popularity
signal exists. Internal cross-host evidence is useful but is not independent
external reproduction.

### Current implementation evidence

The [package smoke record](https://github.com/Oxygen56/missionbraid/blob/main/evidence/iteration-10-package-smoke-local-2026-08-26.json)
shows an internal clean install of the local tarball and public exports. A
consumer-style external direct Adapter passes conformance and retains its real
Adapter/Harness/Profile/Attempt/Binding/Receipt identity chain through installed
CLI and Workbench Missions plus a same-Adapter isolated Execution Fork. The
installed Workbench also migrates a schema-v1 store to v2 without changing the
retained Mission event chain. Separately, the smoke builds a source-candidate
bundle containing the exact lockfile and verifies, from the extracted bundle
without repository fallback, frozen install, typecheck, build, and the full
test suite. npm publication, an independently maintained Adapter, independent
external reproduction, cross-host proof, and production adoption remain open.

## Why this order

The dependency chain is intentional:

```text
Runtime semantics
→ live evidence
→ real control
→ executable state branches
→ adaptive Runtime execution and conditional Handoff
→ credible attribution
→ multi-agent goal evolution
→ evaluation and regression
→ open platform
```

The planner is not built immediately because choosing between shallow,
hard-coded Profiles would demonstrate a scheduler rather than Agent Runtime
understanding. The product first learns what each Runtime can actually expose
and control.

CI export is delayed until the Workbench can bind an effective Agent Revision,
real execution evidence, separately versioned outcome criteria, and stochastic trial
semantics. This keeps CI as an output of Agent development rather than a second
product center.

## Existing evidence gates

The original evidence names remain useful historical boundaries:

- **E0:** one Mission survives a process interruption;
- **E1:** one Mission survives a Codex-to-Qoder Runtime boundary;
- **E2:** evidence for safe replan, executable Fork/Replay, and visible state
  semantics.

E0 and E1 are locally satisfied by the retained evidence records. Iteration 5
locally satisfies E2's visible-state, Replay-semantics, and executable
Execution Fork slices; Iteration 6 adds a controlled adaptive-Handoff slice.
E2 as an umbrella remains incomplete for natural failure recovery, native
session/workspace migration, cross-host continuity, and independent or
production proof. Later iterations add new product gates rather than
retroactively upgrading the meaning of E0 or E1.

## Release and claim policy

- A capability is documented as target, implemented, real-runtime validated,
  independently reproduced, or production adopted.
- Tagged releases name only capabilities with evidence at the stated level.
- Release evidence may be exported to CI, but MissionBraid 1.0 does not own
  deployment, organizational approval, artifact signing, or general CD.
- A new Adapter must add a real protocol, control, or user capability; another
  inventory card alone is not a milestone.
- The same flagship Mission evolves across iterations so the final product is a
  coherent workflow rather than a portfolio of unrelated demos.
