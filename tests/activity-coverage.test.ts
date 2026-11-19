import assert from "node:assert/strict";
import test from "node:test";
import { extractProgressEvent, extractStatusUpdate } from "../src/codex/notification-events.js";
import { extractActivityEvent } from "../src/codex/activity-events.js";
import { normalizeProgressEvent } from "../src/bridge/progress/normalizer.js";
import { BridgeStore } from "../src/store/index.js";
import { fixtureProgressService } from "./fixtures/progress-service.js";
import type { AppServerNotification } from "../src/codex/client.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { NotificationDispatcher } from "../src/bridge/notifications/dispatcher.js";
import { messageAppearance } from "../web/src/lib/message-appearance.js";
import { createProgressMessageSpec } from "../src/bridge/renderers/progress.js";

function item(type: string, id: string, extra: object = {}, completed = true): AppServerNotification {
  return { method: completed ? "item/completed" : "item/started", params: { threadId: "thread", turnId: "turn", item: { type, id, ...extra } } };
}
function hook(id: string, completed: boolean, extra: object = {}): AppServerNotification {
  return { method: completed ? "hook/completed" : "hook/started", params: { threadId: "thread", turnId: "turn",
    run: { id, eventName: "preCompact", status: completed ? "completed" : "running", ...extra } } };
}

test("activity extraction preserves actual plan, review, image and wait fields without guessing completion", () => {
  const plan = extractProgressEvent({ method: "turn/plan/updated", params: { threadId: "thread", turnId: "turn", explanation: "Next steps",
    plan: [{ step: "Inspect", status: "completed" }, { step: "Fix", status: "inProgress" }] } })!;
  assert.deepEqual(plan.activity!.lines, ["Next steps", "1. [Completed] Inspect", "2. [In progress] Fix"]);
  assert.equal(plan.activity!.terminal, false);
  assert.deepEqual(extractProgressEvent(item("plan", "p", { text: "Actual model plan" }))!.activity!.lines, ["Actual model plan"]);
  assert.deepEqual(extractProgressEvent(item("sleep", "w", { durationMs: 300 }))!.activity!.lines, ["Requested duration: 300 ms"]);
  assert.equal(extractProgressEvent(item("sleep", "w", { durationMs: 300 }, false))!.activity!.status, "Waiting");
  assert.deepEqual(extractProgressEvent(item("imageView", "v", { path: "/work/image.png" }))!.activity!.lines, ["/work/image.png"]);
  for (const type of ["enteredReviewMode", "exitedReviewMode"]) {
    assert.deepEqual(extractProgressEvent(item(type, type, { review: "Actual review content" }))!.activity!.lines, ["Actual review content"]);
  }
});

test("Hook and automated review include public outcomes without Hook context, tool inputs or invented turn IDs", () => {
  const event = extractProgressEvent(hook("h", true, { status: "blocked", statusMessage: "Needs attention", sourcePath: "/private/hook",
    entries: [{ kind: "context", text: "private context" }, { kind: "feedback", text: "private feedback" },
      { kind: "error", text: "Public hook error" }] }))!;
  assert.deepEqual(event.activity!.lines, ["Needs attention", "error: Public hook error"]);
  assert.equal(event.failed, true);
  const nullTurn = hook("h", true); (nullTurn.params as Record<string, unknown>).turnId = null;
  assert.equal(extractProgressEvent(nullTurn), null);
  const review = extractProgressEvent({ method: "item/autoApprovalReview/completed", params: { threadId: "thread", turnId: "turn",
    reviewId: "r", review: { status: "denied", rationale: "Public rationale" }, action: { command: "private command" } } })!;
  assert.equal(review.failed, false, "review denial is not evidence that the tool executed and failed");
  assert.deepEqual(review.activity!.lines, ["Public rationale"]);
  assert.equal(review.activity!.status, "denied");
  assert.equal(extractProgressEvent({ method: "item/plan/delta", params: { threadId: "thread", delta: "partial" } }), null);
});

test("failed activities keep their title, subdued transport presentation and Web error tone through finalization", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/workspace/src/_appio/_inbox/codex-bridge" });
  const sent: MessageSpec[] = [];
  const service = fixtureProgressService(store, (_id, spec) => sent.push(spec));
  await service.sendProgressMessage(session, extractProgressEvent(hook("failed", true, { status: "blocked", statusMessage: "Manual confirmation needed" }))!, "turn");
  await service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.ok(sent.length >= 2, "both the preview and final edit must be observed");
  for (const spec of sent) {
    assert.equal(spec.title, "Hook · .../_inbox/codex-bridge");
    assert.equal(spec.kind, "failed");
    assert.equal(spec.presentation, "activity");
    assert.deepEqual(messageAppearance(spec), { appearance: "activity", tone: "error" });
    assert.deepEqual(spec.body, [{ type: "text", text: "preCompact · Blocked" }, { type: "text", text: "Manual confirmation needed" }]);
    assert.equal(renderSlackMessageSpec("slack:T:C:1", spec, null).every(block => block.type === "context"), true);
    assert.match(renderTelegramMessageSpec(spec).markdown, /^<footer>/);
  }
});

test("plan steps share readable status labels without rewriting user content or repeating the Plan heading", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const sent: MessageSpec[] = [];
  const service = fixtureProgressService(store, (_id, spec) => sent.push(spec));
  const event = extractProgressEvent({ method: "turn/plan/updated", params: { threadId: "thread", turnId: "turn",
    plan: [{ step: "Inspect", status: "completed" }, { step: "Keep the literal [inProgress] token", status: "inProgress" },
      { step: "Verify", status: "pending" }, { step: "Future state", status: "futureStatus" }] } })!;
  await service.sendProgressMessage(session, event, "turn");
  await service.clearProgressMessageForThread("thread", { turnId: "turn" });
  for (const spec of sent) {
    assert.equal(spec.title, "Plan · /work");
    assert.deepEqual(spec.body.map(part => "text" in part ? part.text : part.value), ["Updated",
      "1. [Completed] Inspect", "2. [In progress] Keep the literal [inProgress] token", "3. [Pending] Verify", "4. [futureStatus] Future state"]);
  }
});

test("activity status labels preserve review meaning and unknown values across the shared renderer", () => {
  for (const [status, label] of [["inProgress", "In progress"], ["approved", "Approved"], ["denied", "Denied"],
    ["timedOut", "Timed out"], ["aborted", "Aborted"], ["API_ONLY", "API_ONLY"], ["toString", "toString"]]) {
    const event = extractProgressEvent({ method: "item/autoApprovalReview/completed", params: { threadId: "thread", turnId: "turn",
      reviewId: "review", review: { status, rationale: "Original rationale" } } })!;
    const spec = createProgressMessageSpec({ directory: "/work", event });
    assert.equal(event.activity!.status, status, "the upstream status remains unchanged");
    assert.equal(spec.kind, "progress", "review outcomes are not tool execution failures");
    assert.deepEqual(spec.body, [{ type: "text", text: `Approval review · ${label}` }, { type: "text", text: "Original rationale" }]);
  }
  const event = extractProgressEvent(item("exitedReviewMode", "review", { review: "Actual review content" }))!;
  assert.deepEqual(createProgressMessageSpec({ directory: "/work", event }).body,
    [{ type: "text", text: "Result" }, { type: "text", text: "Actual review content" }]);
});

test("dynamic tools show the declared name and explicit result, while raw output and Hook prompts remain internal", () => {
  const dynamic = extractProgressEvent(item("dynamicToolCall", "d", { namespace: null, tool: "probe", status: "failed", success: false,
    arguments: { query: "Actual tool argument" }, contentItems: [{ text: "private output" }] }))!;
  assert.equal(normalizeProgressEvent(dynamic)!.operation, "probe");
  assert.equal(dynamic.failed, true);
  assert.match(dynamic.inputPreview!, /Actual tool argument/);
  assert.equal(JSON.stringify(dynamic).includes("private"), false);
  for (const type of ["functionCallOutput", "hookPrompt"]) {
    assert.equal(extractProgressEvent(item(type, "internal", { name: "mcp__secret__read", server: "secret", tool: "read", output: "private output" })), null);
    assert.equal(extractStatusUpdate(item(type, "internal", { name: "private-status-name" }, false)), null);
  }
  assert.equal(extractActivityEvent(item("futureItem", "u")), null);
});

test("activities keep ordered phases, update late completion in its original block, and preserve content through storage", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const cards = new Map<string, MessageSpec>(), sends: string[] = [];
  const service = fixtureProgressService(store, (id, spec, edit) => { cards.set(id, spec); if (!edit) sends.push(id); });
  const send = async (notification: AppServerNotification) => { const event = extractProgressEvent(notification)!; assert.ok(event); await service.sendProgressMessage(session, event, "turn"); };
  await send(hook("h1", false));
  const hookPhase = store.getActiveProgressPhaseMessage("thread", "turn")!;
  await send(item("sleep", "w1", { durationMs: 100 }, false));
  const waiting = store.getActiveProgressPhaseMessage("thread", "turn")!;
  await send(hook("h1", true, { statusMessage: "Hook finished" }));
  assert.equal(sends.length, 2, "a late completion edits its original block instead of reopening its type");
  assert.equal(store.getActiveProgressPhaseMessage("thread", "turn")!.id, waiting.id);
  assert.equal(store.getProgressPhaseMessage(hookPhase.id)!.aggregate.activities![0]!.status, "completed");
  assert.match(renderLegacyMessage(cards.get(hookPhase.platformMessageId)!), /Hook finished/);
  await send(item("sleep", "w1", { durationMs: 100 }));
  await send(item("plan", "p1", { text: "First plan content" }));
  await send(item("imageView", "i1", { path: "/work/image.png" }));
  await send(item("plan", "p2", { text: "Second plan content" }));
  await send(item("exitedReviewMode", "r1", { review: "Review found no remaining issues" }));
  await service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.deepEqual([...cards.values()].map(c => c.title.split(" · ")[0]), ["Hook", "Waiting", "Plan", "Viewed", "Plan", "Review"]);
  assert.match(renderLegacyMessage(cards.get(sends[2]!)!), /First plan content/);
  assert.match(renderLegacyMessage(cards.get(sends[4]!)!), /Second plan content/);
  for (const spec of cards.values()) {
    assert.equal(spec.presentation, "activity");
    assert.deepEqual(spec.actions, []); assert.equal(spec.decision, undefined);
    for (const rendered of [renderSlackMessageSpec("slack:T:C", spec, null), renderTelegramMessageSpec(spec)]) {
      assert.equal(JSON.stringify(rendered).includes("Phase complete"), false);
    }
  }
  await send(hook("h1", false)); assert.equal(sends.length, 6, "late starts cannot overwrite terminal content");
});

test("identical content from distinct activity IDs is not lost, while replayed IDs remain idempotent", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  let sends = 0;
  const service = fixtureProgressService(store, (_id, _spec, edit) => { if (!edit) sends++; });
  for (const id of ["first", "second", "second"]) await service.sendProgressMessage(session, extractProgressEvent(item("imageView", id, { path: "/same.png" }))!, "turn");
  const phase = store.getActiveProgressPhaseMessage("thread", "turn")!;
  assert.equal(sends, 1); assert.equal(phase.aggregate.activities!.length, 2);
  assert.equal(phase.aggregate.eventCount, 2);
});

test("turn plan snapshots replace only within their consecutive phase and preserve later occurrence order", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const cards = new Map<string, MessageSpec>();
  const service = fixtureProgressService(store, (id, spec) => cards.set(id, spec));
  const plan = (step: string) => extractProgressEvent({ method: "turn/plan/updated", params: { threadId: "thread", turnId: "turn", plan: [{ step, status: "pending" }] } })!;
  await service.sendProgressMessage(session, plan("First"), "turn");
  await service.sendProgressMessage(session, plan("Updated first"), "turn");
  await service.sendProgressMessage(session, extractProgressEvent(item("imageView", "view", { path: "/work/image.png" }))!, "turn");
  await service.sendProgressMessage(session, plan("Later plan"), "turn");
  assert.equal(cards.size, 3);
  const output = [...cards.values()].map(renderLegacyMessage);
  assert.match(output[0]!, /Updated first/); assert.doesNotMatch(output[0]!, /Later plan/);
  assert.match(output[2]!, /Later plan/);
});

test("declared dynamic tools are not swallowed by legacy Called suppression after MCP input", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const sent: MessageSpec[] = [];
  const service = fixtureProgressService(store, (_id, spec) => { sent.push(spec); }, () => true);
  await service.sendProgressMessage(session, extractProgressEvent(item("dynamicToolCall", "d", { tool: "probe", status: "completed", success: true }))!, "turn");
  await service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.match(renderLegacyMessage(sent.at(-1)!), /probe ×1/);
});

test("new activities require the actual owned turn route and reject unrelated or stale turn events", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "thread", pathKey: "/work" });
  const owner = store.claimSession(session.id, "web:local");
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "thread", turnId: "turn", sourceId: "web:local", bindingId: owner.binding.id });
  const received: string[] = [];
  const dispatcher = new NotificationDispatcher({ store, resolveNotificationSession: async () => session,
    sendProgressMessage: async (_session, event) => { received.push(event.activity!.status); }
  } as ConstructorParameters<typeof NotificationDispatcher>[0]);
  const event = hook("h", true);
  await dispatcher.handle(event);
  (event.params as Record<string, unknown>).turnId = "stale-turn";
  await dispatcher.handle(event);
  store.markSessionExternalUnknown(session.id);
  (event.params as Record<string, unknown>).turnId = "turn";
  await dispatcher.handle(event);
  assert.deepEqual(received, ["completed"]);
});

test("long activity content follows the existing visible-character limit without losing its title or stored content", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const sent: MessageSpec[] = [];
  const service = fixtureProgressService(store, (_id, spec) => sent.push(spec));
  const text = "Actual plan 🙂 ".repeat(200);
  await service.sendProgressMessage(session, extractProgressEvent(item("plan", "long", { text }))!, "turn");
  const record = store.getActiveProgressPhaseMessage("thread", "turn")!;
  assert.equal(record.aggregate.activities![0]!.lines[0], text);
  await service.clearProgressMessageForThread("thread", { turnId: "turn" });
  for (const spec of sent) {
    assert.equal(spec.title, "Plan · /work");
    const content = spec.body.map(p => p.type === "field" ? p.value : p.text).join("");
    assert.ok(Array.from(content).length <= 800); assert.match(content, /…$/);
  }
});
