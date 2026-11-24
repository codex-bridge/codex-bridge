import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { extractWarningEvent, extractMcpStartupStatusEvent } from "../src/codex/notification-events.js";
import { McpStartupTracker, formatMcpUnavailableSummary } from "../src/bridge/status/mcp-startup.js";
import { NotificationNoticeService } from "../src/bridge/notifications/notices.js";
import { NotificationDispatcher } from "../src/bridge/notifications/dispatcher.js";
import { BridgeStore } from "../src/store/index.js";
import type { AppServerMcpStartupStatusEvent, AppServerNotification, CodexAppServerClient } from "../src/codex/client.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { formatMcpStartupFailureDetails, formatMcpStartupStatusCache } from "../src/bridge/status/formatters.js";
import { BridgeService } from "../src/bridge/service.js";
import { testConfig } from "./bridge-test-config.js";
import { NotificationListener } from "../src/bridge/notifications/listener.js";
import { SubagentTracker } from "../src/bridge/notifications/subagent-tracker.js";
import { WebMessageTransport } from "../src/web/transport.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";

const failure: AppServerMcpStartupStatusEvent = { threadId: null, source: "startup", name: "tools", status: "failed",
  error: "Could not connect", failureReason: "reauthenticationRequired" };
const ready: AppServerMcpStartupStatusEvent = { ...failure, status: "ready", error: null, failureReason: null };

test("warning extraction follows declared scopes and never stringifies private payloads", () => {
  assert.deepEqual(extractWarningEvent({ method: "warning", params: { threadId: "a", message: "Public message", private: "omit" } }),
    { kind: "warning", threadId: "a", message: "Public message", details: null, path: null });
  assert.deepEqual(extractWarningEvent({ method: "configWarning", params: { threadId: "injected", summary: "Bad config", details: "Fix the option", path: "/config.toml" } }),
    { kind: "configWarning", threadId: null, message: "Bad config", details: "Fix the option", path: "/config.toml" });
  assert.equal(extractWarningEvent({ method: "guardianWarning", params: { message: "No target" } }), null);
  assert.equal(extractWarningEvent({ method: "warning", params: { threadId: 2, message: "Bad target" } }), null);
  assert.equal(extractWarningEvent({ method: "deprecationNotice", params: { summary: " " } }), null);
  assert.equal(extractWarningEvent({ method: "error", params: { message: "Different owner" } }), null);
});

test("MCP extraction preserves scope and structured reason; OAuth success does not claim readiness", () => {
  assert.deepEqual(extractMcpStartupStatusEvent({ method: "mcpServer/startupStatus/updated", params: failure }), failure);
  assert.deepEqual(extractMcpStartupStatusEvent({ method: "mcpServer/oauthLogin/completed", params: { name: "tools", threadId: "a", success: true } }),
    { name: "tools", threadId: "a", source: "oauth", status: "authenticated", error: null, failureReason: null });
  assert.equal(extractMcpStartupStatusEvent({ method: "mcpServer/startupStatus/updated", params: { ...failure, threadId: 7 } }), null);
});

test("MCP incidents are scoped; only actual ready status rearms failure notices", () => {
  const tracker = new McpStartupTracker();
  assert.deepEqual(tracker.remember(failure), { failed: true, recovered: false });
  assert.deepEqual(tracker.remember({ ...failure, error: "Changed detail" }), { failed: false, recovered: false });
  tracker.remember({ ...ready, status: "starting" });
  tracker.remember({ ...ready, source: "oauth", status: "authenticated" });
  assert.deepEqual(tracker.remember(failure), { failed: false, recovered: false });
  assert.deepEqual(tracker.remember({ ...failure, threadId: "a" }), { failed: true, recovered: false });
  tracker.remember({ ...ready, threadId: "b" });
  assert.equal(tracker.forThread("a").get("tools")!.status, "failed");
  assert.equal(tracker.forThread("b").get("tools")!.status, "ready");
  assert.equal(tracker.forThread("c").get("tools")!.status, "failed");
  assert.deepEqual(tracker.remember(ready), { failed: false, recovered: true });
  assert.deepEqual(tracker.remember(failure), { failed: true, recovered: false });
  assert.equal(tracker.forThread("b").get("tools")!.status, "ready");
  tracker.clear(); assert.equal(tracker.forThread("a").size, 0);
});

test("MCP summaries count unique scoped unavailable servers, retain names, and clear only on readiness", () => {
  const tracker = new McpStartupTracker();
  for (let index = 0; index < 5; index++) tracker.remember(failure);
  tracker.remember({ ...failure, threadId: "a" });
  tracker.remember({ ...failure, threadId: "b", name: "other" });
  tracker.remember({ ...failure, threadId: "a", name: "figma" });
  assert.equal(formatMcpUnavailableSummary(tracker.unavailableForThread("a")), "MCP unavailable ×2 · figma, tools");
  assert.equal(formatMcpUnavailableSummary(tracker.unavailableForThread("b")), "MCP unavailable ×2 · other, tools");
  tracker.remember({ ...ready, threadId: "a", status: "starting" });
  tracker.remember({ ...ready, threadId: "a", source: "oauth", status: "authenticated" });
  assert.equal(tracker.unavailableForThread("a").length, 2);
  tracker.remember({ ...ready, threadId: "a" });
  assert.deepEqual(tracker.unavailableForThread("a"), ["figma"]);
  tracker.remember({ ...ready, threadId: "a", name: "figma" });
  assert.deepEqual(tracker.unavailableForThread("a"), []);
  tracker.clear(); assert.deepEqual(tracker.unavailableForThread("b"), []);
});

test("MCP failures and recoveries update cached details without sending or queuing standalone notices", async t => {
  const f = await fixture(t), session = (await f.store.getSessionByThreadId("a"))!;
  for (const event of [failure, { ...failure, threadId: "a" }, { ...failure, error: "New detail" }]) await f.service.handleMcpStartup(event);
  await f.service.flushPending(session, "web:local");
  assert.equal(f.sent.length, 0); assert.deepEqual(f.service.snapshot(), []);
  assert.deepEqual(f.tracker.unavailableForThread("a"), ["tools"]);
  await f.service.handleMcpStartup(ready);
  await f.service.handleMcpStartup({ ...ready, threadId: "a" });
  await f.service.flushPending(session, "web:local");
  assert.equal(f.sent.length, 0); assert.deepEqual(f.tracker.unavailableForThread("a"), []);
});

async function fixture(t: TestContext) {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  for (const thread of ["a", "b"]) {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: thread, pathKey: `/work/${thread}` });
    store.claimSession(session.id, "web:local");
  }
  const sent: Array<{ sourceId: string; spec: MessageSpec }> = [];
  const tracker = new McpStartupTracker();
  const service = new NotificationNoticeService({
    appendWorkflowMessage: (_session, operation) => operation(), store, mcpStartup: tracker,
    resolveNotificationSession: id => store.getSessionByThreadId(id), getSessionDirectory: s => s.pathKey,
    sendLongSpec: async (sourceId, spec) => { sent.push({ sourceId, spec }); } });
  return { store, sent, tracker, service };
}

test("equivalent warning methods share one global notice in either observation order", async t => {
  for (const globalFirst of [true, false]) {
    const f = await fixture(t), session = (await f.store.getSessionByThreadId("a"))!;
    const global = extractWarningEvent({ method: "configWarning", params: { summary: "A deprecated setting" } })!;
    const scoped = extractWarningEvent({ method: "warning", params: { threadId: "a", message: "A deprecated setting" } })!;
    for (const event of globalFirst ? [global, scoped] : [scoped, global]) await f.service.handleWarning(event);
    await f.service.handleWarning({ ...global, kind: "deprecationNotice" });
    await f.service.flushPending(session, "web:local");
    await f.service.handleWarning({ ...scoped, threadId: "b" });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.spec.session!.id, session.id);
    assert.equal(f.service.snapshot().length, 1);
    assert.equal(f.service.snapshot()[0]!.title, "Configuration warning");
  }
});

test("warning deduplication keeps different details, config paths and independent session warnings", async t => {
  const f = await fixture(t), session = (await f.store.getSessionByThreadId("a"))!;
  const global = extractWarningEvent({ method: "configWarning", params: { summary: "Invalid setting", details: "First detail", path: "/one.toml" } })!;
  await f.service.handleWarning(global);
  await f.service.handleWarning({ ...global, details: "Second detail" });
  await f.service.handleWarning({ ...global, path: "/two.toml" });
  await f.service.flushPending(session, "web:local");
  assert.equal(f.sent.length, 3);
  const local = extractWarningEvent({ method: "warning", params: { threadId: "a", message: "Local warning" } })!;
  await f.service.handleWarning(local);
  await f.service.handleWarning({ ...local, kind: "deprecationNotice" });
  await f.service.handleWarning({ ...local, threadId: "b" });
  assert.equal(f.sent.length, 5);
  assert.deepEqual(f.sent.slice(-2).map(s => s.spec.session!.directory), ["/work/a", "/work/b"]);
  await f.service.handleWarning({ ...global, kind: "guardianWarning", threadId: "a" });
  assert.equal(f.sent.length, 6, "a Guardian warning is not an alias for a configuration diagnostic");
});

test("failed authorization does not consume warning deduplication; concurrent aliases do not duplicate", async t => {
  const f = await fixture(t), session = (await f.store.getSessionByThreadId("a"))!;
  const local = extractWarningEvent({ method: "warning", params: { threadId: "a", message: "Authorization-sensitive warning" } })!;
  f.store.markSessionExternalUnknown(session.id);
  await f.service.handleWarning(local);
  assert.equal(f.sent.length, 0);
  f.store.clearSessionExternalUnknown(session.id); f.store.claimSession(session.id, "web:local");
  await Promise.all([f.service.handleWarning(local), f.service.handleWarning(local)]);
  assert.equal(f.sent.length, 1);
  await f.service.handleWarning({ ...local, threadId: null, kind: "configWarning" });
  await f.service.flushPending(session, "web:local");
  assert.equal(f.sent.length, 1);
});






test("global notices wait for a conversation, deduplicate service-wide and keep their read-only snapshot", async t => {
  const f = await fixture(t);
  const session = (await f.store.getSessionByThreadId("a"))!;
  const other = (await f.store.getSessionByThreadId("b"))!;
  const event = extractWarningEvent({ method: "deprecationNotice", params: { summary: "Deprecated feature", details: "Use the new setting" } })!;
  await f.service.handleWarning(event); await f.service.handleWarning(event);
  assert.equal(f.sent.length, 0);
  assert.equal(f.service.snapshot()[0]!.session, undefined);
  assert.equal(f.service.snapshot()[0]!.title, "Deprecation notice");
  const copy = f.service.snapshot(); copy[0]!.body = [];
  assert.equal(f.service.snapshot()[0]!.body.length, 2);
  await f.service.handleMcpStartup(failure);
  await f.service.handleMcpStartup({ ...failure, error: "Latest connection detail" });
  await Promise.all([f.service.flushPending(session, "web:local"), f.service.flushPending(other, "web:local")]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent.every(s => s.spec.session!.id === session.id), true);
  assert.match(f.sent[0]!.spec.title, /^Deprecation notice · /);
  assert.equal(f.sent.every(s => s.spec.presentation === "activity"), true);
  const slack = renderSlackMessageSpec("slack:T:C:1", f.sent[0]!.spec, null);
  assert.equal(slack.every(b => b.type === "context"), true);
  assert.match(JSON.stringify(slack), /Deprecation notice · .*work.*a ·/);
  const telegram = renderTelegramMessageSpec(f.sent[0]!.spec);
  assert.match(telegram.markdown, /<footer>/);
  assert.equal(telegram.html.includes("<b>"), false);
  await f.service.handleWarning(event);
  await f.service.flushPending(other, "web:local");
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.snapshot().length, 1, "pushing does not clear the status snapshot");
  await f.service.handleMcpStartup(ready);
  assert.equal(f.service.snapshot().length, 1);
  await f.service.flushPending(other, "web:local");
  assert.equal(f.sent.length, 1);
  await f.service.handleMcpStartup(failure);
  await f.service.flushPending(session, "web:local");
  assert.equal(f.sent.length, 1);
  f.service.clear(); f.tracker.clear();
  assert.deepEqual(f.service.snapshot(), []);
  await f.service.handleWarning(event);
  await f.service.flushPending(other, "web:local");
  assert.equal(f.sent.length, 2, "runtime cleanup allows the warning to notify again");
});


test("unauthorized or revoked inputs do not consume pending warnings; only one transport receives each batch", async t => {
  const f = await fixture(t);
  const session = (await f.store.getSessionByThreadId("a"))!;
  const event = extractWarningEvent({ method: "configWarning", params: { summary: "Check config" } })!;
  await f.service.handleWarning(event);
  await f.service.flushPending(session, "slack:T:C:old");
  await f.service.flushPending(session, "web:local", () => { throw new Error("window revoked"); });
  assert.equal(f.sent.length, 0);
  const other = await f.store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "tg", pathKey: "/work/tg" });
  f.store.claimSession(other.id, "123");
  await Promise.all([f.service.flushPending(other, "123"), f.service.flushPending(session, "web:local")]);
  assert.deepEqual(f.sent.map(s => s.sourceId), ["123"]);
  await f.service.handleWarning({ ...event, message: "New config warning" });
  await f.service.flushPending(session, "web:local");
  assert.deepEqual(f.sent.map(s => s.sourceId), ["123", "web:local"]);
});

test("scoped warnings and MCP failures follow their owned session and never fall back to global", async t => {
  const f = await fixture(t);
  const warning = { kind: "guardianWarning" as const, threadId: "a", message: "Review could not run", details: null, path: null };
  await f.service.handleWarning(warning);
  await f.service.handleWarning({ ...warning, threadId: "b" });
  await f.service.handleWarning({ ...warning, threadId: "unmapped" });
  await f.service.handleMcpStartup({ ...failure, threadId: "a" });
  assert.deepEqual(f.sent.map(s => s.spec.session!.directory), ["/work/a", "/work/b"]);
  assert.deepEqual(f.service.snapshot(), []);
  const session = (await f.store.getSessionByThreadId("a"))!;
  f.store.markSessionExternalUnknown(session.id);
  await f.service.handleWarning({ ...warning, message: "After ownership loss" });
  assert.equal(f.sent.length, 2);
  const chat = await f.store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "chat", pathKey: "/work/chat" });
  f.store.claimSession(chat.id, "123");
  await f.store.setActiveSession("123", chat.id);
  f.store.markSessionExternalUnknown(chat.id);
  await f.service.handleWarning({ ...warning, threadId: "chat", message: "Selected but no longer owned" });
  assert.equal(f.sent.length, 2, "chat selection alone does not authorize notice delivery");
  assert.deepEqual(f.tracker.unavailableForThread("a"), ["tools"]);
});
test("warning write failures do not block conversation or retry unknown outcomes; new warnings remain pending", async t => {
  const f = await fixture(t); let writes = 0;
  const session = (await f.store.getSessionByThreadId("a"))!;
  const event = extractWarningEvent({ method: "warning", params: { threadId: null, message: "Public warning" } })!;
  const service = new NotificationNoticeService({
    appendWorkflowMessage: (_session, operation) => operation(), store: f.store, mcpStartup: f.tracker,
    resolveNotificationSession: id => f.store.getSessionByThreadId(id), getSessionDirectory: s => s.pathKey,
    sendLongSpec: async () => {
      writes++;
      if (writes === 1) { await service.handleWarning({ ...event, message: "Arrived during delivery" }); throw new Error("write outcome unknown"); }
    } });
  await service.handleWarning(event);
  await service.flushPending(session, "web:local");
  assert.equal(writes, 1);
  await service.handleWarning(event);
  await service.flushPending(session, "web:local");
  assert.equal(writes, 2);
  await service.flushPending(session, "web:local");
  assert.equal(writes, 2); assert.equal(service.snapshot().length, 2);
});

test("ownership loss during a batch preserves unsent notices for a later valid conversation", async t => {
  const f = await fixture(t);
  const session = (await f.store.getSessionByThreadId("a"))!;
  const writes: MessageSpec[] = [];
  const service = new NotificationNoticeService({
    appendWorkflowMessage: (_session, operation) => operation(), store: f.store, mcpStartup: f.tracker,
    resolveNotificationSession: id => f.store.getSessionByThreadId(id), getSessionDirectory: s => s.pathKey,
    sendLongSpec: async (_source, spec) => { writes.push(spec); f.store.markSessionExternalUnknown(session.id); } });
  for (const message of ["First warning", "Second warning"]) await service.handleWarning({ kind: "warning", threadId: null, message, details: null, path: null });
  await service.flushPending(session, "web:local");
  assert.equal(writes.length, 1);
  assert.equal(f.store.clearSessionExternalUnknown(session.id), true);
  assert.equal(f.store.claimSession(session.id, "123").owned, true);
  await service.flushPending(session, "123");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1]!.body, [{ type: "text", text: "Second warning" }]);
});

test("notification dispatcher reaches notice handling without changing the task lifecycle", async t => {
  const f = await fixture(t);
  const dispatcher = new NotificationDispatcher({ notices: f.service } as ConstructorParameters<typeof NotificationDispatcher>[0]);
  await dispatcher.handle({ method: "warning", params: { threadId: null, message: "Low-level warning" } });
  await dispatcher.handle({ method: "mcpServer/startupStatus/updated", params: failure });
  assert.equal(f.sent.length, 0);
  assert.equal(f.service.snapshot().length, 1);
  assert.equal(dispatcher.getQueueKey({ method: "guardianWarning", params: { threadId: "a", message: "Review issue" } }), "a");
});

test("status rendering uses structured auth reason and does not classify notStarted as ready", () => {
  assert.equal(formatMcpStartupStatusCache(null, new Map([["tools", { status: "notStarted", error: null }]])), "0/1 ready, 1 unknown");
  assert.equal(formatMcpStartupFailureDetails(new Map([["tools", failure]])), "tools: Could not connect (reauthenticationRequired) Run: codex mcp login tools");
});

test("Bridge queues global warnings without historical fanout and flushes them on a real Web send", { timeout: 5000 }, async t => {
  const store = new BridgeStore(":memory:");
  await store.ensureSeedChats(["slack:T:C:1", "slack:T:C:2", "slack:T:X:1", "123", "999", "web:local"]);
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "web-thread", pathKey: "/workspace/src/_appio/_inbox/codex-bridge" });
  store.claimSession(session.id, "web:local");
  let notify!: (event: AppServerNotification) => void;
  let turns = 0;
  const service = new BridgeService({ ...testConfig(":memory:"), codexAppServerCommand: process.execPath,
    slackEnabled: true, slackAllowedChannelIds: new Set(["C"]), telegramAllowedChatIds: new Set(["123"]) }, store, {
    connect: async () => {}, onNotification: listener => { notify = listener; return () => {}; },
    sendTurn: async () => { turns++; return { turnId: "turn" }; }, steerTurn: async () => { turns++; return { turnId: "turn" }; },
    onApprovalRequest: () => () => {}, onUserInputRequest: () => () => {}
  } as unknown as CodexAppServerClient);
  t.after(async () => { await service.shutdown(); store.close(); });
  const sent: Array<{ sourceId: string; spec: MessageSpec }> = [];
  service.registerMessageTransport({ name: "isolated-notices", canHandle: () => true, wholeMessageSpecs: true,
    sendMessageSpec: async (sourceId, spec) => { sent.push({ sourceId, spec }); return { message_id: String(sent.length) }; },
    sendMessage: async () => null, editMessageText: async () => true, clearMessageActions: async () => true,
    deleteMessage: async () => true, sendTyping: async () => {} });
  await service.bootstrap();
  notify({ method: "configWarning", params: { summary: "Public configuration warning", details: "Check the option" } });
  // Drain the asynchronous notification listener before observing its snapshot.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
  const api = service.createWebApi();
  assert.equal(api.readServiceNotices()[0]!.title, "Configuration warning");
  await assert.rejects(api.sendText({ threadId: session.codexThreadId, requestId: "invalid", text: "hello" }, () => { throw new Error("revoked"); }));
  assert.equal(sent.length, 0);
  assert.equal((await api.sendText({ threadId: session.codexThreadId, requestId: "one", text: "hello" }, () => {})).accepted, true);
  assert.deepEqual(sent.map(s => s.sourceId), ["web:local"]);
  assert.equal(sent[0]!.spec.session!.id, session.id);
  assert.equal(sent[0]!.spec.title, "Configuration warning · .../_inbox/codex-bridge");
  assert.equal(sent[0]!.spec.presentation, "activity");
  notify({ method: "configWarning", params: { summary: "Another warning" } });
  await new Promise(resolve => setImmediate(resolve));
  await api.sendText({ threadId: session.codexThreadId, requestId: "one", text: "hello" }, () => {});
  assert.equal(sent.length, 1, "duplicate input must not consume a newly pending warning");
  await api.sendText({ threadId: session.codexThreadId, requestId: "two", text: "again" }, () => {});
  assert.equal(sent.length, 2); assert.equal(turns, 2);
  assert.equal(api.readServiceNotices().length, 2);
});

test("pending global warnings carry a usable Web delivery identity", async t => {
  const f = await fixture(t);
  const transport = new WebMessageTransport(f.store);
  const delivered: string[] = [];
  transport.subscribe(({ event }) => { delivered.push(event.threadId); });
  const service = new NotificationNoticeService({
    appendWorkflowMessage: (_session, operation) => operation(), store: f.store, mcpStartup: f.tracker,
    resolveNotificationSession: id => f.store.getSessionByThreadId(id), getSessionDirectory: s => s.pathKey,
    sendLongSpec: async (source, spec) => { assert.ok(await transport.sendMessageSpec(source, spec)); } });
  await service.handleWarning(extractWarningEvent({ method: "configWarning", params: { summary: "Check config" } })!);
  await service.flushPending((await f.store.getSessionByThreadId("a"))!, "web:local");
  assert.deepEqual(delivered, ["a"]);
});

test("direct-child notices reach their parent session instead of being swallowed by the subagent tracker", async t => {
  const f = await fixture(t);
  const parent = (await f.store.getSessionByThreadId("a"))!;
  const subagents = new SubagentTracker();
  subagents.observe({ method: "turn/started", params: { threadId: "a", turn: { id: "p1" } } }, parent.id);
  subagents.observe({ method: "item/completed", params: { threadId: "a", turnId: "p1",
    item: { id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/check" } } });
  const notices = new NotificationNoticeService({
    appendWorkflowMessage: (_session, operation) => operation(), store: f.store, mcpStartup: f.tracker,
    resolveNotificationSession: async id => subagents.route(id) ? parent : null, getSessionDirectory: s => s.pathKey,
    sendLongSpec: async (sourceId, spec) => { f.sent.push({ sourceId, spec }); } });
  const dispatcher = new NotificationDispatcher({ notices } as ConstructorParameters<typeof NotificationDispatcher>[0]);
  const queue = new KeyedQueue();
  let notify!: (event: AppServerNotification) => void;
  const listener = new NotificationListener({
    codexClient: { onNotification: (callback: typeof notify) => { notify = callback; return () => {}; },
      onApprovalRequest: () => () => {}, onUserInputRequest: () => () => {} },
    earlyApprovals: new Map(), subagents, subagentDelivery: { reset: () => {} }, notificationQueue: queue,
    notificationDispatcher: dispatcher, handleAppServerNotification: event => dispatcher.handle(event)
  } as ConstructorParameters<typeof NotificationListener>[0]);
  listener.attach(); t.after(() => listener.detach());
  notify({ method: "guardianWarning", params: { threadId: "child", message: "Child review unavailable" } });
  notify({ method: "mcpServer/startupStatus/updated", params: { ...failure, threadId: "child" } });
  await queue.run("child", async () => {});
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent.every(s => s.spec.session!.id === parent.id), true);
  assert.equal(f.tracker.forThread("child").get("tools")!.status, "failed");
  assert.equal(f.tracker.forThread("a").size, 0);
});
