import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { extractWarningEvent, extractMcpStartupStatusEvent } from "../src/codex/notification-events.js";
import { McpStartupTracker } from "../src/bridge/status/mcp-startup.js";
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

async function fixture(t: TestContext) {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  for (const thread of ["a", "b"]) {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: thread, pathKey: `/work/${thread}` });
    store.claimSession(session.id, "web:local");
  }
  const sent: Array<{ sourceId: string; spec: MessageSpec }> = [], global: MessageSpec[] = [];
  const tracker = new McpStartupTracker();
  const service = new NotificationNoticeService({ store, mcpStartup: tracker,
    resolveNotificationSession: id => store.getSessionByThreadId(id), getSessionDirectory: s => s.pathKey,
    sendLongSpec: async (sourceId, spec) => { sent.push({ sourceId, spec }); }, sendGlobalNotice: async spec => { global.push(spec); } });
  return { store, sent, global, tracker, service };
}

test("global notices stay at service scope; repeated warnings and ongoing MCP failure do not duplicate", async t => {
  const f = await fixture(t);
  const event = extractWarningEvent({ method: "deprecationNotice", params: { summary: "Deprecated feature", details: "Use the new setting" } })!;
  await f.service.handleWarning(event); await f.service.handleWarning(event);
  assert.equal(f.global.length, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.service.snapshot()[0]!.session, undefined);
  assert.equal(f.service.snapshot()[0]!.title, "Deprecation notice");
  const copy = f.service.snapshot(); copy[0]!.body = [];
  assert.equal(f.service.snapshot()[0]!.body.length, 2);
  await f.service.handleMcpStartup(failure); await f.service.handleMcpStartup(failure);
  assert.equal(f.global.length, 2); assert.equal(f.service.snapshot().length, 2);
  await f.service.handleMcpStartup({ ...failure, error: "Latest connection detail" });
  assert.equal(f.global.length, 2);
  assert.match(JSON.stringify(f.service.snapshot()), /Latest connection detail/);
  await f.service.handleMcpStartup(ready);
  assert.equal(f.service.snapshot().length, 1); assert.equal(f.global.at(-1)!.title, "MCP recovered");
  await f.service.handleMcpStartup(failure);
  assert.equal(f.global.length, 4); assert.equal(f.service.snapshot().length, 2);
  f.service.clear(); assert.deepEqual(f.service.snapshot(), []);
});

test("scoped warnings and MCP failures follow their owned session and never fall back to global", async t => {
  const f = await fixture(t);
  const warning = { kind: "guardianWarning" as const, threadId: "a", message: "Review could not run", details: null, path: null };
  await f.service.handleWarning(warning);
  await f.service.handleWarning({ ...warning, threadId: "b" });
  await f.service.handleWarning({ ...warning, threadId: "unmapped" });
  await f.service.handleMcpStartup({ ...failure, threadId: "a" });
  assert.deepEqual(f.sent.map(s => s.spec.session!.directory), ["/work/a", "/work/b", "/work/a"]);
  assert.equal(f.global.length, 0); assert.deepEqual(f.service.snapshot(), []);
  const session = (await f.store.getSessionByThreadId("a"))!;
  f.store.markSessionExternalUnknown(session.id);
  await f.service.handleWarning({ ...warning, message: "After ownership loss" });
  assert.equal(f.sent.length, 3);
  const chat = await f.store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "chat", pathKey: "/work/chat" });
  f.store.claimSession(chat.id, "123");
  await f.store.setActiveSession("123", chat.id);
  f.store.markSessionExternalUnknown(chat.id);
  await f.service.handleWarning({ ...warning, threadId: "chat", message: "Selected but no longer owned" });
  assert.equal(f.sent.length, 3, "chat selection alone does not authorize notice delivery");
  const spec = f.sent[2]!.spec;
  for (const rendering of [renderSlackMessageSpec("slack:T:C:1", spec, null), renderTelegramMessageSpec(spec)]) {
    assert.match(JSON.stringify(rendering), /reauthenticationRequired/);
    assert.match(JSON.stringify(rendering), /Could not connect/);
    assert.equal(JSON.stringify(rendering).includes("Step failed"), false);
  }
});

test("warning write errors are not automatically retried or converted to successful delivery", async t => {
  const f = await fixture(t); let writes = 0;
  const service = new NotificationNoticeService({ store: f.store, mcpStartup: f.tracker,
    resolveNotificationSession: id => f.store.getSessionByThreadId(id), getSessionDirectory: s => s.pathKey,
    sendLongSpec: async () => {}, sendGlobalNotice: async () => { writes++; throw new Error("write outcome unknown"); } });
  const event = extractWarningEvent({ method: "warning", params: { threadId: null, message: "Public warning" } })!;
  await assert.rejects(service.handleWarning(event), /unknown/);
  await service.handleWarning(event);
  assert.equal(writes, 1); assert.equal(service.snapshot().length, 1);
});

test("notification dispatcher reaches notice handling without changing the task lifecycle", async t => {
  const f = await fixture(t);
  const dispatcher = new NotificationDispatcher({ notices: f.service } as ConstructorParameters<typeof NotificationDispatcher>[0]);
  await dispatcher.handle({ method: "warning", params: { threadId: null, message: "Low-level warning" } });
  await dispatcher.handle({ method: "mcpServer/startupStatus/updated", params: failure });
  assert.equal(f.global.length, 2);
  assert.equal(dispatcher.getQueueKey({ method: "guardianWarning", params: { threadId: "a", message: "Review issue" } }), "a");
});

test("status rendering uses structured auth reason and does not classify notStarted as ready", () => {
  assert.equal(formatMcpStartupStatusCache(null, new Map([["tools", { status: "notStarted", error: null }]])), "0/1 ready, 1 unknown");
  assert.equal(formatMcpStartupFailureDetails(new Map([["tools", failure]])), "tools: Could not connect (reauthenticationRequired) Run: codex mcp login tools");
});

test("live global warnings reach each authorized chat root once and appear in Web service state", { timeout: 5000 }, async t => {
  const store = new BridgeStore(":memory:");
  await store.ensureSeedChats(["slack:T:C:1", "slack:T:C:2", "slack:T:X:1", "123", "999", "web:local"]);
  let notify!: (event: AppServerNotification) => void;
  const service = new BridgeService({ ...testConfig(":memory:"), codexAppServerCommand: process.execPath,
    slackEnabled: true, slackAllowedChannelIds: new Set(["C"]), telegramAllowedChatIds: new Set(["123"]) }, store, {
    connect: async () => {}, onNotification: listener => { notify = listener; return () => {}; },
    onApprovalRequest: () => () => {}, onUserInputRequest: () => () => {}
  } as CodexAppServerClient);
  t.after(async () => { await service.shutdown(); store.close(); });
  const sent: Array<{ sourceId: string; spec: MessageSpec }> = [];
  let finished!: () => void;
  const delivered = new Promise<void>(resolve => { finished = resolve; });
  service.registerMessageTransport({ name: "isolated-notices", canHandle: () => true, wholeMessageSpecs: true,
    sendMessageSpec: async (sourceId, spec) => { sent.push({ sourceId, spec }); if (sent.length === 2) finished(); return { message_id: String(sent.length) }; },
    sendMessage: async () => null, editMessageText: async () => true, clearMessageActions: async () => true,
    deleteMessage: async () => true, sendTyping: async () => {} });
  await service.bootstrap();
  notify({ method: "configWarning", params: { summary: "Public configuration warning", details: "Check the option" } });
  await delivered;
  assert.deepEqual(sent.map(s => s.sourceId).sort(), ["123", "slack:T:C"]);
  assert.equal(sent.every(s => s.spec.session === undefined), true);
  const api = service.createWebApi();
  assert.equal(api.readServiceNotices()[0]!.title, "Configuration warning");
});

test("direct-child notices reach their parent session instead of being swallowed by the subagent tracker", async t => {
  const f = await fixture(t);
  const parent = (await f.store.getSessionByThreadId("a"))!;
  const subagents = new SubagentTracker();
  subagents.observe({ method: "turn/started", params: { threadId: "a", turn: { id: "p1" } } }, parent.id);
  subagents.observe({ method: "item/completed", params: { threadId: "a", turnId: "p1",
    item: { id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/check" } } });
  const notices = new NotificationNoticeService({ store: f.store, mcpStartup: f.tracker,
    resolveNotificationSession: async id => subagents.route(id) ? parent : null, getSessionDirectory: s => s.pathKey,
    sendLongSpec: async (sourceId, spec) => { f.sent.push({ sourceId, spec }); }, sendGlobalNotice: async () => assert.fail("not global") });
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
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent.every(s => s.spec.session!.id === parent.id), true);
  assert.equal(f.tracker.forThread("child").get("tools")!.status, "failed");
  assert.equal(f.tracker.forThread("a").size, 0);
});
