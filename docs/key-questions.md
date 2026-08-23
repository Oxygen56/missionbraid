# Key Questions

> **Status:** pre-alpha design and local implementation. Commit-bound
> real-runtime evidence is pending; these answers do not represent verified
> process or cross-runtime continuity.

MissionBraid is intentionally organized around questions that must be answered
with code and reproducible evidence, not feature-count claims.

## 1. What remains when existing tools already launch many runtimes?

**Current position:** MissionBraid should not compete on the number of agent
CLIs it can start. Its proposed value is the portable Mission contract that owns
planning, evidence handoff, mutable-effect state, and verified completion across
runtime boundaries.

**Evidence required:** one real Mission must cross runtimes without manual
context transfer and close against its original Outcome Contract.

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

**Evidence required:** the public interface must support the workspace,
lifecycle, status, output, and stable-reference contract needed by a real E1
run. Until then, Kandev compatibility is a target, not a supported claim.

## 10. How will MissionBraid prove value rather than merely add machinery?

**Current position:** the flagship result is not a schema, UI, adapter count, or
test count. It is one repeatable Mission that survives a real process and then a
real runtime boundary with no manual context movement, no repeated controlled
effect, and an independently verified outcome.

**Evidence required:** E0 and E1 must satisfy the public gates in the
[roadmap](roadmap.md), followed by matched evaluation against manual transfer
and relevant overlapping baselines.

## 11. Which claims are intentionally excluded?

MissionBraid does not currently claim:

- lossless session migration;
- universal exactly-once tool execution;
- perfect or universal root-cause attribution;
- globally optimal runtime selection;
- production readiness;
- verified cross-runtime continuity.

These are not marketing caveats. They define the boundary between accepted
architecture and demonstrated capability.
