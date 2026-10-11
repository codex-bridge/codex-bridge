import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import type {
  BridgeMessageTransport,
  BridgeSentMessage
} from "../src/bridge/transport.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import type { AppConfig } from "../src/config/index.js";
import { BridgeStore } from "../src/store/index.js";

function testConfig(databasePath: string): AppConfig {
  return {
    telegramBotToken: "test",
    telegramAllowedChatIds: null,
    slackEnabled: true,
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "secret",
    slackSocketClientPingTimeoutMs: 15_000,
    slackSocketServerPingTimeoutMs: 45_000,
    bridgeCallbackSecret: null,
    slackAllowedChannelIds: null,
    bridgeDbFile: databasePath,
    codexTransport: "stdio",
    codexAppServerCommand: "codex",
    codexAppServerArgs: ["app-server"],
    codexAppServerWsUrl: null,
    codexModel: null,
    codexEffort: "medium",
    codexSummary: "auto",
    codexApprovalPolicy: "on-request",
    codexSandboxMode: "workspaceWrite",
    codexWritableRoots: [],
    codexNetworkAccess: false,
    codexPermissionMode: "default",
    codexPersonality: "pragmatic",
    codexServiceName: "codex-bridge",
    codexSkillExtraRoots: [],
    codexAutoCompactOnIncompatibleHistory: false
  };
}

test("routes Slack thread notifications to the session that started the turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-route-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      sendTurn: async () => ({ turnId: "turn-1" })
    } as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "slack-test",
    canHandle: (chatId) => chatId.startsWith("slack:"),
    sendMessage: async (
      chatId: string,
      text: string
    ): Promise<BridgeSentMessage> => {
      sentMessages.push({ chatId, text });
      return { message_id: String(sentMessages.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => {}
  };
  service.registerMessageTransport(transport);

  const baseChatId = "slack:TTEST0001:DTEST0001";
  const threadChatId = "slack:TTEST0001:DTEST0001:1785563589.527999";

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: baseChatId,
      codexThreadId: "codex-thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "base",
      latestActivityAt: Date.now() - 60_000
    });
    const threadSession = await store.upsertDiscoveredSession({
      telegramChatId: threadChatId,
      codexThreadId: "codex-thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "thread",
      latestActivityAt: Date.now()
    });
    await store.setActiveSession(threadChatId, threadSession.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const routed = await service.handleIncomingUserText({
      telegramChatId: threadChatId,
      telegramMessageId: "slack-message-1",
      text: "Are you there?"
    });
    assert.equal(routed.routed, true);

    await (service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    }).handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "codex-thread-1",
        item: {
          type: "agentMessage",
          text: "Here."
        }
      }
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.chatId, threadChatId);
    assert.match(sentMessages[0]?.text ?? "", /Here\./);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes Telegram notifications to the chat that started the turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-tg-route-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      sendTurn: async () => ({ turnId: "turn-1" })
    } as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "telegram-test",
    canHandle: (chatId) => !chatId.startsWith("slack:"),
    sendMessage: async (
      chatId: string,
      text: string
    ): Promise<BridgeSentMessage> => {
      sentMessages.push({ chatId, text });
      return { message_id: String(sentMessages.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => {}
  };
  service.registerMessageTransport(transport);

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "tg-chat-old",
      codexThreadId: "codex-thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "old tg",
      latestActivityAt: Date.now() - 60_000
    });
    const activeSession = await store.upsertDiscoveredSession({
      telegramChatId: "tg-chat-active",
      codexThreadId: "codex-thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "active tg",
      latestActivityAt: Date.now()
    });
    await store.setActiveSession("tg-chat-active", activeSession.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const routed = await service.handleIncomingUserText({
      telegramChatId: "tg-chat-active",
      telegramMessageId: "tg-message-1",
      text: "Are you there?"
    });
    assert.equal(routed.routed, true);

    await (service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    }).handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "codex-thread-1",
        item: {
          type: "agentMessage",
          text: "Here."
        }
      }
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.chatId, "tg-chat-active");
    assert.match(sentMessages[0]?.text ?? "", /Here\./);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes a queued turn back to the Slack thread that submitted it", async () => {
  const store = new BridgeStore(":memory:");
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  let serverQueue = [{ id: "queue-server", clientUserMessageId: "pending", input: [{ type: "text" as const, text: "later" }] }];
  const client = {
    addQueuedSubmission: async (_threadId: string, input: unknown, clientUserMessageId: string) => {
      serverQueue = [{ id: "queue-server", clientUserMessageId, input: input as typeof serverQueue[0]["input"] }];
      return serverQueue[0];
    },
    listQueuedSubmissions: async () => serverQueue,
    deleteQueuedSubmission: async () => true
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(":memory:"), store, client);
  service.registerMessageTransport({
    name: "slack-test", canHandle: (chatId) => chatId.startsWith("slack:"),
    sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); return { message_id: String(sentMessages.length) }; },
    editMessageText: async () => true, deleteMessage: async () => true,
    clearMessageActions: async () => true, sendTyping: async () => {}
  });
  const originChat = "slack:T:C:100.1";
  const otherChat = "slack:T:C:100.2";
  try {
    const origin = await store.upsertDiscoveredSession({ telegramChatId: originChat, codexThreadId: "thread", pathKey: "/p" });
    const other = await store.upsertDiscoveredSession({ telegramChatId: otherChat, codexThreadId: "thread", pathKey: "/p" });
    await store.setActiveSession(originChat, origin.id);
    await store.setActiveSession(otherChat, other.id);
    const internal = service as unknown as {
      runtimeState: "connected";
      bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> };
      notificationSessionIdByThread: Map<string, string>;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    internal.runtimeState = "connected";
    internal.bridgeRuntimeState.inFlightTurnIdByThread.set("thread", "old-turn");
    internal.notificationSessionIdByThread.set("thread", other.id);
    assert.equal((await service.handleIncomingUserText({ telegramChatId: originChat, telegramMessageId: "m1", text: "later", queue: true })).routed, true);
    await internal.handleAppServerNotification({ method: "turn/completed", params: { threadId: "thread", turn: { id: "old-turn", status: "completed" } } });
    serverQueue = [];
    await internal.handleAppServerNotification({ method: "turn/started", params: { threadId: "thread", turn: { id: "queued-turn" } } });
    await internal.handleAppServerNotification({ method: "item/completed", params: { threadId: "thread", item: { type: "agentMessage", text: "queued answer" } } });
    assert.equal(sentMessages.find((message) => message.text.includes("queued answer"))?.chatId, originChat);
    assert.equal((await store.listPendingQueuedSubmissions("thread")).length, 0);
  } finally { store.close(); }
});
