# MissionBraid Adapter SDK v1

The Adapter SDK lets a Runtime integration describe its capabilities, discover
its native binding, emit sanitized evidence, and report a Runtime run outcome.
The host retains Mission, Branch, Effect, failure, permission, and Receipt
authority.

## Install the current local package

MissionBraid has not been published to a package registry. Build a local
tarball and install that exact artifact into a clean consumer directory:

```sh
pnpm build
npm pack --ignore-scripts --pack-destination /tmp
mkdir -p /tmp/missionbraid-consumer
cd /tmp/missionbraid-consumer
npm init -y
npm install /tmp/missionbraid-1.0.0.tgz
```

Stable v1 imports are explicit:

```js
import { ADAPTER_API_VERSION, defineAdapterV1 } from 'missionbraid/adapter-sdk/v1';
import { runAdapterConformanceSuiteV1 } from 'missionbraid/adapter-conformance/v1';
```

Unversioned aliases remain available within the package 1.x release line.

## Run the packaged examples

The tarball contains three executable examples:

- `examples/third-party-adapter`: direct Adapter;
- `examples/acp-adapter`: ACP v1 JSON-RPC over stdio with a local fixture Agent;
- `examples/process-provider-adapter`: provider-owned child process behind the
  replaceable `ProcessExecutionProviderV1` boundary.

Copy any directory into the consumer project and run its verifier:

```sh
cp -R node_modules/missionbraid/examples/acp-adapter ./my-acp-adapter
node my-acp-adapter/verify.mjs
```

Each example imports only installed package exports and runs the same public
conformance suite. The ACP fixture proves the wire mapping, not interoperability
with every production ACP Agent. The process-provider fixture proves the
replaceable provider contract, not Kandev compatibility.

## Choose a transport

- `direct`: the Adapter binds a local executable and receives a local
  workspace.
- `acp`: the Adapter binds an ACP endpoint and may receive a local or provider
  workspace.
- `provider-backed`: the Adapter binds a provider session and provider
  workspace.

Transport does not imply capability. Each Adapter separately declares whether
it supports context capture, steering, interruption, pre-tool gating, resume,
native Fork, workspace restoration, or external Effect control, and at what
fidelity.

`missionbraid/process-provider/v1` exports
`createProcessProviderAdapterV1` and the minimal provider contract. A provider
maps an opaque workspace reference, starts and observes its own process, and
returns sanitized ordered evidence. It receives no Mission state transition
port.

## Load an Adapter into a Mission

An external ESM module exports one Adapter as `default` or `adapter`, or an
array as `adapters`. Its manifest declares both a stable Adapter identity and
the real Harness identity shown throughout the Mission:

```js
const manifest = {
  // version fields omitted
  adapterId: 'example.third-party-direct',
  harnessId: 'my-harness',
  displayName: 'My Harness Adapter',
  // transport, nativeProtocol, and capabilities omitted
};
```

Bind the same two identities in the Mission profile. An external Adapter must
not masquerade as Codex, Qoder, or Claude:

```yaml
attemptPlan:
  - stageId: external-runtime
    profile:
      harness: my-harness
      adapterId: example.third-party-direct
      model: default
      permissionMode: workspace-write
      injectionBudgetTokens: 4000
    instruction: Complete the declared workspace task.
    onFailure: stop
```

Provider-backed profiles additionally set an opaque `providerWorkspaceRef`.
Do not put a local credential or access token in this field.

Run the same module through either installed product entry:

```sh
missionbraid run mission.yaml --workspace /absolute/worktree \
  --adapter /absolute/consumer/adapter.mjs

missionbraid app --adapter /absolute/consumer/adapter.mjs
```

Adapter module paths are process-start configuration in v1. Pass every
`--adapter` path again whenever the CLI or Workbench process restarts; v1 does
not claim a persistent plugin installer.

The Workbench Runtime Hub lists the registered Adapter with its real
`harnessId`, and the Mission form offers it as a route. The creation endpoint
validates Adapter discovery and the manifest/Profile identity binding before
queueing the run. Adding the module does not modify the Mission, Branch,
Effect, failure, or Receipt state machines.

For a `direct` or locally bound `acp` Adapter, controller Execution Fork starts
a fresh run of the same Adapter in the isolated Git worktree. This is distinct
from the optional SDK `native-fork` and `resume` declarations: the Engine does
not claim to invoke those methods in v1. A provider-backed or opaque provider
workspace cannot be restored into that local worktree, so Execution Fork
rejects it explicitly and never falls back to a built-in Harness.

## Pass conformance honestly

`runAdapterConformanceSuiteV1` checks the manifest, binding shape, ordered and
sanitized evidence, Runtime-only outcome, and the Kernel-authority boundary.
That boundary is the actual SDK port surface: the host exposes evidence append
and an optional tool-gate decision port, but no Kernel mutation port. Field
names inside sanitized native evidence remain non-authoritative data and are
not mistaken for state transitions.
Any optional capability declared `supported` must expose its SDK method and a
behavioral probe. Mark unavailable behavior `unsupported`, and behavior that
cannot yet be observed `unknown`.

The suite produces `local-conformance` evidence only. An independently built
Adapter and an independent operator reproducing the flagship workflow remain
separate evidence requirements.

The current Kandev v0.91.0 compatibility check establishes public task,
worktree, and preconfigured custom-process lifecycle calls. It does not
establish arbitrary Mission instruction delivery or result capture, so the
provider-backed example does not claim to be a Kandev execution Adapter.

## Verify the packaged product

From the MissionBraid repository, run:

```sh
pnpm test:package
```

The smoke test builds a tarball, installs it in a newly created temporary
consumer, runs all three Adapter examples, creates a new consumer Adapter using
only installed exports, and runs real verified Missions through the installed
CLI and the visible Workbench form. It then creates a Composite Checkpoint and
runs an isolated Execution Fork through the same external Adapter. It does not
publish a package and is not independent third-party evidence.
