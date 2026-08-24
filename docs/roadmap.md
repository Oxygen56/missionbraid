# MissionBraid Roadmap

> **Current status:** pre-alpha. E0/E1 and the local unified Harness Workbench
> are implemented. A clean public-clone Workbench run against `c55dd54`
> submitted one Mission without user-authored YAML, executed real Codex and
> Qoder profiles with distinct changes, verified the original outcome, and
> restored the same Receipt after restart. Only Codex and Qoder execute today;
> automatic planning, quota-aware routing, additional adapters, and
> third-party/cross-host reproduction remain open.

This roadmap separates implementation order from evidence. A module existing in
the repository does not prove the corresponding product outcome.

## Implementation path

### 1. Mission kernel and local durability

- versioned Mission and Outcome Contract;
- append-only local event store and rebuildable projections;
- workspace lease and fencing;
- permission and cost envelopes;
- immutable Runtime Profile snapshots.

### 2. One-runtime vertical path

- deterministic profile filtering and planning;
- one direct runtime adapter;
- Attempt lifecycle and checkpointing;
- independent criterion verification;
- minimal Outcome Receipt.

### 3. Cross-runtime handoff

- Canonical Handoff Capsule;
- profile-budgeted Capsule Projection;
- structured target acknowledgement;
- Effect Ledger and crash reconciliation;
- a second direct runtime adapter.

### 4. External execution-provider path

- versioned provider contract;
- implemented exact-release public-interface check for Kandev v0.91.0 task,
  worktree, and preconfigured custom-process lifecycle;
- workspace and lifecycle binding without forking or importing provider state;
- real cross-runtime handoff with basic failure evidence.

### 5. Replanning and timeline

- evidence-backed failure candidates and bounded diagnostic probes;
- automatic safe replanning;
- checkpoint replay and isolated fork semantics;
- agentctl-compatible session projection where applicable.

### 6. Platform surface

- implemented local Mission Workbench over authoritative state, including
  Runtime inventory, Mission creation, run/resume/verify actions, timeline, and
  Receipt;
- adapter SDK and conformance suite;
- matched evaluation against manual context transfer and relevant baselines;
- additional adapters only when they add a new capability category or answer a
  demonstrated user need.

## Evidence milestones

### E0 — The Mission survives a process

E0 is complete only when one real Mission demonstrates all of the following:

- the user submits the Mission once;
- the runtime or MissionBraid process is genuinely interrupted after meaningful
  state exists;
- restart recovers the same Mission, workspace, completed boundary, and
  remaining work;
- the user does not restate the task or edit internal storage;
- the original Outcome Contract passes independent verification and produces a
  Receipt.

[One controlled local run](../evidence/e0-local-2026-08-24.json) satisfies this
gate for implementation commit `9d5b4d3`: the controller was terminated with
`SIGKILL`, recovery used the Mission ID without task restatement or storage
editing, and the original Contract produced a verified Receipt. This is not an
independent reproduction or production-readiness result.

### E1 — The Mission survives a runtime

E1 is complete only when one real Mission demonstrates all of the following:

- two real Runtime Profiles execute consecutive Attempts;
- the source runtime is interrupted or becomes genuinely unavailable;
- the target receives a budgeted Capsule, acknowledges its critical
  identifiers, and uses the existing workspace and evidence;
- the user copies no context between runtimes;
- confirmed Effect identities are disclosed and not duplicated; enforced or
  guarded Effect deduplication remains a later evidence gate;
- the same Mission closes against the original Contract with a verified
  Receipt.

If an external execution provider is described as verified for the run, it must
actually own that run's workspace or execution lifecycle.

[One controlled local run](../evidence/e1-local-2026-08-24.json) satisfies this
gate for commit `b16bd0b`: Codex was interrupted with `SIGTERM` after meaningful
work, Qoder acknowledged the budgeted Capsule while its workspace digest still
matched the recorded handoff baseline, continued there without manual context
transfer, and the original Contract produced a verified Receipt with no
unresolved items. A [same-host, task-context-isolated fresh-clone
run](../evidence/e1-context-isolated-reproduction-local-2026-08-24.json)
reproduced the path against public commit `f73bc24` and explicitly replayed the
verifier to issue another verified Receipt. The exact checkpoint-helper content
also completed a [local real-runtime validation](../evidence/e1-checkpoint-helper-local-2026-08-24.json)
with a second verified Receipt. The [earlier blocked
run](../evidence/e1-blocked-local-2026-08-24.json) is retained as failure
history. These records do not establish third-party or cross-host
reproducibility, production readiness, or compatibility beyond the controlled
Codex-to-Qoder fixture.

### E2 — The Mission can replan, replay, and fork

E2 requires:

- observable failure evidence can trigger a safe replan;
- a checkpoint can create isolated branches without contaminating the source;
- deterministic decisions and safe reads can replay, while external Effects are
  inherited, reconciled, or newly authorized rather than blindly repeated;
- automatic process-tree ownership and isolated recovery are demonstrated;
- the user can inspect the selected Profile, planning reasons, Capsule, Effect
  state, failure evidence, and Receipt.

Before E2, MissionBraid does not claim automatic failover or time travel.

### Product milestone — Unified Workbench

[One clean-public-clone run](../evidence/unified-workbench-codex-qoder-local-2026-08-24.json)
binds the product-shaped path to `c55dd54`: six target Harnesses were visible,
Codex and Qoder were selectable as Runtime Profiles, one web submission created
and ran the Mission, both Attempts changed the same disposable workspace, the
Capsule was acknowledged before Qoder mutation, the verifier passed, and a new
Workbench process restored the same Receipt. This milestone does not satisfy
E2 automatic replanning or broaden execution support beyond Codex and Qoder.

## Evaluation after the flagship path

A same-host, task-context-isolated run from a clean public clone has reproduced
E1. The next external evidence upgrade is a third-party or cross-host
reproduction. Matched evaluation will use the same repository revision, Outcome
Contract, profiles, interruption point, and cost limits:

- manual restart versus MissionBraid process recovery;
- manual context transfer versus MissionBraid Capsule transfer;
- relevant strong baselines where their supported runtime pair overlaps.

Primary measures are verified Mission completion, successful first action after
handoff, manual context-transfer effort, Capsule core fidelity, duplicate
confirmed Effects, cost and latency, attribution coverage, and independent
Receipt replay.

## Scope discipline

While evidence remains limited to controlled local and same-host runs, the
project will not prioritize:

- secondary dashboards beyond the implemented local Workbench;
- a generic plugin marketplace;
- a broad runtime compatibility matrix;
- distributed or multi-host state;
- production-readiness claims;
- additional reliability machinery not exposed by the real vertical path.

The next product capability is deterministic `filter → rank → record` planning
over the Runtime Profiles already exposed by the Workbench, followed by one
additional real adapter and evidence-triggered E2 recovery. The next provider
item is a real Mission Attempt bound to an external worktree and complete
runtime lifecycle. Kandev v0.91.0's checked public API does not expose full
Session or Agent stop, so the completed compatibility check is not promoted to
Provider support. MissionBraid will not silently depend on Kandev's documented
internal, unversioned WebSocket protocol.

## Release policy

- Pre-alpha commits may expose incomplete interfaces and schema revisions.
- A tagged release requires reproducible evidence for every capability named in
  its release notes.
- E0, E1, and E2 claims remain independently gated.
- Published documentation must distinguish target design, local implementation,
  real-runtime verification, and production adoption.
