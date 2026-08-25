# MissionBraid Iteration 5 fixture

This disposable repository proves a real checkpoint Execution Fork.

- Read `mode.txt` before acting.
- In the parent Mission, when the value is `PENDING`, use a native file-editing tool to replace it with exactly `PARENT`, run `node verify.mjs`, and commit only `mode.txt` with commit message `complete parent boundary`. Use one-command Git identity flags if needed; do not change repository configuration.
- In an Execution Fork, follow the single declared guidance Intervention exactly. If it requests `FORK-GUIDANCE`, replace `PARENT` with exactly `FORK-GUIDANCE`, run `node verify.mjs`, and leave that Branch B change uncommitted so the isolated delta remains visible.
- Do not edit `AGENTS.md`, `README.md`, or `verify.mjs`.
- Do not install dependencies, access the network, push, publish, deploy, or send messages.
- Stop after the required verifier passes and the requested parent commit or Branch B delta exists.
