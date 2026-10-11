import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerClient } from "../src/codex/client.js";
import { MessageDeliveryService } from "../src/bridge/messages/sender.js";
import { HistoryDeliveryService } from "../src/bridge/messages/history-delivery.js";
import { QueuedSubmissionService } from "../src/bridge/input/queued-submission.js";
import type { BridgeMessageTransport } from "../src/bridge/transport.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { BridgeStore } from "../src/store/index.js";

test("message delivery owns transport replacement and title envelopes", async () => {
  const sender = new MessageDeliveryService({
    maxLength: 4_000,
    queue: new KeyedQueue(),
    getEnvelopeTitle: async () => "Codex · .../projects/codex-bridge"
  });
  const first = {
    name: "test",
    canHandle: (chatId) => chatId === "chat",
    sendMessage: async () => null,
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  } satisfies BridgeMessageTransport;
  const replacement = { ...first, sendMessage: async () => ({ message_id: "replacement" }) };

  sender.registerTransport(first);
  sender.registerTransport(replacement);

  assert.equal(sender.requireTransport("chat"), replacement);
  assert.equal(
    await sender.envelopeText("chat", "content"),
    "Codex · .../projects/codex-bridge\ncontent"
  );
  assert.equal(await sender.envelopeText("chat", "**Help**\ncontent"), "**Help**\ncontent");
  assert.equal(await sender.envelopeText("chat", "**Important**\ncontent"),
    "Codex · .../projects/codex-bridge\n**Important**\ncontent");
  assert.equal(await sender.envelopeText("chat", "**Run · .../projects/codex-bridge**\n1 succeeded, 0 failed"),
    "**Run · .../projects/codex-bridge**\n1 succeeded, 0 failed");
  assert.throws(() => sender.requireTransport(""), /No message transport/);
});

test("Slack history delivery uses the faster bounded launch policy", async () => {
  const calls: Array<{ launchIntervalMs?: number; maxInFlight?: number }> = [];
  const history = new HistoryDeliveryService({
    sender: {
      sendConcurrentTextBatch: async (_chatId, _messages, options) => { calls.push(options ?? {}); },
      sendLongSpec: async () => undefined,
      sendLongText: async () => undefined
    } as Pick<MessageDeliveryService, "sendConcurrentTextBatch" | "sendLongSpec" | "sendLongText">,
    formatCodexTelegramHtml: () => null,
    sendTelegramTextChunksAndGetLastMessage: async () => null
  });

  await history.sendHistoryBlocks("slack:T:C:1", [
    { text: "first", assistant: false, messageSpec: null },
    { text: "second", assistant: true, messageSpec: null }
  ], "session_switch");

  assert.deepEqual(calls, [{ launchIntervalMs: 250, maxInFlight: 2 }]);
});

test("concurrent history sends cap in-flight messages while preserving launch order", async () => {
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const transport: BridgeMessageTransport = {
    name: "slack",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      started.push(text);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, text.endsWith("one") ? 250 : 5));
      active -= 1;
      return { message_id: text };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  const sender = new MessageDeliveryService({
    maxLength: 4000,
    queue: new KeyedQueue(),
    getEnvelopeTitle: async () => "Codex"
  });
  sender.registerTransport(transport);

  await sender.sendConcurrentTextBatch("slack:T:C:1", [
    { text: "one" },
    { text: "two" },
    { text: "three" }
  ], { launchIntervalMs: 10, maxInFlight: 2 });

  assert.deepEqual(started, ["Codex\none", "Codex\ntwo", "Codex\nthree"]);
  assert.equal(maxActive, 2);
});

test("long Telegram specs use native ordered chunks with actions only on the final message", async () => {
  const sentSpecs: MessageSpec[] = [];
  const transport: BridgeMessageTransport = {
    name: "telegram",
    canHandle: () => true,
    sendMessageSpec: async (_chatId, spec) => {
      sentSpecs.push(spec);
      return { message_id: String(sentSpecs.length) };
    },
    sendMessage: async () => assert.fail("legacy text transport should not be used"),
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  const sender = new MessageDeliveryService({
    maxLength: 200,
    queue: new KeyedQueue(),
    getEnvelopeTitle: async () => "Codex"
  });
  sender.registerTransport(transport);
  const messageSpec: MessageSpec = {
    kind: "codex",
    title: "Codex · .../projects/codex-bridge",
    body: [{ type: "text", text: "content\n".repeat(500) }],
    actions: [{ id: "help", label: "Help", callback: "quick:help" }]
  };

  await sender.sendLongText("telegram:1", "stale legacy text", { messageSpec });

  assert.ok(sentSpecs.length > 1);
  assert.ok(sentSpecs.slice(0, -1).every((spec) => spec.actions.length === 0));
  assert.deepEqual(sentSpecs.at(-1)?.actions.map((action) => action.id), ["help"]);
});

test("long Slack specs bypass the legacy text splitter", async () => {
  const sentSpecs: MessageSpec[] = [];
  const transport: BridgeMessageTransport = {
    name: "slack",
    canHandle: () => true,
    sendMessageSpec: async (_chatId, spec) => {
      sentSpecs.push(spec);
      return { message_id: String(sentSpecs.length) };
    },
    sendMessage: async () => assert.fail("legacy text transport should not be used"),
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  const sender = new MessageDeliveryService({
    maxLength: 4_000,
    queue: new KeyedQueue(),
    getEnvelopeTitle: async () => "Codex"
  });
  sender.registerTransport(transport);
  const messageSpec: MessageSpec = {
    kind: "codex",
    title: "Codex · .../projects/codex-bridge",
    body: [{ type: "text", text: "content\n".repeat(2_000) }],
    actions: [{ id: "help", label: "Help", callback: "quick:help" }]
  };

  await sender.sendLongText("slack:T:C:1", "stale legacy text", { messageSpec });

  assert.ok(sentSpecs.length > 1);
  assert.ok(sentSpecs.slice(0, -1).every((spec) => spec.actions.length === 0));
  assert.deepEqual(sentSpecs.at(-1)?.actions.map((action) => action.id), ["help"]);
});

test("concurrent Slack spec batches split each history item in order", async () => {
  const sentSpecs: MessageSpec[] = [];
  const transport: BridgeMessageTransport = {
    name: "slack",
    canHandle: () => true,
    sendMessageSpec: async (_chatId, spec) => {
      sentSpecs.push(spec);
      return { message_id: String(sentSpecs.length) };
    },
    sendMessage: async () => assert.fail("legacy text transport should not be used"),
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  const sender = new MessageDeliveryService({
    maxLength: 4_000,
    queue: new KeyedQueue(),
    getEnvelopeTitle: async () => "Codex"
  });
  sender.registerTransport(transport);
  const firstSpec: MessageSpec = {
    kind: "codex",
    title: "First",
    body: [{ type: "text", text: "first\n".repeat(2_000) }],
    actions: [{ id: "help", label: "Help", callback: "quick:help" }]
  };
  const secondSpec: MessageSpec = {
    kind: "codex",
    title: "Second",
    body: [{ type: "text", text: "second\n".repeat(2_000) }],
    actions: [{ id: "help", label: "Help", callback: "quick:help" }]
  };

  await sender.sendConcurrentTextBatch("slack:T:C:1", [
    { text: "stale first", options: { messageSpec: firstSpec } },
    { text: "stale second", options: { messageSpec: secondSpec } }
  ], { launchIntervalMs: 10, maxInFlight: 2 });

  const firstChunks = sentSpecs.filter((spec) => spec.title === "First");
  const secondChunks = sentSpecs.filter((spec) => spec.title === "Second");
  assert.ok(firstChunks.length > 1);
  assert.ok(secondChunks.length > 1);
  assert.ok(firstChunks.slice(0, -1)
    .every((spec) => spec.actions.length === 0));
  assert.ok(secondChunks.slice(0, -1)
    .every((spec) => spec.actions.length === 0));
  assert.deepEqual(firstChunks.at(-1)?.actions.map((action) => action.id), ["help"]);
  assert.deepEqual(secondChunks.at(-1)?.actions.map((action) => action.id), ["help"]);
});

test("queue client sends exact add/list/delete requests and preserves local images", async () => {
  const calls: unknown[] = [];
  const responses = [
    { queuedSubmission: { id: "q1", clientUserMessageId: "m1", input: [] } },
    { data: [{ id: "q1", clientUserMessageId: "m1", input: [{ type: "text", text: "later" }] }], nextCursor: null },
    { deleted: true }
  ];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async (...args: unknown[]) => { calls.push(args); return responses.shift(); }
  });
  const input = [{ type: "text" as const, text: "later" }, { type: "localImage" as const, path: "/tmp/a.png" }];
  assert.equal((await client.addQueuedSubmission("thread", input, "m1")).id, "q1");
  assert.equal((await client.listQueuedSubmissions("thread"))[0]?.clientUserMessageId, "m1");
  assert.equal(await client.deleteQueuedSubmission("thread", "q1"), true);
  assert.deepEqual(calls, [
    ["thread/queue/add", { threadId: "thread", input, clientUserMessageId: "m1" }, { timeoutMs: 5000 }],
    ["thread/queue/list", { threadId: "thread", cursor: null, limit: 100 }, { timeoutMs: 5000 }],
    ["thread/queue/delete", { threadId: "thread", queuedSubmissionId: "q1" }, { timeoutMs: 5000 }]
  ]);
});

test("queue records preserve origin and are consumed in FIFO order", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "slack:T:C:1", codexThreadId: "thread", pathKey: "/p" });
    for (const [sourceMessageId, summary] of [["1", "first"], ["2", "second"]]) {
      const row = await store.createQueuedSubmission({ sessionId: session.id, telegramChatId: session.telegramChatId,
        codexThreadId: "thread", codexQueueId: `q${sourceMessageId}`, clientUserMessageId: `m${sourceMessageId}`,
        sourceMessageId, summary, attachmentPaths: [], state: "queued" });
      assert.ok(row.id.startsWith("queue_"));
    }
    assert.equal(await store.countPendingQueuedSubmissions("thread"), 2);
    assert.equal((await store.startNextQueuedSubmission("thread"))?.summary, "first");
    const first = (await store.getQueuedSubmission((await store.listPendingQueuedSubmissions("thread"))[0]?.id ?? ""));
    assert.equal(first?.summary, "second");
    assert.equal(await store.countPendingQueuedSubmissions("thread"), 1);
    assert.equal((await store.startNextQueuedSubmission("thread"))?.summary, "second");
    assert.equal(await store.countPendingQueuedSubmissions("thread"), 0);
    assert.equal(store.checkDatabase().ok, true);
  } finally {
    store.close();
  }
});

test("queued cancellation reports an explicit outcome instead of inferring success from message kind", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "web:local", codexThreadId: "thread-cancel", pathKey: "/work"
    });
    store.claimSession(session.id, "web:local");
    const row = await store.createQueuedSubmission({
      sessionId: session.id, telegramChatId: "web:local", codexThreadId: session.codexThreadId,
      codexQueueId: "codex-queue", clientUserMessageId: "client-message", sourceMessageId: "source-message",
      summary: "later", attachmentPaths: [], state: "queued"
    });
    let deleted = false;
    const service = new QueuedSubmissionService({
      store,
      codexClient: { deleteQueuedSubmission: async () => deleted } as unknown as CodexAppServerClient,
      sessionOwnershipService: { getSessionOwnershipPrompt: async () => null } as never,
      statusRuntimeState: { resetEditThrottle: () => {}, getLabel: () => null },
      ensureChatAllowed: async () => {}, getSessionDirectory: () => "/work",
      setSessionStatus: async () => {}, rememberNotificationSessionId: () => {}
    });

    const refused = await service.cancelWithOutcome("web:local", row.id);
    assert.equal(refused.cancelled, false);
    assert.equal((await store.getQueuedSubmission(row.id))?.state, "queued");
    deleted = true;
    const accepted = await service.cancelWithOutcome("web:local", row.id);
    assert.equal(accepted.cancelled, true);
    assert.equal((await store.getQueuedSubmission(row.id))?.state, "cancelled");
  } finally { store.close(); }
});

test("queued submission reconciliation starts the next local row after Codex removes it", async () => {
  const store = new BridgeStore(":memory:");
  const remembered: Array<{ threadId: string; sessionId: string }> = [];
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/p" });
    const row = await store.createQueuedSubmission({
      sessionId: session.id,
      telegramChatId: session.telegramChatId,
      codexThreadId: session.codexThreadId,
      codexQueueId: "server-queue",
      clientUserMessageId: "client-message",
      sourceMessageId: "message-1",
      summary: "queued",
      attachmentPaths: [],
      state: "queued"
    });
    const service = new QueuedSubmissionService({
      store,
      codexClient: { listQueuedSubmissions: async () => [] } as unknown as CodexAppServerClient,
      sessionOwnershipService: { getSessionOwnershipPrompt: async () => null } as never,
      statusLastEditAtBySession: new Map(),
      statusLabelBySession: new Map(),
      ensureChatAllowed: async () => undefined,
      getSessionDirectory: (value) => value.currentCwd ?? value.pathKey,
      setSessionStatus: async () => undefined,
      rememberNotificationSessionId: (threadId, sessionId) => remembered.push({ threadId, sessionId })
    });

    await service.reconcileStartedSubmission(session.codexThreadId);

    assert.equal((await store.getQueuedSubmission(row.id))?.state, "started");
    assert.deepEqual(remembered, [{ threadId: session.codexThreadId, sessionId: session.id }]);
  } finally {
    store.close();
  }
});

test("an early turn start cannot be reverted to queued by a late add response", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/p" });
    const row = await store.createQueuedSubmission({ sessionId: session.id, telegramChatId: "chat", codexThreadId: "thread",
      codexQueueId: null, clientUserMessageId: "m", sourceMessageId: "1", summary: "race", attachmentPaths: [], state: "submitting" });
    assert.equal((await store.startNextQueuedSubmission("thread"))?.state, "started");
    await store.markQueuedSubmissionAccepted(row.id, "server-q");
    const persisted = await store.getQueuedSubmission(row.id);
    assert.equal(persisted?.state, "started");
    assert.equal(persisted?.codexQueueId, "server-q");
  } finally { store.close(); }
});
