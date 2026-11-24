import assert from "node:assert/strict";
import test from "node:test";
import { McpStatusNotifier } from "../src/bridge/notifications/mcp-status.js";
import { McpStartupTracker } from "../src/bridge/status/mcp-startup.js";
import { GoShortcutService } from "../src/bridge/interactions/go-shortcut.js";
import type { BridgeMessageOptions } from "../src/bridge/transport.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { SessionRecord } from "../src/shared/types.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { messageAppearance } from "../web/src/lib/message-appearance.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });
const session = { id: "session", codexThreadId: "thread", telegramChatId: "chat", pathKey: "/project" } as SessionRecord;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture() {
  const tracker = new McpStartupTracker();
  const sent: Array<{ source: string; spec: MessageSpec }> = [];
  let beforeSend: (options?: BridgeMessageOptions) => Promise<void> = async () => {};
  let afterAuthorize = async (): Promise<void> => {};
  const send = async (source: string, spec: MessageSpec, options?: BridgeMessageOptions) => {
    await beforeSend(options);
    if (await options?.canSend?.() === false) return null;
    await afterAuthorize();
    sent.push({ source, spec }); return { message_id: String(sent.length) };
  };
  const notifier = new McpStatusNotifier({ getUnavailable: thread => tracker.unavailableForThread(thread),
    getSessionDirectory: s => s.pathKey, sendMessageSpec: send });
  const actions = new GoShortcutService({ store: { getActiveSession: async () => session, getSessionLease: () => null,
    getSessionBindingById: () => null, listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
    messageOperations: { sendMessageSpec: send }, lastAssistantMessageByThread: new Map(), getSessionDirectory: s => s.pathKey,
    beforeActions: (s, source, canSend, signal) => notifier.deliverBeforeActions(s, source, canSend, signal) });
  return { tracker, notifier, actions, sent,
    fail: (name: string, threadId: string | null = "thread", error = "Unavailable") => tracker.remember({ name, threadId,
      source: "startup", status: "failed", error, failureReason: null }),
    ready: (name: string) => tracker.remember({ name, threadId: "thread", source: "startup", status: "ready", error: null, failureReason: null }),
    before: (callback: typeof beforeSend) => { beforeSend = callback; },
    after: (callback: typeof afterAuthorize) => { afterAuthorize = callback; },
    deliver: (source = "chat", s = session) => notifier.deliverBeforeActions(s, source, async () => true) };
}

test("MCP snapshots are standalone before Actions, quiet while unchanged, and report recovery once", async () => {
  const f = fixture();
  await f.actions.flush(session);
  assert.deepEqual(f.sent.map(s => s.spec.kind), ["actions"]);
  f.fail("figma"); await f.actions.flush(session);
  assert.deepEqual(f.sent.slice(-2).map(s => s.spec.title.split(" · ")[0]), ["MCP status", "Actions"]);
  f.fail("figma", "thread", "Another error detail"); await f.actions.flush(session);
  assert.equal(f.sent.filter(s => s.spec.title.startsWith("MCP status")).length, 1);
  f.ready("figma"); f.fail("notion"); await f.actions.flush(session);
  assert.deepEqual(f.sent.at(-2)!.spec.body, [{ type: "text", text: "MCP unavailable ×1 · notion" }]);
  f.ready("notion"); await f.actions.flush(session); await f.actions.flush(session);
  const snapshots = f.sent.filter(s => s.spec.title.startsWith("MCP status"));
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.at(-1)!.spec.body, [{ type: "text", text: "MCP unavailable ×0" }]);
  assert.ok(f.sent.filter(s => s.spec.kind === "actions").every(s => s.spec.body.length === 0));
  f.fail("notion"); await f.actions.flush(session);
  assert.equal(f.sent.filter(s => s.spec.title.startsWith("MCP status")).length, 4);
});

test("state is deduplicated per session across entries, with independent scoped states", async () => {
  const f = fixture(); f.fail("global", null); f.fail("local");
  await f.deliver("topic-a"); await f.deliver("topic-b");
  assert.equal(f.sent.length, 1);
  await f.deliver("other", { ...session, id: "other", codexThreadId: "other" });
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1]!.spec.body, [{ type: "text", text: "MCP unavailable ×1 · global" }]);
});

test("MCP notices use activity presentation with project context and no buttons", async () => {
  const f = fixture(); f.fail("tools<&>"); await f.deliver();
  const spec = f.sent[0]!.spec;
  assert.equal(spec.title, "MCP status · /project"); assert.equal(spec.presentation, "activity");
  assert.deepEqual(spec.actions, []);
  const slack = renderSlackMessageSpec("slack:T:C:1", spec, null);
  assert.ok(slack.length > 0 && slack.every(block => block.type === "context"));
  const telegram = renderTelegramMessageSpec(spec);
  assert.match(telegram.markdown, /^<footer>MCP status/);
  assert.ok(telegram.markdown.includes("tools&lt;&amp;&gt;")); assert.equal(telegram.keyboard, undefined);
  assert.deepEqual(messageAppearance(spec), { appearance: "activity", tone: "default" });
});

test("concurrent requests for one state produce one notice and changes during a wait defer to the next Actions", async () => {
  const f = fixture(), entered = gate(), blocked = gate(); f.fail("figma");
  f.before(async () => { entered.release(); await blocked.promise; });
  const first = f.deliver(); await entered.promise;
  assert.equal(await f.deliver(), false);
  f.fail("notion"); blocked.release(); assert.equal(await first, false);
  f.before(async () => {}); await f.deliver();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0]!.spec.body, [{ type: "text", text: "MCP unavailable ×2 · figma, notion" }]);
});

test("cancelled or ineligible sends do not consume a notice; ambiguous writes are not replayed", async () => {
  const f = fixture(); f.fail("figma");
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat", async () => false), false);
  const controller = new AbortController(); controller.abort();
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat", async () => true, controller.signal), false);
  f.after(async () => { throw new Error("network outcome unknown"); });
  assert.equal(await f.deliver(), false); assert.equal(await f.deliver(), false);
  assert.deepEqual(f.sent, []);
  f.fail("notion"); f.after(async () => {}); assert.equal(await f.deliver(), true);
});

test("new work cancels MCP and Actions while their transport slot is waiting", async () => {
  const f = fixture(), entered = gate(), blocked = gate(); f.fail("figma");
  f.before(async () => { entered.release(); await blocked.promise; });
  const sending = f.actions.flush(session); await entered.promise;
  f.actions.invalidate("thread"); blocked.release(); await sending; await f.actions.drain();
  assert.deepEqual(f.sent, []);
  f.before(async () => {}); await f.actions.flush(session);
  assert.deepEqual(f.sent.map(s => s.spec.title.split(" · ")[0]), ["MCP status", "Actions"]);
});

test("runtime reset invalidates an in-flight snapshot and allows the next runtime state to announce once", async () => {
  const f = fixture(), entered = gate(), blocked = gate(); f.fail("figma");
  f.before(async () => { entered.release(); await blocked.promise; });
  const old = f.deliver(); await entered.promise;
  f.notifier.clear(); blocked.release(); await old;
  assert.deepEqual(f.sent, []);
  f.before(async () => {}); await f.deliver(); await f.deliver();
  assert.equal(f.sent.length, 1);
});

test("fingerprints use complete names even when displayed text is truncated", async () => {
  const f = fixture(); const name = "a".repeat(900);
  f.fail(name); await f.deliver();
  f.ready(name); f.fail(`${name}b`); await f.deliver();
  assert.equal(f.sent.length, 2);
  for (const entry of f.sent) {
    const text = entry.spec.body[0]!;
    assert.ok(text.type === "text" && Array.from(text.text).length <= 800);
  }
});

test("Bridge delivers a changed MCP snapshot before Actions and omits it from later unchanged turns", async t => {
  const { BridgeService } = await import("../src/bridge/service.js");
  const { BridgeStore } = await import("../src/store/index.js");
  const { testConfig } = await import("./bridge-test-config.js");
  const store = new BridgeStore(":memory:");
  const bridge = new BridgeService(testConfig(":memory:"), store, { listQueuedSubmissions: async () => [] } as never);
  t.after(async () => { await bridge.shutdown(); store.close(); });
  const bound = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/project" });
  await store.setActiveSession("chat", bound.id); store.claimSession(bound.id, "chat");
  const writes: MessageSpec[] = [];
  bridge.registerMessageTransport({ name: "fixture", canHandle: () => true,
    sendMessageSpec: async (_source, spec) => { writes.push(spec); return { message_id: String(writes.length) }; },
    editMessageSpec: async () => true, sendMessage: async () => assert.fail("structured"),
    editMessageText: async () => true, deleteMessage: async () => true, clearMessageActions: async () => true, sendTyping: async () => {}
  });
  const internal = bridge as unknown as {
    handleAppServerNotification(event: { method: string; params: unknown }): Promise<void>;
    goShortcutService: GoShortcutService;
  };
  for (const turn of ["one", "two"]) {
    await internal.handleAppServerNotification({ method: "turn/started", params: { threadId: "thread", turn: { id: turn, status: "inProgress" } } });
    await internal.handleAppServerNotification({ method: "mcpServer/startupStatus/updated", params: {
      threadId: "thread", name: "figma", status: "failed", error: { message: "Unavailable" } } });
    await internal.handleAppServerNotification({ method: "item/completed", params: { threadId: "thread", turnId: turn,
      item: { id: `reply-${turn}`, type: "agentMessage", text: "Done", phase: "final_answer" } } });
    await internal.handleAppServerNotification({ method: "turn/completed", params: { threadId: "thread", turn: { id: turn, status: "completed" } } });
    await internal.goShortcutService.drain();
  }
  const relevant = writes.filter(spec => spec.kind === "actions" || spec.title.startsWith("MCP status"));
  assert.deepEqual(relevant.map(spec => spec.title.split(" · ")[0]), ["MCP status", "Actions", "Actions"]);
  assert.deepEqual(relevant[0]!.body, [{ type: "text", text: "MCP unavailable ×1 · figma" }]);
  assert.ok(relevant.filter(spec => spec.kind === "actions").every(spec => spec.body.length === 0));
});
