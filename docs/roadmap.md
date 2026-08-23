# MissionBraid Roadmap

> **Current status:** pre-alpha. The thin direct-adapter E0/E1 paths are
> implemented in code. One controlled local E0 run is verified against
> implementation commit `9d5b4d3`; one controlled local Codex-to-Qoder E1 run
> is verified against commit `b16bd0b`. Independent reproduction remains open.

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
- public-interface compatibility checks for Kandev;
- workspace and lifecycle binding without forking or importing provider state;
- real cross-runtime handoff with basic failure evidence.

### 5. Replanning and timeline

- evidence-backed failure candidates and bounded diagnostic probes;
- automatic safe replanning;
- checkpoint replay and isolated fork semantics;
- agentctl-compatible session projection where applicable.

### 6. Platform surface

- read-only Mission console over authoritative state;
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
unresolved items. The [earlier blocked
run](../evidence/e1-blocked-local-2026-08-24.json) is retained as failure
history. Neither record establishes independent reproducibility, production
readiness, or compatibility beyond the controlled Codex-to-Qoder fixture.

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

## Evaluation after the flagship path

The next evidence step is an independent reproduction of E1. Evaluation will
then compare matched runs using the same repository revision, Outcome Contract,
profiles, interruption point, and cost limits:

- manual restart versus MissionBraid process recovery;
- manual context transfer versus MissionBraid Capsule transfer;
- relevant strong baselines where their supported runtime pair overlaps.

Primary measures are verified Mission completion, successful first action after
handoff, manual context-transfer effort, Capsule core fidelity, duplicate
confirmed Effects, cost and latency, attribution coverage, and independent
Receipt replay.

## Scope discipline

While E0 and E1 evidence remains limited to single controlled local runs, the
project will not prioritize:

- a dashboard-first experience;
- a generic plugin marketplace;
- a broad runtime compatibility matrix;
- distributed or multi-host state;
- production-readiness claims;
- additional reliability machinery not exposed by the real vertical path.

The next work item is independent E1 reproduction, followed by the shortest
provider-bound path that can validate Kandev's workspace and lifecycle contract,
not the largest available feature list.

## Release policy

- Pre-alpha commits may expose incomplete interfaces and schema revisions.
- A tagged release requires reproducible evidence for every capability named in
  its release notes.
- E0, E1, and E2 claims remain independently gated.
- Published documentation must distinguish target design, local implementation,
  real-runtime verification, and production adoption.
