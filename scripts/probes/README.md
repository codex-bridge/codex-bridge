# Codex probes

These scripts verify the local Codex app-server protocol and Bridge compatibility. This directory only retains probes with stable package entry points that remain suitable for long-term maintenance. They are not production commands and should not run continuously in the Bot runtime directory.

## Before use

- Probes use the current shell's Codex configuration and credentials by default.
- Run probes that connect to or start `codex app-server` only in a low-risk test session or temporary directory.
- `probe-method-diff` starts an independent app-server process.

## Probes

- `probe-method-diff.ts`: initializes app-server and checks the protocol method registry and runtime responses.
- `probe-thread-timeline.ts`: reads the timeline for a specific thread; requires `THREAD_ID`.

## Guidelines

When adding a probe, document whether it starts app-server, sends a turn, or writes to a database or temporary directory. Destructive behavior must require an explicit environment variable or argument. Production code should import explicit modules under `src/` rather than a root-level compatibility shim.

Stable, read-only routine verification belongs in `yarn verify:codex --scenario <name>`, not this directory. It covers effective configuration, session inventory, a single thread, configuration reads after provider switches, and the basic protocol surface without sending a turn or modifying Bridge data.
