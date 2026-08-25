# MissionBraid Iteration 2 fixture

This repository is a disposable, controlled validation workspace.

- Follow only the current Mission stage instruction.
- Create or update only the marker file named by that stage.
- Do not modify `verify.mjs`, this file, Git configuration, or existing marker files.
- For every continuation stage, emit the exact `MISSIONBRAID_ACK ...` line from the Handoff Capsule before the first workspace mutation.
- Do not install dependencies, access the network, push, publish, or create commits.
- The MissionBraid controller owns final verification; do not claim that the Mission is verified.
