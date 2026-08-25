# MissionBraid Product Requirements

> **Document status:** accepted target PRD and product boundary for the Agent
> Runtime Workbench. Requirements describe the intended product. The
> [current capability table](#current-product-baseline) and linked evidence
> distinguish implemented behavior from target behavior.

## Product summary

MissionBraid gives Agent developers one local Workbench for building and
improving applications that run through native coding-agent Runtimes:

```text
compose → run → inspect → revise → re-run → evaluate → verify
                         ↘ checkpoint / fork / handoff when needed
```

The product answers a practical development problem: changing a model, Prompt,
Skill, tool, context policy, permission, or Runtime can change an Agent's
behavior in ways that ordinary source diffs do not explain. The developer
should be able to see the effective Agent, run a real task, understand the
observable decisions and effects, revise one execution condition, continue
from a useful boundary, and judge the result against the same outcome.

### Product boundary

MissionBraid remains a **Mission-centric Agent Runtime Workbench**. Its primary
product loop is Agent application development: compose, execute, observe,
debug, revise, and evaluate. The following capabilities support that loop but
do not replace it:

- durable Mission state and long-running execution;
- checkpoint, Branch, Replay, and failure reconstruction;
- cross-Harness Handoff and adaptive Runtime selection;
- regression scenarios, CI export, and release evidence;
- multi-Agent coordination and Outcome Receipts.

MissionBraid is not repositioned as a generic CI/CD system, an enterprise
approval product, or a Harness switcher. Continuing in the same Harness is the
normal path. Handoff is used when the current Runtime is unavailable, lacks a
required capability, or a deliberate comparison justifies the change. CI is a
consumer of retained scenarios and evidence, not the product's central user
experience.

## Product purpose

### User outcome

An Agent developer can change an Agent application, run it on a real Mission,
inspect why it behaved as it did, revise it from a preserved execution
boundary, and decide whether the new behavior is better using Branch-bound
outcome evidence. A failure is one useful entry point, not a prerequisite for
using the Workbench.

### Project outcome

The repository should demonstrate real engineering depth across Agent
application composition, Runtime integration, context engineering, tool
calling, memory, long-running state, multi-agent coordination,
non-deterministic replay, cross-Harness handoff, failure attribution,
evaluation, and the model/program boundary.

### Empty victories

The product is not successful merely because it has:

- many Harness cards or adapters;
- an architecture diagram or extensive schema;
- a live-looking transcript page;
- a Git rollback labeled as time travel;
- copied trace records labeled as an executable fork;
- a model-generated root-cause explanation;
- a high test count without a real native-Agent user loop.

The defining result is an observable, interruptible, editable, branchable,
continuable, and independently verifiable Agent run.

## Target users

### Primary user: Agent application developer

Builds and iterates on prompts, Skills, MCP tools, context policies, models, and
Agent workflows. Needs to understand behavior changes, compare revisions, and
fix failures without rerunning an entire task.

### Primary user: Agent Runtime or platform engineer

Integrates native Harnesses, manages long-running execution, diagnoses
production-like incidents, controls tool boundaries, and maintains state across
process or Runtime changes.

### Secondary user: Agent researcher or technical lead

Compares models, Runtime Profiles, context strategies, and tool policies using
the same task, state boundary, and outcome contract.

Ordinary end users may benefit from the Workbench, but developer workflows take
priority when product requirements conflict.

## Agent Revision boundary

MissionBraid identifies the effective behavior of an Agent application as an
**Agent Revision**. This is a content-addressed view composed from existing
Profile Snapshot, Attempt Binding, policy, Adapter, and environment evidence;
it is not a second control-state machine beside the Mission. A Revision
references the immutable inputs that can change how the same Mission is
executed:

- model, provider, reasoning, and exposed generation configuration;
- system, developer, user, organization, and project instructions;
- Skills and their resources;
- MCP servers, tool schemas, tool implementations, and tool descriptions;
- context, retrieval, memory, and compaction policies;
- planner, retry, Handoff, session, and other orchestration behavior;
- permissions, guardrails, Effect policy, and authority ceiling;
- Runtime, Adapter, execution-provider, dependency, and environment identity.

Authorship does not define the boundary. Code written by an Agent for an
unrelated application is ordinary project output and remains subject to that
project's normal tests. It becomes part of an Agent Revision only when it
changes the Agent application or its effective execution environment.

Evaluation suites, verifier implementations, baselines, thresholds, and
qualification policies are **control artifacts**, not part of the candidate Agent
Revision. They are versioned and reviewed separately. Changing either the
Revision or a controlling artifact invalidates the previous qualification for
that pair and requires the relevant checks to run again. An Agent or model may
suggest a fix or explain evidence, but it cannot approve its own Revision.

## User problems

1. Native coding agents expose incompatible sessions, events, tools,
   permissions, models, and configuration.
2. A source diff does not reveal the complete effective Agent Revision that ran
   a task or explain why its behavior changed.
3. Logs rarely show one coherent view of the effective context, tool request,
   workspace change, and subsequent test result.
4. A developer often notices an error only after a tool has already created a
   side effect.
5. Long tasks are expensive to rerun and non-deterministic enough that an
   observed behavior may disappear or change on the next attempt.
6. Changing a Prompt, model, Skill, tool result, memory policy, or permission
   usually loses the original execution boundary needed for a fair comparison.
7. Existing replay terminology often mixes playback, cached responses, model
   resampling, and real execution.
8. Moving a task to another Harness requires manual context reconstruction and
   can repeat already completed work or external actions.
9. A failure may belong to the model, context, tool, Harness, environment, or
   orchestration layer, but evidence is spread across those boundaries.
10. Multiple Agents and requirement revisions can leave active workers
    pursuing stale or conflicting goals.
11. An Agent's completion message is not independent proof that the user's
    outcome was achieved.

## Product principles

1. The Mission and Outcome Contract are more durable than any Runtime session.
2. The default experience is autonomous and exception-driven; developers do
   not watch every token.
3. Native details remain inspectable even after events are normalized.
4. Strong controls are used only where the adapter or tool boundary can
   actually enforce them.
5. Historical state is immutable. Interventions create new events or branches.
6. Replay modes are named by their real execution semantics.
7. External effects are reconciled, not erased by a timeline operation.
8. Evidence may remain unknown; the product does not manufacture certainty.
9. Models handle semantic judgement and explanation. Deterministic code owns
   authority, durable state, budgets, side effects, and acceptance.
10. Every major capability must eventually appear in one end-to-end flagship
    Mission rather than a disconnected demo.
11. Same-Harness iteration is the default. Runtime switching and automatic
    routing must solve a recorded need rather than manufacture activity.
12. Evaluation evidence is created inside the development loop. CI may enforce
    a versioned result, but MissionBraid does not become a general deployment
    or organizational approval system.

## Primary user journey

1. Open the Workbench and inspect the effective Agent Revision and available
   Runtime Profiles for a project.
2. Create a Mission with an objective, constraints, workspace, authority, and
   Outcome Contract.
3. Select a Profile manually or accept a recorded planner decision. The normal
   path keeps using that Profile until evidence justifies a change.
4. Run the Mission and inspect a live, normalized view of model, context, tool,
   workspace, subagent, cost, and verification events.
5. Review normal behavior, a breakpoint, an anomaly, a failed criterion, or a
   deliberate Revision change without waiting for a catastrophic failure.
6. Open the execution scene: effective Revision and Profile, visible Context
   Graph, pending or completed tools, workspace, Effect state, and evidence
   graph.
7. Change a supported Prompt, Skill, tool, context or memory policy, model,
   permission, or orchestration input, then resume or create an isolated
   Branch from an explicit Checkpoint.
8. Continue in the same Harness by default. Compile a Handoff Capsule only when
   another Runtime is required or deliberately selected.
9. Compare the original and revised Branches by behavior, state, cost, Effects,
   and Outcome Contract results, using repeated trials where stochastic
   behavior requires them.
10. Select a verified Branch, keep unresolved evidence visible, save useful
    behavior as a versioned regression scenario, and optionally export its
    machine-readable result to an external CI system.

## Functional requirements

### PR-1 — Runtime Hub and effective Runtime Profiles

The Workbench must discover locally or remotely available Harnesses and
represent the effective execution environment rather than only a saved name.
It separates mutable Catalog Observations, reusable Profile Definitions,
immutable Profile Snapshots, and Mission-specific Attempt Bindings.

Required Profile dimensions:

- execution provider, Harness, version, and authentication readiness;
- model, reasoning configuration, fast mode, and context limits when exposed;
- effective user, organization, and project instructions;
- Skills, MCP servers, tool schemas, and capability availability;
- permission and sandbox ceilings;
- session, steering, interrupt, fork, and pre-tool-gate capabilities;
- availability, quota, cost, and freshness observations as planner inputs;
- workspace, Contract revision, authority, budget, and native session/process
  identity in the Attempt Binding.

Acceptance:

- a developer can inspect and diff Profile snapshots without reading native
  configuration files;
- the Workbench computes an Agent Revision identity from behavior-affecting
  Profile, instruction, Skill, tool, context/memory, permission, orchestration,
  Adapter, and environment evidence, while preserving unknown fields;
- a Revision diff explains which effective behavior inputs changed without
  claiming that a source diff predicts the resulting model behavior;
- an Attempt records the exact immutable Profile snapshot it used;
- changing quota or workspace state does not silently change a saved Profile's
  identity;
- unknown or estimated fields remain labeled and credentials never enter the
  snapshot;
- launching an Attempt uses the configuration shown to the developer or reports
  a native override.

### PR-2 — Mission, Outcome Contract, and Mission Plan

The product must keep long-running user intent independent from a Harness
session.

Acceptance:

- the Agent cannot modify its bound Contract revision, enlarge authority, or
  mark itself verified;
- a Mission Plan can represent sequential work, parallel Agent nodes, review,
  diagnostic branches, and joins;
- every Attempt and subagent maps to a Mission Plan node and Contract revision;
- a user requirement change creates a new revision and visible impact set
  rather than silently mutating active work;
- Agents still executing an obsolete revision are stopped, fenced, or isolated;
  unaffected evidence remains reusable and only impacted nodes are replanned;
- Branch history never merges in place: a join creates a provenance-bound
  consolidation Attempt, and workspace integration is a new Effect whose
  conflicts and selections are judged with verifier evidence.

### PR-3 — Unified live Agent Event IR

The product must normalize native Runtime events while preserving sanitized
native-format evidence and provider-specific extensions.

Acceptance:

- at least two genuinely different native protocols render through the shared
  Event envelope, and every semantic family an Adapter claims is proven by real
  native evidence;
- every normalized event references its native source artifact and fidelity;
- unsupported context, tool, subagent, session, or other semantics remain
  explicitly unavailable or namespaced native extensions;
- causal and correlation identifiers connect model requests, tool results,
  file changes, tests, checkpoints, and branches;
- events record source sequence, Mission ingest sequence, and causal parents;
  restart preserves those recorded orders and relationships without inventing
  a global native total order;
- unsupported native semantics remain explicit extensions rather than being
  dropped.

### PR-4 — Context and tool inspector

The developer must be able to inspect the observable inputs that shaped an
Agent turn.

Acceptance:

- the Workbench shows instruction sources, active messages, Skills, MCP/tool
  schemas, tool results, referenced files, compaction, and context-budget
  observations when the Runtime exposes them;
- adjacent turns can be diffed to show additions, removals, replacement, and
  truncation;
- hidden chain-of-thought, signed thinking, KV cache, and unavailable provider
  state are never fabricated;
- sensitive values support local redaction before display or export.

### PR-5 — Live debugger and semantic breakpoints

The product must support exception-driven intervention in a running native
Agent.

Breakpoint types:

- structural rules over tool, path, permission, event, budget, or process;
- behavioral rules for loops, repeated failures, edit churn, stale context, or
  scope drift;
- model-assisted semantic rules over Mission constraints, clearly labeled by
  confidence and enforcement capability.

Acceptance:

- an adapter claiming `pre_tool_gate` can stop a real tool before dispatch;
- the Workbench distinguishes enforced, cooperative, interrupt-only, and
  observe-only controls;
- the developer can approve, reject, modify supported inputs, inject guidance,
  resume, terminate, fork, or hand off;
- child-process, network-request, and already-dispatched-tool behavior is
  visible for each pause mechanism;
- a post-hoc alert is never presented as a pre-side-effect breakpoint.

### PR-6 — Tool Effect and permission runtime

The product must track mutable actions separately from ordinary tool
observations.

Acceptance:

- every mutable action MissionBraid controls or observes receives an Effect
  identity; unobservable boundaries remain unknown, and controlled actions
  receive identity before dispatch;
- Effect control is labeled enforced, guarded, advisory, or unknown, separately
  from breakpoint control capability;
- every Effect declares branch-local workspace, shared-resource, or
  mission-global external scope;
- permission can stay equal or narrow during resume, fork, and handoff. An
  expansion requires an explicitly authorized Grant or Contract revision and
  cannot be inherited or requested into existence by an Agent;
- confirmed or ambiguous external Effects are not automatically repeated on a
  descendant Branch;
- restart after an uncertain dispatch performs reconciliation before retry;
- compensation is represented as a new Effect, not history deletion.

### PR-7 — Composite Checkpoint, Fork, and Replay

The product must create executable debugging branches from explicit safe
points.

Acceptance:

- a Checkpoint manifest covers the event prefix, Mission revision, Profile,
  visible context, workspace, Effect frontier, permissions, and native session
  reference where available;
- every component is labeled portable, rebindable, reconstructable,
  runtime-native, external, or unavailable;
- the source history remains immutable and a new Branch receives isolated
  future events and workspace state;
- the user can change a supported context item, tool result, model/Profile,
  workspace state, new guidance, or narrow permission; broader authority uses a
  separately authorized Grant or Contract revision;
- the UI distinguishes playback, cached replay, counterfactual resampling, and
  real execution fork;
- projection rebuild and playback create no Branch; cached replay or resampling
  that produces evidence creates a child Branch, while ordinary resume/Handoff
  from the current head may append an Attempt to the same Branch;
- real execution after a fork uses real subsequent tools and produces its own
  Receipt.

### PR-8 — Cross-Harness Handoff

The product must let a Branch continue on another native Runtime without manual
context copying when a Runtime change is justified. It is a conditional
continuation path, not a required step in an ordinary Agent development loop.

Acceptance:

- the Handoff Capsule contains the Branch-bound Contract revision, plan
  frontier, visible context, workspace checkpoint, Effect state, permissions,
  and provenance;
- the target Profile receives a compatibility report for exact, emulated,
  summarized, rebound, unavailable, and blocking state;
- the target cooperatively acknowledges critical identifiers, and the product
  records its native source order relative to the first observed tool request;
  only an enforced Adapter gate may claim that mutation was prevented;
- the original Branch remains inspectable;
- same-Harness continuation remains the default and never requires a synthetic
  Handoff or duplicate run;
- the product describes this as semantic continuation, not hidden-state or
  process migration.

### PR-9 — Failure evidence and attribution

The product must help developers decide which layer to change.

Acceptance:

- evidence can be connected across model, context, tool, Harness, environment,
  and MissionBraid layers;
- findings are labeled observed, inferred, confirmed, or unknown;
- a discriminating diagnostic Branch changes one declared observable dimension
  while preserving the remaining Checkpoint boundary;
- removing decisive evidence downgrades a conclusion;
- model-generated explanations cite evidence and cannot promote themselves to
  confirmed.

### PR-10 — Branch comparison, evaluation, and Outcome Receipt

The developer must be able to choose a result using the same user goal.

Acceptance:

- Branches can be compared by trajectory, context, tools, files, tests, model
  usage, cost, time, Effects, failures, and criterion results;
- comparisons bind each Branch to its exact Agent Revision and controlling
  evaluation artifacts;
- every required Contract criterion ends in passed, failed, or unknown;
- terminal evaluation issues a Receipt for both successful and unsuccessful
  outcomes; failed or unknown required criteria remain visible in a rejected
  Receipt;
- an Agent-reported success cannot issue a verified Receipt when an independent
  verifier fails;
- any required failed/unknown criterion or blocking/ambiguous required Effect
  prevents a verified Receipt;
- selecting or accepting a Branch is separate from model generation and from
  technical verification;
- the Receipt binds the exact Contract revision, Branch lineage, Checkpoint,
  Effects, verifier evidence, and event head.

### PR-11 — Adaptive planner and Runtime routing

The product must support both deliberate manual selection and explainable
automatic execution.

Acceptance:

- planning follows explicit requirement extraction, hard filtering, ranking,
  binding, observation, and adaptation;
- capability, permission, control fidelity, context, workspace, availability,
  quota, cost, and prior outcome observations can influence selection only with
  source and freshness;
- accepted requirements, Catalog observations, candidates, rejected Profiles,
  rank vectors, policy version, and decision hash remain inspectable;
- equal frozen inputs and policy produce the same filter, rank, binding, and
  decision hash; models may propose stored features but do not perform the
  authoritative rank;
- failure, quota change, or Mission revision can trigger a recorded replan;
- a manual override remains possible and becomes part of the event history.

### PR-12 — Agent Revision, incident, and regression studio

The product must turn a meaningful Agent Revision or resolved failure into
reusable Agent engineering knowledge.

Acceptance:

- a developer can save a redacted Checkpoint, intervention, Contract, and
  expected evidence as a versioned incident scenario;
- scenarios can run against selected model, Prompt, Skill, MCP, tool, and
  context/memory, orchestration, permission, Harness, Adapter, and environment
  versions;
- comparisons preserve the difference between deterministic control tests and
  stochastic model behavior;
- deterministic gates cover structure, dependency, authority, Effect,
  executable, and independently verifiable outcome invariants;
- stochastic behavior checks use explicit scenario revisions, repeated trials,
  retained outputs, and predeclared thresholds rather than output equality;
- an LLM grader is evidence with a named rubric and calibration boundary, not
  the sole authority for qualification;
- a regression result links back to the exact Profile and scenario revision;
- a machine-readable scenario result can be consumed by an external CI runner;
  MissionBraid does not implement general deployment, organization approval,
  artifact signing, or release governance.

### PR-13 — Adapter SDK and execution providers

The product must grow without adding Harness-specific branches to the Mission
Kernel.

Acceptance:

- an Adapter declares discovery, event, context, control, resume, fork,
  workspace, and effect capabilities;
- conformance checks verify declared behavior rather than requiring a false
  lowest-common-denominator implementation;
- direct adapters, ACP, Kandev, Sandbox Agent, or another provider can bind
  through public versioned interfaces;
- a third-party Adapter can be added without editing Mission, Branch, Effect,
  or Receipt state machines;
- reused code and dependencies retain upstream license and attribution.

### PR-14 — Installable Open Workbench

The complete product must be independently installable, extensible, and
reproducible rather than remaining a repository-specific demo.

Acceptance:

- a packaged local daemon, Workbench, and CLI install from a clean environment;
- state migrations, a versioned local API, and redacted evidence/incident export
  are documented and exercised;
- an external developer implements or connects an Adapter through the public
  SDK without editing Mission control state machines;
- an independent external operator reproduces the complete flagship evidence
  matrix for observe, break, fork, replan/handoff, attribution, Effect
  reconciliation, Mission revision, incident regression, and verification;
- internal clean-host reproduction remains a lower evidence level and cannot be
  presented as independent external reproduction.

## Ten-iteration requirement mapping

The accepted delivery order remains ten product iterations. The sequence is
unchanged; this PRD clarifies the role each iteration plays in the Agent
development loop.

| Iteration | User result                                                                         | Product role                          |
| --------: | ----------------------------------------------------------------------------------- | ------------------------------------- |
|         1 | Mission, Contract, execution evidence, and Receipt survive interruption             | Durable development-loop foundation   |
|         2 | Effective Profiles and native events expose what Agent actually ran                 | Reproducible Revision foundation      |
|         3 | Context, tools, files, tests, usage, and subagents are visible live                 | Daily observation                     |
|         4 | Supported mutable actions can be inspected and controlled before dispatch           | Daily debugging                       |
|         5 | A retained boundary becomes an isolated executable comparison Branch                | Revision and repair experiments       |
|         6 | Profiles are selected explainably and Handoff occurs only when justified            | Runtime selection and fallback        |
|         7 | Evidence and diagnostic Branches distinguish likely failure layers                  | Behavior diagnosis                    |
|         8 | Multiple Agents and live requirement revisions remain one durable Mission           | Complex Agent application development |
|         9 | Agent Revisions are compared, evaluated, saved as regressions, and exportable to CI | Continuous improvement                |
|        10 | External developers install, extend, and reproduce the complete Workbench           | Open product form                     |

The detailed completion evidence and non-completion conditions remain in the
[roadmap](roadmap.md).

## Non-functional requirements

### Local-first operation

The core Workbench, evidence store, and redaction path run locally. Remote
execution providers are optional and explicitly connected.

### Durability

An event is persisted before acknowledgement. Every accepted execution command
commits its Kernel intent and transactional outbox entry before dispatch. A
restart must reconcile incomplete dispatch and rebuild Mission, Branch,
Attempt, Checkpoint, Effect, failure, and Receipt projections from durable
state.

### Responsiveness

Live events must be visible quickly enough to intervene before the next
supported boundary. Iteration 3 will establish an observed latency baseline and
calibrate an explicit release target instead of inventing an unverified number
now.

### Isolation

Writable Branches use distinct worktrees or stronger execution-provider
isolation. A stale controller or process cannot write authoritative Kernel
state after lease and fencing ownership changes.

### Secret handling

Credentials remain in adapters and are filtered before any persistence.
“Raw” evidence means sanitized native-format artifacts with redaction and
fidelity metadata. Other sensitive local context follows an explicit storage,
encryption, retention, and export policy; incident and public exports are
redacted by default.

### Extensibility without semantic loss

The Event IR uses a stable core plus namespaced native extensions and raw
artifacts. Adapter support is a capability matrix, not a single boolean.

### Honest recovery

The UI never claims to restore hidden model state, arbitrary process memory,
unobservable provider state, or already-realized external-world effects.

## Product success measures

Primary measures:

- elapsed time from an Agent behavior change to an independently verified
  improvement on a real Mission;
- proportion of Attempts bound to an inspectable effective Agent Revision;
- proportion of useful comparisons that reuse a retained execution boundary
  instead of rerunning the complete Mission;
- proportion of resolved behavior problems saved as versioned regression
  scenarios;
- rate at which independent verification catches a false Agent completion or a
  Revision regression before selection.

Supporting measures:

- time from a detected anomaly to a verified replacement Branch;
- proportion of failure conclusions with explicit evidence and calibrated
  uncertainty;
- first correct action and manually copied context after a justified
  cross-Harness Handoff;
- number of confirmed or ambiguous Effects repeated automatically;
- successful independent replay of Outcome Receipt evidence;
- live-event latency and dropped-event rate;
- Runtime cost and latency by Branch;
- Adapter capability coverage and conformance results.

Adapter count, event count, test count, screenshots, and GitHub popularity are
not product success measures.

## Current product baseline

The repository currently provides:

- a local CLI and a bilingual Workbench with a browser-persisted
  English/Chinese selection;
- durable Mission and Outcome Contract state;
- direct Codex, Qoder, and Claude Code execution Adapters;
- a default root Branch for each new Mission, without Fork behavior yet;
- separate Runtime Profile Definitions, timestamped Catalog Observations,
  immutable effective Snapshots, and Mission-specific Attempt Bindings;
- explicit Adapter capability declarations and honest unknown/unsupported
  effective fields;
- source-scoped Event IR records linked to sanitized, content-addressed native
  artifacts;
- a durable command/outbox path that retains accepted execution intent across
  application restart;
- local Runtime discovery for additional Harnesses;
- Git workspace baseline/checkpoint evidence (digest and delta, not a
  restorable snapshot);
- a bounded Codex-to-Qoder Handoff Capsule and acknowledgement;
- advisory workspace Effect identities;
- independent command verification and Outcome Receipt;
- application-restart restoration.

The strongest current evidence is indexed in
[evidence/README.md](../evidence/README.md). The Iteration 2 record is a
same-host real Codex/Qoder/Claude Workbench result with successful Attempts,
source-linked Event IR/native artifacts, a verified Receipt, and stable restart
restoration. Its Handoff result is cooperative native-source ordering before
the first observed tool request, not an enforced tool gate. It is not evidence
for the target Context Graph debugger, automatic planner, executable
Fork/Replay, broad Adapter matrix, cross-host or third-party reproduction, or
production use.

## Scope and claim boundaries

MissionBraid does not promise:

- access to or editing of hidden chain-of-thought;
- lossless migration of native model or process state;
- arbitrary-instruction process snapshots;
- universal exactly-once external actions;
- perfect automatic root-cause attribution;
- identical semantics across all Harnesses;
- production multi-tenancy in the local-first 1.0;
- that a target architecture diagram is an implemented capability.

The [architecture](architecture.md) defines the system boundaries. The
[roadmap](roadmap.md) defines ten product iterations, their ordering, and the
real completion condition for each.
