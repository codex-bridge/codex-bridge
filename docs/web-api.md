# Web API and behavior

This document is the technical reference for the browser workbench and its
same-origin HTTP/SSE API. End users should start with the repository README.

## Runtime shape

`yarn build` builds the backend and the React/Vite frontend. The Bridge listener
serves the workbench at `/` from `dist/web-ui`; there is no second production Web
server, API proxy, CORS exemption, or separate authentication service.

Enable the listener with:

```dotenv
WEB_ENABLED=true
WEB_HOST=127.0.0.1
WEB_PORT=8787
```

`WEB_HOST` accepts an IP address or `localhost`. Use a LAN IP or `0.0.0.0` only
on a trusted network. The browser and API must use the same origin.

Optional `WEB_TLS_CERT_FILE` and `WEB_TLS_KEY_FILE` enable native HTTPS on this
same listener. Configure both files or neither; unreadable or invalid TLS files
fail startup instead of falling back to HTTP. Origin checks use the listener's
actual scheme and port, never forwarded headers. Use a certificate trusted by
the browser. HTTPS does not add user authentication.

`GET /api/web/health` checks the Web listener, not the Codex runtime.

## Security boundaries

Protected requests require both headers:

- `X-Bridge-Window-Id: <window-id>`
- `Authorization: Bearer <window-token>`

Tokens are never accepted in URLs. API responses disable caching, and
cross-origin browser requests are rejected. This is an origin guard, not user
authentication; do not expose the listener directly to the internet.

Window connection rights and session ownership are independent:

- one browser window holds the in-memory Web connection grant;
- a connected window may inspect the catalog without reading conversations;
- only the current owner of a session may read its history, send, or decide;
- taking over a window does not transfer session ownership or interrupt work.

Connection grants do not survive a Bridge restart.

## Window connection endpoints

- `GET /api/web/connection` returns the holder window ID or `null`; it never
  returns a token.
- `POST /api/web/window/acquire` accepts `{ "windowId": "window-id" }` and
  returns a random token. An occupied connection returns HTTP 409. Passing
  `"takeover": true` explicitly replaces the holder and closes its streams.
- `GET /api/web/window` checks existing credentials without acquiring a grant.
- `POST /api/web/window/restore` rotates valid same-window credentials after a
  refresh. Consumed, replaced, released, or restarted grants return HTTP 403.
- `POST /api/web/window/release` releases only the matching holder.

Network loss does not release a grant. Reconnect uses the original grant and
never silently acquires a new one.

## Event stream

`GET /api/web/events` is an SSE stream. It emits:

- `connected` plus heartbeat comments;
- `connection-lost` with `taken_over`, `restored`, `released`, or
  `server_stopped`;
- `session-binding` metadata targeted to the relevant source;
- `message` events with `send`, `edit`, `delete`, or `clear-actions` operations;
- `attention` events for live, Web-owned sessions, independent of selected session.

Message events carry a complete structured `MessageSpec`, logical message and
session IDs, the native thread ID, and the lease version. They do not contain
Slack/Telegram-rendered HTML or chat callback payloads.

Events are ephemeral and are not replayed. Every write rechecks the current
window grant and session owner.

## Background notifications

The bell control explicitly enables notifications for the current browser origin.
Only the window holding the Web connection receives attention events. The browser
shows them only while its page is hidden, with permission and a secure context.
Notification types are: a completed reply turn, actionable approval or input,
execution stopped by a terminal failure, and acquisition of a previously pending
session binding. A completed reply turn does not mean the user's overall task is
finished. A normal tool failure followed by continued execution is not a notice.
Manual interrupts without a terminal error are quiet.

Attention events contain stable IDs, session/thread identity, directory, display
name and lease version; no response text, commands or error payloads are copied
into OS notifications. Duplicate events are bounded and deduplicated in memory.
History reads and reconnection do not replay notifications. Session transfer or
window takeover cancels pending notices and closes existing ones for the lost access.
Immediately successful bindings and other immediate action receipts are quiet.

The notification-only service worker displays notices and routes clicks back to
the originating open tab. Clicking selects the session; it never takes over a
connection or binds a session. Closed pages are not reopened. There is no Web Push
subscription, third-party provider, offline cache or background network connection.
Sleeping browsers or suspended tabs may miss events. Mobile browser support also
depends on platform restrictions, such as installed-web-app requirements.

## Catalog and directories

`GET /api/web/catalog` returns metadata-only directory and session inventory.
It deduplicates by native thread ID and includes archive, ownership, pending
handoff, and supported-capability state. It does not resume a thread, read a
transcript, or claim ownership.

`POST /api/web/directories` accepts:

```json
{ "path": "/existing/project" }
```

The path must be an existing readable directory on the Bridge machine. The
endpoint registers it as navigation metadata; it does not create a directory,
Codex thread, Bridge session, task, or active selection. Registering the same
normalized path is idempotent.

## Session ownership

`POST /api/web/session/request` accepts a native `threadId` and optional
`leaseVersion`. It explicitly takes Web ownership when the session is available,
or records a pending handoff when current work prevents an immediate transfer.
It may register previously unseen upstream metadata, but it does not read or
resume the thread.

`POST /api/web/session/cancel` cancels only Web's pending handoff. It never
cancels another source's pending handoff, ownership, or running work.

`POST /api/web/session/manage` with action `release` releases a Web-owned session
for external Codex use. The action is available only when Bridge confirms the
session is idle with no accepted queue, open decision/input, or pending handoff.

Handoff policy is shared with Telegram and Slack:

- free, idle sessions transfer immediately;
- running work, pending upstream dispatches, approvals/input, and accepted queues
  defer transfer;
- the latest pending source replaces the previous one rather than entering a
  FIFO queue;
- existing work keeps its original delivery route.

## History

`POST /api/web/session/history` requires current Web ownership. It returns at
most the latest five user/assistant messages, oldest first. It does not include
temporary statistics or replay approvals.

Ownership is checked before and after the upstream read and immediately before
delivery. Typical failures are:

- HTTP 403: not the owner;
- HTTP 404: unavailable session;
- HTTP 409: stale lease version;
- HTTP 503: history service unavailable.

History lacks stable upstream message IDs. The client merges overlap by
contiguous role/text pairs, which preserves repeated short replies better than
global text deduplication but cannot disambiguate every history.

## Sending and attachments

`POST /api/web/session/send` accepts JSON text or multipart input with:

- `threadId`;
- unique `requestId`;
- `text`;
- optional `leaseVersion`;
- one to five repeated `attachment` fields for multipart requests.

The JSON text limit is 6000 characters and the JSON body limit is 8192 bytes.
Request IDs contain 1–128 ASCII letters, digits, underscores, or hyphens.

Idle sessions start a turn. Running sessions use the existing steer path.
Slash-prefixed text remains conversation text rather than becoming a Bridge
command. HTTP 202 acknowledges acceptance, not task completion.

Request IDs are idempotency keys only after Bridge records the send. A missing
or error response can have an unknown outcome and must not be retried
automatically.

Web accepts PNG, JPEG, WebP, and GIF images only. Other file types are rejected.
Limits are five images, 10 MiB per image, and 25 MiB total. Pending, failed, or
uncertain images expire after seven days; images confirmed sent to Codex expire
after 24 hours. `WEB_ATTACHMENT_DIR` overrides the default
`workspaces/web-attachments` directory.

`POST /api/web/session/queue/send` uses the same request shape and explicitly
queues input for a running session. Queued files keep the seven-day retention
until their turn starts.

## Decisions and MCP input

`POST /api/web/session/decisions` returns pending and awaiting-input cards for an
owned session. It exposes native Bridge decision IDs and safe display content,
not upstream RPC tokens or chat callbacks.

`POST /api/web/session/decision` accepts a `threadId`, `decisionId`, action,
optional `leaseVersion`, and input content when required. Cards advertise their
currently available actions:

- `accept`
- `acceptForSession`
- `decline`
- `cancel`
- `submit`

MCP forms first enter `awaitingInput`; `submit` requires an object containing the
known required fields. The browser cannot invent command amendments or permission
overrides. A successful response records the decision transition, not completion
of the requested work.

Decision dispatch is serialized and the original upstream token is single-use.
Unknown outcomes are never retried automatically.

## Browser persistence

The selected native thread ID is stored in `/?session=<thread-id>`, so refresh,
bookmarks, and browser navigation preserve the target without claiming it.

Optional local storage retains dialogue/stat display history for up to 20
sessions, 100 messages per session, 512 KiB total, and seven days without an
update. It excludes window tokens, callbacks, approval controls, and ambiguous
sends. Cached content loads only after fresh owned reads succeed and cannot
authorize an operation.

Composer drafts are stored per session. Selected images are retained in the
current browser's IndexedDB for refresh recovery and are cleared after an
accepted send. They are not uploaded until a send or queue action is accepted.

## Error and retry policy

- HTTP success means the operation was accepted or recorded, not that Codex work
  completed successfully.
- Stale lease responses require a catalog refresh before another explicit action.
- Connection, send, decision, and release results that may have reached the
  server are never retried automatically.
- Taking over or restoring a window invalidates earlier credentials immediately.
