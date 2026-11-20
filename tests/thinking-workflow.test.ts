import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerNotification, AppServerProgressEvent } from "../src/codex/client.js";
import { ReasoningSummaryTracker } from "../src/codex/reasoning-summary.js";
import { NotificationDispatcher } from "../src/bridge/notifications/dispatcher.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { markdownToText } from "../src/shared/markdown-text.js";
import { BridgeStore } from "../src/store/index.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { presentWebMessage } from "../src/web/message-presentation.js";
import { messageAppearance } from "../web/src/lib/message-appearance.js";
import { fixtureProgressService } from "./fixtures/progress-service.js";

function delta(id: string, text: string, summaryIndex = 0): AppServerNotification {
  return { method: "item/reasoning/summaryTextDelta", params: {
    threadId: "thread", turnId: "turn", itemId: id, delta: text, summaryIndex
  } };
}
function completed(id: string, summary: string[], content = ["private reasoning content"]): AppServerNotification {
  return { method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
    id, type: "reasoning", summary, content
  } } };
}
const run: AppServerProgressEvent = { threadId: "thread", turnId: "turn", itemId: "command", label: "Run", toolName: null,
  action: null, target: null, input: null, changes: null, failed: false, completed: false, text: "pwd" };

test("Thinking tracks only public summaries, preserves streamed whitespace and orders actual summary indexes", () => {
  const tracker = new ReasoningSummaryTracker();
  assert.equal(tracker.observe({ method: "item/reasoning/summaryPartAdded", params: {
    threadId: "thread", turnId: "turn", itemId: "r", summaryIndex: 0
  } }, "turn"), null);
  tracker.observe(delta("r", "**Planning"), "turn");
  tracker.observe(delta("r", " "), "turn");
  assert.deepEqual(tracker.observe(delta("r", "scenario**"), "turn")!.activity!.lines, ["**Planning scenario**"]);
  assert.deepEqual(tracker.observe(delta("r", "Second", 1), "turn")!.activity!.lines, ["**Planning scenario**", "Second"]);
  const event = tracker.observe(completed("r", ["**Final summary**"]), "turn")!;
  assert.deepEqual(event.activity!.lines, ["**Final summary**"]);
  assert.equal(event.activity!.terminal, true);
  assert.doesNotMatch(JSON.stringify(event), /private reasoning/);
  assert.equal(tracker.observe(delta("r", "late duplicate"), "turn"), null);
  assert.equal(tracker.observe(completed("r", ["**Final summary**"]), "turn"), null);
  assert.equal(tracker.observe(completed("private-only", []), "turn"), null);
  assert.equal(tracker.observe({ method: "item/reasoning/textDelta", params: {
    threadId: "thread", turnId: "turn", itemId: "raw", delta: "private reasoning content", contentIndex: 0
  } }, "turn"), null);
});

test("Thinking requires real item, turn and summary index identities and resets with its turn", () => {
  const tracker = new ReasoningSummaryTracker();
  assert.equal(tracker.observe(delta("r", "Old"), undefined), null);
  assert.equal(tracker.observe(delta("r", "Old"), "other-turn"), null);
  for (const index of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(tracker.observe(delta("r", "Invalid", index), "turn"), null);
  }
  const missing = delta("r", "Invalid"); delete (missing.params as Record<string, unknown>).itemId;
  assert.equal(tracker.observe(missing, "turn"), null);
  tracker.observe(delta("r", "Old"), "turn");
  tracker.reset("thread", "stale-turn");
  assert.deepEqual(tracker.observe(delta("r", " kept"), "turn")!.activity!.lines, ["Old kept"]);
  tracker.reset("thread");
  assert.deepEqual(tracker.observe(delta("r", "Fresh"), "turn")!.activity!.lines, ["Fresh"]);
});

test("Thinking uses one subdued block per consecutive phase and preserves its place around Run and Edited", async t => {
  let now = 100_000; t.mock.method(Date, "now", () => now);
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const deliveries: Array<{ id: string; spec: MessageSpec; edit: boolean }> = [];
  const service = fixtureProgressService(store, (id, spec, edit) => deliveries.push({ id, spec, edit }));
  const tracker = new ReasoningSummaryTracker();
  await service.sendProgressMessage(session, tracker.observe(delta("r1", "**Planning"), "turn")!, "turn");
  const first = store.getActiveProgressPhaseMessage("thread", "turn")!;
  now += 1_000;
  await service.sendProgressMessage(session, tracker.observe(delta("r1", " scenario**"), "turn")!, "turn");
  assert.equal(deliveries.length, 1, "streaming updates are throttled but retained in the aggregate");
  now += 5_000;
  await service.sendProgressMessage(session, tracker.observe(completed("r1", ["**Planning scenario**"]), "turn")!, "turn");
  assert.equal(deliveries.at(-1)!.id, first.platformMessageId);
  await service.sendProgressMessage(session, run, "turn");
  assert.equal(store.getProgressPhaseMessage(first.id)!.state, "phase_complete");
  await service.sendProgressMessage(session, tracker.observe(delta("r2", "Reviewing results"), "turn")!, "turn");
  await service.sendProgressMessage(session, { ...run, itemId: "edit", label: "Edited", completed: true,
    changes: [{ path: "/work/policy.ts", type: "update", added: 12, removed: 4, lineStatsAvailable: true }] }, "turn");
  await service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.deepEqual(deliveries.filter(d => !d.edit).map(d => d.spec.title),
    ["Thinking · /work", "Run · /work", "Thinking · /work", "Edited · /work"]);
  const firstFinal = deliveries.filter(d => d.id === first.platformMessageId).at(-1)!.spec;
  assert.equal(renderLegacyMessage(firstFinal), "Thinking · /work\nPlanning scenario");
  assert.deepEqual(store.getProgressPhaseMessage(first.id)!.aggregate.activities![0]!.lines, ["**Planning scenario**"]);
  for (const { spec } of deliveries.filter(d => d.spec.title.startsWith("Thinking"))) {
    assert.equal(spec.presentation, "activity");
    assert.deepEqual(spec.actions, []);
    assert.deepEqual(messageAppearance(presentWebMessage(spec)), { appearance: "activity", tone: "default" });
    const slack = renderSlackMessageSpec("slack:T:C:1", spec, null);
    assert.ok(slack.every(block => block.type === "context"));
    const telegram = renderTelegramMessageSpec(spec);
    assert.match(telegram.markdown, /^<footer>/);
    assert.doesNotMatch(telegram.html, /Completed|Succeeded|Failed/);
    if (spec === firstFinal) assert.doesNotMatch(telegram.html, /\*\*/);
  }
});

test("late Thinking completion updates its original phase without interrupting later work", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const deliveries: Array<{ id: string; spec: MessageSpec; edit: boolean }> = [];
  const service = fixtureProgressService(store, (id, spec, edit) => deliveries.push({ id, spec, edit }));
  const tracker = new ReasoningSummaryTracker();
  await service.sendProgressMessage(session, tracker.observe(delta("r", "Partial"), "turn")!, "turn");
  const thinking = store.getActiveProgressPhaseMessage("thread", "turn")!;
  await service.sendProgressMessage(session, run, "turn");
  const running = store.getActiveProgressPhaseMessage("thread", "turn")!;
  await service.sendProgressMessage(session, tracker.observe(completed("r", ["Full public summary"]), "turn")!, "turn");
  assert.equal(store.getActiveProgressPhaseMessage("thread", "turn")!.id, running.id);
  assert.equal(deliveries.filter(d => !d.edit).length, 2);
  assert.equal(deliveries.at(-1)!.id, thinking.platformMessageId);
  assert.equal(renderLegacyMessage(deliveries.at(-1)!.spec), "Thinking · /work\nFull public summary");
});

test("Thinking finalization keeps only the summary across every terminal state and truncates visible content", async t => {
  for (const terminal of ["completed", "failed", "interrupted"] as const) {
    const store = new BridgeStore(":memory:"); t.after(() => store.close());
    const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
    const delivered: MessageSpec[] = [];
    const service = fixtureProgressService(store, (_id, spec) => delivered.push(spec));
    const summary = "**Public summary** 🙂 ".repeat(100);
    const event = new ReasoningSummaryTracker().observe(completed("long", [summary]), "turn")!;
    await service.sendProgressMessage(session, event, "turn");
    const record = store.getActiveProgressPhaseMessage("thread", "turn")!;
    await service.clearProgressMessageForThread("thread", { turnId: "turn", terminal });
    assert.equal(store.getProgressPhaseMessage(record.id)!.aggregate.activities![0]!.lines[0], summary);
    for (const spec of delivered) {
      const text = spec.body.map(part => part.type === "field" ? part.value : part.text).join("");
      assert.ok(Array.from(text).length <= 800);
      assert.match(text, /…$/);
      assert.doesNotMatch(text, /\*\*|Completed|Succeeded|Failed|Interrupted/);
      assert.deepEqual(messageAppearance(spec), { appearance: "activity", tone: "default" });
    }
  }
});

test("Thinking summaries pass the same active-turn ownership checks as other workflow activities", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "thread", pathKey: "/work" });
  const owner = store.claimSession(session.id, "web:local");
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "thread", turnId: "turn", sourceId: "web:local", bindingId: owner.binding.id });
  const received: AppServerProgressEvent[] = [];
  const dispatcher = new NotificationDispatcher({ store, resolveNotificationSession: async () => session,
    notificationTurnService: { handleStatusUpdate: async () => {} },
    sendProgressMessage: async (_session, event) => { received.push(event); }
  } as unknown as ConstructorParameters<typeof NotificationDispatcher>[0]);
  await dispatcher.handle(delta("r", "Allowed"));
  const stale = delta("stale", "Stale"); (stale.params as Record<string, unknown>).turnId = "old-turn";
  await dispatcher.handle(stale);
  store.markSessionExternalUnknown(session.id);
  await dispatcher.handle(delta("r", "Not owned"));
  assert.deepEqual(received.map(event => event.text), ["Allowed"]);
});

test("Markdown projection uses parsed text, retaining paths, whitespace, list boundaries and escaped literals", () => {
  assert.equal(markdownToText("**Planning** `src/my_file.ts`"), "Planning src/my_file.ts");
  assert.equal(markdownToText("# Summary\n\n- First\n- Second\n\nUse \\*literal\\*"), "Summary\nFirst\nSecond\nUse *literal*");
});
