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

## Group topics

In a supergroup with Topics enabled:

1. Add the bot and put the group's numeric chat ID in `TELEGRAM_ALLOWED_CHAT_IDS`.
   Topic IDs do not belong in this allowlist.
2. Ensure the bot can receive ordinary group messages: make it an administrator
   or configure the appropriate BotFather privacy setting.
3. Create topics manually in Telegram.
4. Open `/sessions` inside each topic, select a session, and acquire it with the
   existing session controls. Each topic keeps its own selection.

Bridge does not create, rename, close or delete topics, and does not require topic
management permission for this workflow. Private chat, ordinary groups and General
remain available with the same session controls. An unbound entry prompts for a
session; it does not inherit another topic's selection. All group members who can
use the bot share these controls; topics are not per-user authorization boundaries.

Conversation replies, visible activity, approval cards and Actions stay in the
originating topic. Different sessions can work through different topics. Reusing
one session across topics, private chat, Slack or Web follows the normal ownership
handoff rules; switching selection does not redirect already accepted work.

If a topic becomes unavailable or the bot loses permission, Bridge does not send
the conversation to General or private chat instead. Restore access or explicitly
acquire the session from another entry. Buttons on inaccessible messages cannot
route actions; open a fresh `/sessions` menu in the intended entry.

All topics share the physical group's send queue. Telegram's explicit `429`
`retry_after` response pauses that chat and permits one retry after the requested
wait; a second rejection leaves the cooldown for subsequent writes. Unknown
network outcomes are not automatically replayed by the Telegram transport. Topic
routing does not give each topic a separate Telegram rate allowance.

Incoming updates keep their order within each private chat, ordinary group or
topic, while different entries can be processed concurrently. Group-level output
limits still apply. Callback loading feedback does not delay the action; approval
and question failures are posted as short messages in the same entry, while
successful actions use their existing card updates without extra receipts.

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

### Session handoff

Use **Use this session next** to acquire a session. If another Bridge conversation
is still working, the handoff waits for accepted work to finish. Once acquired,
the latest five conversation messages appear automatically once. If external
Codex still occupies the session, retry the same action after external work ends.
Session occupancy prompts no longer require a separate Refresh action; old
Refresh buttons show state only. Directory and session-list refreshes remain available.

## Image input

Send a photo or a JPEG, PNG, WebP or GIF image document in the bound private chat,
group or topic. Captions accompany the image. A media album is collected for 600 ms
and delivered as one input, before the following text or command. Up to 10 images,
10 MiB per image and 25 MiB in total are accepted. Other document types receive a
clear unsupported-file response. Actual image signatures are validated.

Files use the shared managed-attachment lifecycle under
`workspaces/telegram-attachments` (`TELEGRAM_ATTACHMENT_DIR` overrides it).
Delivered files expire after 24 hours; pending/failed files after seven days.
Cleanup runs at startup and every six hours. Shutdown flushes accepted albums.
Downloads never log token-bearing Telegram file URLs. Normal session ownership and
Codex input/queue rules apply; changing the selection during a download cancels
that delivery rather than sending the file into another session.

## Workflow summaries

Telegram shows Called, Edited and other visible workflow phases once they end,
in their original sequence. Run blocks and their success/failure summaries are
hidden; execution counts, failures and phase boundaries are still stored.
Existing messages are not deleted.

Working remains available: status or queue-count changes are coalesced at a
minimum twenty-second interval after confirmed delivery. The clock does not
refresh on its own. Completion cancels pending changes and finalizes the panel
without waiting for that interval, subject to write budgets. Typing is disabled.
Slack and Web retain their live workflow display.

Replies, approvals, questions and Actions remain available. Successful automatic
approval reviews are silent; review problems and unknown Guardian warnings stay
visible. MCP connection problems are summarized in Actions, without separate
failure/recovery notices. All topics share the Bot, physical-chat and group write
budgets; see [delivery policy](development.md#telegram-input-and-api-lifecycle).

## Voice and audio input

Voice notes and audio files use the same transcription service as Slack. Configure
`OPENAI_API_KEY` and optionally `AUDIO_TRANSCRIPTION_MODEL` (default:
`gpt-4o-mini-transcribe`). `SLACK_AUDIO_TRANSCRIPTION_MODEL` remains a fallback
for existing installations. This is an OpenAI transcription API call, separate
from the Codex CLI login. Without a key, Bridge reports a configuration error in
the original topic and does not submit an empty turn.

OGG/Opus voice notes and supported MP3, MP4/M4A, WAV, FLAC and WebM containers are
validated and forwarded for transcription. No local transcoding dependency is
required. The Telegram download limit is 20 MiB per audio file, three files per
batch and 25 MiB in total. Captions accompany the transcript. The resulting text
uses the existing Codex routing/steering/queue path; image input remains localImage.
Transcription has a two-minute request deadline and no automatic retry of unknown
outcomes. Failure details are shown in the current session context. No audio
response-generation feature is implied.
