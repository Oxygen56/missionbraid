# Key Product and Technical Questions

> **Status:** these answers define the accepted target architecture. “Today”
> includes the verified pre-alpha Codex/Qoder vertical slice and the Iteration 2
> same-host real Codex/Qoder/Claude Workbench validation. “Target” describes
> later capabilities still scheduled in the ten-iteration roadmap.

## 1. Why build a Workbench instead of another Agent launcher?

Launching a CLI is already cheap. The unsolved developer loop is understanding
and controlling a long Agent execution: effective configuration, context
assembly, tool behavior, workspace mutations, failure location, retries,
cross-Harness continuation, and final acceptance.

MissionBraid therefore owns the Mission lifecycle and debugging workflow while
native Harnesses keep their execution strengths.

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

Implemented today:

- bilingual local Workbench and Mission Kernel;
- Codex, Qoder, and Claude Code execution Adapters;
- a default root Branch for new Missions, without Fork semantics yet;
- Runtime Profile Definition, Catalog Observation, immutable effective
  Snapshot, and Attempt Binding;
- source-scoped Event IR linked to sanitized, content-addressed native
  artifacts;
- durable events plus command/outbox dispatch and restart restoration;
- workspace baseline/checkpoint evidence (digest/delta, not a restorable
  snapshot) and Handoff Capsule;
- independent verifier and Outcome Receipt;
- one clean-public-clone Codex-to-Qoder evidence path and one clean-revision,
  same-host Codex/Qoder/Claude Code evidence path.

The [Iteration 2 record](../evidence/iteration-2-three-harness-local-2026-08-25.json)
proves that user result at the same-host local level: all three real Attempts
succeeded, 1,066 source-linked Runtime events and sanitized native artifacts
were retained, the Receipt was verified, and Mission head, Receipt, source
sequences, and causal links remained stable after restart.

Not implemented today:

- live Event IR transport, the Context Graph, and context diffs;
- pre-tool gating and interactive debugger;
- composite executable fork/replay;
- adaptive Profile planning;
- general failure attribution;
- multi-Agent Mission graphs;
- packaged Adapter SDK or broad Harness execution.

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
