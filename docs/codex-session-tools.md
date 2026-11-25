# Codex session tools

Session configuration is refreshed at each new turn. The existing session and
conversation history stay intact when the model, reasoning, approval or sandbox
settings change in Codex's effective configuration. Steering an active turn does
not start another turn or silently replace its settings.

## Conversation search

In Web, enter a query in the sidebar and choose **Search conversation history**.
Incremental matches appear while searching; the final response replaces those
provisional rows. Closing or cancelling a search cancels its upstream request.
The Archived view searches archived conversations. Selecting a result does not
claim it: use the usual session binding action before interacting.

Telegram and the Slack root conversation also accept `/search <text>`, returning
up to eight matches with normal session handoff controls. Subsequent requests do
not reuse a pending search from another connection.

## Default provider

Open **Codex tools** in the Web sidebar, or use `/provider` in Telegram or the
Slack root conversation. The list comes from Codex; it does not expose provider
credentials or create another Bridge configuration layer.

Choosing **Save default**, or sending `/provider <id>`, changes Codex's global
default provider when Codex permits it. It does not interrupt an active turn.
Projects can override the global setting. An existing session can still be tied
to its original provider: Bridge retains the provider compatibility check rather
than migrating history or creating a replacement session automatically. Next-turn
configuration refresh and provider migration are distinct operations.

Writes with an unknown result are not retried automatically. Reopen the list to
inspect the current setting before trying again.

## Realtime history

**Codex tools → Read realtime history**, or `/realtime`, reads existing voice
transcripts and lifecycle entries for an owned session. It does not activate a
microphone, start a realtime call or generate audio. Pending and unsupported
history coverage is shown as reported; it is not treated as an empty completed
history. Web pagination keeps the original snapshot boundary.

## MCP registration scope and error details

MCP registrations are isolated by thread, environment and server name. One
environment becoming ready cannot clear another environment's failure. The
quiet summary still counts distinct server names; detailed status identifies
the environment. Older Codex messages without an environment remain supported.

Public errors retain known API-key/project/organization spend-limit categories,
additional details and public misalignment explanations. Private payloads and
suggested continuation instructions are not executed or displayed. If an error
was already shown, later richer reports add only previously unseen details.
