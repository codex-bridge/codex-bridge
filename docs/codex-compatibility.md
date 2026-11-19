# Codex compatibility and verification scope

The current protocol baseline is Codex CLI **0.170.0**, checked on **2026-11-19**.
Use the `0.170` family (`>=0.170.0 <0.171.0`) as the recommended range; only
`0.170.0` was exercised. Retained compatibility code for older versions is not
evidence that every newer Bridge feature works on those versions.

## Evidence

| Area | Verification | Boundary |
| --- | --- | --- |
| Protocol inventory | Official generated experimental bindings, independent app-server method discovery, and read-only response validation | A listed method does not prove Bridge implements it. |
| Replies and display restrictions | Live/history adapters, storage boundaries, cache handling and three client renderers | Restricted replies use synthetic upstream data; not a real remote moderation result. Existing stored messages cannot be retroactively certified. |
| Native questions | Real CLI, Bridge client/service, live Web transport and decision endpoint with a local deterministic model | Original question IDs and typed answers, explicit submission, interrupt expiry and no fabricated default consent; no remote provider is certified. |
| Asynchronous question choices | Real CLI and Bridge, ordinary text reply after turn completion, multi-question token tests and browser fixture | Choices are ordinary replies, not native RPC answers. Old history/cache does not recreate controls. |
| Command approval and Run | Real local CLI and Bridge with an explicitly accepted, harmless fixture command | This is ordinary command approval, not certification of every managed human-only policy or OS permission dialog. |
| Warnings and MCP failures | Scoped parser, real Bridge listener wiring with controlled events, root routing/authorization tests and browser fixture | Real remote MCP outages and Slack/Telegram API delivery were not triggered. |
| Plan, Hook, wait, image view, dynamic tools and Review | Actual progress service, SQLite storage, three renderers and browser fixture with controlled events | Not every real activity producer was exercised. Direct-child activity retains the bounded subagent-summary policy. |
| History and session restore | Real CLI and Bridge reading structured history before and after unsubscribe/resume | Uses temporary sessions. This does not establish that all external-writer contention has been fixed upstream. |

The final integration used an independent temporary `CODEX_HOME`, a temporary
working directory, in-memory Bridge storage, and a local Responses fixture.
It did not use production sessions, bot tokens, a remote model, or the user's
global Codex configuration. Local model-response timing is not a remote-model
performance measurement. Feature flags needed by that fixture were confined to
its temporary configuration; Bridge does not enable them globally.

The automated baseline finished with **953 passing tests**, plus type, lint,
language, protocol-evidence and build checks. Browser checks used an isolated
fixture at desktop and 390px widths. These are scoped compatibility checks,
not certification of every provider, operating system or network path.

## User-visible behavior and known limits

- Native questions use a dedicated form or chat choices/text, then one explicit
  submission. They are separate from approvals and MCP JSON input. Skip sends
  empty answers, not consent. The original connection must remain active.
- Asynchronous questions continue through the normal text-send flow. A task's
  ordinary start/end must not invalidate unused options. Ownership changes,
  consumed choices and disconnects still invalidate them.
- Native questions in Codex Default mode depend on upstream support and the
  `default_mode_request_user_input` feature. Bridge does not change the user's
  feature flags, collaboration mode or global approval defaults to expose them.
  Ordinary `Go` text does not answer a pending native RPC.
- Thread warnings stay with an authorized session. Global notices use service
  scope. Pending global notices push once service-wide at the next authorized
  conversation input, with that session directory and subdued activity styling;
  there is no historical-entry broadcast. Web also refreshes the service snapshot
  with the existing catalog poll, normally every 8 seconds. State is memory-only;
  failed/unknown writes do not block the conversation or retry automatically.
- MCP login success alone is not connection readiness. Continuing failures do
  not repeat the same notice; reported readiness allows a later failure to
  notify again. Bridge does not reconnect or change configuration automatically.
- Activity types preserve chronological traces. Missing upstream starts or
  completions are not invented. Hook events without a turn ID are not assigned
  to an arbitrary task; Windows writable-path warnings remain unsupported.
- Internal tool outputs, Hook context/feedback, raw deltas and telemetry are
  not promoted to user messages. Plan and Review retain public content within
  the normal temporary-message length limit.
- Called live previews show supplied tool arguments as code, like Edited diffs,
  within the same 800-visible-character body limit. Detailed arguments are omitted
  from final phase summaries, phase records and restored history; missing inputs
  are not reconstructed.
- Resume responses need not contain legacy `initialMessages`. Bridge reads
  structured thread history separately; it does not require that old field.

## Rechecking a CLI upgrade

Use the pinned Node/Yarn toolchain. Read-only verification starts an independent
app-server; it does not send a turn or alter Bridge state:

```bash
codex --version
corepack yarn verify:codex --scenario protocol --cwd /absolute/test/project --json
corepack yarn check:protocol-evidence
corepack yarn check
corepack yarn lint
corepack yarn check:language
corepack yarn test
corepack yarn build
```

Review upstream field semantics and affected paths before extending the range.
Update the registry/evidence and both README tables together. Repeat affected
turn, approval and restore scenarios in an isolated environment; passing a
method inventory alone is insufficient. See [development](development.md) and
[probe and fixture behavior](../scripts/probes/README.md) for the maintained
commands and synthetic test entry points.
