# Telegram setup

This guide connects a Telegram bot to Codex Bridge. It assumes the repository
is installed, Codex CLI is authenticated, and Bridge can already start with at
least one entry enabled.

## 1. Create a bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Choose a display name and a unique username ending in `bot`.
4. Copy the bot token that BotFather returns.

Treat the token as a password. Do not paste it into an issue, chat transcript,
commit, or screenshot. If it is exposed, use BotFather's `/revoke` command and
replace the token in the Bridge environment.

Codex Bridge registers its supported command menu when it starts, so manual
BotFather command configuration is optional.

## 2. Configure Bridge

Direct starts load `.env`. The PM2 and Windows helpers load `.env.bridge`.
Copy `.env.example` to the appropriate file, then set:

```dotenv
TELEGRAM_BOT_TOKEN=<telegram-bot-token>
TELEGRAM_ALLOWED_CHAT_IDS=<optional-comma-separated-chat-ids>
```

`TELEGRAM_ALLOWED_CHAT_IDS` is strongly recommended. When it is empty, any chat
that can reach the bot is accepted. Multiple IDs are comma-separated. Private
chat IDs are positive integers; group and supergroup IDs are commonly negative.

The bot can run beside the Web or Slack adapters. To run Telegram without the
Web workbench, set `WEB_ENABLED=false`.

## 3. Find and allow your chat ID

Telegram does not show the numeric chat ID in BotFather. A controlled first-run
flow avoids third-party lookup bots:

1. Keep the bot private and leave `TELEGRAM_ALLOWED_CHAT_IDS` empty temporarily.
2. Start one Bridge instance.
3. Open a direct chat with the bot and send `/help`.
4. Read the structured Bridge log entry named `telegram.command.help` and copy
   its `chatId` value.
5. Stop Bridge, set that value in `TELEGRAM_ALLOWED_CHAT_IDS`, and start Bridge
   again.

Keep the unrestricted interval short. Do not use the same token in another
polling process while Bridge is running.

Direct messages are the recommended setup. For a group, add the bot to the
group and allow the group's numeric chat ID. Telegram privacy mode may prevent
the bot from receiving ordinary group text. Disable privacy through BotFather
only when the group workflow requires all messages, and review the wider access
that this grants first.

## 4. Start and verify

For a direct foreground start:

```bash
corepack yarn start
```

For PM2 or Windows, use the lifecycle commands documented in
[Operations](operations.md).

Successful startup logs `app.telegram.ready`. In Telegram:

1. Send `/help` and confirm that the action menu appears.
2. Send `/sessions` and select or create the intended Codex session.
3. Send a short message and confirm that its reply returns to the same chat.

Useful commands include `/sessions`, `/session_new`, `/go`, `/next`, `/queue`,
`/interrupt`, `/codex_status`, `/compact`, and `/help`. Bridge publishes the
complete current command list to Telegram at startup.

## Troubleshooting

- **The bot does not reply:** verify the token, confirm the chat ID is allowed,
  and check Bridge logs for `telegram.bot.error`.
- **Telegram reports a polling conflict:** another process is using the same bot
  token. Stop the duplicate Bridge or bot process.
- **Commands work in a group but ordinary text does not:** review the bot's
  BotFather privacy setting.
- **`/sessions` is empty:** confirm Codex CLI is authenticated and that Codex has
  sessions under a directory visible to the Bridge host.
- **A command menu is stale:** restart the single Bridge instance so it can run
  `setMyCommands` again.

## Security checklist

- Keep `TELEGRAM_BOT_TOKEN` only in an ignored environment file or secret store.
- Restrict `TELEGRAM_ALLOWED_CHAT_IDS` after the first controlled message.
- Run only one polling instance per bot token.
- Rotate the token immediately if it appears in logs, commits, or support data.

Official references:

- [Telegram BotFather](https://core.telegram.org/bots/features#botfather)
- [Telegram bot privacy mode](https://core.telegram.org/bots/features#privacy-mode)
- [Telegram Bot API](https://core.telegram.org/bots/api)
