# MissionBraid engineering rules

- The Mission Kernel is the sole source of truth for Mission, Attempt, Effect,
  verification, and Receipt state.
- Persist and deduplicate runtime events before acknowledging or projecting
  them. A model transcript is evidence input, not authoritative state.
- Model output cannot directly mark a Mission verified, grant permissions,
  approve an external action, or create a public claim.
- Every mutable action must have an Effect identity. External or irreversible
  effects additionally require exact authority, an idempotency mechanism when
  available, reconciliation evidence, and an immutable receipt.
- Keep credentials behind runtime adapters. Never place secrets in prompts,
  traces, fixtures, logs, committed evidence, or generated documentation.
- Public claims must identify their evidence level. Design, fixture tests,
  local real-runtime runs, published code, and production adoption are distinct.
- MissionBraid is an independent project. Do not copy Kandev or Multica source,
  internal types, private protocols, UI, or restricted content. Preserve every
  upstream license and attribution for code intentionally reused.
- Prefer the shortest real vertical path. Until E0 and thin E1 are verified,
  do not add a dashboard, generic plugin framework, broad Harness matrix, or
  unrelated reliability machinery.
- Runtime state belongs under `.missionbraid/` and must remain untracked.
- Tests must not push, publish, deploy, send messages, charge money, or modify
  repositories outside their explicit disposable workspace.
- Preserve unrelated repositories and user changes. Source material outside
  this repository is read-only unless the user explicitly places it in scope.
- Do not push, publish packages, create releases, or make other public changes
  unless the user has explicitly authorized the exact action.
