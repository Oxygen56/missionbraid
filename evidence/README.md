# MissionBraid Evidence Index

MissionBraid keeps public claims tied to explicit evidence levels. A design, a
test fixture, a local real-Runtime run, a clean public-clone reproduction, and
production adoption are different results.

## Start here

The strongest product-shaped result is the
[Unified Workbench Codex-to-Qoder run](unified-workbench-codex-qoder-local-2026-08-24.json).

It records one clean public-clone, same-host local Mission submitted through the
Workbench:

- the user did not author Mission YAML or copy context between Runtimes;
- Codex and Qoder both exited successfully and made distinct workspace changes;
- Qoder acknowledged the hash-bound Capsule before its mutation;
- the original verifier passed 12 target tests;
- the 26-event chain produced a verified Receipt with no unresolved item;
- a new Workbench process restored the same Mission and Receipt.

It does **not** prove automatic routing, arbitrary Harness compatibility,
third-party reproduction, hostile-Runtime isolation, production readiness, or
adoption.

## Evidence catalog

| Record                                                                                          | Evidence level                                    | What it establishes                                                                                                      | What it does not establish                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [Unified Workbench Codex→Qoder](unified-workbench-codex-qoder-local-2026-08-24.json)            | Clean-public-clone local real Runtime             | Product entry, ordered real Attempts, Capsule acknowledgement before mutation, verified Receipt, app restart restoration | Automatic planning, broad adapters, third-party or production results                  |
| [E0 controller recovery](e0-local-2026-08-24.json)                                              | Local real Runtime                                | One controlled Mission recovers after controller `SIGKILL` and closes against the original Contract                      | Independent reproduction or general crash safety                                       |
| [E1 interrupted Codex→Qoder](e1-local-2026-08-24.json)                                          | Local real Runtime                                | Meaningful Codex checkpoint, Qoder continuation, original verifier and Receipt                                           | Arbitrary task or Runtime compatibility                                                |
| [Task-context-isolated E1 reproduction](e1-context-isolated-reproduction-local-2026-08-24.json) | Clean-public-clone, separate local task context   | Fresh Mission state/workspace reproduced the controlled E1 path                                                          | New host, new user configuration, or third-party reproduction                          |
| [Checkpoint-helper E1 validation](e1-checkpoint-helper-local-2026-08-24.json)                   | Local real Runtime with exact interruption helper | Helper-bound interruption point and resulting verified Receipts                                                          | General interruption policy or production automation                                   |
| [Earlier blocked E1](e1-blocked-local-2026-08-24.json)                                          | Retained local failure history                    | Qoder stopped before acknowledgement and MissionBraid issued no false Receipt                                            | Successful continuity                                                                  |
| [Kandev v0.91.0 public-interface check](kandev-v0.91.0-provider-check-local-2026-08-24.json)    | Clean-clone local compatibility check             | Fresh-create and deduplicated rerun for checked task, worktree, and custom-process endpoints                             | Kandev-backed Mission, full Session/Agent lifecycle, Outcome Receipt, Provider support |

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
other host state. The next evidence upgrade is a third-party or cross-host
reproduction under a documented Runtime Profile boundary.
