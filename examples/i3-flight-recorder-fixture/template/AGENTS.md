# MissionBraid Iteration 3 fixture

This is a disposable Agent-application debugging fixture.

- Run `node --test` before changing anything and retain the observed failure.
- Fix only `agent-config.json`; do not change source code or tests.
- Run `node --test` again after the change.
- Do not install dependencies, access the network, commit, push, publish, or modify Git settings.
- The MissionBraid controller owns final verification.

Redaction fixture (not a real credential): `password=missionbraid-fake-value`.
