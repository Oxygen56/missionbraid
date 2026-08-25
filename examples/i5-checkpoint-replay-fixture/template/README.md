# Iteration 5 Checkpoint Replay fixture

This disposable Git repository proves the three Checkpoint Replay modes through
the built MissionBraid Workbench. A real source Runtime produces one exact
delta, the local proof controller seals that delta as a Git commit, and a real
continuation Runtime later supplies persisted same-Branch future artifacts.

The repository-level proof script owns the controlled process interruption,
external Effect target, Replay requests, browser inspection, and restart check.
