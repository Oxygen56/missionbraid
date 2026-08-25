# Iteration 5 Execution Fork fixture

`mode.txt` starts at `PENDING`. A real parent Harness changes and commits it as
`PARENT`. MissionBraid then captures a complete Composite Checkpoint and starts
Branch B from that exact Git commit. One guidance Intervention changes only the
isolated Branch B copy to `FORK-GUIDANCE`.
