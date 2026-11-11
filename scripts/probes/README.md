# Codex probes

These scripts verify the local Codex app-server protocol and Bridge compatibility. This directory only retains probes with stable package entry points that remain suitable for long-term maintenance. They are not production commands and should not run continuously in the Bot runtime directory.

## Before use

- Probes use the current shell's Codex configuration and credentials by default.
- Run probes that connect to or start `codex app-server` only in a low-risk test session or temporary directory.
- `probe-method-diff` starts an independent app-server process.

## Probes

- `probe-method-diff.ts`: initializes app-server and checks the protocol method registry and runtime responses.
- `probe-thread-timeline.ts`: reads the timeline for a specific thread; requires `THREAD_ID`.

## Protocol evidence baseline

The registry and generated evidence currently target Codex CLI **0.167.1**, including experimental bindings: 183 client requests, 11 server requests, and 88 notifications. A listed method is not proof that Bridge integrates it or that a real invocation succeeds. Live evidence currently covers only `server/diagnostics`, `configRequirements/read`, and `modelProvider/capabilities/read` response validation.

Run `yarn protocol:evidence:refresh --live` with that exact CLI version to regenerate bindings, enumerate requests using an independent app-server, validate those three read-only responses, and refresh production references. This does not send a model turn or certify turn, approval, or session-resume behavior. Old-version live verification is discarded when the baseline changes. Use `yarn check:protocol-evidence` to check version and source-reference consistency.

The 0.167.1 inventory registers new methods without calling them. In particular, `thread/guardianReview` subscribes the connection and keeps the thread loaded until unsubscribe or disconnect; it is not a side-effect-free status read. `thread/sample` starts model sampling. `thread/section/changed` describes Codex section membership, not a working-directory change.

Bridge advertises `requiredHumanApproval` only when an approval handler is registered before initialization; read-only verification clients do not advertise it. Managed `humanCommand` prompts allow only a person's one-time Accept, Decline, or Cancel, with no session/policy grant or batch action. An actual replay from Codex creates a fresh local token after disconnect; old tokens cannot answer it. Current stdio operation does not promise recovery of pending prompts across Bridge restarts. Controlled fixtures cover these behaviors, including early initialization delivery; real managed-policy checkpoints still need separate validation. Codex global approval defaults and Bridge text/image attachment support stay unchanged.

## Guidelines

When adding a probe, document whether it starts app-server, sends a turn, or writes to a database or temporary directory. Destructive behavior must require an explicit environment variable or argument. Production code should import explicit modules under `src/` rather than a root-level compatibility shim.

Stable, read-only routine verification belongs in `yarn verify:codex --scenario <name>`, not this directory. It covers effective configuration, session inventory, a single thread, configuration reads after provider switches, and the basic protocol surface without sending a turn or modifying Bridge data.
