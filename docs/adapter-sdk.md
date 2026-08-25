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

## Start with the copyable example

The package contains
`examples/third-party-adapter/adapter.mjs` and a conformance runner. Copy that
directory into the consumer project, then run:

```sh
cp -R node_modules/missionbraid/examples/third-party-adapter ./my-adapter
node my-adapter/verify.mjs
```

The example proves that an Adapter can be implemented against package exports
without importing Mission Kernel modules. It deliberately supports only three
baseline capabilities: discovery, observation, and workspace binding.

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

## Pass conformance honestly

`runAdapterConformanceSuiteV1` checks the manifest, binding shape, ordered and
sanitized evidence, Runtime-only outcome, and the Kernel-authority boundary.
Any optional capability declared `supported` must expose its SDK method and a
behavioral probe. Mark unavailable behavior `unsupported`, and behavior that
cannot yet be observed `unknown`.

The suite produces `local-conformance` evidence only. An independently built
Adapter and an independent operator reproducing the flagship workflow remain
separate evidence requirements.

## Verify the packaged product

From the MissionBraid repository, run:

```sh
pnpm test:package
```

The smoke test builds a tarball, installs it in a newly created temporary
consumer, runs the copyable Adapter through conformance, imports every public
v1 surface, invokes the installed CLI, starts the installed local Workbench,
and checks its browser and JSON endpoints. It does not publish a package.
