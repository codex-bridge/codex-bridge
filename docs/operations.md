# Operations and adapter configuration

This document covers production configuration, chat adapters, process lifecycle,
runtime data, and recovery. Start with the repository README for installation.

## Environment files

Direct `yarn start` loads `.env` by default. The PM2 and Windows service helpers
use `.env.bridge`.

At least one entry must be enabled:

- `WEB_ENABLED=true`;
- a non-empty `TELEGRAM_BOT_TOKEN`;
- or `SLACK_ENABLED=true` with complete Slack credentials.

Codex behavior belongs in `~/.codex/config.toml` or the trusted project's
`.codex/config.toml`. `CODEX_APP_SERVER_ARGS` controls app-server startup only and
rejects Codex config or feature overrides.

## Web listener

```dotenv
WEB_ENABLED=true
WEB_HOST=127.0.0.1
WEB_PORT=8787
# WEB_ATTACHMENT_DIR=./workspaces/web-attachments
```

Bind to a LAN IP or `0.0.0.0` only on a trusted network. Use a VPN for remote
access; the Web UI is not an internet-facing authenticated service.

## Telegram

```dotenv
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_ALLOWED_CHAT_IDS=<optional-comma-separated-ids>
```

Available commands:

- `/help`
- `/sessions`
- `/session_new`
- `/interrupt`
- `/codex_status`
- `/codex_status_full`
- `/compact`
- `/bot_disconnect`
- `/bot_connect`
- `/bot_restart` when running under PM2

## Slack

```dotenv
SLACK_ENABLED=true
SLACK_BOT_TOKEN=<xoxb-token>
SLACK_APP_TOKEN=<xapp-token>
SLACK_SIGNING_SECRET=<secret>
SLACK_ALLOWED_CHANNEL_IDS=<optional-comma-separated-ids>
```

Slack app configuration:

- enable Socket Mode;
- enable Interactivity & Shortcuts;
- subscribe to the message and mention events required by the deployment;
- add `chat:write`, `app_mentions:read`, `commands`, `channels:history`,
  `groups:history`, `im:history`, `mpim:history`, and `files:read` bot scopes;
- reinstall the app after changing OAuth scopes;
- keep Delayed Events disabled.

Images are forwarded as local-image input. Voice input is transcribed before it
is sent to Codex and requires:

```dotenv
OPENAI_API_KEY=<key>
SLACK_AUDIO_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
# SLACK_ATTACHMENT_DIR=./workspaces/slack-attachments
```

Socket Mode reconnect is automatic. Change the client/server ping timeouts only
when logs show a sustained network problem.

## PM2 lifecycle

`ecosystem.config.cjs` starts one Bridge runtime, loads `.env.bridge`, writes the
default database under `workspaces/`, and stores logs under `workspaces/logs/`.

```bash
corepack yarn pm2:start
corepack yarn pm2:status
corepack yarn pm2:logs
corepack yarn pm2:restart
corepack yarn pm2:stop
corepack yarn pm2:delete
corepack yarn pm2:save
```

Do not run two instances with the same Telegram or Slack credentials.

## Windows lifecycle

The repository includes Windows PowerShell helpers under `scripts/windows/`:

- `win-install-codex-cli.ps1` installs or updates Codex CLI with OpenAI's
  official installer and verifies `codex --version`;
- `win-install-bridge-dependencies.ps1` installs the pinned Volta, Node, and Yarn
  toolchain, dependencies, native binding, and production build;
- `win-update-and-build.ps1` requires a clean tracked worktree, pulls with
  `--ff-only`, and rebuilds without restarting;
- `win-start-bridge.ps1` starts one console runtime and prevents duplicate Bridge
  processes;
- `win-start-and-enable-autostart.ps1` creates or updates the current user's
  logon task and starts Bridge when it is not already running;
- `win-stop-and-disable-autostart.ps1` stops this checkout's Bridge process and
  removes the logon task.

The scripts recognize an existing Bridge only through its health response. An
unrelated process that occupies the port is allowed to produce the normal listen
error; it is never treated as Bridge.

## Runtime data

The default ignored runtime directory is `workspaces/`. Depending on enabled
features, it contains:

- the Bridge SQLite database;
- PM2 and structured logs;
- Web attachments;
- Slack attachments;
- local process state used by Windows helpers.

Preserve the database and needed attachments before moving an installation.

## Database migrations

Inspect pending migrations without changing the database:

```bash
corepack yarn db:migrate --database /absolute/path/bridge.sqlite --dry-run
```

Apply migrations with an explicit backup destination:

```bash
corepack yarn db:migrate --database /absolute/path/bridge.sqlite \
  --backup /absolute/path/bridge.pre-migration.sqlite
```

When a destructive migration is pending, Bridge creates and integrity-checks a
timestamped backup if an explicit path is not supplied. Keep the reported backup
until runtime acceptance is complete.

## Native module recovery

`better-sqlite3` is a native dependency. If Node changes or startup reports a
`NODE_MODULE_VERSION` mismatch, rebuild it with the repository's pinned runtime:

```bash
corepack yarn native:rebuild
```

Restart Bridge only after the rebuild succeeds.
