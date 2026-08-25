# MissionBraid Evidence Index

MissionBraid keeps public claims tied to explicit evidence levels. A design, a
test fixture, a local real-Runtime run, a clean public-clone reproduction, and
production adoption are different results.

## Start here

The strongest current product-shaped results are the
[Iteration 5 Checkpoint/Replay record](iteration-5-checkpoint-replay-local-2026-08-26.json)
and its real-workspace
[Iteration 5 Execution Fork](iteration-5-execution-fork-local-2026-08-26.json).
They build on the retained
[Iteration 3 live flight recorder](iteration-3-flight-recorder-local-2026-08-26.json),
[Iteration 4 native Tool Gateway](iteration-4-tool-gateway-local-2026-08-26.json),
[Iteration 4 external Effect recovery](iteration-4-external-effect-local-2026-08-26.json),
and earlier
[Iteration 2 three-Harness Workbench run](iteration-2-three-harness-local-2026-08-25.json).

The Iteration 2 record captures one clean-revision, same-host local Mission
submitted through the normal Workbench API:

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

The Iteration 5 record adds one same-host real product flow: Codex produced and
a deterministic verifier checked the parent delta; the local proof controller
then sealed that exact delta as a Git commit because the Codex workspace
sandbox could not write Git metadata; the browser created a Git-backed
Composite Checkpoint; and a fresh real Codex process continued only in Branch
B's isolated worktree. Branch A stayed unchanged, both Receipts were retained,
one confirmed queryable external Effect was inherited without repetition, and
the Workbench reconstructed the state after restart.

This is an Execution Fork from an explicit Git boundary, not a native Codex
session fork or resume. The Checkpoint/Replay record separately exercises all
four Replay semantics: Playback, Cached Replay, Counterfactual Resampling, and
Execution Fork. Only Execution Fork launches a real future workspace Attempt;
the other three preserve their documented no-tool or no-workspace-mutation
semantics. These records do **not** prove a Codex-authored parent commit,
native session migration, a natural Harness failure, cross-host or third-party
reproduction, hostile-Runtime isolation, production readiness, or adoption.

## Iterations 2–5 local validation

Iteration 2 is implemented in source, including Codex/Qoder/Claude Code
execution Adapters, the root Branch, the four-part Runtime Profile model,
source-scoped Event IR with sanitized native artifacts, durable command/outbox
recovery, and the bilingual Workbench.

The linked records satisfy the Iteration 2, 3, 4, and the Iteration 5
completion gates at the **same-host local real-Runtime** level. Iteration 3
retains live Codex and Claude Code events, a causal failed-test path,
redaction, measured journal-to-browser latency, and restart-stable ordering.
Iteration 4 retains both the native pre-dispatch Tool Gateway flow and the
external Effect crash/reconciliation flow. Iteration 5 retains the Git-backed
Checkpoint, isolated child worktree, fresh Codex process, Branch-bound Receipt,
no-repeat Effect inheritance, restart reconstruction, and local evidence for
all four Replay semantics. Iteration 6 has a separate same-host record for a
controlled Codex interruption followed by deterministic Profile selection and
native Handoff. Iterations 7–9 currently have implementation/API/local-test
slices but no real-Runtime evidence; Iteration 10 has an internal clean-install
package smoke. Stronger cross-host, independent, or production evidence remains
open.

## Evidence catalog

| Record                                                                                          | Evidence level                                                         | What it establishes                                                                                                                                                                    | What it does not establish                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Iteration 5 Checkpoint/Replay](iteration-5-checkpoint-replay-local-2026-08-26.json)            | Same-host real Codex/Qoder/Claude, browser, and local proof controller | Restorable Composite Checkpoint; Playback, Cached Replay, Counterfactual Resampling, and Execution Fork records; no-tool/no-repeat semantics; restart                                  | Native session fork/resume or migration, natural Harness failure, cross-host, production, independent reproduction                                   |
| [Iteration 5 Execution Fork](iteration-5-execution-fork-local-2026-08-26.json)                  | Same-host real Codex, browser, and Git worktree                        | Controller-sealed parent boundary, Git-backed Checkpoint, isolated fresh-Codex child Branch, both Receipts, no-repeat Effect, restart                                                  | Codex-authored commit, native session fork/resume, other Harnesses, cross-host, production, independent reproduction                                 |
| [Iteration 6 adaptive Handoff](iteration-6-adaptive-handoff-local-2026-08-26.json)              | Same-host real Codex/Qoder/Claude and browser; controlled interruption | Preferred Profile success without fallback; controlled Codex interruption; deterministic filter/rank; Capsule ACK before first target tool; no-repeat Effect; verifier/Receipt/restart | Natural model/quota/network failure, restorable Handoff workspace, native session migration/resume, cross-host, production, independent reproduction |
| [Iteration 4 native Tool Gateway](iteration-4-tool-gateway-local-2026-08-26.json)               | Same-host real native hook and browser                                 | Pre-dispatch block, browser input modification, Kernel decision before release, same-Mission Receipt, restart                                                                          | Universal Harness control, child-process containment, production or external reproduction                                                            |
| [Iteration 4 external Effect recovery](iteration-4-external-effect-local-2026-08-26.json)       | Same-host real HTTP target and controller crash                        | Durable intent, one dispatch, controller `SIGKILL`, lookup-before-retry reconciliation, Receipt, restart                                                                               | Non-queryable targets, universal exactly-once, production or external reproduction                                                                   |
| [Iteration 3 live flight recorder](iteration-3-flight-recorder-local-2026-08-26.json)           | Same-host live real Runtime and browser                                | Live Codex/Claude events, Context Graph, failed-test causality, redaction, latency, restart                                                                                            | Hidden model state, all Harness semantics, production or external reproduction                                                                       |
| [Iteration 2 Codex→Qoder→Claude](iteration-2-three-harness-local-2026-08-25.json)               | Same-host local real Runtime                                           | Three real Attempts, Runtime model, source-scoped Event IR/native artifacts, cooperative Handoff ordering, Receipt, restart                                                            | Tool gate, auto-routing, Fork/Replay, cross-host or production results                                                                               |
| [Unified Workbench Codex→Qoder](unified-workbench-codex-qoder-local-2026-08-24.json)            | Clean-public-clone local real Runtime                                  | Product entry, ordered real Attempts, matching checkpoint/baseline workspace snapshot, distinct workspace digests, Receipt, restart                                                    | Enforced pre-mutation gate, automatic planning, broad adapters, third-party or production results                                                    |
| [E0 controller recovery](e0-local-2026-08-24.json)                                              | Local real Runtime                                                     | One controlled Mission recovers after controller `SIGKILL` and closes against the original Contract                                                                                    | Independent reproduction or general crash safety                                                                                                     |
| [E1 interrupted Codex→Qoder](e1-local-2026-08-24.json)                                          | Local real Runtime                                                     | Meaningful Codex checkpoint, Qoder continuation, original verifier and Receipt                                                                                                         | Arbitrary task or Runtime compatibility                                                                                                              |
| [Task-context-isolated E1 reproduction](e1-context-isolated-reproduction-local-2026-08-24.json) | Clean-public-clone, separate local task context                        | Fresh Mission state/workspace reproduced the controlled E1 path                                                                                                                        | New host, new user configuration, or third-party reproduction                                                                                        |
| [Checkpoint-helper E1 validation](e1-checkpoint-helper-local-2026-08-24.json)                   | Local real Runtime with exact interruption helper                      | Helper-bound interruption point and resulting verified Receipts                                                                                                                        | General interruption policy or production automation                                                                                                 |
| [Earlier blocked E1](e1-blocked-local-2026-08-24.json)                                          | Retained local failure history                                         | Qoder stopped before acknowledgement and MissionBraid issued no false Receipt                                                                                                          | Successful continuity                                                                                                                                |
| [Kandev v0.91.0 public-interface check](kandev-v0.91.0-provider-check-local-2026-08-24.json)    | Clean-clone local compatibility check                                  | Fresh-create and deduplicated rerun for checked task, worktree, and custom-process endpoints                                                                                           | Kandev-backed Mission, full Session/Agent lifecycle, Outcome Receipt, Provider support                                                               |

The following iterations are represented by implementation and API tests, not
real-Runtime product evidence:

| Slice                            | Evidence level                       | What is available                                                                                                        | Boundary                                                              |
| -------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Iteration 7 Failure Intelligence | Implementation/API/local tests       | Event-chain projection of runtime, context, tool, workspace, verification, checkpoint, and diagnostic-candidate evidence | No real fault run or independent diagnosis accuracy claim             |
| Iteration 8 Mission Plan runtime | Implementation/API/local tests       | Versioned plan DAG, selective invalidation, node execution projection, and Workbench/API view                            | No multi-Agent execution/revision study or real planner outcome claim |
| Iteration 9 Outcome Studio       | Implementation/API/local tests       | Agent Revision dimensions, evaluation/incident/CI projections, scenario save/export APIs                                 | No benchmark, CI pipeline, or regression-quality claim                |
| Iteration 10 package contract    | Internal clean-install package smoke | Tarball manifest, public exports, adapter conformance, installed CLI/Workbench startup                                   | No registry publication or independent external reproduction          |

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

All current runtime records are local and same-host. Clean-worktree or
clean-clone runs isolate repository revision, Mission state, and target
workspace, but may reuse authenticated Runtime installations, user-level
instructions, Skills, MCP configuration, and other host state. The next
evidence-level upgrade is a third-party or cross-host reproduction under a
documented Runtime Profile boundary. The Iteration 6 planner result is a
controlled-interruption demonstration rather than a natural-failure benchmark;
the Iteration 7–9 slices are not runtime evidence; and the Iteration 10 smoke
does not establish registry publication or independent external installation.
