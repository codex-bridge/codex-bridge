# Development and protocol verification

This document covers local development, tests, and Codex App Server compatibility
checks.

## Toolchain

Use the Node and Yarn versions pinned in `package.json`.

```bash
corepack yarn install --immutable
corepack yarn check:language
corepack yarn check
corepack yarn check:protocol-evidence
corepack yarn lint
corepack yarn test
corepack yarn build
```

`check:language` keeps backend, Web implementation, scripts, tests, and code
configuration in English. When the future i18n layer introduces dedicated
locale resources, narrow the check only around that explicit resource boundary;
ordinary source files remain English.

`yarn dev` runs the TypeScript entry point once. `yarn dev:watch` uses the tsx
watcher and requires an environment that allows its IPC socket.

## Web-only tmux workflow

On macOS, the repository provides a contributor convenience script:

```bash
corepack yarn web-dev:start
corepack yarn web-dev:status
corepack yarn web-dev:attach
corepack yarn web-dev:stop
```

It runs `web:watch` and `dev:watch` in separate tmux windows, disables Telegram
and Slack, uses `workspaces/web-dev.sqlite`, and binds to `127.0.0.1:51049` by
default. Override the listener with `WEB_DEV_HOST` or `WEB_DEV_PORT` before
starting. The helper never uses PM2 or starts automatically after reboot.

### HTTPS notification testing

System notifications need a secure context and browser permission. Use a certificate
trusted by the test browser. To generate a short-lived, self-signed development
certificate (requires OpenSSL with `req -addext` support):

```bash
corepack yarn web-dev:tls <LAN-IP>
corepack yarn web-dev:stop
WEB_DEV_HOST=<LAN-IP> \
WEB_DEV_TLS_CERT_FILE=./workspaces/web-dev-tls/cert.pem \
WEB_DEV_TLS_KEY_FILE=./workspaces/web-dev-tls/key.pem \
corepack yarn web-dev:start
```

This uses the same development port over HTTPS. The helper does not install a CA,
change a trust store, overwrite existing certificates, or touch the production
listener. Generated keys stay in ignored `workspaces/`. A self-signed certificate
still needs explicit client trust; clicking through a warning is not a reliable
way to enable notifications. Prefer your existing trusted certificate or a local
development CA. `OPENSSL_BIN` may select a compatible OpenSSL executable.

Use the bell button to enable notifications. Browser permission, the OS notification
settings, and background-page scheduling still apply. A suspended or closed page
does not receive live events; the notification worker does not keep SSE alive.

## Browser fixture

To exercise the workbench without real Codex sessions or a production database:

```bash
corepack yarn web:build
node --import tsx tests/fixtures/web-workbench-server.ts
```

The fixture binds a random loopback port and uses an in-memory database and fake
runtime. Sending `approval` creates test decision cards; `native-question` and
`questions` exercise native and asynchronous question controls. `activities`
runs the actual progress service with controlled events. Service notices can be
exercised with `service-warning`, `thread-warning`, `mcp-failed` and `mcp-ready`.
Other text demonstrates Markdown and SSE behavior. Set `WEB_FIXTURE_HOST`,
`WEB_FIXTURE_PORT` and `WEB_FIXTURE_STATIC_ROOT` to use an explicit test listener
and built frontend; never reuse a production database for this fixture.

## Telegram input and API lifecycle

Telegram uses the official grammY runner with a maximum of 16 accepted updates at
a time, including updates waiting on the per-entry ordering middleware. The fetch
adapter also caps the initial batch to this limit. `sequentialize` uses the same
logical source identity as routing; it does not serialize all topics as one input
entry. The existing physical-chat output scheduler remains responsible for rate
limits. Shutdown stops polling and drains accepted updates before closing Bridge
and the database. No middleware timeout abandons a still-running business action.

Non-polling API calls have a 10-second abort timeout, starting after quota admission, and preserve caller
cancellation. `getUpdates` retains the runner's long-poll timeout and cancellation
signal. This does not introduce retries for unknown write outcomes. Explicit
Telegram foreground rate-limit rejection retries at most once after server-directed
backoff. Background refreshes instead remain pending and yield before retrying.

All transports using one Bot share an in-memory `TelegramDeliveryBudget`. Raw
send, edit, control-update and delete attempts (including format fallback and
retries) consume the same limits: 25 requests per rolling second per Bot, one
request per second per physical chat, and 18 requests per rolling minute per
group. Topics do not receive independent group quotas. These conservative
ceilings leave room below the [official FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
limits; Telegram can still impose other limits. A 429 shares its cooldown across
the Bot because the response does not identify the quota scope. Polling, reads
and callback acknowledgements do not consume the message-write budget.

Background edits of existing summaries share one admission every second per
physical chat, rotating between waiting sessions. This is not a separate request
quota: the Bot, physical-chat and group-minute write budgets still apply. Admission waits outside
notification, workflow and physical-chat queues. An admission overtaken by a
foreground write yields instead of waiting for quota while holding a workflow
lock. An already-started write completes its format fallback, with each attempt
charged, and remains cancellable. Unknown outcomes are never automatically retried.

Callback acknowledgement is disposable, starts independently, and keeps its
2-second abort bound. It no longer blocks business dispatch. Known failed approval
and question results use a shared in-entry notice; success uses the existing card
updates. Text edits, structured edits and button clearing treat the shared
`synced` no-change result as success. Actual errors propagate, and interaction
follow-up runs only after a confirmed successful write.

## Workflow message ordering

New chronological outputs use `ProgressService.appendWorkflowMessage` after producer
deduplication and before the transport write. `WorkflowSequence` serializes that
write with progress events and final-summary retries for the accepted turn route.
It ends the previous continuous phase and resets its preview cache. The session,
source and optional explicit turn must match the active route; missing context
never selects an unrelated turn. Message titles and activity styling do not define
these boundaries.

Compact notifications and manual replies, assistant/MCP conversation output,
approval/input cards, notices and errors use this path. Run RPCs outside the delivery
queue: a Compact request can itself need an approval card. Slack and Telegram wrap
only the actual interaction write; post-delivery follow-up runs outside the queue.
Web Compact results close the phase before returning, but HTTP responses and SSE
are separate channels and do not guarantee browser arrival order.

Existing item results update the original phase by native item/key, including late
results after a boundary. Turn-wide plan snapshots start a new occurrence after a
boundary. Working, typing and the fixed subagent overview retain their independent
update behavior. Deduplicated outputs and existing-card refreshes are not new
boundaries. Optional aggregate item metadata supports old database rows without a
migration; missing identities are never inferred from text or timing. Ending a
message phase does not complete or fail the Codex task.

The notification listener coalesces queued previews for consecutive progress of the
same type and explicit thread/turn. Every notification still executes in FIFO order
and reaches aggregation; only superseded active-card edits are omitted. Creating a
block is never omitted, even when its first preview has already been superseded:
subsequent edits require the platform message ID. The latest meaningful preview is
retained, and phase finalization still delivers the full summary. `Run` counts only
successfully displayed content, not received events or omitted previews.

Type changes, failures and chronological output stop preview coalescing. Explicit
metadata and panel-only updates do not split the visible sequence; unknown events
and missing turn IDs remain conservative barriers. A conditional producer such as
the account rate-limit notifier declares a boundary only when it actually writes
a notice. Reasoning deltas retain their stateful tracker and preview throttle.

Finalization persists the complete summary before releasing the phase, then defers
editing its existing card until that thread's foreground notification queue drains.
Replies and approvals therefore do not await old-card summary edits. Native late
results and retries still serialize with phase updates, re-read stored summaries
and only edit the original IDs. Waiting is cancellable on shutdown; persisted
pending summaries remain recoverable after restart. New block creation and new
chronological messages keep their order. In-flight writes cannot be preempted.
Old turns of one thread deliver summaries one at a time. A summary overtaken while
waiting at the transport stays pending for the next idle period; this scheduling
skip does not mark its destination unavailable.

Telegram defaults to summary-only workflow output. Active phases aggregate and
persist without a platform message ID. At the phase boundary or turn end, Bridge
creates one summary in workflow order, before the next chronological message.
Late results edit that summary rather than creating another block. Slack and Web
keep their existing live previews. Telegram retains a Working panel with status
changes coalesced at a minimum twenty-second interval, without clock-only refreshes.
It omits typing; approvals, questions, conversation replies and Actions remain
available. Queue-count changes use the same interval and duplicate observations
do not refresh the clock. Completion cancels pending refreshes and finalizes the
existing panel without waiting for its change interval; write budgets still apply.

Telegram hides Run phases, including their success and failure summaries. Events,
counts and phase boundaries remain stored; Called, Edited and Working retain
their own display rules. The summary policy declares hidden phase kinds; final
delivery marks them `suppressed` without writing to the platform. Late results
and restart recovery do not resend suppressed records. Existing messages are
not deleted. Slack/Web Run output is unchanged.

Stored TG Run counts use distinct upstream execution item IDs, not displayed
preview versions. Missing item identity makes the count unavailable rather than guessed.
Other transports retain the existing displayed-content counting rule. Events and
explicit failures continue to aggregate even when nothing is shown during a phase.

The summary's first send is claimed durably before I/O. Unknown send outcomes and
crashes during that first send are not automatically replayed. Known IDs retain
in-place final-delivery retries. Unsent closed phases remain recoverable after
restart. Old cards created before this policy are finalized in place. New summary
creation uses the chronological queue; old-card edits continue to wait outside it
for idle/background admission. Shared Telegram write budgets apply to both.

The Telegram summary policy contains no live-progress preview interval. Working
has an independent interval shared by summary and live display policies; progress
preview intervals belong only to the live TypeScript variant. Slack/Web keep their
existing display behavior. First summary creation does not wait for the separate
background-edit admission.

Migration 019 makes the phase's platform message ID nullable, preserving existing
records and indexes. Existing on-disk databases get an automatic verified backup
before the table rebuild. The project scaffolder `yarn db:migration:create name`
creates and registers a migration without opening a database; review its body
before applying. No migration or production restart is performed by scaffolding.

`bridge.notification.timing` records application queue wait, handler processing
and total time by method/key, without payload text. Processing includes nested
transport time; do not add the two totals. Transport queue wait alone does not
measure the earlier application backlog. Platform rate backoff still applies,
and unknown write outcomes are never automatically replayed.

### Automatic approval review visibility

Automatic review start (`inProgress`) and approved completion notifications are
silent on all transports. Denied, timed-out, aborted, strict-review-required and
unknown outcomes remain visible. Manual review-mode content and actual approval
requests are unaffected. Silent observations do not split workflow phases or
supersede their previews.

Guardian warnings contain only a thread ID and message, with no review identity.
Bridge suppresses only the observed complete auto-approval success envelope with
known risk/authorization values. It does not infer an association from event
proximity or search arbitrary text for approval keywords. Changed formats remain
visible. This is a presentation rule, not a change to approval execution.

### Actions and delivery timing

Completed turns settle their internal route and lease before interactive Actions.
After status cleanup and recovery handling, the last phase is finalized first.
A summary without a platform message ID is first-sent before Actions; edits of
existing cards wait outside workflow queues and yield to pending Actions. The
schedule yields one timer tick with zero default delay. Network delivery runs
outside the Codex notification queue. Version reminders precede Actions without
triggering a synchronous version lookup.

Turn completion and history recovery share one pending request per thread and
destination, merging overlapping calls. A later explicit history recovery can
create fresh controls. New-turn and interaction receipts invalidate pending
Actions before entering the notification queue; a captured receipt guard also
covers the interval before Actions has been scheduled. Selection, ownership,
active-turn and pending-decision checks run again at the send boundary. Cancelled
requests cannot clear a newer request's state. Physical transport queues and
server-directed rate backoff still apply; in-flight requests are not preempted.
Unknown send outcomes are not automatically replayed.

`bridge.go_shortcut.scheduled` records the scheduling point. Both adapters use the
shared timing collector: `slack.delivery.timing` and `telegram.delivery.timing`.
Telegram records the logical entry, physical chat and topic, message kind, physical
queue wait, operation/total wall time, individual SDK-call time and retry wait.
These transport measurements start at the transport entry, excluding earlier
business orchestration and the shared message sender's logical-entry queue. They
record no message bodies or API credentials. Logging failures preserve the actual
delivery result; a skipped write is unconfirmed, not a successful send.

## Codex verification CLI

`yarn verify:codex` starts an independent, read-only app-server process. It does
not use bot tokens, modify Bridge state, create threads, or send turns.

```bash
corepack yarn verify:codex --scenario config --cwd /absolute/project/path
corepack yarn verify:codex --scenario session-inventory --cwd /absolute/project/path
corepack yarn verify:codex --scenario thread --cwd /absolute/project/path --thread-id <thread-id>
corepack yarn verify:codex --scenario provider-switch --cwd /absolute/project/path --provider <provider-id>
corepack yarn verify:codex --scenario protocol --cwd /absolute/project/path --json
```

Reports are the only default standard output, so `--json` is directly
machine-readable. Add `--verbose` to write app-server diagnostics to standard
error. The verifier does not write Bridge log files.

The `session-inventory` scenario compares active and archived threads with native
provider filtering and samples rows that omit a provider through read-only
`thread/read`. Use it to investigate visibility before changing Bridge filtering.

## Compatibility policy

Both README versions contain the recommended range and latest verified Codex CLI
baseline. [Compatibility scope](codex-compatibility.md) distinguishes real local
CLI checks, synthetic/controlled integration and browser evidence from remote
provider or platform validation. When Codex changes:

1. run `codex --version` and the protocol scenario;
2. review method-registry additions and removals;
3. run the complete project test suite;
4. exercise affected approvals, session history, and event rendering;
5. update both README compatibility tables together.

Official app-server schemas can be generated for the installed Codex version:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

Generated artifacts are version-specific and should be treated as investigation
output unless the project explicitly decides to track them.

### Protocol evidence inventory

The compact `src/codex/protocol-evidence.generated.json` snapshot records four
independent facts: accepted runtime request names, generated types (including
experimental types), production source references, and explicitly verified live
requests. It stores method names and repository-relative paths, never raw RPC
payloads or credentials. Production references are static literals, including
type declarations; they do not prove an executable path or successful request.
The legacy `status` field is derived for compatibility and must not drive feature
availability decisions.

After changing protocol-related source references:

```bash
corepack yarn protocol:evidence:refresh
corepack yarn check:protocol-evidence
```

When adopting a new CLI baseline, update the registry version and run:

```bash
corepack yarn protocol:evidence:refresh --live
```

This generates experimental bindings in a temporary directory, discovers accepted
request names, and validates three read-only capability responses using an
independent app-server process. The generated directory is printed for inspection
and can be discarded afterwards. Baseline changes clear old live verification;
local-only refreshes preserve it. CI checks the source snapshot without needing
a Codex login or running a real turn.

### Runtime capabilities in Status

Status reads `server/diagnostics`, `configRequirements/read`, and
`modelProvider/capabilities/read` in parallel with a three-second request timeout.
Each result is independent: a missing method reports `unsupported`; other errors
or malformed responses report `unavailable`. Missing fields remain `unknown`,
and empty allowlists explicitly mean none are allowed.

Basic Status shows process memory, relevant managed restrictions, and reported
image-generation/Web-search support for the **configured provider**. Full Status
also shows diagnostic gauges and enabled required features. These global provider
bounds do not establish the abilities of an older session or its selected model.
They also do not indicate image-input support. Reads are fresh on every Status
request, so configuration changes do not reuse cached capabilities.

## Protocol baseline

Bridge uses the official JSON-RPC Codex App Server protocol over stdio by
default. Core interactions include:

- `initialize` followed by `initialized`;
- `thread/list`, `thread/read`, `thread/start`, and `thread/resume`;
- `turn/start`, `turn/steer`, and `turn/interrupt`;
- streamed thread, turn, item, and account notifications;
- server-initiated approval and MCP elicitation requests.

WebSocket transport is optional and follows the Codex App Server's current
experimental status. Keep non-loopback transport behind the authentication and
TLS controls documented by OpenAI.

## Quiet MCP connection state

MCP startup/auth observations update the scoped tracker and logs as metadata,
without sending an immediate message or creating workflow boundaries. At the next
eligible Actions, a separate `MCP status` activity message precedes its controls.
It uses Slack context, Telegram footer and the existing Web activity styling,
keeps the session directory, and has no buttons. Actions itself has no MCP body.

Each session announces its full unavailable-server list once and announces a new
snapshot only when that list changes. Delivery identity follows the Codex thread
across chat entries; other sessions have independent snapshots. Repeated errors
with unchanged names do not resend. Initially healthy sessions are silent; after
an announced failure, full recovery is shown once as `MCP unavailable ×0`.
Multiple intermediate changes before Actions coalesce to the latest state.

Global/thread copies count each server once. Explicit local readiness overrides
global fallback; intermediate startup or OAuth receipts do not erase an incident.
Names are sorted and text is truncated to 800 visible characters, while the
fingerprint uses the full list and the count stays complete. Detailed reasons
remain available in Codex status. Tool failures, approvals and questions retain
their existing presentation.

Snapshots share Actions ownership, selection, active-turn and decision guards.
Cancellation or a state change before authorization keeps the snapshot eligible
for a later Actions; an authorized send with an ambiguous network outcome is not
replayed. Runtime cleanup clears the bounded in-memory delivery history, so a
restart may announce the current state again. History is not rewritten.

## Telegram Markdown tables

A live three-variant probe confirmed that Telegram's Rich Markdown folds a table
immediately following a paragraph into paragraph text. The same table preceded
by a blank line returns a native table block; Rich HTML tables also work.
The Telegram renderer uses the standard GFM AST to add that missing separator
before top-level table nodes. It does not rewrite cells, fenced code, escaped
pipes, already separated tables, stored Markdown or other platforms' rendering.
The existing GFM parser extensions are declared as direct pinned dependencies.
