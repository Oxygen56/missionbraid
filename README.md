# MissionBraid

**English** | [简体中文](README.zh-CN.md)

**One Mission. Native Runtimes. Inspectable Agent behavior.**

MissionBraid is a local-first **Agent Runtime Workbench** for developers who
build and improve applications with native coding agents. It gives Codex,
Qoder, Claude Code, OpenCode, Hermes, and future Harnesses one durable Mission
and one development loop:

```text
compose → run → inspect → revise → re-run → evaluate → verify
                         ↘ checkpoint / fork / handoff when needed
```

The normal path keeps using the same Harness. Branching, Handoff, adaptive
routing, and CI export are supporting capabilities used when the task actually
needs them.

> **Status:** pre-alpha, local-first, and run from source. Iterations 1–5 have
> same-host local evidence records; Iteration 6 has a controlled-interruption
> adaptive Handoff record; Iteration 7 has a same-host controlled-fixture record
> in which real Qoder with Qwen3.8-Max fails with stale Context, then a fresh
> Attempt under the same Runtime Profile succeeds with refreshed Context. The
> current Workbench runs real Codex, Qoder, and
> Claude Code Attempts; streams a live Context Graph; controls one real Claude
> Code pre-tool boundary; reconciles one queryable external Effect after a
> controller crash; creates a Git-backed Composite Checkpoint and isolated
> child Branch; supports playback, cached replay, and model-only
> counterfactual resampling with their distinct evidence semantics; and can
> select a replacement Runtime through a deterministic planner. Iteration 8 now
> has a same-host controlled-Git-fixture record: the Workbench HTTP API creates,
> starts, revises, observes, and completes one Mission Plan using real local
> Qoder/Qwen3.8-Max and Claude Code/deepseek-v4-pro processes, selective
> invalidation and reuse, a new consolidation Attempt, a latest-revision
> Receipt, and restart reconstruction. Iteration 9 remains a local product
> slice. Iteration 10 has an internal clean-install record in which a
> consumer-authored external Harness appears in the Runtime Hub, starts a
> verified Mission from the Workbench form, and executes the same Adapter in
> an isolated Execution Fork. Package-registry publication, an independent
> external reproduction, and production evidence remain open.

![MissionBraid local Workbench overview](docs/assets/missionbraid-workbench-overview.png)

[Open the current verified timeline and Receipt](docs/assets/missionbraid-workbench-verified.png).

## The product in one view

|                   | MissionBraid                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User problem      | Changing a model, Prompt, Skill, tool, memory policy, permission, or Runtime can change Agent behavior, but source diffs and fragmented logs do not explain the effective Agent that actually ran.                                                                                                                                                                                                                                            |
| Product           | One Workbench to bind the effective Agent Revision, run a durable Mission, inspect context and tools live, revise supported inputs, re-run from a useful boundary, compare behavior, and verify the outcome.                                                                                                                                                                                                                                  |
| Core abstraction  | A **Mission** owns intent, execution branches, evidence, effects, and completion. A Harness is a replaceable Runtime.                                                                                                                                                                                                                                                                                                                         |
| Implemented today | I1–I8 provide the bilingual Workbench, Mission Kernel, native and public external Adapters, Runtime Profiles, live Event IR/Context Graph, tool and Effect controls, Checkpoint/Replay/Fork, adaptive Handoff, stale-Context diagnosis, Mission Plan coordination, verifier, and Outcome Receipts. I10 adds a clean-install public Adapter path with a real Harness identity, Workbench route, CLI execution, and same-Adapter isolated Fork. |
| Delivery plan     | **10 major product iterations in total. I8 has a bounded real local Qoder/Claude workflow. I9 is a local implementation slice. I10 has an internal installed-product workflow, but npm publication, independent external reproduction, cross-host evidence, and production claims remain open.**                                                                                                                                              |

## Why this exists

The hard part of Agent application development is not launching another
process. It is preserving and understanding the effective Agent and its real
execution:

- which effective model, instructions, Skills, MCP servers, permissions, and
  tools were active;
- which observable context the Harness exposed before it acted;
- which behavior changed after a Prompt, Skill, tool, memory, model, or Runtime
  revision;
- which tool call or context change caused a failure when one occurs;
- how to retry from a useful boundary without rerunning everything;
- how to continue in another Harness without manually reconstructing the task
  when a Runtime change is justified;
- which external effects already happened and must not be repeated;
- whether the Branch-bound result was actually achieved.

MissionBraid makes this state explicit and keeps it above any vendor session.

> **The Mission outlives every Runtime, session, and execution branch.**

## Target user story

An Agent developer changes a Prompt, Skill, MCP tool, model, context/memory
policy, permission, or orchestration rule in a repository. MissionBraid binds
the effective Agent Revision—not just a source commit or “Codex”/“Qoder”, but
the actual Harness, model, reasoning mode, instructions, Skills, MCP servers,
tools, permissions, policies, environment, and available resource signals—to a
Mission with an objective, constraints, and Outcome Contract.

The developer starts the Mission. The selected native Harness still performs
the work, while MissionBraid records a unified live trace of model turns,
context assembly, tool calls, workspace mutations, and lifecycle events.

The developer can inspect normal behavior without waiting for a failure. When a
Revision behaves unexpectedly, a criterion fails, or a breakpoint fires, they
can inspect the exact observable context and state before the next controlled
action. They can revise a Prompt, Skill, context item, tool result, memory
policy, model, or supported orchestration input; narrow authority; then resume
or create an isolated execution branch from a composite checkpoint.

The same Harness continues by default. MissionBraid uses a Handoff Capsule only
when another Runtime is required or deliberately selected. It compares Agent
Revisions and Branches, explains failure candidates without inventing hidden
reasoning, runs the verifier bound to the selected Branch's immutable Contract
revision, issues an Outcome Receipt, and can save the case as a regression
scenario for later local or CI execution.

### Current flagship workflow: stale Context

The first real vertical proof focuses on a routine Agent-development problem:
the workspace changes while an Agent receives an old cached Context. In the
controlled fixture, an initial real Qoder/Qwen3.8-Max Attempt follows that
stale Context and the bound deterministic Verifier rejects its result. The
developer then sees the Context/workspace freshness evidence and creates an
isolated child Branch whose Intervention declares Context refresh as the product
variable while retaining the Contract, Runtime Profile, and authority. A fresh
Qoder process and Attempt run under the same Runtime Profile, receive the
refreshed Context, and pass the Verifier; the case is then saved as a regression
scenario. This is an Execution Fork, not continuation of the original Qoder
Session. The refresh applies only to that diagnostic Attempt and is not a
portable, persistent Context cache. The [same-host proof is recorded in the
evidence index](evidence/iteration-7-stale-context-2026-08-26.json); it proves
this one stale-Context mechanism, not provider-internal Context capture,
multi-layer attribution accuracy or recall, cross-host continuity, or
production recovery.

## Product architecture

```mermaid
flowchart TB
  U[Agent Developer] --> W[Runtime Workbench]

  subgraph C[Mission Control Plane]
    K[Mission Kernel]
    P[Planner]
    C2[Run Coordinator]
    D[Debug Orchestrator]
    B[Branch and Handoff Manager]
    V[Outcome Controller]
  end

  subgraph E[State and Evidence Plane]
    O[Durable Outbox]
    IR[Sanitized Native and Normalized Events]
    CG[Context Graph]
    CP[Composite Checkpoints]
    FX[Tool and Effect Ledger]
    RC[Outcome Receipts]
  end

  subgraph R[Runtime Data Plane]
    A[Capability-aware Adapters]
    T[Tool Gateway and Hooks]
    X[Workspace and Process Manager]
    EP[Execution Provider Boundary]
    VR[Verifier Runner]
  end

  H[Native Harnesses]
  TL[Tools / MCP / External APIs]

  W --> K
  K --> P
  P --> K
  K --> V
  K --> O
  O --> C2
  C2 --> EP
  EP --> X
  X --> A
  A <--> H
  H --> T
  T --> TL
  A --> IR
  T --> IR
  T --> FX
  X --> CP
  IR --> CG
  IR --> D
  D --> K
  CP --> B
  FX --> B
  B --> K
  V --> VR
  VR --> IR
  IR --> V
  V --> K
  K --> RC
```

MissionBraid is designed as a modular local application, not a distributed
platform assembled prematurely. Mission Kernel events are the only authority
for control-state transitions. Native Harnesses, Git, and external systems
remain evidence sources for their own real state. Adapters preserve sanitized
native-format evidence and add normalized events without flattening away unique
capabilities.

Kandev may be used through a public provider boundary for mature workspace and
process execution. It is not forked, embedded as MissionBraid's state machine,
or required for direct local adapters.

Read the [final architecture](docs/architecture.md) and
[target product requirements](docs/product-requirements.md).

## Core design decisions

1. **Schedule a Runtime Profile, not a brand name.** Resolve Harness × model ×
   reasoning × instructions × Skills × MCP/tools × permissions × capabilities,
   then bind that snapshot to a Mission, workspace, authority, and budget.
2. **Preserve native fidelity before normalization.** Sanitized native-format
   evidence remains addressable; the common Event IR supports shared product
   behavior.
3. **Debug at real control boundaries.** Adapters declare whether they can
   observe, gate, interrupt, steer, resume, or reconstruct each boundary.
4. **A checkpoint is composite.** It binds Mission revision, event prefix,
   visible context, workspace state, Runtime binding, process/session locator,
   and Effect history.
5. **Replay never rewrites history.** Playback does not execute or branch.
   Cached replay, counterfactual resampling, and execution fork create child
   Branches whenever they produce new evidence.
6. **External effects survive time travel.** A branch must inherit, reconcile,
   compensate, or stop on effects that cannot be undone.
7. **Handoff transfers evidence, not hidden state.** MissionBraid does not claim
   to move KV cache, private chain-of-thought, or identical internal
   understanding.
8. **Models propose; deterministic code controls.** Models may propose
   structured soft requirements or features and explain a result. Once
   accepted, a versioned deterministic policy owns filter, rank, bind,
   authority, state, and final acceptance.
9. **Done is a Receipt, not an Agent claim.** Completion evaluates the exact
   immutable Contract revision bound to the selected Branch using
   controller-run evidence.
10. **Agent development is the product center.** Same-Harness iteration is the
    default. Fork, Handoff, routing, and CI export support development without
    turning MissionBraid into a switching or release-governance product.

The reasoning behind these choices is collected in
[Key Questions](docs/key-questions.md).

## What works today

The implemented foundation already provides:

- a local CLI and a bilingual Workbench with persisted English/Chinese
  selection;
- versioned Missions and immutable Outcome Contracts;
- append-only, hash-linked SQLite events with rebuildable projections;
- direct Codex, Qoder, and Claude Code process adapters;
- a default root Branch for every new Mission;
- separate Runtime Profile Definitions, timestamped Catalog Observations,
  immutable effective Snapshots, and Mission-specific Attempt Bindings;
- explicit Adapter capability declarations and honest unknown/unsupported
  Runtime fields;
- source-scoped normalized Runtime events linked to sanitized,
  content-addressed native-format artifacts;
- live event transport, Context Graph projections, adjacent context diffs, and
  source-linked model/tool/workspace/test evidence;
- a durable command/outbox path whose accepted execution intent survives an
  application restart;
- Runtime Hub inventory and Mission-form routes for registered external
  Adapters, using each manifest's real Harness identity;
- a real Claude Code native pre-tool gate for supported requests and guarded,
  queryable external Effect reconciliation;
- Git-backed Composite Checkpoints whose workspace component references an
  exact restorable commit/tree, with other components explicitly classified;
- immutable parent/child Branch lineage and an Execution Fork that starts a
  fresh native process in an isolated Git worktree;
- a budgeted, provenance-bound Handoff Capsule;
- explicit mutable workspace Effect identities;
- out-of-process verification and hash-bound Outcome Receipts;
- playback, cached replay, counterfactual resampling, and real Execution Fork
  operations with distinct side-effect guarantees;
- deterministic Runtime Profile filtering/ranking with inspectable Handoff
  decisions and a Mission Plan/Contract revision graph;
- branch-scoped Failure Intelligence and diagnostic Fork entry points;
- Outcome Studio projections plus redacted scenario/CI-result save and export
  endpoints;
- a versioned public Adapter SDK with direct, ACP, and provider-backed examples,
  plus an installed consumer Adapter that runs through the CLI, Workbench form,
  and same-Adapter isolated Execution Fork;
- restart restoration and recovery of interrupted Missions.

Current public evidence is classified by the capability it exercises:

- **I8 — living multi-Agent Mission:** the Workbench HTTP API runs real local
  Qoder/Qwen3.8-Max and Claude Code/deepseek-v4-pro on separate Plan nodes,
  accepts a prompt-only Contract revision, interrupts only stale prompt work,
  reuses the verified tool Artifact without rerunning Qoder, creates a new
  consolidation Attempt over immutable sources, issues a Receipt for the latest
  revisions, and reconstructs the same state after restart.
- **I7 — daily Agent debugging:** real Qoder/Qwen3.8-Max first fails with stale
  cached Context, then a fresh Attempt under the same Runtime Profile passes
  after a Context-only diagnostic Fork in a controlled fixture.
- **I5 — retained-boundary execution:** a real Codex parent result becomes a
  browser-created Composite Checkpoint and an isolated real Codex Execution
  Fork, with separate Branch lineage, verification, no-repeat Effect evidence,
  a child Receipt, restart restoration, and separately recorded Replay
  semantics.
- **I6 — justified Runtime replacement:** deterministic Profile
  filtering/ranking selects and binds a replacement Runtime for a controlled
  Codex→Claude Handoff.

These records do not prove native session fork/resume, portable refreshed
Context state, natural Runtime failure recovery, provider-internal state,
general multi-layer diagnosis accuracy, cross-host or distributed execution,
production isolation, or third-party adoption.

## Runtime support today

| Runtime or provider | Discovery support           | Executes Attempts | Current evidence                                 |
| ------------------- | --------------------------- | ----------------: | ------------------------------------------------ |
| Codex               | Probe/catalog implemented   |               Yes | Same-host three-Harness Mission                  |
| Qoder               | Probe/catalog implemented   |               Yes | Three-Harness Mission + I7/I8 controlled records |
| Claude Code         | Probe/catalog implemented   |               Yes | Three-Harness Mission + I8 controlled record     |
| OpenCode            | Probe/catalog implemented   |                No | Discovery support only                           |
| Hermes              | Probe/catalog implemented   |                No | Discovery support only                           |
| DeepSeek Harness    | Bootstrap/catalog signal    |                No | Discovery support only                           |
| Kandev v0.91.0      | Separate compatibility path |                No | Public task/worktree/process interfaces only     |
| Public Adapter      | Startup-loaded manifest     |               Yes | Internal clean-install CLI, Workbench, and Fork  |

## Ten product iterations

| Iteration | User-visible result                                                                           | Status                                                |
| --------: | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
|         1 | A Mission survives interruption, crosses Codex → Qoder, and closes with a verified Receipt    | Implemented locally                                   |
|         2 | Runtime Profiles and native events become observable through a unified Event IR               | Validated locally                                     |
|         3 | Developers inspect a live execution, context assembly, tool flow, and workspace changes       | Validated locally                                     |
|         4 | A supported tool call can stop before dispatch and be changed before continuation             | Validated locally                                     |
|         5 | A retained boundary creates an isolated executable comparison Branch                          | Completed locally                                     |
|         6 | A reproducible planner selects Profiles and hands off only when a Runtime change is justified | Validated locally (controlled interruption)           |
|         7 | One stale-Context failure is diagnosed from observable Context/workspace evidence             | Real Qoder controlled proof; broader attribution open |
|         8 | Multi-Agent work becomes a durable Mission graph with revision-aware coordination             | Same-host real-Runtime controlled proof               |
|         9 | Agent Revision comparison, regression scenarios, evaluation, Receipts, and CI export          | Implemented local slice                               |
|        10 | External developers install, extend, and reproduce the complete Runtime Workbench             | Internal clean-install validated                      |

The completion rule is that each iteration should eventually end in a real
Workbench workflow, not only an isolated schema, adapter, or test suite. I8 has
a bounded same-host real-Runtime workflow; I10 has an internal clean-install
Workbench workflow and machine-readable record. I9 remains a local slice. See the
[detailed roadmap](docs/roadmap.md) and [evidence boundaries](evidence/README.md).

## Run the current Workbench

Requirements: Node.js 24–26, pnpm, Git, and either an authenticated built-in
Runtime or a startup-loaded external Adapter. The documented native
Codex→Qoder path requires both `codex` and `qodercli`.

MissionBraid can be built as a locally installable npm tarball, but it has not
been published to a package registry or tagged as a release. The public v1
Adapter surface and clean-install check are documented in the
[1.0 source-candidate release and reproduction guide](docs/source-candidate-1.0.md)
and [Adapter SDK guide](docs/adapter-sdk.md).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:package
node dist/src/cli.js runtimes list --json

MISSIONBRAID_DEMO_ROOT="$(mktemp -d)"
node scripts/prepare-e1-fixture.mjs "$MISSIONBRAID_DEMO_ROOT/workspace"
node dist/src/cli.js app --state-dir "$MISSIONBRAID_DEMO_ROOT/state" --port 4317
```

Open `http://127.0.0.1:4317`. Select locally available model and reasoning
settings, then enter:

The Workbench follows the browser language on first use. Use the `EN | 中文`
control beside the wordmark to switch; the choice is stored only in that
browser.

**Title**

```text
Complete the Effect Ledger across Codex and Qoder
```

**Objective**

```text
Complete the dependency-free JSONL Effect Ledger in this disposable repository. Read AGENTS.md, README.md, and every public test. Implement record, replay, same-payload idempotency, payload-conflict detection, deterministic serialization, incomplete-tail recovery, strict corruption handling, and the CLI. Do not edit tests or install dependencies. Leave node --test passing for the Mission's bound Outcome Contract.
```

- **Workspace:** the absolute path printed by the fixture preparer
- **Route:** Codex to Qoder
- **Verifier executable:** `node`
- **Verifier arguments:** one line containing `--test`

Submit once. The full interruption and lower-level reproduction procedures are
in [Reproducing Evidence](docs/reproducing-evidence.md).

## Evidence

The [Iteration 8 multi-Agent revision record](evidence/iteration-8-multi-agent-revision-local-2026-08-26.json)
binds one controlled Git fixture and same-host Workbench flow to:

- Workbench HTTP creation, Plan start, live Contract revision, status queries,
  and verified completion;
- one real local Qoder/Qwen3.8-Max tool Attempt and one real local Claude
  Code/deepseek-v4-pro prompt Attempt on distinct isolated Plan nodes;
- a prompt-only revision that aborts and fences the stale Claude Attempt while
  preserving and explicitly reusing Qoder's verifier-backed tool Artifact
  without rerunning that node;
- a fresh revised Claude Attempt and a separate consolidation Attempt whose
  source Branch commits remain unchanged;
- deterministic verification, a Receipt bound to the latest Contract and Plan
  revisions, and stable Mission head, Receipt, Plan execution, and event chain
  after Workbench restart.

This is one same-host controlled-fixture result. It does not establish natural
failure handling, provider-internal state capture, distributed or cross-host
execution, independent external reproduction, production reliability, or
adoption.

The [Iteration 7 stale-Context record](evidence/iteration-7-stale-context-2026-08-26.json)
binds one controlled, same-host debugging flow to:

- an initial real Qoder Attempt using Qwen3.8-Max and the cached old Context,
  whose result the Mission-bound deterministic Verifier rejects;
- observable cached/current Context digests and a stale-Context candidate;
- an isolated child Branch whose Intervention declares Context refresh as the
  product variable while retaining the same Contract, Runtime Profile, and
  authority;
- a fresh Qoder process and Attempt under the same Runtime Profile, whose
  refreshed-Context result passes the Verifier and receives a verified Receipt;
- a saved regression scenario and stable restored identities after Workbench
  restart.

The child is a new Attempt and process, not a continuation or resume of the
original Qoder Session. Refreshed Context is assembled for this diagnostic
Attempt only; the record does not prove a portable persistent cache. It proves
one stale-Context mechanism in a controlled fixture, not provider-internal
Context capture, general model/tool/Harness/environment attribution, diagnosis
accuracy or recall, cross-host continuity, or production recovery.

The
[Iteration 5 machine-readable record](evidence/iteration-5-execution-fork-local-2026-08-26.json)
binds one same-host product flow to:

- a real Codex parent Mission whose one-file result passed the bound
  deterministic verifier;
- a parent Git commit created by the local proof controller only after it
  inspected that Codex-produced delta, because the Codex workspace sandbox did
  not write Git metadata;
- a browser-created Git-backed Composite Checkpoint and one declared guidance
  Intervention;
- a fresh real Codex process running only in Branch B's isolated Git worktree,
  while Branch A remained unchanged;
- runtime, model, tool, workspace, and verification evidence, followed by a
  child-Branch Receipt;
- one confirmed queryable external Effect inherited as `inherit-no-repeat`,
  with no second target call during Fork or restart;
- the same Branches, Checkpoint, Fork, Effect state, and Receipt after a new
  Workbench process restored the Mission.

This is an **Execution Fork from an explicit Git-backed boundary**, not a
native Codex session fork or resume. It is same-host evidence, not cross-host,
independent reproduction, production evidence, or proof that Codex authored
the parent Git commit.

The [Iteration 5 replay record](evidence/iteration-5-checkpoint-replay-local-2026-08-26.json)
also retains playback, cached replay, and counterfactual resampling. Playback
does not write a Branch; cached replay creates evidence from persisted future
Artifacts without launching a Runtime; counterfactual resampling launches a
real model-only Claude process with tools disabled and leaves the outcome
unknown. None of these operations claims native session migration or an
undoable external side effect.

The [Iteration 6 adaptive record](evidence/iteration-6-adaptive-handoff-local-2026-08-26.json)
shows deterministic candidate filtering/ranking, Capsule acknowledgement, and
Codex→Claude continuation after a controlled provider interruption without a
user copying context. It is not evidence of a natural Runtime failure,
restorable target workspace, native session migration, cross-host continuity,
or production reliability.

The [Iteration 10 package smoke record](https://github.com/Oxygen56/missionbraid/blob/main/evidence/iteration-10-package-smoke-local-2026-08-26.json)
shows a locally packed tarball installing into a clean consumer, public exports
loading, a third-party Adapter passing local conformance, and the installed
Workbench starting and shutting down cleanly. Registry publication and
independent external reproduction were not performed.

The
[Iteration 2 machine-readable record](evidence/iteration-2-three-harness-local-2026-08-25.json)
binds a clean revision to:

- one Mission submitted through the normal local Workbench API with no
  user-authored Mission YAML or manual cross-Harness context transfer;
- successful real Codex, Qoder, and Claude Code Attempts on one root Branch;
- Profile Definitions, Catalog Observations, immutable Snapshots, and Attempt
  Bindings for the three Runtimes;
- 1,066 source-scoped Runtime events and 1,066 sanitized native artifacts;
- two cooperative Handoff acknowledgements whose native source events precede
  each target's first observed tool-request event; this is ordering evidence,
  not a live tool gate;
- a verified Receipt and stable Mission head, Receipt, source sequences, and
  causal links after Workbench restart.

The earlier
[Codex-to-Qoder record](evidence/unified-workbench-codex-qoder-local-2026-08-24.json)
retains a matching source-checkpoint/target-baseline workspace snapshot and
distinct before/after workspace digests; it is not used to claim an enforced
pre-mutation gate.

All current records are local and same-host unless explicitly labelled
otherwise. The [evidence index](evidence/README.md) keeps implementation,
real-runtime validation, clean-install validation, and target claims separate.
The package smoke record proves a local tarball install, not registry
publication or independent external reproduction.

## Documentation

- [1.0 source-candidate release and reproduction guide](docs/source-candidate-1.0.md)
- [Product requirements](docs/product-requirements.md)
- [Final architecture](docs/architecture.md)
- [Ten-iteration roadmap](docs/roadmap.md)
- [Project tour](docs/project-tour.md)
- [Key product decisions and technical questions](docs/key-questions.md)
- [Evidence and claim boundaries](evidence/README.md)
- [Controlled reproduction](docs/reproducing-evidence.md)
- [Contributing](CONTRIBUTING.md)

## License

MissionBraid is licensed under the [Apache License 2.0](LICENSE).
