# MissionBraid Product Roadmap

> **Plan:** ten major product iterations in total. Iteration 1 is the verified
> local foundation. Iteration 2 is implemented and validated by an integrated
> same-host real three-Harness Workbench record. Iterations 3–10 remain planned.
> The number describes dependency-complete product releases, not calendar
> sprints.

MissionBraid's final scope is the full Agent Runtime Workbench described in the
[architecture](architecture.md) and [product requirements](product-requirements.md).
The sequence below does not narrow that scope. It prevents broad capabilities
from becoming disconnected pages backed by the same passive log.

Every iteration strengthens one flagship user journey:

```text
Mission → native Runtime → live evidence → intervention
→ executable Branch → cross-Harness continuation → verified outcome
```

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

| Iteration                                       | Product result                                                                           | Status                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------- |
| 1. Mission continuity foundation                | One Mission survives process and Harness changes and closes with a Receipt               | Implemented local slice |
| 2. Runtime intelligence and Event IR            | Effective Profiles and native events share one typed Runtime model                       | Validated local slice   |
| 3. Live flight recorder and Context Graph       | Developers see context, tools, files, tests, cost, and subagents while work runs         | Planned                 |
| 4. Tool gateway and live debugger               | A real mutable tool can be stopped before dispatch and changed or rejected               | Planned                 |
| 5. Composite checkpoints, Fork, and Replay      | A failure scene becomes an isolated executable alternative Branch                        | Planned                 |
| 6. Adaptive planning and cross-Harness handoff  | A failed Runtime is replaced without manual Profile choice or context copying            | Planned                 |
| 7. Failure intelligence and diagnostic Branches | Evidence and single-variable probes distinguish likely failure layers                    | Planned                 |
| 8. Multi-agent Mission Graph and live revisions | Parallel Agents stay attached to one changing Mission and stale work is invalidated      | Planned                 |
| 9. Outcome, Eval, and Incident Studio           | Branches and Runtime versions are compared against one Contract and saved as regressions | Planned                 |
| 10. Open Runtime Workbench 1.0                  | External developers install, extend, and reproduce the complete workflow                 | Planned                 |

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
- independent command verifier and Outcome Receipt.

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

## Iteration 5 — Composite checkpoints, Fork, and Replay

### User-visible result

The developer opens a historical failure scene, changes one observable
condition, and creates an isolated Branch that really continues while the
original Branch remains unchanged.

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

- Branch A preserves or reproduces the original failure;
- Branch B changes one declared variable and performs real subsequent tool work;
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

## Iteration 6 — Adaptive planning and cross-Harness handoff

### User-visible result

When the current Runtime becomes unavailable or no longer fits the Mission,
MissionBraid selects an eligible Profile, explains the decision, compiles a
compatibility report and Handoff Capsule, and continues without manual context
copying.

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

- a real Runtime or Profile becomes unavailable after meaningful work;
- the user does not choose the replacement or copy context;
- MissionBraid records why Profiles were filtered and ranked;
- another native Harness continues from the same Mission frontier and the
  immutable Contract revision bound to that Branch reaches a Receipt;
- confirmed or ambiguous Effects are not blindly repeated.

### Not done when

The route is a fixed Codex-to-Qoder script, health and quota are mocked, a model
only recommends a Runtime in prose, or the target starts a fresh unrelated
task.

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

## Iteration 9 — Outcome, Eval, and Incident Studio

### User-visible result

The developer compares Branches and Runtime versions against one Contract,
promotes a verified result, and saves the resolved failure as a repeatable
regression scenario.

### Included

- Branch comparison across events, context, tools, files, tests, usage, cost,
  latency, Effects, failures, and criteria;
- extensible criterion runners and evaluator registry;
- strict separation of agent-reported, verified, and accepted completion;
- incident scenario packaging with redacted Checkpoint, Intervention, Profile,
  and expected evidence;
- model, Prompt, Skill, MCP, tool, and Harness regression matrices;
- deterministic-control and stochastic-model result separation;
- versioned Outcome Receipt and scenario export.

### Done when

- a failed and a repaired real Branch are compared under the same Contract;
- a false Agent success cannot issue a verified Receipt;
- the selected Branch has criterion-level evidence and unresolved items remain
  visible;
- the incident can be rerun against an upgraded Runtime Profile and identifies
  whether the failure returned.

### Not done when

A model-as-judge alone selects the winner, public tests are the only verifier,
or one aggregate score hides criterion, Effect, and uncertainty differences.

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
- one evolving flagship Mission and its incident revisions covering live
  observation, pre-tool control, executable Fork, deterministic replan and
  Handoff, failure attribution, Effect reconciliation, multi-Agent requirement
  revision, regression rerun, and verification;
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

## Why this order

The dependency chain is intentional:

```text
Runtime semantics
→ live evidence
→ real control
→ executable state branches
→ adaptive cross-Harness execution
→ credible attribution
→ multi-agent goal evolution
→ evaluation and regression
→ open platform
```

The planner is not built immediately because choosing between shallow,
hard-coded Profiles would demonstrate a scheduler rather than Agent Runtime
understanding. The product first learns what each Runtime can actually expose
and control.

## Existing evidence gates

The original evidence names remain useful historical boundaries:

- **E0:** one Mission survives a process interruption;
- **E1:** one Mission survives a Codex-to-Qoder Runtime boundary;
- **E2:** future evidence for safe replan, executable Fork/Replay, and visible
  state semantics.

E0 and E1 are locally satisfied by the retained evidence records. E2 is not.
Later iterations add new product gates rather than retroactively upgrading the
meaning of E0 or E1.

## Release and claim policy

- A capability is documented as target, implemented, real-runtime validated,
  independently reproduced, or production adopted.
- Tagged releases name only capabilities with evidence at the stated level.
- A new Adapter must add a real protocol, control, or user capability; another
  inventory card alone is not a milestone.
- The same flagship Mission evolves across iterations so the final product is a
  coherent workflow rather than a portfolio of unrelated demos.
