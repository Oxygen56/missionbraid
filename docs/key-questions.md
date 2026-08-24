# Key Questions

> **Status:** pre-alpha design and local product implementation. The unified
> Workbench path is verified in a clean public clone of `c55dd54`: one web-form
> Mission crossed real Codex and Qoder Attempts, both changed the workspace, the
> original verifier passed, and the Receipt survived app restart. This does not
> represent automatic routing, third-party or cross-host reproduction,
> production readiness, or broad execution compatibility.

MissionBraid is intentionally organized around questions that must be answered
with code and reproducible evidence, not feature-count claims.

## 1. What remains when existing tools already launch many runtimes?

**Current position:** MissionBraid should not compete on the number of agent
CLIs it can start. Its proposed value is the portable Mission contract that owns
planning, evidence handoff, mutable-effect state, and verified completion across
runtime boundaries.

**Evidence status:** the [controlled local E1 run](../evidence/e1-local-2026-08-24.json)
crossed from Codex to Qoder without manual context transfer and closed against
its original Outcome Contract. A [same-host, task-context-isolated fresh-clone
run](../evidence/e1-context-isolated-reproduction-local-2026-08-24.json)
reproduced that path. The [unified Workbench run](../evidence/unified-workbench-codex-qoder-local-2026-08-24.json)
then proved the same core value through the product entry rather than a
user-authored Mission file; third-party or cross-host reproduction remains
required.

## 2. What exactly is portable across runtimes?

**Current position:** observable facts, decisions, constraints, artifacts,
effect state, and verification evidence are portable. Hidden model state,
identical internal reasoning, and perfect transcript equivalence are not.

**Evidence required:** every handoff fact must have provenance; the target must
acknowledge the critical identifiers; later behavior must still pass the
original verifier.

## 3. How can a Capsule fit different context windows without losing the task?

**Current position:** separate an immutable, non-compressible core from optional
material. Compute the injection budget from a Runtime Profile snapshot. Degrade
optional items deterministically from full content to summaries to immutable
references. Never silently truncate the core.

**Evidence required:** projection hashes must be reproducible; property tests
must preserve the core under every valid budget; real adapters must measure or
guarantee the injection limit they advertise.

## 4. Can MissionBraid prevent an external action from happening twice?

**Current position:** not universally. Every mutable action receives an Effect
identity before dispatch, but the guarantee depends on control:

- enforced when credentials and tools pass through MissionBraid;
- guarded when the upstream system provides idempotency or a queryable
  postcondition;
- advisory when the runtime can bypass both.

**Evidence required:** crash injection around dispatch must show zero automatic
repeats for controlled, confirmed Effects. Advisory paths must remain visible in
the Receipt.

## 5. How is a model failure distinguished from a harness or tool failure?

**Current position:** collect hashed observations at each boundary, keep
observations separate from hypotheses, rank candidates with a versioned policy,
and use a bounded discriminating probe only when it changes one declared
dimension. If evidence is not decisive, report `unknown`.

**Evidence required:** injected failures must produce stable candidates;
removing decisive evidence must downgrade a confirmation; duplicate logs must
not inflate confidence.

## 6. Can a planner use live availability, price, and history and still be reproducible?

**Current position:** yes only when every dynamic input is frozen into an
immutable snapshot included in the planning hash. Otherwise that input is not
allowed to affect the decision.

**Evidence required:** equal inputs and policy must produce the same decision
hash; modifying an input without updating its hash must fail closed.

## 7. Who decides that a Mission is complete?

**Current position:** neither the model nor the harness. They may report
completion, but the Mission Kernel runs the verifier declared in the Outcome
Contract and issues a Receipt containing criterion and evidence results.

**Evidence required:** a false agent success report must remain unverified; a
third party must be able to replay or inspect the Receipt's evidence chain.

## 8. How are permissions handled when execution moves?

**Current position:** permission can only narrow to the intersection of Mission,
current-owner, source-Attempt, target-Profile, and execution-provider grants.
Unknown permissions are denied. A broader target runtime does not create new
Mission authority.

**Evidence required:** handoff must reject missing capabilities, permission
expansion, stale grants, and profiles that cannot enforce a Mission's required
control level.

## 9. What role does Kandev play?

**Current position:** Kandev is a candidate external workspace and execution
provider, not MissionBraid's state machine or source-code base. Integration is
through a versioned public process boundary, without a fork or shared internal
database. Direct local adapters remain a valid path.

**Evidence status:** a [clean-clone, two-run local check](../evidence/kandev-v0.91.0-provider-check-local-2026-08-24.json)
against the official v0.91.0 container first created a fresh task, session, and
worktree, then reconciled the same identities on rerun. Both runs started and
retired distinct preconfigured custom processes. The versioned public API still
lacks full Session or Agent stop. Kandev-backed
Mission execution, a real provider-bound E1, and Outcome Receipt issuance
therefore remain unproven and unsupported.

## 10. How will MissionBraid prove value rather than merely add machinery?

**Current position:** the flagship result is not a schema, UI, adapter count, or
test count. It is one repeatable Mission that survives a real process and then a
real runtime boundary with no manual context movement, no duplicate disclosed
Effect identity, and an independently verified outcome. Preventing repeated
mutable Effects through guarded or enforced controls remains a separate
evidence gate.

**Evidence status:** controlled local E0 and E1 runs satisfy the public gates in
the [roadmap](roadmap.md). A same-host, task-context-isolated run from a clean
public clone reproduced E1 and explicitly replayed its verifier. A second clean
public-clone run submitted through the Workbench and restored its verified
Receipt after restart. Third-party or cross-host reproduction and matched
evaluation against manual transfer and relevant overlapping baselines remain.

## 11. Which claims are intentionally excluded?

MissionBraid does not currently claim:

- lossless session migration;
- universal exactly-once tool execution;
- perfect or universal root-cause attribution;
- globally optimal runtime selection;
- production readiness;
- cross-runtime continuity beyond the controlled local Codex-to-Qoder fixture.

These are not marketing caveats. They define the boundary between accepted
architecture and demonstrated capability.
