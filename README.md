# Codex Bridge

[Simplified Chinese](README.zh-CN.md)

Codex Bridge lets you continue the same local Codex sessions from a browser,
Telegram, or Slack. It runs beside Codex CLI, connects through the official
Codex App Server protocol, and coordinates which client currently controls each
session.

The project is designed for self-hosted, single-user or trusted-team use. Codex
still owns authentication, models, permissions, skills, MCP servers, and project
configuration. Bridge only adds more ways to reach the local runtime.

Codex Bridge has been developed since March 2026 and went through more than 650
commits before its first public release.

## What it does

- Continues existing Codex sessions from a LAN browser, Telegram, or Slack.
- Switches projects and sessions without interrupting work already running.
- Streams replies, progress, approvals, MCP input requests, and supported
  attachments.
- Coordinates session ownership so clients do not silently drive the same
  session at once.
- Stores Bridge routing state and message metadata in a local SQLite database.

## Supported clients

| Client | Main use | Current support |
| --- | --- | --- |
| Web | Primary workbench | Projects, sessions, messages, image uploads, approvals, and connection takeover. |
| Telegram | Mobile access | Text turns, session commands, progress messages, and approvals. |
| Slack | Team chat | Thread-aware routing, approvals, images, and optional voice transcription. |

Web can run by itself. Telegram and Slack are optional adapters. All enabled
clients share one Bridge process and one Codex runtime.

## Compatibility

Codex App Server schemas are version-specific. The Bridge baseline verified on
2026-10-12 is:

**Latest Codex CLI version verified by this project: `0.162.1`.**

| Component | Supported range | Verified version |
| --- | --- | --- |
| Codex CLI | `>=0.158.0 <0.163.0` | `0.162.1` |
| Node.js | `22.22.x` | `22.22.0` |
| Yarn | `4.8.x` | `4.8.1` |

The lower bound reflects retained Codex `0.158` compatibility behavior; the
latest live protocol and ephemeral turn verification used `0.162.1`. Treat
versions outside this range as unverified until both the protocol check and
project tests pass.

Official references: [install Codex CLI](https://developers.openai.com/codex/cli/)
and [Codex App Server](https://developers.openai.com/codex/app-server/).

## Security model

The Web UI has no user-account or internet-facing authentication layer. Bind it
to loopback or a trusted LAN address. Use your own VPN for remote access, and do
not expose Bridge directly to the public internet.

Report vulnerabilities through the process described in
[SECURITY.md](SECURITY.md).

Browser connection rights and Codex session ownership are separate. Only one
browser window holds the Web connection at a time, and only the client that owns
a session can read its conversation or act on it.

## Prerequisites

- Codex CLI installed and authenticated for the OS user that runs Bridge.
- Git.
- The Node and Yarn versions pinned in `package.json`; Volta is recommended.
- At least one enabled client: Web, Telegram, or Slack.

## Quick start: Web only

1. Install Codex CLI using the [official instructions](https://developers.openai.com/codex/cli/),
   run `codex`, and complete authentication.
2. Clone this repository and enter its directory.
3. Install dependencies and build the backend and Web UI:

   ```bash
   corepack yarn install --immutable
   corepack yarn build
   ```

4. Copy the example configuration. It enables only the Web workbench on
   `127.0.0.1:8787`:

   ```bash
   cp .env.example .env
   ```

5. Start Bridge:

   ```bash
   corepack yarn start
   ```

6. Open <http://127.0.0.1:8787/>.

For LAN access, change `WEB_HOST` to the machine's LAN IP or `0.0.0.0`, then
open the same port from another trusted device. Current host validation accepts
IP addresses and `localhost`, not custom DNS hostnames.

## Use the Web workbench

1. Connect this browser window to the Bridge service.
2. Add an existing project directory from the Bridge machine.
3. Select a session and explicitly take control before reading or sending.
4. Send a message, upload images, or answer approval and MCP input cards.

Useful behavior to know:

- Opening another browser does not grant it control. It may explicitly take over
  the Web connection, which immediately revokes the previous window.
- Switching sessions does not interrupt running work.
- A refresh restores the selected session when possible and reloads up to the
  latest five user/assistant messages. Temporary progress statistics may be lost.
- The selected session remains in the URL, so refresh and browser navigation keep
  the intended target without silently claiming it.
- Session ownership can be released back to an external Codex client from the
  session menu when Bridge reports that release is safe.

## Enable Telegram or Slack

Use `.env` for direct starts, or `.env.bridge` with the PM2 and Windows service
helpers.

Detailed setup:

- [Telegram bot setup](docs/telegram-setup.md)
- [Slack app setup](docs/slack-setup.md)

Telegram:

- Set `TELEGRAM_BOT_TOKEN`.
- Optionally restrict access with `TELEGRAM_ALLOWED_CHAT_IDS`.

Slack:

- Set `SLACK_ENABLED=true`.
- Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET`.
- Optionally restrict channels with `SLACK_ALLOWED_CHANNEL_IDS`.
- Voice transcription additionally requires `OPENAI_API_KEY`.

Models, providers, reasoning effort, approval policy, sandbox, service tier,
personality, skills, MCP, and feature flags remain Codex configuration. Set them
in `~/.codex/config.toml` or the trusted project's `.codex/config.toml`.

## Windows setup

Run these helpers from the repository root with Windows PowerShell 5.1 or newer:

```powershell
.\scripts\windows\win-install-codex-cli.ps1
.\scripts\windows\win-install-bridge-dependencies.ps1
Copy-Item .env.example .env.bridge
.\scripts\windows\win-start-bridge.ps1
```

Additional helpers:

- `win-update-and-build.ps1`: fast-forward the checkout and rebuild.
- `win-start-and-enable-autostart.ps1`: start Bridge and create or update the
  current user's logon task without starting a duplicate process.
- `win-stop-and-disable-autostart.ps1`: stop this checkout's Bridge process and
  remove its logon task.

## Run in the background

On macOS or Linux, PM2 is an optional process manager. Copy the configuration to
`.env.bridge`, install PM2 separately, then run:

```bash
corepack yarn pm2:start
corepack yarn pm2:status
corepack yarn pm2:logs
```

Use `corepack yarn pm2:restart`, `corepack yarn pm2:stop`, or `corepack yarn
pm2:delete` for lifecycle operations. Do not run two Bridge instances with the
same Telegram or Slack credentials.

## Update an installation

```bash
git pull --ff-only
corepack yarn install --immutable
corepack yarn build
```

Restart the service only after the build succeeds. On Windows, the equivalent
helper is `scripts/windows/win-update-and-build.ps1`; it builds but does not
restart Bridge.

If Node changes or startup reports a `NODE_MODULE_VERSION` mismatch, run:

```bash
corepack yarn native:rebuild
```

## Data and backups

Runtime data is stored under the ignored `workspaces/` directory by default.
Preserve the SQLite database and needed attachments before moving or replacing
an installation.

Bridge creates an integrity-checked SQLite backup before destructive migrations.
Inspect pending migrations without changing the database:

```bash
corepack yarn db:migrate --database /absolute/path/bridge.sqlite --dry-run
```

Keep any reported migration backup until runtime acceptance is complete.

## Common commands

```bash
corepack yarn check
corepack yarn lint
corepack yarn test
corepack yarn build
corepack yarn start
corepack yarn verify:codex --scenario protocol --json
```

## More documentation

- [Web API and behavior](docs/web-api.md)
- [Operations and adapter configuration](docs/operations.md)
- [Development and protocol verification](docs/development.md)

## License

[MIT](LICENSE)

Contributions are accepted under the same license; see
[CONTRIBUTING.md](CONTRIBUTING.md).

Codex Bridge is an independent community project. It is not affiliated with,
endorsed by, or sponsored by OpenAI.
