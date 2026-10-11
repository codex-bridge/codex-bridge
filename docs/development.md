# Development and protocol verification

This document covers local development, tests, and Codex App Server compatibility
checks.

## Toolchain

Use the Node and Yarn versions pinned in `package.json`.

```bash
corepack yarn install --immutable
corepack yarn check:language
corepack yarn check
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

## Browser fixture

To exercise the workbench without real Codex sessions or a production database:

```bash
corepack yarn web:build
node --import tsx tests/fixtures/web-workbench-server.ts
```

The fixture binds a random loopback port and uses an in-memory database and fake
runtime. Sending `approval` creates test decision cards; other text demonstrates
Markdown and SSE behavior.

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

The README contains the current supported range and latest live-verified Codex
CLI version. When Codex changes:

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
