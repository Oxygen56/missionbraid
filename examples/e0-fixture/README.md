# Controlled E0 fixture

This Mission uses the incomplete workspace prepared from
`examples/e1-fixture/template`. A real Codex process is interrupted only after
the worktree contains a meaningful implementation change. `resume` must then
continue the same Mission without the user restating the task and close the
original acceptance contract.

The verifier is outside the disposable workspace. It first confirms that the
public tests and fixture support file are byte-identical to the committed
template, then runs those tests in a child process with a clean environment.

This is evidence for one controlled local process-continuity path. It is not a
production-readiness or arbitrary-project claim.
