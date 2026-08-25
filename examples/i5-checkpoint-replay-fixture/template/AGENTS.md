# MissionBraid Iteration 5 Checkpoint Replay fixture

This disposable repository is a controlled same-host Checkpoint Replay proof.

- Read `task-state.txt` before acting.
- Never edit `AGENTS.md`, `README.md`, `task-state.txt`, `hold-open.mjs`, or `verify.mjs`.
- Do not install dependencies, access the network, push, publish, deploy, or send messages.
- Change only `source.txt` and `final.txt`, as allowed below.

When there is no MissionBraid Handoff Capsule in the controller prompt:

1. Create `source.txt` with exactly `source-sealed` followed by one newline.
2. Do not create or edit `final.txt`.
3. After the source file exists, run `node hold-open.mjs` and wait. The local proof runtime-provider controls the process boundary; do not simulate or describe a failure yourself.

When the controller prompt contains a MissionBraid Handoff Capsule:

1. Emit the exact `MISSIONBRAID_ACK {...}` line requested by the Capsule before invoking any tool or changing any file.
2. Confirm that `source.txt` already contains exactly `source-sealed` followed by one newline; preserve it unchanged.
3. Create `final.txt` with exactly `source-future-complete` followed by one newline.
4. Run `node verify.mjs` and stop after it passes.
