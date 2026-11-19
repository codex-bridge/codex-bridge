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

The registry and generated evidence currently target Codex CLI **0.170.0**, including experimental bindings: 187 client requests, 11 server requests, 88 notifications, and 19 ThreadItem kinds. A listed method is not proof that Bridge integrates it or that a real invocation succeeds. Live evidence currently covers only `server/diagnostics`, `configRequirements/read`, and `modelProvider/capabilities/read` response validation.

Run `yarn protocol:evidence:refresh --live` with that exact CLI version to regenerate bindings, enumerate requests using an independent app-server, validate those three read-only responses, and refresh production references. This does not send a model turn or certify turn, approval, or session-resume behavior. Old-version live verification is discarded when the baseline changes. Use `yarn check:protocol-evidence` to check version and source-reference consistency.

The 0.170.0 inventory catalogs new account-security, provider-list/configuration and approved-plan APIs without enabling new Bridge workflows. `modelProvider/config/write` changes configuration and `thread/prepareApprovedPlan` changes thread context. In addition, `thread/guardianReview` subscribes the connection and keeps the thread loaded until unsubscribe or disconnect; it is not a side-effect-free status read. `thread/sample` starts model sampling. `thread/section/changed` describes Codex section membership, not a working-directory change.

`src/codex/protocol-coverage.ts` records explicit client dispositions for every generated notification, server request and ThreadItem kind: handled, partial, intentionally ignored, or unsupported. Partial coverage includes MCP status caching without proactive notices and remaining activity/interaction gaps. The coverage table is an audit, not a runtime router or a claim of end-to-end support. `yarn check:protocol-evidence` rejects missing, duplicate and obsolete entries, so refreshed upstream types require review. Coverage declarations are excluded from production-reference evidence.

Unsupported server requests receive JSON-RPC error `-32601` with the original request ID. They never receive a generic successful `"cancel"` result or a fabricated user answer. Native user-question and dynamic-tool interfaces remain unimplemented until their delivery and response contracts are integrated. Existing command, file, permission and MCP elicitation approvals retain their typed response shapes.

Bridge advertises `requiredHumanApproval` only when an approval handler is registered before initialization; read-only verification clients do not advertise it. Managed `humanCommand` prompts allow only a person's one-time Accept, Decline, or Cancel, with no session/policy grant or batch action. An actual replay from Codex creates a fresh local token after disconnect; old tokens cannot answer it. Current stdio operation does not promise recovery of pending prompts across Bridge restarts. Controlled fixtures cover these behaviors, including early initialization delivery; real managed-policy checkpoints still need separate validation. Codex global approval defaults and Bridge text/image attachment support stay unchanged.

## Guidelines

When adding a probe, document whether it starts app-server, sends a turn, or writes to a database or temporary directory. Destructive behavior must require an explicit environment variable or argument. Production code should import explicit modules under `src/` rather than a root-level compatibility shim.

Stable, read-only routine verification belongs in `yarn verify:codex --scenario <name>`, not this directory. It covers effective configuration, session inventory, a single thread, configuration reads after provider switches, and the basic protocol surface without sending a turn or modifying Bridge data.

## Assistant questions

Assistant display instructions are applied before logging, persistence and delivery. Asynchronous `agentMessage.questions` with `delivery=async` retain their ordered question titles/options in live messages and history. Live choices use the existing text-send flow on Slack, Telegram and Web; they are not approvals or native RPC answers. Callbacks are short, session/owner/version scoped, in-memory and one-use per question. Another question in the same message remains answerable. Full choice text is retained even if a platform shortens the button label. Free-text-only questions use the normal composer; no preselected answer is submitted automatically. History and browser cache preserve content without restoring old choice actions.

`item/tool/requestUserInput` remains unsupported pending a separate typed-answer implementation. Real 0.170.0 CLI probes against a local mock model confirmed that `isBlocking=false` does not make ordinary text steering answer that RPC. A default-mode native question also depends on the upstream `default_mode_request_user_input` feature. Bridge does not enable that feature, change collaboration modes, or promise every model/provider will generate asynchronous choices.

The isolated browser fixture accepts `questions` to exercise two independent option groups and a free-text question without production services.
