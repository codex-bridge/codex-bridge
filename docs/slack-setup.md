# Slack setup

Codex Bridge uses Slack Socket Mode, so a local Bridge does not need a public
HTTP request URL. This guide configures the permissions and events used by the
current implementation.

## 1. Create the Slack app

1. Open [Slack API apps](https://api.slack.com/apps).
2. Choose **Create New App**, then **From scratch**.
3. Select the workspace that will run Codex Bridge.
4. Give the app a recognizable, non-secret name.

Use a separate app for testing when production messages or approvals must not
be affected.

## 2. Enable Socket Mode

1. Open **Socket Mode** and enable it.
2. Create an app-level token with the `connections:write` scope.
3. Copy the generated app token. Slack app tokens normally start with `xapp-`.

No public Request URL is required for events or interactivity in Socket Mode.

## 3. Add bot scopes

Under **OAuth & Permissions**, add these Bot Token Scopes:

- `chat:write`
- `app_mentions:read`
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`
- `files:read`

`files:read` is required for the supported image and audio attachment flow. Add
`commands` only when you also create Slack slash commands.

The current Bridge does not require `chat:write.public`: invite the app to each
channel where it should operate. It also does not require App Home publishing
or user-profile scopes.

Install the app to the workspace after setting the scopes. Reinstall it after
every scope change. Copy the Bot User OAuth Token, which normally starts with
`xoxb-`.

## 4. Subscribe to events

Open **Event Subscriptions**, enable events, and add these bot events:

- `message.im`
- `message.mpim`
- `app_mention`
- `message.channels`
- `message.groups`

Do not add `app_home_opened`; the current Bridge has no App Home handler. Keep
Slack's Delayed Events option disabled. Bridge tolerates replayed events, but it
does not require Slack to delay delivery.

Enable the **Messages Tab** under **App Home** if users will send direct
messages. The Home Tab itself is not required.

## 5. Enable interactions

Open **Interactivity & Shortcuts** and enable interactivity. Socket Mode carries
button, select-menu, and modal payloads without a public Request URL. Bridge
uses these payloads for session actions, approvals, queue input, and runtime
controls.

Slash commands are optional. If enabled, create only commands that Bridge
recognizes, such as `/codex`, `/sessions`, `/session_new`, `/goals`,
`/codex_status`, `/codex_status_full`, `/codex-interrupt`, or `/compact`.
Current slash-command handling is intended for direct messages; use bot mentions
and threads in channels.

## 6. Copy the signing secret

Open **Basic Information**, then copy the app's Signing Secret. Bridge requires
`SLACK_SIGNING_SECRET` when Slack is enabled even though events arrive through
Socket Mode.

## 7. Restrict channels

Invite the app to each intended channel. Obtain a channel ID from Slack's
channel details or a copied channel link, then configure an allowlist.

Public channel IDs commonly start with `C`; private channel IDs commonly start
with `G`. Direct messages are always allowed by the current Bridge routing rule.
If `SLACK_ALLOWED_CHANNEL_IDS` is empty, every non-DM channel from which the app
receives an event is allowed.

At a channel root, mention the bot with an entry command such as
`@CodexBridge sessions` or `@CodexBridge help`. Open a thread beneath the bot's
reply and continue normal conversation there. In a direct message, begin with
`sessions`, `session_new`, `help`, or a registered management slash command.

## 8. Configure Bridge

Direct starts load `.env`. The PM2 and Windows helpers load `.env.bridge`.
Set:

```dotenv
SLACK_ENABLED=true
SLACK_BOT_TOKEN=<bot-user-oauth-token>
SLACK_APP_TOKEN=<app-level-token>
SLACK_SIGNING_SECRET=<signing-secret>
SLACK_ALLOWED_CHANNEL_IDS=<optional-comma-separated-channel-ids>
BRIDGE_CALLBACK_SECRET=<random-secret>
```

`BRIDGE_CALLBACK_SECRET` signs Bridge action values and is recommended for Slack
buttons and modals. Generate it locally with a cryptographically secure secret
generator; do not reuse a Slack token.

Voice transcription is optional and requires:

```dotenv
OPENAI_API_KEY=<api-key>
SLACK_AUDIO_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
# SLACK_ATTACHMENT_DIR=./workspaces/slack-attachments
```

Socket Mode reconnects automatically. The default heartbeat timeouts are 15
seconds for the client and 45 seconds for the server. Override
`SLACK_SOCKET_CLIENT_PING_TIMEOUT_MS` or
`SLACK_SOCKET_SERVER_PING_TIMEOUT_MS` only when logs show a sustained network
problem.

## 9. Start and verify

For a direct foreground start:

```bash
corepack yarn start
```

For PM2 or Windows, use the lifecycle commands documented in
[Operations](operations.md).

Successful startup calls Slack `auth.test` and logs `slack.app.ready`. Verify:

1. Send `help` or `sessions` in the app's direct-message tab.
2. Mention the bot with `sessions` in an allowed channel.
3. Open a thread beneath the bot response, select a session there, and continue
   in that thread.
4. Test one action button to confirm interactivity.
5. If attachments are needed, send a small image and confirm Bridge accepts it.

## Troubleshooting

- **`missing_scope`:** add the named bot scope and reinstall the app.
- **No channel events:** verify the bot event subscription, invite the app to
  the channel, and check `SLACK_ALLOWED_CHANNEL_IDS`.
- **Buttons or queue modals do nothing:** enable Interactivity & Shortcuts and
  verify the app token has `connections:write`.
- **Attachment download fails:** add `files:read`, reinstall the app, and retry
  with a supported image or audio file.
- **Socket Mode disconnects:** inspect the Bolt/WebSocket error first. Native
  reconnect is enabled; do not run a second Bridge with the same Slack tokens.
- **A direct-message free-form prompt is ignored:** start with `sessions` or
  another root management command, then continue inside the resulting thread.

## Security checklist

- Keep Slack tokens, the signing secret, callback secret, and optional API key
  only in an ignored environment file or secret store.
- Restrict non-DM use with `SLACK_ALLOWED_CHANNEL_IDS`.
- Install the minimum scopes above and add optional scopes only for enabled
  features.
- Run only one Bridge instance with a given Slack app's credentials.
- Rotate any credential that appears in logs, commits, screenshots, or support
  data.

Official references:

- [Slack app settings](https://api.slack.com/apps)
- [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Bolt for JavaScript Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode)
- [Events API](https://docs.slack.dev/apis/events-api/)
- [Slack scopes](https://docs.slack.dev/reference/scopes/)
- [Slack file objects](https://docs.slack.dev/reference/objects/file-object/)
