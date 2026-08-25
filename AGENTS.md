# MissionBraid engineering rules

- Mission Kernel events are the sole source of truth for Mission control state.
  Native Harnesses, Git, tools, and external systems remain evidence sources for
  their own real state; projections and the outbox are not business authority.
- Persist and deduplicate runtime events before acknowledging or projecting
  them. A model transcript is evidence input, not authoritative state.
- Model output cannot directly mark a Mission verified, grant permissions,
  approve an external action, or create a public claim.
- Every mutable action MissionBraid controls or observes must have an Effect
  identity; unobservable boundaries remain unknown. External or irreversible
  Effects additionally require exact authority, an idempotency mechanism when
  available, reconciliation evidence, scope, and an immutable receipt.
- Keep credentials behind runtime adapters. Never place secrets in prompts,
  traces, fixtures, logs, committed evidence, or generated documentation.
- Public claims must identify their evidence level. Design, fixture tests,
  local real-runtime runs, published code, and production adoption are distinct.
- MissionBraid is an independent project. Do not copy Kandev or Multica source,
  internal types, private protocols, UI, or restricted content. Preserve every
  upstream license and attribution for code intentionally reused.
- Follow the accepted ten-iteration product roadmap. Preserve one evolving
  flagship Mission and expose each new capability through the real Workbench
  path; an isolated schema, adapter count, test suite, or infrastructure layer
  is not an iteration result.
- The target scope is the full Agent Runtime Workbench. Do not narrow it merely
  because adjacent projects overlap, and do not add work outside the accepted
  iteration order unless the user changes that order.
- Keep debugger claims exact: observation, interruption, gating, steering, and
  reconstruction are different capabilities. Playback, cached replay,
  counterfactual resampling, and execution fork are different operations.
  Projection rebuild and playback do not branch; new replay evidence does.
- Authority can remain equal or narrow during resume, Fork, and Handoff.
  Expansion requires an explicitly authorized Grant or Contract revision.
- The current Git digest/delta checkpoint is boundary evidence, not a restorable
  snapshot. Only a complete composite Checkpoint may be described as resumable
  or forkable state.
- Runtime state belongs under `.missionbraid/` and must remain untracked.
- Tests must not push, publish, deploy, send messages, charge money, or modify
  repositories outside their explicit disposable workspace.
- Preserve unrelated repositories and user changes. Source material outside
  this repository is read-only unless the user explicitly places it in scope.
- Do not push, publish packages, create releases, or make other public changes
  unless the user has explicitly authorized the exact action.
