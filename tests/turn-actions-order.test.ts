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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t: test.TestContext, summaryOnly = false) {
  const store = new BridgeStore(":memory:");
  let notify!: (event: { method: string; params: unknown }) => void;
  let approval!: (request: unknown) => void;
  const bridge = new BridgeService(testConfig(":memory:"), store, {
    onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
    onApprovalRequest: (listener: typeof approval) => { approval = listener; return () => {}; },
    onUserInputRequest: () => () => {}, listQueuedSubmissions: async () => []
  } as never);
  const internal = bridge as unknown as {
    attachCodexListeners(): void;
    detachCodexListeners(): void;
    handleAppServerNotification(n: { method: string; params: unknown }): Promise<void>;
    notificationQueue: { drain(): Promise<void>; run<T>(key: string, operation: () => Promise<T>): Promise<T> };
    bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string>; assistantOutputByThread: Map<string, boolean> };
    notificationSessionIdByThread: Map<string, string>;
    goShortcutService: GoShortcutService;
    versionUpdateNotifier: { deliverBeforeActions(): Promise<boolean> };
    progressService: { retryPendingFinalDeliveries(): Promise<void> };
  };
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work" });
  await store.setActiveSession("chat", session.id); store.claimSession(session.id, "chat");
  internal.notificationSessionIdByThread.set("thread", session.id);
  const order: string[] = [];
  let onSend: (kind: string) => Promise<void> = async () => {};
  let onEdit = async (): Promise<void> => {};
  let id = 0;
  bridge.registerMessageTransport({ name: "test", canHandle: () => true,
    ...(summaryOnly ? { refreshPolicy: { typingEnabled: false, progressMode: "summary" as const, workingIntervalMs: 20_000 } } : {}),
    sendMessageSpec: async (_source, spec) => {
      if (spec.kind === "actions") {
        assert.equal(store.getActiveTurnRoute("thread"), null);
        assert.equal(store.getSessionLease(session.id)?.ownerTurnId, null);
      }
      await onSend(spec.title.split(" · ")[0]!);
      order.push(spec.kind === "actions" ? "actions" : spec.title.split(" · ")[0]!);
      return { message_id: String(++id) };
    },
    editMessageSpec: async (_source, _id, spec) => {
      if (["progress", "failed"].includes(spec.kind)) { order.push("summary edit"); await onEdit(); }
      return true;
    },
    sendMessage: async () => assert.fail("structured"), editMessageText: async () => assert.fail("structured"),
    clearMessageActions: async () => true, deleteMessage: async () => true, sendTyping: async () => {}
  });
  const send = (method: string, params: unknown) => internal.handleAppServerNotification({ method, params });
  await send("turn/started", { threadId: "thread", turn: { id: "old", status: "inProgress" } });
  store.setSessionOwnerTurn(session.id, "chat", "old");
  internal.attachCodexListeners();
  const holds: ReturnType<typeof gate>[] = [];
  const hold = () => { const entry = gate(); holds.push(entry); return entry; };
  t.after(async () => {
    holds.forEach(entry => entry.release());
    internal.detachCodexListeners(); await internal.notificationQueue.drain(); await bridge.shutdown(); store.close();
  });
  const complete = () => {
    internal.bridgeRuntimeState.assistantOutputByThread.set("thread", true);
    notify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "old", status: "completed" } } });
  };
  return { store, session, internal, order, hold, send, complete, notify, approval,
    setSend: (handler: typeof onSend) => { onSend = handler; },
    setEdit: (handler: typeof onEdit) => { onEdit = handler; } };
}

for (const kind of ["Run", "Called", "Edited", "Hook"]) {
  test(`${kind} first summary precedes Actions at turn completion`, { timeout: 2000 }, async t => {
    const f = await fixture(t, true), entered = gate(), blocked = f.hold();
    const item = kind === "Run" ? { id: "item", type: "commandExecution", command: "echo test", status: "completed", exitCode: 0 }
      : kind === "Called" ? { id: "item", type: "mcpToolCall", server: "demo", tool: "read", status: "completed" }
      : { id: "item", type: "fileChange", status: "completed", changes: [{ path: "/work/file", kind: { type: "update" }, diff: "+test" }] };
    if (kind === "Hook") await f.send("hook/completed", { threadId: "thread", turnId: "old",
      run: { id: "hook", eventName: "Stop", status: "completed", entries: [] } });
    else await f.send("item/completed", { threadId: "thread", turnId: "old", item });
    f.setSend(async title => { if (title === kind) { entered.release(); await blocked.promise; } });
    f.complete();
    await entered.promise;
    assert.equal(f.order.includes("actions"), false);
    blocked.release(); await f.internal.notificationQueue.drain(); await f.internal.goShortcutService.drain();
    assert.ok(f.order.indexOf(kind) < f.order.indexOf("actions"));
  });
}

test("Actions precede a slow existing-card summary edit without blocking notification handling", { timeout: 2000 }, async t => {
  const f = await fixture(t), editing = gate(), blocked = f.hold();
  await f.send("item/started", { threadId: "thread", turnId: "old", item: {
    id: "tool", type: "mcpToolCall", server: "demo", tool: "lookup", status: "inProgress" } });
  f.setEdit(async () => { editing.release(); await blocked.promise; });
  f.complete(); await f.internal.notificationQueue.drain(); await f.internal.goShortcutService.drain();
  await editing.promise;
  assert.ok(f.order.indexOf("actions") < f.order.indexOf("summary edit"));
  blocked.release();
});

test("a next-turn receipt cancels old Actions while a preceding reminder is blocked", { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = gate(), blocked = f.hold();
  f.internal.versionUpdateNotifier.deliverBeforeActions = async () => { entered.release(); await blocked.promise; return false; };
  f.complete(); await entered.promise;
  f.notify({ method: "turn/started", params: { threadId: "thread", turn: { id: "new", status: "inProgress" } } });
  await f.internal.notificationQueue.drain();
  assert.equal(f.internal.bridgeRuntimeState.inFlightTurnIdByThread.get("thread"), "new",
    "new-turn handling must not wait for the reminder network operation");
  blocked.release(); await f.internal.goShortcutService.drain();
  assert.equal(f.order.includes("actions"), false);
});

test("a new turn received during the first summary invalidates Actions that have not been scheduled yet", { timeout: 2000 }, async t => {
  const f = await fixture(t, true), entered = gate(), blocked = f.hold();
  await f.send("hook/completed", { threadId: "thread", turnId: "old", run: { id: "hook", eventName: "Stop", status: "completed" } });
  f.setSend(async title => { if (title === "Hook") { entered.release(); await blocked.promise; } });
  f.complete(); await entered.promise;
  f.notify({ method: "turn/started", params: { threadId: "thread", turn: { id: "new", status: "inProgress" } } });
  blocked.release(); await f.internal.notificationQueue.drain(); await f.internal.goShortcutService.drain();
  assert.equal(f.order.includes("actions"), false);
  assert.ok(f.order.includes("Hook"));
});

test("approval receipt cancels Actions before the approval can leave a blocked notification queue", { timeout: 2000 }, async t => {
  const f = await fixture(t), entered = gate(), blocked = f.hold();
  f.internal.versionUpdateNotifier.deliverBeforeActions = async () => { entered.release(); await blocked.promise; return false; };
  f.complete(); await entered.promise;
  const queueGate = f.hold();
  const queued = f.internal.notificationQueue.run("thread", () => queueGate.promise);
  f.approval({ threadId: "thread", turnId: "old", requestId: "request", method: "item/commandExecution/requestApproval",
    title: "Approve", summary: "Review", requestedFields: [], requiresUserInput: true });
  blocked.release(); await f.internal.goShortcutService.drain();
  assert.equal(f.order.includes("actions"), false);
  queueGate.release(); await queued; await f.internal.notificationQueue.drain();
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
    scheduleGoShortcut: () => { running.set("thread", "new"); throw new Error("failed Actions"); },
    cancelGoShortcut: () => {}, rememberRateLimitSession: () => {}, promoteSessionHandoff: async () => {}
  });
  await assert.rejects(turns.handleStatusUpdate({ threadId: "thread", kind: "clear", label: null, detail: null, detailMode: null }), /failed Actions/);
  assert.deepEqual(closed, ["old"]); assert.equal(running.get("thread"), "new");
});

test("cancelling scheduled Actions releases waiting lifecycle cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const service = new GoShortcutService({ store: {} as never,
    messageOperations: { sendMessageSpec: async () => assert.fail("cancelled") },
    lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/work" });
  const session = { id: "session", codexThreadId: "thread", telegramChatId: "chat" } as Parameters<GoShortcutService["schedule"]>[0];
  const cancelled = service.schedule(session); service.cancel("thread"); await cancelled;
  const shutdown = service.schedule(session); service.cancelAll(); await shutdown;
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
