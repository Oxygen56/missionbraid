# Key Product Decisions and Technical Questions

> **Status:** these answers define the accepted target architecture. “Today”
> includes the same-host real-Runtime evidence for Iterations 1–8: the live
> Flight Recorder, native Tool Gateway, Composite Checkpoint/Execution Fork,
> four Replay semantics, controlled adaptive Handoff, and one stale-Context
> daily-debugging case. Iteration 8 has a retained same-host controlled-fixture
> record using real local Qoder/Qwen3.8-Max and Claude Code/deepseek-v4-pro
> through Workbench HTTP. Iterations 9–10 have
> implementation/API or package slices. Independent external reproduction and
> production evidence remains open.
> Iteration 7's
> stale-Context diagnostic loop is now recorded as same-host local evidence;
> its provider-internal and generalization boundaries remain explicit.

## 1. Why build a Workbench instead of another Agent launcher?

Launching a CLI is already cheap. The unsolved developer loop is understanding
and improving a real Agent application: which model, instructions, Skills,
tools, context/memory, permissions, and Runtime actually governed a task; how
those inputs shaped tool behavior and workspace mutations; what changed after
a revision; and whether the result improved under the same outcome standard.

MissionBraid therefore owns the Mission lifecycle, evidence, debugging, and
evaluation workflow while native Harnesses keep their execution strengths.
Checkpoint, Fork, Handoff, and CI export support this daily loop; they are not
mandatory steps in every run.

## 2. What is the scheduling unit?

Not “Codex”, “Qoder”, or a model name. Planning evaluates a timestamped Runtime
Catalog Observation and binds an immutable **Runtime Profile Snapshot**:

```text
provider × Harness × model × reasoning mode × instructions
× Skills × MCP/tools × permissions × capabilities
```

The selected snapshot becomes an Attempt Binding only after it is attached to
the Mission revision, Branch, workspace, authority, budget, and native
session/process. Availability, quota, and price are versioned planning inputs,
not permanent Profile identity. Unknown or stale inputs cannot silently affect
a reproducible decision.

## 3. How can different Harnesses share one event model without losing what makes them different?

MissionBraid stores both:

- immutable sanitized native-format artifacts, redaction metadata, and native
  extension fields;
- a versioned Agent Event IR for shared concepts such as turns, context,
  tool calls, artifacts, effects, lifecycle, and outcomes.

Normalization is additive, not destructive. An adapter may expose capabilities
that have no common equivalent. The Workbench degrades explicitly instead of
pretending every Harness supports the same controls.

## 4. Can the debugger pause an arbitrary Agent at any instruction?

No. That would be a false capability. An adapter declares concrete safe points:
pre-tool, post-tool, turn boundary, idle, process exit, or provider-native
interrupt. MissionBraid distinguishes:

- **observe:** events are visible but execution cannot be stopped;
- **interrupt:** a process or turn can be stopped, possibly after the current
  action;
- **gate:** the next controlled action cannot happen until MissionBraid allows
  it;
- **steer:** supported state can be changed before continuation;
- **reconstruct:** a new Attempt can be created from recorded state.

The UI must show the actual control level for every breakpoint.
An intervention may preserve or narrow authority. Expanding it requires an
explicitly authorized Grant or Contract revision; an Agent or descendant Branch
cannot inherit a larger permission set by default.

## 5. What state must a checkpoint contain?

A useful checkpoint is not just a Git commit or transcript offset. It binds:

- Mission and Outcome Contract revision;
- branch and Attempt identity;
- persisted event prefix;
- visible Context Graph and instruction sources;
- workspace snapshot and untracked state;
- Runtime Profile and native session/process locator when available;
- tool and external Effect history;
- environment fingerprints needed for reconstruction;
- unresolved acceptance criteria.

Missing components are recorded as reconstruction limits, not hidden behind a
“resume” label.

## 6. What does “time travel” mean?

Projection rebuild is an internal deterministic recovery operation, not time
travel and not a Branch. MissionBraid exposes four user operations:

1. **Playback:** inspect recorded history without executing anything.
2. **Cached replay:** create a child Branch that substitutes eligible recorded
   controlled outputs as new branch evidence.
3. **Counterfactual resample:** create a child Branch and call a model or tool
   again with a changed input; the result is new evidence.
4. **Execution fork:** create a new branch from a composite checkpoint and run
   it.

Playback creates no Branch. The other three create a child Branch whenever they
produce new evidence; only execution fork necessarily performs real subsequent
tool work. Ordinary resume or Handoff from the current head may add an Attempt
to the same Branch. No operation claims deterministic reproduction of a
stochastic model unless the underlying Runtime can prove it.

## 7. What happens to external effects after rewind or fork?

Time travel cannot unsend a message, undo a deployment, reverse a purchase, or
erase an API mutation. Every mutable action MissionBraid controls or observes
receives an Effect identity; an unobservable boundary remains `unknown`.
Control levels are:

- **enforced:** MissionBraid owns dispatch and can block duplicates;
- **guarded:** the target system provides idempotency or a queryable
  postcondition;
- **advisory:** the action is observed or predeclared, but the Harness can
  bypass MissionBraid;
- **unknown:** available evidence cannot establish whether the action happened.

Effects are scoped as branch-local workspace, shared-resource, or
mission-global external. A new Branch owns new Effects and references the
inherited external frontier; it must reconcile, compensate, or stop before
repeating prior actions. Unknown state is never converted into “safe to
repeat”.

## 8. What exactly crosses a Harness boundary?

A Handoff Capsule carries portable, provenance-bound evidence:

- Mission and Contract identity;
- source branch, Attempt, and checkpoint;
- achieved and unresolved criteria;
- relevant context and artifact references;
- workspace and Effect state;
- decisions, failures, and constraints;
- target-specific injection projection and acknowledgement requirements.

Hidden chain-of-thought, KV cache, private model state, and identical internal
understanding are not portable and are not claimed.

The current Handoff acknowledgement is cooperative. Its native source event is
ordered before the first observed tool-request event, but this does not prove a
pre-tool gate or that no unobserved mutation occurred.

## 9. How does failure attribution avoid becoming an LLM-written guess?

The system first records observable boundaries: model request/response metadata,
context changes, tool inputs/outputs, Harness lifecycle, workspace changes, and
environment state. Deterministic rules identify contradictions and missing
preconditions. Models may summarize evidence and rank hypotheses, but cannot
upgrade a hypothesis to fact.

Where useful, MissionBraid creates a diagnostic branch that changes one
declared dimension. If evidence remains insufficient, the correct result is
`unknown`.

The Iteration 7 record confirms one stale-Context mechanism in a controlled
fixture: an isolated new Qoder Attempt/process keeps the same Harness/Profile,
Contract, and authority while applying a declared Context refresh. It is not
the original native Session continuing, does not prove every hidden or
unobserved input stayed equal, and does not establish multi-layer attribution
or general diagnosis accuracy.

## 10. How does the planner choose a Runtime Profile?

The accepted flow is:

```text
extract requirements → filter hard constraints → rank eligible Profiles
→ bind immutable decision → observe → adapt or replan
```

Hard constraints include required tools, permissions, control points,
environment, context budget, and policy. Ranking may use cost, latency, quota
signals, historical outcomes, and user preferences only when their source,
freshness, and fallback behavior are recorded.

Models can extract soft requirements or explain a ranking. Deterministic policy
owns eligibility, rank, binding, authority, and budget enforcement. The frozen
requirements, Catalog observations, candidate set, rejection reasons, rank
vector, policy version, and decision hash make equal inputs reproducible.

## 11. How does multi-Agent work avoid becoming an unstructured swarm?

A Mission Plan is a versioned graph of goals, dependencies, ownership,
acceptance criteria, and shared artifacts. Every worker produces an Attempt on
a branch. A Mission revision can invalidate, supersede, or replan downstream
work explicitly.

The user can revise a living Mission, but the change creates a new revision; it
does not silently rewrite the contract against which earlier work was judged.
Agents on an obsolete revision are stopped or fenced. Branch histories never
merge in place; a join creates a consolidation Attempt over provenance-bound
artifacts, and workspace integration is a new Effect.

The current implementation executes independent ready nodes concurrently in
isolated Git worktrees. It advances a node only with Artifact evidence bound to
the current Plan, Contract, and node version plus a passing deterministic
verifier. A live revision fences the affected Attempt, explicitly adopts an
unaffected verified Artifact into the new revision, reruns the invalidated
frontier, and consolidates selected source commits in a new Attempt. This chain
has controlled process-boundary integration coverage and a retained
[same-host real-Runtime record](../evidence/iteration-8-multi-agent-revision-local-2026-08-26.json).

## 12. Who decides that the Mission is complete?

Neither the model nor the Harness. They may report completion, but the Mission
Kernel evaluates the exact immutable Contract revision bound to the selected
Branch through controller-owned verifier evidence. The Verifier Runner cannot
issue a Receipt. Any required failed/unknown criterion or blocking/ambiguous
required Effect prevents `verified`; authorized acceptance remains a separate
signal. Terminal failure or unknown still produces a rejected Receipt with its
unresolved evidence.

“The Agent said done” is evidence input, never the completion transition.

## 13. What role does Kandev play?

Kandev is a candidate external execution provider for mature workspace,
process, and session capabilities. MissionBraid integrates through a versioned
public boundary and keeps its own Mission state, Event IR, debugger, branch
semantics, and Outcome Contract.

MissionBraid does not fork Kandev, depend on its internal database, or make it
the only execution path. Direct local adapters remain valid.

The current compatibility record only proves selected public Kandev v0.91.0
task/worktree/process behavior. It does not prove a Kandev-backed Mission.

## 14. What is implemented and what is still a design?

Implemented and evidenced today (same-host, local pre-alpha):

- bilingual local Workbench and Mission Kernel;
- Codex, Qoder, and Claude Code execution Adapters;
- Runtime Profile Definition, Catalog Observation, immutable effective
  Snapshot, and Attempt Binding;
- source-scoped Event IR linked to sanitized, content-addressed native
  artifacts, with live Context Graph and context-diff projections;
- durable events, command/outbox dispatch, and restart restoration;
- a native Claude Code pre-tool boundary and queryable external Effect
  reconciliation;
- Git-backed Composite Checkpoints, isolated Execution Fork Branches, and
  Playback, Cached Replay, Counterfactual Resampling, and Execution Fork
  semantics;
- deterministic Profile filtering/ranking and a controlled adaptive Handoff
  Capsule path;
- one same-host controlled stale-Context diagnostic Branch: a new Qoder
  Attempt/process keeps the recorded Harness/Profile, Contract, and authority,
  applies a declared Context refresh, passes an out-of-process deterministic
  Verifier, and saves a restart-stable regression scenario;
- executable Mission Plan coordination through the Workbench/API: parallel
  isolated node Attempts, live revision fencing, verified Artifact reuse, a new
  consolidation Attempt, and a Receipt bound to the latest Contract and Plan;
- controller-run out-of-process verifier, Branch-bound Outcome Receipts, and
  the public Adapter SDK/package contract.

The [evidence index](../evidence/README.md) records the exact retained Runtime
boundaries for Iterations 1–8. They are local same-host results, not native
session migration, natural failure recovery, cross-host reproduction,
production readiness, or third-party adoption. The Iteration 8 record covers
Workbench HTTP creation, start, live revision, query, and completion with real
local Qoder/Qwen3.8-Max and Claude Code/deepseek-v4-pro; selective interruption
and reuse, independent consolidation, the latest-revision Receipt, and restart
consistency are retained.

Still open beyond that bounded Iteration 7 record:

- broader Failure Intelligence coverage, automatic diagnosis accuracy, and
  multi-layer evidence beyond the recorded stale-Context mechanism;

Still open at stronger evidence or delivery levels:

- Iteration 9 external CI execution and regression-quality evidence;
- Iteration 10 registry publication and independent clean installation.

The [Iteration 7 stale-Context record](../evidence/iteration-7-stale-context-2026-08-26.json)
now proves one same-host local case: an old cached Context led to a rejected
Mission; a new isolated Attempt/process on the same Qoder Profile, Contract,
and authority applied the declared Context refresh and passed the deterministic
Verifier; and the diagnosis, Receipt, and saved scenario survived restart. The
fixture controls the visible Snapshot and instruction boundary; this is not the
original native Session continuing, and the refreshed cache is used only for
that diagnostic Attempt. It does not establish equality of every hidden or
unobserved input, provider-internal Context capture, multi-layer attribution,
diagnosis accuracy across incidents, or production recovery.

The [product requirements](product-requirements.md), [final
architecture](architecture.md), and [ten-iteration roadmap](roadmap.md) keep
those boundaries explicit.

## 15. What claims are intentionally excluded?

MissionBraid does not currently claim:

- lossless session migration;
- access to hidden chain-of-thought;
- deterministic replay of arbitrary stochastic Runtimes;
- universal exactly-once external actions;
- perfect root-cause attribution;
- globally optimal Runtime selection;
- arbitrary Harness compatibility;
- production readiness or adoption.

These are architectural boundaries, not footnotes. Any future claim must be
earned by the corresponding real product workflow and published evidence.

## 16. What counts as an Agent modification?

Authorship is not the criterion. If Codex edits an unrelated application's
button, that is Agent-authored project code and uses the project's ordinary CI.
If a change can alter how the Agent handles the same Mission, it belongs to the
effective **Agent Revision**:

```text
model/provider/reasoning
+ instructions and Skills
+ MCP/tools and their implementations
+ context, retrieval, memory and compaction
+ planning, retry, session and Handoff behavior
+ permissions, guardrails and Effect policy
+ Runtime, Adapter, dependencies and environment
```

The Revision is a content-addressed view composed from existing Profile,
Attempt, policy, Adapter, and environment evidence. It is not another state
machine beside the Mission.

Evaluation suites, verifiers, baselines, thresholds, and qualification policies are
separate control artifacts. Changing the candidate or its judge requires a new
qualification for that exact pair. An Agent may propose a Revision or explain
results, but it cannot approve its own change.

## 17. How is an Agent Revision validated when model behavior is stochastic?

The release decision is layered rather than delegated to another Agent:

- deterministic checks cover structure, dependencies, permissions, tool and
  Effect invariants, executable tests, and objective environment outcomes;
- real Runtime trials cover trigger behavior, tool selection, trajectories,
  cost, latency, side effects, and Mission outcomes;
- repeated trials and predeclared thresholds handle stochastic behavior;
- model-based graders cover open-ended qualities only with a visible rubric,
  retained outputs, and a calibration boundary;
- deterministic policy applies the recorded evidence to issue the final
  qualification and Outcome Receipt.

Public systems already expose parts of this pattern. Volcengine states that
its Skills pass internal CI and end-to-end tests before synchronization, while
its public release workflow validates versions, layouts, tests, bundles, and
published hashes ([maintenance model](https://github.com/volcengine/volcengine-skills/blob/main/CONTRIBUTING.md),
[release workflow](https://github.com/volcengine/volcengine-skills/blob/main/.github/workflows/release.yml)).
ByteDance DeerFlow runs deterministic review CI for changed public Skills, but
its own reviewer distinguishes static readiness from runtime behavior and
regression evidence ([CI](https://github.com/bytedance/deer-flow/blob/main/.github/workflows/skill-review-ci.yml),
[assurance rules](https://github.com/bytedance/deer-flow/blob/main/skills/public/skill-reviewer/SKILL.md)).
These are useful precedents, not evidence that a complete native coding-Agent
Revision gate already exists.

## 18. Is MissionBraid a CI/CD platform or a Harness switching product?

No. The primary product is the Agent application development loop:

```text
compose → run → inspect → revise → re-run → evaluate → verify
```

The same Harness normally continues. Fork is used for an isolated comparison;
Handoff is used when availability, capability, deliberate comparison, or user
choice justifies another Runtime. Saved scenarios and machine-readable results
may be consumed by CI, but deployment, organization approval, artifact signing,
and general release governance remain outside the 1.0 product boundary.
