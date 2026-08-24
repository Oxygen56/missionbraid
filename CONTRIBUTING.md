# Contributing to MissionBraid

MissionBraid is pre-alpha. Contributions are welcome when they preserve the
project's central boundary: the Mission Kernel owns control-plane truth, while
Runtimes and execution providers remain replaceable adapters.

## Before opening a change

Read the [project tour](docs/project-tour.md),
[architecture](docs/architecture.md), and [evidence index](evidence/README.md).
Please open an issue before implementing a new Runtime adapter, execution
provider, schema revision, or public capability claim so the contract and
evidence requirement can be agreed first.

Useful contribution areas include:

- reproductions of an existing evidence path on a fresh host;
- focused fixes exposed by the real Workbench or CLI paths;
- tests for Mission invariants, recovery, Capsule projection, or verifier
  behavior;
- Runtime detection improvements that keep unsupported execution explicit;
- documentation that makes a verified boundary easier to reproduce;
- adapter proposals with a versioned public process or protocol boundary.

Please do not add an adapter only to increase the visible Harness count. A new
adapter should execute a real Mission Attempt and define its lifecycle,
permissions, observation, interruption, and evidence semantics.

## Development setup

Requirements: Node.js 24–26, pnpm, and Git.

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

Tests must use disposable workspaces. They must not push, publish, deploy, send
messages, charge money, or mutate repositories outside the explicit fixture.

## Runtime support boundary

- Codex and Qoder have direct Mission execution adapters.
- Claude Code, OpenCode, Hermes, and DeepSeek Harness are catalog targets only.
- Kandev v0.91.0 has a separate compatibility check; it is not a supported
  Mission execution provider.
- Automatic optimal or quota-aware routing is not implemented.

A change must not present detection, configuration parsing, a mocked adapter, or
a provider compatibility probe as real Mission execution.

## Design invariants

- Persist and deduplicate Runtime events before projecting them.
- Treat model output and transcripts as evidence, not authoritative state.
- Do not let a Runtime edit the Outcome Contract, grant permissions, or mark a
  Mission verified.
- Give every mutable action an Effect identity and disclose its control level.
- Keep credentials inside adapters; never commit them to prompts, traces,
  fixtures, evidence, or documentation.
- Keep historical events append-only and projections rebuildable.
- Preserve unknown outcomes instead of upgrading them to success.

## Evidence and documentation

Public claims must distinguish:

1. target design;
2. implemented code;
3. fixture or unit validation;
4. local real-Runtime evidence;
5. clean-clone or independent reproduction;
6. production use or adoption.

New evidence should be machine-readable, revision-bound, free of credentials,
and include an explicit claim boundary. A model or Harness report is not an
Outcome Receipt.

## Pull requests

Keep changes focused and explain:

- the user-visible or invariant-level problem;
- why the change belongs in the Mission control plane;
- the exact verification performed;
- any capability or evidence boundary that remains open.

Do not copy third-party internal types, databases, private protocols, or UI.
Preserve licenses and attribution for any intentionally reused material.
