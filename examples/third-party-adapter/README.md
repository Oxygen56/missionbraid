# Minimal third-party Adapter

This copyable example imports only the public `missionbraid/adapter-sdk/v1`
and `missionbraid/adapter-conformance/v1` package paths. It does not import or
edit Mission, Branch, Effect, failure, or Receipt state machines.

After installing a MissionBraid package tarball, copy this directory outside
the MissionBraid repository and run:

```sh
node verify.mjs
```

The example declares only discovery, observation, and workspace binding as
supported. Every stronger capability remains explicitly unsupported until a
real implementation and a behavioral conformance probe exist.

Passing this example is local conformance evidence. It is not evidence of an
independently maintained Adapter or independent external reproduction.
