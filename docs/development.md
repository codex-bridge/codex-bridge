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
