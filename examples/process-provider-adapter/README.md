# Process-provider Adapter example

This example implements the public `ProcessExecutionProviderV1` boundary with a
provider-owned child process, adapts it to the MissionBraid Adapter API, and
runs the packaged conformance suite. It is a replaceable provider contract, not
a claim that Kandev exposes the same interface.

Run `node verify.mjs` from a consumer project that has installed MissionBraid.
