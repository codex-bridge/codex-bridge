import assert from "node:assert/strict";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import type {
  AppServerNotification,
  AppServerApprovalRequest,
  AppServerThreadStatus
} from "../src/codex/client.js";
import { ThreadRuntimeState } from "../src/codex/thread-runtime-state.js";
import { BridgeStore } from "../src/store/index.js";
import { SubagentDeliveryService } from "../src/bridge/notifications/subagent-delivery.js";
import { SubagentTracker, type SubagentDelivery } from "../src/bridge/notifications/subagent-tracker.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { testConfig } from "./bridge-test-config.js";

test("turn requests use one strict Codex config snapshot without Bridge fallbacks", async () => {
  const calls: Record<string, unknown>[] = [];
  let configError: Error | null = null;
  let configReads = 0;
  const runtimeState = new ThreadRuntimeState();
  const observed: AppServerThreadStatus = {
    threadId: "t",
    cwd: "/p",
    threadName: null,
    model: "m",
    modelProvider: null,
    serviceTier: "previous",
    serviceTierKnown: true,
    approvalPolicy: null,
    sandboxMode: null,
    reasoningEffort: null,
    activity: "idle",
    activityType: null,
    contextLeftPercent: null,
    contextUsedTokens: null,
    contextMaxTokens: null
  };
  runtimeState.rememberSettings("t", observed);
  const snapshot: CodexConfigSnapshot = {
    cwd: "/p",
    model: "config-model",
    modelProvider: "codex-lb",
    reasoningEffort: "high",
    reasoningSummary: "concise",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/p"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    serviceTier: "priority-custom",
    personality: "pragmatic",
    origins: {},
    layerVersions: ["v1"]
  };
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    config: testConfig(":memory:"), threadRuntimeState: runtimeState,
    authReconnect: { handleTurnCompleted: () => {} },
    connect: async () => {}, resumeThread: async () => {},
    readCodexConfigSnapshot: async (cwd: string) => {
      configReads += 1;
      assert.equal(cwd, "/p");
      if (configError) throw configError;
      return snapshot;
    },
    request: async (_method: string, params: Record<string, unknown>) => {
      calls.push(JSON.parse(JSON.stringify(params)));
      return { turn: { id: "turn" } };
    }
  });
  await client.sendTurn("t", "hello", "/p");
  assert.equal(configReads, 1);
  assert.deepEqual(calls[0], {
    threadId: "t",
    input: [{ type: "text", text: "hello" }],
    cwd: "/p",
    model: "config-model",
    effort: "high",
    summary: "concise",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/p"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    },
    serviceTier: "priority-custom",
    personality: "pragmatic"
  });
  assert.equal(runtimeState.getObservedSettings("t")!.serviceTierKnown, false);

  configError = new Error("snapshot failed");
  await assert.rejects(client.sendTurn("t", "again", "/p"), /snapshot failed/);
  assert.equal(configReads, 2);
  assert.equal(calls.length, 1);
});

test("early child approval is delivered only to the originating parent chat", async () => {
  const store = new BridgeStore(":memory:");
  let notify!: (event: AppServerNotification) => void;
  const answers: string[] = [];
  const client = {
    onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
    onApprovalRequest: () => () => {},
    resolveApproval: async (id: string) => { answers.push(id); }
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(":memory:"), store, client);
  const sent: string[] = [];
  service.registerMessageTransport({ name: "test", canHandle: () => true,
    sendMessage: async (chatId) => { sent.push(chatId); return { message_id: String(sent.length) }; },
    editMessageText: async () => true, deleteMessage: async () => true,
    clearMessageActions: async () => true, sendTyping: async () => {}
  });
  const internal = service as unknown as {
    notificationSessionIdByThread: Map<string, string>;
    attachCodexListeners(): void; detachCodexListeners(): void;
    handleAppServerNotification(event: unknown): Promise<void>;
    notificationApprovalService: {
      handleApprovalRequest(request: AppServerApprovalRequest): Promise<void>;
    };
  };
  internal.handleAppServerNotification = async () => {};
  try {
    const origin = await store.upsertDiscoveredSession({ telegramChatId: "chat-origin", codexThreadId: "parent",
      pathKey: "/project", currentCwd: "/project" });
    const other = await store.upsertDiscoveredSession({ telegramChatId: "chat-other", codexThreadId: "parent-other",
      pathKey: "/project", currentCwd: "/project" });
    await store.setActiveSession("chat-origin", origin.id);
    await store.setActiveSession("chat-other", other.id);
    internal.notificationSessionIdByThread.set("parent", origin.id);
    internal.attachCodexListeners();
    notify({ method: "turn/started", params: { threadId: "parent", turn: { id: "p1" } } });
    const original = internal.notificationApprovalService.handleApprovalRequest.bind(internal.notificationApprovalService);
    const tasks: Promise<void>[] = [];
    internal.notificationApprovalService.handleApprovalRequest = (request) => { const task = original(request); tasks.push(task); return task; };
    await internal.notificationApprovalService.handleApprovalRequest({ requestId: "opaque-child", threadId: "child", turnId: "c1", itemId: "tool",
      method: "item/commandExecution/requestApproval", title: "Run pwd", summary: "pwd",
      requiresUserInput: false, requestedFields: [], elicitationMode: null });
    assert.equal((await store.listPendingDecisions(origin.id)).length, 0);
    internal.notificationSessionIdByThread.set("parent", other.id);
    notify({ method: "item/completed", params: { threadId: "parent", turnId: "p1",
      item: { id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/check" } } });
    await Promise.all(tasks);
    const decisions = await store.listPendingDecisions(origin.id);
    assert.equal(decisions.length, 1);
    assert.match(decisions[0]!.title, /check/);
    assert.equal((await store.listPendingDecisions(other.id)).length, 0);
    assert.ok(sent.length > 0 && sent.every((chatId) => chatId === "chat-origin"));
    assert.equal((await service.handleDecision(decisions[0]!.id, "decline")).ok, true);
    assert.deepEqual(answers, ["opaque-child"]);
  } finally { internal.detachCodexListeners(); store.close(); }
});

test("subagent queue collapses raw child events into one parent summary update", async () => {
  const store = new BridgeStore(":memory:");
  const notificationQueue = new KeyedQueue();
  const service = new SubagentDeliveryService({
    store,
    subagents: new SubagentTracker(),
    notificationQueue,
    getSessionDirectory: (session) => session.currentCwd ?? session.pathKey,
    sendSpecAndGetLastMessage: async () => null,
    editMessageSpec: async () => true
  });
  const internal = service as unknown as {
    queueSubagentDelivery(delivery: SubagentDelivery): Promise<void>;
    sendSubagentDelivery(delivery: SubagentDelivery): Promise<void>;
  };
  const received: string[] = [];
  internal.sendSubagentDelivery = async (delivery) => {
    received.push((delivery.event.params as { item: { id: string } }).item.id);
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = notificationQueue.run("parent", () => gate);
  const make = (id: string, type = "mcp"): SubagentDelivery => ({
    route: { sessionId: "session", parentThreadId: "parent", parentTurnId: "p1",
      childThreadId: "child", turnId: "c1", name: "check", status: "running" },
    event: { method: "item/completed", params: { threadId: "child", turnId: "c1",
      item: { id, type, toolName: "mcp__test__read", text: "result", output: "ok" } } }
  });
  try {
    const promises = new Set<Promise<void>>();
    for (let i = 0; i < 500; i++) promises.add(internal.queueSubagentDelivery(make(`progress-${i}`)));
    assert.equal(promises.size, 1);
    promises.add(internal.queueSubagentDelivery(make("result", "agentMessage")));
    promises.add(internal.queueSubagentDelivery(make("after-result")));
    release();
    await blocker;
    await Promise.all(promises);
    assert.deepEqual(received, ["after-result"]);
  } finally { release(); store.close(); }
});

test("subagent delivery stays in its recorded chat and retains only a summary", async () => {
  const store = new BridgeStore(":memory:");
  const service = new BridgeService(testConfig(":memory:"), store, {} as CodexAppServerClient);
  const sent: { chatId: string; text: string }[] = [];
  service.registerMessageTransport({
    name: "test", canHandle: () => true,
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: String(sent.length) }; },
    editMessageText: async () => true, deleteMessage: async () => true,
    clearMessageActions: async () => true, sendTyping: async () => {}
  });
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "chat-origin",
      codexThreadId: "parent", pathKey: "/workspace/project", currentCwd: "/workspace/project",
      displayName: "parent", latestActivityAt: Date.now() });
    await store.upsertDiscoveredSession({ telegramChatId: "chat-other", codexThreadId: "parent",
      pathKey: "/workspace/project", currentCwd: "/workspace/project", displayName: "other", latestActivityAt: Date.now() });
    const delivery: SubagentDelivery = { route: { sessionId: session.id, parentThreadId: "parent",
      parentTurnId: "p1", childThreadId: "child-123456", turnId: "c1", name: "check", status: "completed" },
      event: { method: "item/completed", params: { threadId: "child-123456", turnId: "c1",
        item: { id: "answer", type: "agentMessage", text: "CHILD_RESULT" } } },
      summary: "Observed subagent turns: 1 completed." };
    await (service as unknown as {
      subagentDelivery: { sendSubagentDelivery(value: SubagentDelivery): Promise<void> };
    }).subagentDelivery.sendSubagentDelivery(delivery);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((message) => message.chatId === "chat-origin"));
    assert.match(sent.map((message) => message.text).join("\n"), /Observed subagent turns: 1 completed\./);
    assert.doesNotMatch(sent.map((message) => message.text).join("\n"), /CHILD_RESULT/);
    assert.equal((await store.listKnownSessions("chat-origin")).length, 1);
  } finally { store.close(); }
});

test("parent terminal freezes the queued subagent summary after it is created", async () => {
  const store = new BridgeStore(":memory:");
  const sends: string[] = [];
  const edits: Array<{ text: string; title: string }> = [];
  const service = new SubagentDeliveryService({
    store,
    subagents: new SubagentTracker(),
    notificationQueue: new KeyedQueue(),
    getSessionDirectory: (session) => session.currentCwd ?? session.pathKey,
    sendSpecAndGetLastMessage: async (_chatId, messageSpec) => {
      sends.push(messageSpec.title);
      return { messageId: "summary-1", text: "sent" };
    },
    editMessageSpec: async (_chatId, _messageId, messageSpec) => {
      edits.push({ title: messageSpec.title, text: messageSpec.body.map((part) => part.text).join("\n") });
      return true;
    }
  });
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "parent", pathKey: "/workspace/project", currentCwd: "/workspace/project"
    });
    const delivery: SubagentDelivery = {
      route: {
        sessionId: session.id, parentThreadId: "parent", parentTurnId: "p1",
        childThreadId: "child", turnId: "c1", name: "check", status: "completed"
      },
      event: { method: "turn/completed", params: { threadId: "child", turn: { id: "c1", status: "completed" } } },
      summary: "Observed subagent turns: 1 completed."
    };

    await Promise.all([
      service.queueSubagentDelivery(delivery),
      service.finalizeParentTurn({
        sessionId: session.id,
        parentThreadId: "parent",
        parentTurnId: "p1",
        terminal: "completed"
      })
    ]);

    assert.deepEqual(sends, ["Subagents · /workspace/project"]);
    assert.deepEqual(edits, [{
      title: "Subagents Completed · /workspace/project",
      text: "Observed subagent turns: pending.\nParent turn: completed."
    }]);
  } finally { store.close(); }
});

test("child completion cannot claim a pending global version notification", async () => {
  const store = new BridgeStore(":memory:");
  let notify!: (event: AppServerNotification) => void;
  const client = {
    onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
    onApprovalRequest: () => () => {}
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(":memory:"), store, client);
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async () => ({ message_id: "1" }),
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });
  const deliveries: Array<string | null> = [];
  const internal = service as unknown as {
    notificationSessionIdByThread: Map<string, string>;
    notificationQueue: KeyedQueue;
    versionUpdateNotifier: {
      deliverAfterRootTurn(session: { id: string } | null): Promise<boolean>;
    };
    attachCodexListeners(): void;
    detachCodexListeners(): void;
  };
  internal.versionUpdateNotifier.deliverAfterRootTurn = async (resolvedSession) => {
    deliveries.push(resolvedSession?.id ?? null);
    return true;
  };

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "parent",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    internal.notificationSessionIdByThread.set("parent", session.id);
    internal.attachCodexListeners();

    notify({ method: "turn/started", params: { threadId: "parent", turn: { id: "p1" } } });
    await internal.notificationQueue.run("parent", async () => undefined);
    notify({ method: "item/completed", params: {
      threadId: "parent",
      turnId: "p1",
      item: {
        id: "spawn",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/check"
      }
    } });
    notify({ method: "turn/completed", params: {
      threadId: "child",
      turn: { id: "c1", status: "completed" }
    } });
    await internal.notificationQueue.run("parent", async () => undefined);
    assert.deepEqual(deliveries, []);

    notify({ method: "turn/started", params: {
      threadId: "parent",
      turn: { id: "p2" }
    } });
    await internal.notificationQueue.run("parent", async () => undefined);
    notify({ method: "turn/completed", params: {
      threadId: "parent",
      turn: { id: "p1", status: "failed" }
    } });
    await internal.notificationQueue.run("parent", async () => undefined);
    assert.deepEqual(deliveries, []);

    notify({ method: "turn/completed", params: {
      threadId: "parent",
      turn: { id: "p2", status: "cancelled" }
    } });
    await internal.notificationQueue.run("parent", async () => undefined);
    assert.deepEqual(deliveries, [session.id]);
  } finally {
    internal.detachCodexListeners();
    store.close();
  }
});
