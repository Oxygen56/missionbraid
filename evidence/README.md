# MissionBraid Evidence Index

MissionBraid keeps public claims tied to explicit evidence levels. A design, a
test fixture, a local real-Runtime run, a clean public-clone reproduction, and
production adoption are different results.

## Start here

The strongest product-shaped result is the
[Iteration 2 three-Harness Workbench run](iteration-2-three-harness-local-2026-08-25.json).

It records one clean-revision, same-host local Mission submitted through the
normal Workbench API:

- the user did not author Mission YAML or manually copy context between
  Runtimes;
- real Codex, Qoder, and Claude Code Attempts all succeeded on one root Branch;
- Profile Definitions, Catalog Observations, immutable Snapshots, and Attempt
  Bindings identify the effective Runtime environments;
- 1,066 source-scoped Runtime events link to 1,066 sanitized native artifacts;
- two cooperative Handoff acknowledgements precede the target's first observed
  tool-request event in the corresponding native source stream;
- the Receipt is verified with no unresolved item;
- a new Workbench process restored the same Mission head, Receipt, source
  sequences, and causal links.

The Handoff result is ordering evidence, not an enforced live tool gate. The
record does **not** prove automatic routing, executable Fork/Replay, arbitrary
Harness compatibility, cross-host or third-party reproduction, hostile-Runtime
isolation, production readiness, or adoption.

## Iteration 2 local validation

Iteration 2 is implemented in source, including Codex/Qoder/Claude Code
execution Adapters, the root Branch, the four-part Runtime Profile model,
source-scoped Event IR with sanitized native artifacts, durable command/outbox
recovery, and the bilingual Workbench.

The linked record satisfies the Iteration 2 completion gate at the
**same-host local real-Runtime** level. Its implementation revision is
`d14201b`, the worktree was clean before the run, all three Attempts succeeded,
the event chain is valid, the Receipt is verified, and restart restoration is
stable. Iteration 3+ capabilities and stronger cross-host or production
evidence remain open.

## Evidence catalog

| Record                                                                                          | Evidence level                                    | What it establishes                                                                                                                 | What it does not establish                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Iteration 2 Codex→Qoder→Claude](iteration-2-three-harness-local-2026-08-25.json)               | Same-host local real Runtime                      | Three real Attempts, Runtime model, source-scoped Event IR/native artifacts, cooperative Handoff ordering, Receipt, restart         | Tool gate, auto-routing, Fork/Replay, cross-host or production results                            |
| [Unified Workbench Codex→Qoder](unified-workbench-codex-qoder-local-2026-08-24.json)            | Clean-public-clone local real Runtime             | Product entry, ordered real Attempts, matching checkpoint/baseline workspace snapshot, distinct workspace digests, Receipt, restart | Enforced pre-mutation gate, automatic planning, broad adapters, third-party or production results |
| [E0 controller recovery](e0-local-2026-08-24.json)                                              | Local real Runtime                                | One controlled Mission recovers after controller `SIGKILL` and closes against the original Contract                                 | Independent reproduction or general crash safety                                                  |
| [E1 interrupted Codex→Qoder](e1-local-2026-08-24.json)                                          | Local real Runtime                                | Meaningful Codex checkpoint, Qoder continuation, original verifier and Receipt                                                      | Arbitrary task or Runtime compatibility                                                           |
| [Task-context-isolated E1 reproduction](e1-context-isolated-reproduction-local-2026-08-24.json) | Clean-public-clone, separate local task context   | Fresh Mission state/workspace reproduced the controlled E1 path                                                                     | New host, new user configuration, or third-party reproduction                                     |
| [Checkpoint-helper E1 validation](e1-checkpoint-helper-local-2026-08-24.json)                   | Local real Runtime with exact interruption helper | Helper-bound interruption point and resulting verified Receipts                                                                     | General interruption policy or production automation                                              |
| [Earlier blocked E1](e1-blocked-local-2026-08-24.json)                                          | Retained local failure history                    | Qoder stopped before acknowledgement and MissionBraid issued no false Receipt                                                       | Successful continuity                                                                             |
| [Kandev v0.91.0 public-interface check](kandev-v0.91.0-provider-check-local-2026-08-24.json)    | Clean-clone local compatibility check             | Fresh-create and deduplicated rerun for checked task, worktree, and custom-process endpoints                                        | Kandev-backed Mission, full Session/Agent lifecycle, Outcome Receipt, Provider support            |

## Reading a record

Machine-readable evidence should identify:

- the exact implementation revision and tree;
- whether a clean clone and fresh build were used;
- the Mission, Contract, Attempt, Checkpoint, Capsule, Effect, verifier, and
  Receipt identities relevant to the claim;
- content hashes or event-chain hashes where available;
- the observed Runtime versions and result;
- cleanup or restart observations when they are part of the claim;
- an explicit `claimBoundary` describing what the run does not prove.

## Why failed evidence remains public

The blocked E1 record is intentionally retained. A trustworthy control plane
must be able to preserve an unknown or failed outcome without converting it into
success. Failure history also prevents later documentation from presenting the
successful path as inevitable.

## Reproduction boundary

All current records are local and same-host. Clean-clone runs isolate repository
revision, Mission state, and target workspace, but may reuse authenticated
Runtime installations, user-level instructions, Skills, MCP configuration, and
other host state. The next evidence-level upgrade is a third-party or cross-host
reproduction under a documented Runtime Profile boundary. Live tool gating,
automatic routing, and executable Fork/Replay require later product iterations,
not a stronger restatement of this same-host record.
