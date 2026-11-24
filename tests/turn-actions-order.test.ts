import assert from "node:assert/strict";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { NotificationTurnService } from "../src/bridge/notifications/turns.js";
import { GoShortcutService } from "../src/bridge/interactions/go-shortcut.js";
import { PhaseDeliveryAdapter } from "../src/bridge/progress/delivery.js";
import { BridgeStore } from "../src/store/index.js";
import { testConfig } from "./bridge-test-config.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });

test("Actions are delivered after terminal bookkeeping and before a slow progress summary", { timeout: 2000 }, async t => {
  const store = new BridgeStore(":memory:");
  const bridge = new BridgeService(testConfig(":memory:"), store, { listQueuedSubmissions: async () => [] } as never);
  t.after(async () => { await bridge.shutdown(); store.close(); });
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work" });
  await store.setActiveSession("chat", session.id); store.claimSession(session.id, "chat");
  const internal = bridge as unknown as {
    handleAppServerNotification(n: { method: string; params: unknown }): Promise<void>;
    bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> };
    progressService: { retryPendingFinalDeliveries(): Promise<void> };
  };
  let id = 0, progressId = "";
  const order: string[] = [];
  let summaryStarted!: () => void, release!: () => void;
  const summary = new Promise<void>(resolve => { summaryStarted = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  bridge.registerMessageTransport({ name: "test", canHandle: () => true,
    sendMessageSpec: async (_source, spec) => {
      if (spec.kind === "actions") {
        assert.equal(store.getActiveTurnRoute("thread"), null);
        assert.equal(store.getSessionLease(session.id)?.ownerTurnId, null);
        assert.equal(internal.bridgeRuntimeState.inFlightTurnIdByThread.has("thread"), false);
        order.push("actions");
      }
      return { message_id: String(++id) };
    },
    editMessageSpec: async (_source, messageId) => {
      if (messageId === progressId) { order.push("summary"); summaryStarted(); await blocked; }
      return true;
    },
    sendMessage: async () => assert.fail("structured"), editMessageText: async () => assert.fail("structured"),
    clearMessageActions: async () => true, deleteMessage: async () => true, sendTyping: async () => {}
  });
  const send = (method: string, params: unknown) => internal.handleAppServerNotification({ method, params });
  await send("turn/started", { threadId: "thread", turn: { id: "turn", status: "inProgress" } });
  store.setSessionOwnerTurn(session.id, "chat", "turn");
  await send("item/started", { threadId: "thread", turnId: "turn", item: {
    id: "tool", type: "mcpToolCall", server: "demo", tool: "lookup", status: "inProgress" } });
  const phase = store.getActiveProgressPhaseMessage("thread", "turn")!; progressId = phase.platformMessageId;
  // Mark output without another chronological message closing the phase first.
  const state = (bridge as unknown as { bridgeRuntimeState: { assistantOutputByThread: Map<string, boolean> } }).bridgeRuntimeState;
  state.assistantOutputByThread.set("thread", true);
  const terminal = send("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  try {
    await summary;
    assert.deepEqual(order, ["actions", "summary"]);
  } finally { release(); await terminal; }
  await internal.progressService.retryPendingFinalDeliveries();
  assert.equal(store.getProgressPhaseMessage(phase.id)?.deliveryState, "synced");
});

test("Actions failure cannot prevent summary cleanup, and cleanup keeps the captured turn", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work" });
  const owner = store.claimSession(session.id, "chat");
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "thread", turnId: "old", sourceId: "chat", bindingId: owner.binding.id });
  const closed: string[] = [];
  const running = new Map([["thread", "old"]]);
  const turns = new NotificationTurnService({ store, inFlightTurnIdByThread: running,
    assistantOutputByThread: new Map([["thread", true]]), errorSeenByThread: new Map(), lastAssistantTelegramByThread: new Map(),
    queuedSubmissionService: { reconcileStartedSubmission: async () => {} }, resolveNotificationSession: async () => session,
    applyStatusUpdate: async () => {}, handleRecoveryTaskComplete: async () => false,
    clearProgressMessageForThread: async (_thread, options) => { closed.push(options!.turnId!); },
    scheduleGoShortcut: async () => { running.set("thread", "new"); throw new Error("failed Actions"); },
    cancelGoShortcut: () => {}, rememberRateLimitSession: () => {}, promoteSessionHandoff: async () => {}
  });
  await assert.rejects(turns.handleStatusUpdate({ threadId: "thread", kind: "clear", label: null, detail: null, detailMode: null }), /failed Actions/);
  assert.deepEqual(closed, ["old"]); assert.equal(running.get("thread"), "new");
});

test("cancelling scheduled Actions releases waiting lifecycle cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = new Map();
  const service = new GoShortcutService({ store: {} as never,
    messageOperations: { sendMessageSpec: async () => assert.fail("cancelled") }, pendingByThread: pending,
    lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/work" });
  const session = { id: "session", codexThreadId: "thread", telegramChatId: "chat" } as Parameters<GoShortcutService["schedule"]>[0];
  const cancelled = service.schedule(session); service.cancel("thread"); await cancelled;
  const shutdown = service.schedule(session); service.cancelAll(); await shutdown;
  assert.equal(pending.size, 0);
});

test("an unchanged Telegram edit is synced without a warning; genuine errors still warn", async t => {
  const warnings: unknown[] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => { warnings.push(args); });
  let error: unknown = { error_code: 400, description: "Bad Request: message is not modified" };
  const delivery = new PhaseDeliveryAdapter({ sendTemporaryMessageSpec: async () => null,
    editMessageSpec: async () => { throw error; } });
  const spec = { kind: "system", title: "System", body: [], actions: [] } as const;
  assert.equal(await delivery.editResult("chat", "1", { ...spec, body: [], actions: [] }), "synced");
  assert.deepEqual(warnings, []);
  error = new Error("unknown delivery outcome");
  assert.equal(await delivery.editResult("chat", "1", { ...spec, body: [], actions: [] }), "retryable");
  assert.equal(warnings.length, 1);
});
