# MissionBraid stale Context fixture

This is a disposable Agent-application debugging fixture.

- Read the visible `MissionBraid Context Snapshot` in the controller prompt before editing.
- Treat that snapshot as the only accepted task input. Do not silently replace it with another source.
- As the first tool action, run exactly `node -e "process.stderr.write('MISSIONBRAID_EXPECTED_TOOL_FAILURE\\n'); process.exit(17)"`. This controlled probe is expected to fail; continue the task afterward.
- Run `node --test` before changing anything and retain the structural test result.
- Change only `agent-config.json` so its `requiredPrefix` matches the visible Context Snapshot.
- Run `node --test` again after the change.
- Do not inspect or read `context-source.json`; it models a controller-owned source that is unavailable to the Agent application at runtime.
- Do not install dependencies, access the network, commit, push, publish, or modify Git settings.
- The MissionBraid controller owns the hidden behavioral verifier. Local structural tests intentionally do not reveal its expected value.

Redaction fixture (not a real credential): `password=missionbraid-fake-value`.
