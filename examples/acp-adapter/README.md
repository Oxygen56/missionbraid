# ACP Adapter example

This example runs an ACP v1 JSON-RPC session over stdio: `initialize`,
`session/new`, `session/prompt`, ordered `session/update` notifications, and the
prompt response. The fixture validates MissionBraid's ACP transport mapping; it
does not claim interoperability with every production ACP Agent.

Run `node verify.mjs` from a consumer project that has installed MissionBraid.
