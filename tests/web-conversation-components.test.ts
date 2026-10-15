import assert from "node:assert/strict";
import test from "node:test";
import { File } from "node:buffer";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import type { ComposerActions, TimelineActions } from "../web/src/lib/conversation-actions.ts";
import type { MessageSpec, QueueSnapshot } from "../web/src/lib/protocol.ts";
import type { TimelineItem } from "../web/src/lib/timeline.ts";
import type { ConversationTimelineProps } from "../web/src/components/conversation-timeline.tsx";
import type { ComposerProps } from "../web/src/components/composer.tsx";

const options = { parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) };
const { ConversationTimeline } = await tsImport("../web/src/components/conversation-timeline.tsx", options) as
  typeof import("../web/src/components/conversation-timeline.tsx");
const { Composer } = await tsImport("../web/src/components/composer.tsx", options) as
  typeof import("../web/src/components/composer.tsx");
const { QueuePanel } = await tsImport("../web/src/components/queue-panel.tsx", options) as
  typeof import("../web/src/components/queue-panel.tsx");
const unexpected = () => assert.fail("render must not execute an operation");
const timelineActions: TimelineActions = { actMessage: unexpected, actDecision: unexpected };
const composerActions: ComposerActions = { setDraft: unexpected, addAttachments: unexpected,
  removeAttachment: unexpected, send: unexpected, queueDraft: unexpected };
const timelineProps: ConversationTimelineProps = { actions: timelineActions, selected: "a", items: [],
  entry: { threadId: "a", sessionId: "session-a", name: "Project A", directory: "/project",
    archived: false, updatedAt: null, provider: null, connection: "active",
    ownership: { state: "active", ownerSourceId: "web:local", pendingSourceId: null, version: 1 } },
  feedback: null, loading: false, catalogFresh: true, allowed: true, pending: false, busy: false,
  emptyTitle: null, emptyDescription: null };
const composerProps: ComposerProps = { actions: composerActions, selected: "a", draft: "saved draft", attachments: [],
  allowed: true, pending: false, busy: false, sending: false, queueRunning: false,
  placeholder: "Write a message", restriction: null };
const message = (title: string, kind: MessageSpec["kind"]): MessageSpec => ({ title, kind,
  body: [{ type: "text", text: title }], actions: [] });
const queue: QueueSnapshot = { threadId: "a", sessionId: "session-a", leaseVersion: 1, running: true, entries: [] };

test("extracted queue panel distinguishes unknown, idle and running empty queues", () => {
  for (const snapshot of [undefined, { ...queue, running: false }]) {
    assert.equal(renderToStaticMarkup(createElement(QueuePanel, {
      queue: snapshot, allowed: true, busy: false, onCancel: unexpected
    })), "");
  }
  const html = renderToStaticMarkup(createElement(QueuePanel, { queue, allowed: true, busy: false, onCancel: unexpected }));
  assert.match(html, /aria-label="Queued messages"/u);
  assert.match(html, /A turn is running/u);
  assert.match(html, /class="muted">0<\/span>/u);
  assert.doesNotMatch(html, />Cancel<\/button>/u);
});

test("queue order follows the snapshot and only confirmed queued entries can be cancelled", () => {
  const entries: QueueSnapshot["entries"] = [
    { id: "q-z", summary: "First item", state: "queued", createdAt: 3 },
    { id: "q-a", summary: "Second item", state: "submitting", createdAt: 1 },
    { id: "q-b", summary: "Unknown outcome", state: "unknown", createdAt: 2 }
  ];
  for (const [allowed, busy, disabled] of [[true, false, 2], [false, false, 3], [true, true, 3]] as const) {
    const html = renderToStaticMarkup(createElement(QueuePanel, {
      queue: { ...queue, running: false, entries }, allowed, busy, onCancel: unexpected
    }));
    assert.ok(html.indexOf("First item") < html.indexOf("Second item"));
    assert.ok(html.indexOf("Second item") < html.indexOf("Unknown outcome"));
    assert.equal((html.match(/disabled=""/gu) ?? []).length, disabled);
    assert.match(html, /class="queue-index">3<\/span>/u);
  }
});

test("timeline preserves interleaved history, Run and failed traces and typed Go/Next actions", () => {
  const items: TimelineItem[] = [
    { id: "old", origin: "history", message: message("Earlier reply", "codex") },
    { id: "run", origin: "live", message: message("Run", "progress") },
    { id: "failed", origin: "live", message: message("Failed reason", "failed") },
    { id: "new", origin: "live", message: { ...message("Final reply", "codex"), actions: [
      { id: "go", label: "Go", execution: { type: "send-text", text: "go" } },
      { id: "next", label: "Next", execution: { type: "send-text", text: "next" } }
    ] } }
  ];
  const html = renderToStaticMarkup(createElement(ConversationTimeline, { ...timelineProps, items }));
  const markers = ['data-message-id="old"', "Messages above are history", 'data-message-id="run"',
    'data-message-id="failed"', 'data-message-id="new"', ">Go</button>", ">Next</button>"];
  let previous = -1;
  for (const marker of markers) { const position = html.indexOf(marker); assert.ok(position > previous, marker); previous = position; }
  assert.doesNotMatch(html, /queue-panel/u);
});

test("timeline actions stay disabled for cached content, pending decisions, busy and non-owner views", () => {
  const item: TimelineItem = { id: "action", origin: "live", message: { ...message("Actions", "actions"), actions: [
    { id: "go", label: "Go", execution: { type: "send-text", text: "go" } }
  ] } };
  for (const [origin, patch, disabled] of [
    ["live", {}, false], ["cache", {}, true], ["live", { pending: true }, true],
    ["live", { busy: true }, true], ["live", { allowed: false }, true]
  ] as const) {
    const html = renderToStaticMarkup(createElement(ConversationTimeline, {
      ...timelineProps, ...patch, items: [{ ...item, origin }]
    }));
    assert.equal(html.includes('disabled=""'), disabled);
    assert.match(html, />Go<\/button>/u);
  }
});

test("timeline retains inline approval and MCP input states through narrow decision callbacks", () => {
  const input: MessageSpec = { ...message("Input", "decision"), decision: { id: "input-a", state: "awaitingInput",
    requiresUserInput: true, requestedFields: ["answer"], availableActions: ["cancel"], inputAllowed: true } };
  for (const [current, allowed, disabled] of [[true, true, false], [false, true, true], [true, false, true]] as const) {
    const html = renderToStaticMarkup(createElement(ConversationTimeline, {
      ...timelineProps, allowed, items: [{ id: "input", message: input, origin: "live", openDecision: current }]
    }));
    if (!current) {
      assert.match(html, /Status unknown/u);
      assert.doesNotMatch(html, /Submit input|>Cancel<\/button>/u);
      continue;
    }
    assert.match(html, /MCP input/u);
    assert.match(html, /<code>answer<\/code>/u);
    assert.equal(html.includes('disabled=""'), disabled);
    assert.match(html, />Submit input<\/button>/u);
  }
});

test("timeline notices keep missing, loading, stale and operation errors distinct", () => {
  const props = { ...timelineProps, entry: undefined };
  const missing = renderToStaticMarkup(createElement(ConversationTimeline, props));
  assert.match(missing, /target session is missing or unavailable/u);
  const stale = renderToStaticMarkup(createElement(ConversationTimeline, { ...props, catalogFresh: false }));
  assert.match(stale, /target session is preserved/u);
  const loading = renderToStaticMarkup(createElement(ConversationTimeline, { ...props, loading: true }));
  assert.match(loading, /5 most recent messages and open approvals/u);
  const failed = renderToStaticMarkup(createElement(ConversationTimeline, { ...props,
    feedback: { source: "operation", surface: "conversation", tone: "error", message: "Outcome unknown" } }));
  assert.match(failed, /role="alert"/u);
  assert.match(failed, /Outcome unknown/u);
  assert.doesNotMatch(failed, /target session is missing/u);
});

test("composer retains controlled drafts, image-only selection and pending/sending/queue button conditions", () => {
  for (const patch of [{}, { allowed: false }, { pending: true }, { busy: true }, { draft: "  " }, { sending: true }]) {
    const props = { ...composerProps, ...patch };
    const html = renderToStaticMarkup(createElement(Composer, props));
    assert.match(html, /<div class="composer-surface"><textarea/u);
    assert.match(html, /<label for="message-draft">Message<\/label>/u);
    assert.ok(html.includes(`>${props.draft}</textarea>`));
    assert.match(html, /maxLength="6000"/u);
    assert.match(html, /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/u);
    const submit = html.match(/<button[^>]*type="submit"[^>]*>/u)?.[0];
    assert.ok(submit);
    assert.equal(submit.includes('disabled=""'), !props.allowed || props.pending || props.busy || !props.draft.trim());
    assert.equal(html.includes("Sending…"), props.sending);
    assert.doesNotMatch(html, />Queue<\/button>/u);
  }
  const queued = renderToStaticMarkup(createElement(Composer, { ...composerProps, queueRunning: true, pending: true }));
  assert.match(queued, /type="button"[^>]*>Queue<\/button>/u);
  assert.doesNotMatch(queued, /type="button"[^>]*disabled=""[^>]*>Queue/u);
});

test("composer keeps restored images and offline drafts visible without sending", () => {
  const file = new File(["image data"], "restored.png", { type: "image/png" });
  const html = renderToStaticMarkup(createElement(Composer, {
    ...composerProps, allowed: false, draft: "restored draft", attachments: [file], restriction: "Reconnect before sending."
  }));
  assert.match(html, />restored draft<\/textarea>/u);
  assert.match(html, /aria-label="Images to send"/u);
  assert.match(html, /aria-label="Remove image restored.png"/u);
  assert.match(html, /Reconnect before sending\./u);
  const imageOnly = renderToStaticMarkup(createElement(Composer, { ...composerProps, draft: "", attachments: [file] }));
  assert.doesNotMatch(imageOnly, /type="submit"[^>]*disabled=""/u);
  const noSelection = renderToStaticMarkup(createElement(Composer, { ...composerProps, selected: null, allowed: false }));
  assert.match(noSelection, /<textarea[^>]*disabled=""/u);
});
