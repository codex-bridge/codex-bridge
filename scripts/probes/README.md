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

`src/codex/protocol-coverage.ts` records explicit client dispositions for every generated notification, server request and ThreadItem kind: handled, partial, intentionally ignored, or unsupported. Partial coverage includes remaining activity/interaction gaps. The coverage table is an audit, not a runtime router or a claim of end-to-end support. `yarn check:protocol-evidence` rejects missing, duplicate and obsolete entries, so refreshed upstream types require review. Coverage declarations are excluded from production-reference evidence.

Unsupported server requests receive JSON-RPC error `-32601` with the original request ID. They never receive a generic successful `"cancel"` result or a fabricated user answer. Dynamic-tool calls remain unsupported. Native user questions are handled only when a dedicated consumer is registered; read-only clients reject them explicitly. Existing command, file, permission and MCP elicitation approvals retain their typed response shapes.

Bridge advertises `requiredHumanApproval` only when an approval handler is registered before initialization; read-only verification clients do not advertise it. Managed `humanCommand` prompts allow only a person's one-time Accept, Decline, or Cancel, with no session/policy grant or batch action. An actual replay from Codex creates a fresh local token after disconnect; old tokens cannot answer it. Current stdio operation does not promise recovery of pending prompts across Bridge restarts. Controlled fixtures cover these behaviors, including early initialization delivery; real managed-policy checkpoints still need separate validation. Codex global approval defaults and Bridge text/image attachment support stay unchanged.

## Guidelines

When adding a probe, document whether it starts app-server, sends a turn, or writes to a database or temporary directory. Destructive behavior must require an explicit environment variable or argument. Production code should import explicit modules under `src/` rather than a root-level compatibility shim.

Stable, read-only routine verification belongs in `yarn verify:codex --scenario <name>`, not this directory. It covers effective configuration, session inventory, a single thread, configuration reads after provider switches, and the basic protocol surface without sending a turn or modifying Bridge data.

## Assistant questions

Assistant display instructions are applied before logging, persistence and delivery. Asynchronous `agentMessage.questions` with `delivery=async` retain their ordered question titles/options in live messages and history. Live choices use the existing text-send flow on Slack, Telegram and Web; they are not approvals or native RPC answers. Callbacks are short, session/owner/version scoped, in-memory and one-use per question. Another question in the same message remains answerable. Full choice text is retained even if a platform shortens the button label. Free-text-only questions use the normal composer; no preselected answer is submitted automatically. History and browser cache preserve content without restoring old choice actions.

Only explicit synchronous owner-turn start/end transitions carry still-current choice versions forward. A claim, handoff, release or already-stale token is never refreshed by that mechanism; disconnect clears question state. This keeps post-turn choices usable without allowing ownership changes to revive old buttons.

`item/tool/requestUserInput` uses the original connection and request identity to submit a typed `answers` map keyed by the original question IDs. Slack and Telegram collect selections or text one question at a time, allow editing saved answers, and require an explicit final Submit answers. Web provides a question form with options and free-text fields, without preselected answers or MCP JSON. Skip questions explicitly sends an empty answers map; it is not approval or consent and does not interrupt the whole turn. Draft answers stay in memory and are not stored as conversation messages. Reconnects and resolved requests invalidate old controls; unknown write outcomes are not retried automatically. An open question can be refreshed only while its original request is still active.

Real 0.170.0 CLI probes against a local mock model confirmed that `isBlocking=false` does not make ordinary text steering answer that RPC. A default-mode native question also depends on the upstream `default_mode_request_user_input` feature. Bridge does not enable that feature, change collaboration modes, or promise every model/provider will generate questions.

The isolated browser fixture accepts `questions` to exercise two independent asynchronous option groups and a free-text question, or `native-question` for a synthetic native question form and typed submission, without production services. Controlled subprocess tests cover the actual RPC response, including request ID `0`, explicit skip, invalid answers, duplicate submission and connection expiry; the browser fixture validates presentation rather than a real model turn.

## Warnings and MCP status

`warning`, `guardianWarning`, `configWarning` and `deprecationNotice` retain their public message, details and optional config path. Explicit thread scope routes only to an available, owned session; known direct-child notices follow their parent session. Unmapped or unauthorized thread notices never become global notices. Identical warning observations are deduplicated in memory. A warning does not fail or interrupt the task.

Global notices wait in memory until the next authorized conversation input (including steering or queueing). That entry receives the pending batch once across the whole service; historical Slack roots, other threads and Telegram chats are not broadcast targets. Menu queries, polling, rejected inputs and duplicate messages do not consume the batch. Pushes use the current session directory and the existing subdued activity presentation (Slack context / Telegram footer), without changing the global scope of the service snapshot. Concurrent inputs cannot claim the same batch. A failed or unknown transport write does not block the user turn and is not retried automatically; the notice remains readable in service state. Web exposes them to the current authorized window through the existing catalog poll (normally every 8 seconds), without requiring a selected session. Only an explicit conversation input also pushes pending notices into that selected session. The collapsible Service notices panel and full status view share the same snapshot. Up to 64 global notices and 512 warning fingerprints are retained in memory; disconnect cleanup or process restart clears them. Warnings have no upstream resolution signal, so they remain within that bounded snapshot until cleanup or eviction.

MCP startup state is keyed by thread scope and server name. Status views use the current thread's observation, with global fallback, without merging another thread's same-name server. Public errors and structured `failureReason` are retained. The first failure prompts once; continued failures update the global snapshot without repeated chat pushes. Starting, cancellation, unknown status or OAuth login success do not assert recovery. Only reported startup readiness clears the active failure and allows a later incident to notify again. A failure resolved before it is pushed is removed from the pending batch without an obsolete failure/recovery pair. After a failure push is attempted, recovery waits for the next conversation input too. Web removes the resolved MCP notice from service state. No reconnect, login, configuration write or automatic message retry is triggered.

The isolated fixture accepts `service-warning`, `thread-warning`, `mcp-failed` and `mcp-ready`. Tests cover scopes, malformed input, deduplication, OAuth/readiness differences, single-entry delivery/authorization/concurrency, direct-child routing, native renderers, and Web window access. This is controlled local evidence, not proof of every real provider or remote transport failure path. Windows writable-path warnings remain separately unsupported.

## Activity coverage

Public `plan`, `sleep`, `imageView`, `dynamicToolCall`, `enteredReviewMode` and `exitedReviewMode` observations use the existing ordered progress phases. Structured `turn/plan/updated`, turn-scoped `hook/started` / `hook/completed`, and approval-review notifications use the same lifecycle. These are informational activities, not approval controls or evidence that the overall task has succeeded. Dynamic tools show declared names and explicit result status without arguments or raw output. Plan and Review keep their actual text; viewing an image only reports its path and observation state, without promising an image preview.

Consecutive same-type observations may replace the active preview and are summarized together. Switching type freezes the previous phase. A late item/Hook completion updates its original block, without reopening its type or reordering later work. Replayed terminal identities cannot regress a finished observation. Turn-plan snapshots replace only within the current Plan phase; a later Plan after another activity creates a new chronological trace. Existing temporary-message truncation also applies to these previews and final summaries.

Only real thread/turn identities authorize task activity delivery. Null-turn Hook events describe session/connection work and are not attached to an invented task. Missing starts or completions are not synthesized. Direct-child activity retains the existing bounded subagent-summary policy; this does not add a second child timeline. Hook public status and warning/error/stop entries are shown, while context/feedback, raw plan deltas, `functionCallOutput`, `hookPrompt`, and telemetry remain internal. Automated approval Review uses a weak activity card with the reported status/rationale and never submits user consent or automatically changes approval policy.

New activity data is stored in the existing aggregate JSON and phase-kind text column; no schema migration is required. Older records remain readable. The isolated fixture accepts `activities` and runs the actual progress service against in-memory storage, including an interleaved late Hook completion. Synthetic regression and browser fixtures verify Bridge behavior; real remote provider/Hook sequences remain subject to upstream reporting and later use validation.
