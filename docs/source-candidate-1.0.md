# MissionBraid 1.0 source candidate

This document is the public release note and reproduction guide for the
MissionBraid 1.0 **source candidate**. It describes what can be built and
reproduced from the repository today; it is not a package-registry release or
a production-readiness announcement.

## Status and claim boundary

- The source candidate contains the implementation surfaces for all ten planned
  product iterations. That implementation statement does not upgrade every
  iteration to independent or production evidence.
- MissionBraid has **not** been published to npm. Install the candidate from a
  locally built tarball.
- The retained records are internal, local, and usually same-host or
  controlled-fixture evidence. They are not production evidence.
- No independent third party has yet implemented an Adapter and reproduced the
  product workflow. A clean temporary consumer created by the project is not
  an independent external reproduction.
- The candidate does not claim native model-state migration, universal Harness
  control, cross-host continuity, natural-failure recovery, or production
  isolation.
- This note does not claim that a single unified flagship workflow covering
  every capability has been completed.
- Codex, Qoder, and Claude Code are direct Mission Adapters; Claude has one
  request-scoped native pre-tool gate. OpenCode, Hermes, and DeepSeek Harness
  remain catalog-only.

## Evidence-backed candidate contents

Every capability below links to the retained record that supports the claim.
The linked record's own boundary takes precedence over this summary.

| Capability available in the source candidate                                                                                                                                                                                                                                                                                                                      | Retained evidence                                                                                                                                                                                   | Claim boundary                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Local tarball build, stable public v1 exports, clean-directory installation, installed CLI and Workbench Missions, a consumer-style external Adapter identity chain through both entries, Workbench form creation, same-Adapter isolated Execution Fork, verified Receipts, and store schema v1 to v2 migration without changing the retained Mission event chain | [Iteration 10 package smoke](https://github.com/Oxygen56/missionbraid/blob/main/evidence/iteration-10-package-smoke-local-2026-08-26.json)                                                          | One internal clean-install artifact run; no npm publication, independent operator, or current-revision binding           |
| Separate source-candidate bundle containing the exact lockfile, followed from its extracted tree by frozen install, typecheck, build, and the full 362-test suite without repository fallback                                                                                                                                                                     | [Iteration 10 package smoke](https://github.com/Oxygen56/missionbraid/blob/main/evidence/iteration-10-package-smoke-local-2026-08-26.json)                                                          | Internal reproduction of the recorded bundle; not independent or cross-host validation                                   |
| Public Adapter SDK and conformance suite, with executable direct, ACP-over-stdio, and provider-backed examples                                                                                                                                                                                                                                                    | [Iteration 10 package smoke](https://github.com/Oxygen56/missionbraid/blob/main/evidence/iteration-10-package-smoke-local-2026-08-26.json)                                                          | Local fixtures; ACP coverage is not universal interoperability, and the process-provider example is not Kandev execution |
| Native Codex, Qoder, and Claude Code Attempts under one Mission, Runtime Profile records, source-scoped Event IR, cooperative Handoff ordering, verified Receipt, and restart reconstruction                                                                                                                                                                      | [Iteration 2 three-Harness Mission](../evidence/iteration-2-three-harness-local-2026-08-25.json)                                                                                                    | Same-host authenticated local Runtimes; not cross-host or production evidence                                            |
| Live Runtime evidence, Context Graph, causal failed-test path, redaction, browser delivery, and restart-stable ordering                                                                                                                                                                                                                                           | [Iteration 3 flight recorder](../evidence/iteration-3-flight-recorder-local-2026-08-26.json)                                                                                                        | One same-host controlled workflow; no hidden-state visibility or universal semantic coverage                             |
| A supported Claude Code request stopped at a native pre-tool boundary and released only after a Kernel decision                                                                                                                                                                                                                                                   | [Iteration 4 Tool Gateway](../evidence/iteration-4-tool-gateway-local-2026-08-26.json)                                                                                                              | One supported native hook path; not universal Harness containment                                                        |
| Durable external-Effect intent, controller crash, lookup-before-retry reconciliation, one target call, Receipt, and restart                                                                                                                                                                                                                                       | [Iteration 4 external Effect recovery](../evidence/iteration-4-external-effect-local-2026-08-26.json)                                                                                               | Queryable controlled HTTP target; not universal exactly-once delivery                                                    |
| Git-backed Composite Checkpoint, Playback, Cached Replay, model-only Counterfactual Resampling, and isolated Execution Fork semantics                                                                                                                                                                                                                             | [Iteration 5 Checkpoint and Replay](../evidence/iteration-5-checkpoint-replay-local-2026-08-26.json) and [Iteration 5 Execution Fork](../evidence/iteration-5-execution-fork-local-2026-08-26.json) | Fresh processes and explicit Git boundaries; not native Session fork, resume, or migration                               |
| Deterministic Runtime Profile filtering and ranking, Handoff Capsule acknowledgement, no-repeat Effect handling, verification, and restart after a controlled Runtime interruption                                                                                                                                                                                | [Iteration 6 adaptive Handoff](../evidence/iteration-6-adaptive-handoff-local-2026-08-26.json)                                                                                                      | Controlled interruption; not a natural model, quota, or network failure benchmark                                        |
| Observable stale-Context diagnosis, isolated Context-refresh Intervention, a fresh Qoder Attempt under the same Profile, verified result, saved regression scenario, and restart reconstruction                                                                                                                                                                   | [Iteration 7 stale Context](../evidence/iteration-7-stale-context-2026-08-26.json)                                                                                                                  | One controlled mechanism; not general attribution accuracy, hidden-input equality, or native Session continuation        |
| Persistent Mission Plan execution with real Qoder and Claude Code nodes, live Contract revision, selective invalidation, verified Artifact reuse, independent consolidation, latest-revision Receipt, and restart reconstruction                                                                                                                                  | [Iteration 8 multi-Agent revision](../evidence/iteration-8-multi-agent-revision-local-2026-08-26.json)                                                                                              | One same-host controlled Git fixture; not distributed coordination or production adoption                                |
| Saved-incident execution with the accepted Context intervention on one distinct Planner-selected high-reasoning Qoder/Qwen3.8-Max Profile, three new Kernel-persisted trials passing a predeclared 3/3 threshold, restart reconstruction, and an outside-repository process that fails closed for returned or unknown results                                     | [Iteration 9 Outcome regression](../evidence/iteration-9-outcome-regression-local-2026-08-26.json)                                                                                                  | Same-host controlled fixture; not a Profile-only causal result, hosted CI pipeline, cross-host proof, or production      |
| Kandev v0.91.0 task, worktree, and preconfigured custom-process compatibility checks                                                                                                                                                                                                                                                                              | [Kandev public-interface check](../evidence/kandev-v0.91.0-provider-check-local-2026-08-24.json)                                                                                                    | Does not establish arbitrary Mission instruction delivery, result capture, or a Kandev-backed Mission                    |

The Claude direct Adapter compacts only high-volume
`system/thinking_tokens` telemetry. It preserves non-telemetry event semantics
and order, and records total raw/retained/dropped line counts plus a SHA-256 of
the full raw stream. Dropped per-token payloads are not retained. This is a
source-and-test boundary, not evidence of private-thinking capture, provider
token accuracy, or production performance. See the [evidence
index](../evidence/README.md) for the full classification.

## Prerequisites

- Node.js 24, 25, or 26;
- pnpm 11;
- Git;
- a POSIX-like shell for the commands below.

Native-Runtime workflows additionally require the selected Harness to be
installed and authenticated. The package and Adapter reproduction below uses
local fixtures and does not require Codex, Qoder, or Claude Code credentials.

## Reproduce the source candidate in one command

Start from a clean checkout:

```sh
git clone https://github.com/Oxygen56/missionbraid.git
cd missionbraid
pnpm install --frozen-lockfile
pnpm test:package -- --output evidence/iteration-10-package-smoke-local.json
```

The package smoke performs the following through the built tarball rather than
through private source imports:

1. builds and packs `missionbraid@1.0.0`;
2. installs the tarball in a fresh temporary consumer directory;
3. imports every public v1 surface;
4. runs the direct, ACP, and provider-backed Adapter examples through the
   public conformance suite;
5. creates a new consumer Adapter using only installed package exports;
6. executes that Adapter in a real Mission through the installed CLI and
   receives a verified Receipt;
7. loads the same Adapter in the installed Workbench, inventories it, creates a
   Mission over HTTP, and receives a Receipt;
8. creates an isolated Execution Fork through that same Adapter and verifies
   the child Receipt and Adapter/Profile/Attempt identity chain;
9. opens a schema-v1 store with the installed Workbench, migrates it to schema
   v2, preserves the original Mission/event/hash chain, and reads it through
   both Mission list and detail APIs;
10. builds a separate source-candidate bundle containing the exact lockfile,
    then runs frozen install, typecheck, build, and the full test suite from its
    extracted tree without falling back to repository files.

A successful JSON result must still report:

```json
{
  "evidenceLevel": "internal-clean-install",
  "claims": {
    "registryPublication": "not-performed",
    "independentExternalReproduction": "not-established"
  }
}
```

Those fields are expected boundaries, not failed checks.

## Install the tarball manually

Build the candidate and install it into a separate consumer directory:

```sh
pnpm build
mkdir -p .artifacts
npm pack --ignore-scripts --pack-destination .artifacts

CANDIDATE_REPOSITORY="$(pwd)"
CANDIDATE_CONSUMER="$(mktemp -d)"
cd "$CANDIDATE_CONSUMER"
npm init -y
npm install "$CANDIDATE_REPOSITORY/.artifacts/missionbraid-1.0.0.tgz"
./node_modules/.bin/missionbraid --help
```

This is a local artifact install. It must not be described as `npm install
missionbraid` until a registry publication actually exists.

## Reproduce the three Adapter contracts

From the clean consumer directory created above:

```sh
cp -R node_modules/missionbraid/examples/third-party-adapter ./direct-adapter
cp -R node_modules/missionbraid/examples/acp-adapter ./acp-adapter
cp -R node_modules/missionbraid/examples/process-provider-adapter ./provider-adapter

node direct-adapter/verify.mjs
node acp-adapter/verify.mjs
node provider-adapter/verify.mjs
```

Each command must return a conformance report with `"passed": true`. The
reports prove the declared local contract only:

- `direct` receives a host workspace binding and returns ordered sanitized
  Runtime evidence;
- `acp` exercises ACP v1 JSON-RPC over stdio against the included fixture
  Agent;
- `provider-backed` lets a provider own process start/observe/stop and opaque
  workspace mapping through `ProcessExecutionProviderV1`.

Transport does not imply capability. An Adapter must mark each optional
capability as supported, unsupported, or unknown, and a supported capability
must pass its behavioral probe.

## Load a consumer Adapter into the installed product

An Adapter module exports one Adapter as `default` or `adapter`, or several as
`adapters`. Load it through either installed entry:

```sh
./node_modules/.bin/missionbraid run /absolute/mission.yaml \
  --workspace /absolute/worktree \
  --state-dir /absolute/controller-state \
  --adapter /absolute/consumer-adapter/adapter.mjs

./node_modules/.bin/missionbraid app \
  --state-dir /absolute/controller-state \
  --port 4317 \
  --adapter /absolute/consumer-adapter/adapter.mjs
```

Bind both the manifest's real `harnessId` and its `adapterId` in the Mission's
Runtime Profile. Do not masquerade as a built-in Harness. A provider-backed
Adapter may also use an opaque `providerWorkspaceRef`. Adapter paths are
startup configuration and must be passed again after a process restart. The
complete profile example, SDK contract, Kernel-authority boundary, and
capability rules are in the [Adapter SDK guide](adapter-sdk.md).

The Adapter may submit sanitized Runtime evidence and a Runtime outcome. It
does not own Mission, Branch, Effect, failure, permission, or Receipt state.
Adding a new Adapter must not require changes to those Kernel state machines.

## What an independent reproduction would add

The current clean consumer is created and operated by the project itself. A
stronger external result requires an unrelated developer or operator to:

1. start from a named public revision;
2. install the tarball without repository-private imports;
3. implement or connect an Adapter using only the public SDK;
4. run conformance and an installed CLI or Workbench Mission;
5. publish the revision, environment, commands, report, Mission/Receipt
   identities, and claim boundary.

Until that record exists, the accurate description is **internal clean-install
source-candidate evidence**, not independent third-party adoption.

## Further reading

- [Adapter SDK v1](adapter-sdk.md)
- [Evidence index](../evidence/README.md)
- [Controlled runtime evidence reproduction](reproducing-evidence.md)
- [Architecture](architecture.md)
- [Roadmap](roadmap.md)
