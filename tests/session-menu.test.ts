import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { BridgeService, SessionActivationError } from "../src/bridge/service.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { BridgeMessageOptions, BridgeMessageTransport } from "../src/bridge/transport.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { handleSlackSessionWorkflow } from "../src/slack/interactions/session-workflow.js";
import type { SlackMessageTransport } from "../src/slack/transport.js";
import { BridgeStore } from "../src/store/index.js";
import { testConfig } from "./bridge-test-config.js";

function menuText(menu: MessageSpec): string {
  return renderLegacyMessage(menu);
}

function menuActions(menu: MessageSpec): MessageSpec["actions"] {
  return menu.actions;
}

test("renders sessions as directory then section menus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-menu-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let discoveryCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => {
        discoveryCount += 1;
        return [];
      },
      resumeThread: async () => ({ displayPath: null, messages: [] }),
      unsubscribeThread: async () => "unsubscribed",
      listRecentThreadHistory: async () => [],
      setThreadName: async () => undefined
    } as unknown as CodexAppServerClient
  );

  try {
    const first = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "migration",
      latestActivityAt: Date.now() - 60_000
    });
    const second = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-2",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "menu",
      latestActivityAt: Date.now() - 120_000
    });
    await store.setActiveSession("chat-1", second.id);
    assert.equal(store.claimSession(second.id, "chat-1").owned, true);
    await store.addMessage({
      sessionId: first.id,
      role: "user",
      text: "first"
    });
    await store.addMessage({
      sessionId: second.id,
      role: "user",
      text: "second"
    });
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const directoryMenu = await service.renderSessionMenu("chat-1", 0);
    assert.equal(discoveryCount, 0);
    assert.equal(directoryMenu.title, "Sessions · /workspace/project");
    assert.ok(directoryMenu.actions.some((action) => action.callback.startsWith("session-dir:")));
    assert.ok(directoryMenu.actions.some((action) => action.callback === "quick:help"));
    assert.equal(directoryMenu.actions.filter((action) => action.callback === "quick:help").length, 1);
    assert.match(menuText(directoryMenu), /^Sessions/m);
    assert.match(menuText(directoryMenu), /Current session/);
    assert.match(menuText(directoryMenu), /Session ID: thread-2/);
    assert.doesNotMatch(menuText(directoryMenu), /Directories/);
    assert.ok(menuActions(directoryMenu).some((action) => action.group === "Sessions"));
    assert.equal(
      await service.envelopeChatMessage("chat-1", "**Codex · /workspace/project**\n\nSession ID thread-2"),
      "**Codex · /workspace/project**\n\nSession ID thread-2"
    );
    assert.equal(await service.envelopeChatMessage("chat-1", "**Help**"), "**Help**");
    assert.match(
      menuActions(directoryMenu).map((action) => action.callback).join("\n"),
      new RegExp(`^session-release-bridge:${second.id}:\\d+$`, "m")
    );
    const directoryButton = menuActions(directoryMenu)
      .find((action) => action.callback.startsWith("session-dir:"));
    assert.match(directoryButton?.label ?? "", /2 sections/);
    assert.match(directoryButton?.callback ?? "", /^session-dir:/);

    const [, directoryHash] = (directoryButton?.callback ?? "").split(":");
    const sectionMenu = await service.renderSessionSectionMenu("chat-1", directoryHash, 0);
    assert.equal(discoveryCount, 0);
    assert.equal(sectionMenu.title, "Sections · /workspace/project");
    assert.ok(sectionMenu.actions.some((action) => action.callback.startsWith("section:")));
    assert.ok(sectionMenu.actions.some((action) => action.callback === "quick:help"));
    assert.equal(sectionMenu.actions.filter((action) => action.callback === "quick:help").length, 1);
    assert.match(menuText(sectionMenu), /^Sections · \/workspace\/project/m);
    assert.match(menuText(sectionMenu), /Current session/);
    assert.equal(menuText(sectionMenu).match(/Sections · \/workspace\/project/g)?.length, 1);
    assert.ok(menuActions(sectionMenu).some((action) => action.group === "Sessions"));
    assert.match(
      menuActions(sectionMenu).map((action) => action.callback).join("\n"),
      new RegExp(`^session-release-bridge:${second.id}:\\d+$`, "m")
    );
    const sectionButtonLabels = menuActions(sectionMenu)
      .map((action) => action.label)
      .join("\n");
    assert.match(sectionButtonLabels ?? "", /^unknown · .+ · u .+ · c .+/m);
    assert.doesNotMatch(sectionButtonLabels ?? "", /c Jan01/);
    assert.match(sectionButtonLabels ?? "", /migration/);
    assert.match(sectionButtonLabels ?? "", /menu/);
    assert.match(sectionButtonLabels ?? "", /New session/);

    const expiredMenu = await service.renderSessionSectionMenu("chat-1", "expired", 0);
    assert.deepEqual(expiredMenu.actions.map((action) => action.callback), [
      "session-refresh",
      "quick:help",
      "session-page:0"
    ]);

    await service.renderSessionMenu("chat-1", 0, { refresh: false });
    assert.equal(discoveryCount, 0);

    const result = await service.activateSection("chat-1", first.id);
    assert.equal(result.session.id, first.id);
    assert.equal((await store.getActiveSession("chat-1"))?.id, first.id);

    assert.match(
      renderLegacyMessage(await service.renameActiveSectionMessage("chat-1", "  api   migration  ")),
      /api migration/
    );
    const renamedSectionMenu = await service.renderSessionSectionMenu("chat-1", directoryHash, 0);
    assert.equal(discoveryCount, 0);
    const renamedLabels = menuActions(renamedSectionMenu)
      .map((action) => action.label)
      .join("\n");
    assert.match(renamedLabels ?? "", /api migration/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("switching sessions releases the previous idle Bridge lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-switch-lease-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const unsubscribed: string[] = [];
  const service = new BridgeService(testConfig(databasePath), store, {
    unsubscribeThread: async (threadId: string) => {
      unsubscribed.push(threadId);
      return "unsubscribed";
    },
    resumeThread: async () => ({ displayPath: null, messages: [] }),
    listRecentThreadHistory: async () => []
  } as CodexAppServerClient);
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
  const chatId = "chat-1";

  try {
    const previous = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-previous",
      pathKey: "/workspace/previous",
      currentCwd: "/workspace/previous",
      displayName: "previous"
    });
    const target = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-target",
      pathKey: "/workspace/target",
      currentCwd: "/workspace/target",
      displayName: "target"
    });
    await store.setActiveSession(chatId, previous.id);
    assert.equal(store.claimSession(previous.id, chatId).owned, true);

    await service.activateSession(chatId, target.id);

    assert.equal((await store.getActiveSession(chatId))?.id, target.id);
    assert.equal(store.getSessionLease(previous.id)?.state, "unbound");
    assert.equal(store.getSessionLease(target.id)?.ownerBindingId, store.getSessionBinding(target.id, chatId)?.id);
    assert.deepEqual(unsubscribed, [previous.codexThreadId]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed previous-thread unsubscribe keeps its lease without undoing the new selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-switch-unsubscribe-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(testConfig(databasePath), store, {
    unsubscribeThread: async () => { throw new Error("unsubscribe unavailable"); },
    resumeThread: async () => ({ displayPath: null, messages: [] }),
    listRecentThreadMessages: async () => []
  } as CodexAppServerClient);
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
  const chatId = "chat-1";

  try {
    const previous = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-previous",
      pathKey: "/workspace/previous",
      currentCwd: "/workspace/previous"
    });
    const target = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-target",
      pathKey: "/workspace/target",
      currentCwd: "/workspace/target"
    });
    await store.setActiveSession(chatId, previous.id);
    assert.equal(store.claimSession(previous.id, chatId).owned, true);

    await service.activateSession(chatId, target.id);

    assert.equal((await store.getActiveSession(chatId))?.id, target.id);
    assert.equal(store.getSessionLease(previous.id)?.state, "active");
    assert.equal(store.getSessionLease(target.id)?.state, "active");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime status keeps the active session directory and exposes the opposite action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-runtime-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(testConfig(databasePath), store, {} as CodexAppServerClient);
  const chatId = "chat-1";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-runtime",
      pathKey: "/workspace/runtime",
      currentCwd: "/workspace/runtime"
    });
    await store.setActiveSession(chatId, session.id);

    const message = await service.disconnectBotRuntimeMessage(chatId);

    assert.equal(message.title, "Codex · /workspace/runtime");
    assert.deepEqual(message.actions.map((action) => action.id), ["bot-connect", "help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime transition status exposes only Help", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-runtime-transition-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(testConfig(databasePath), store, {} as CodexAppServerClient);

  try {
    (service as unknown as { runtimeState: "connecting" }).runtimeState = "connecting";
    const connecting = await service.connectBotRuntimeMessage();
    assert.match(connecting.body[0]?.type === "text" ? connecting.body[0].text : "", /connecting/);
    assert.deepEqual(connecting.actions.map((action) => action.id), ["help"]);

    (service as unknown as { runtimeState: "disconnecting" }).runtimeState = "disconnecting";
    const disconnecting = await service.disconnectBotRuntimeMessage();
    assert.match(disconnecting.body[0]?.type === "text" ? disconnecting.body[0].text : "", /disconnecting/);
    assert.deepEqual(disconnecting.actions.map((action) => action.id), ["help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected Codex connection loss exposes the connect state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-runtime-loss-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let notificationListener: ((notification: { method: string; params?: unknown }) => void) | undefined;
  const client = {
    onNotification: (listener: typeof notificationListener) => {
      notificationListener = listener;
      return () => undefined;
    },
    onApprovalRequest: () => () => undefined
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(databasePath), store, client);

  try {
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
    (service as unknown as { attachCodexListeners: () => void }).attachCodexListeners();
    notificationListener?.({ method: "bridge/connection/lost", params: {} });

    assert.equal((service as unknown as { runtimeState: string }).runtimeState, "failed");
    const message = await service.disconnectBotRuntimeMessage();
    assert.deepEqual(message.actions.map((action) => action.id), ["bot-connect", "help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex account reconnect restores runtime state and releases old Bridge locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-auth-reconnect-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let notificationListener: ((notification: { method: string; params?: unknown }) => void) | undefined;
  const client = {
    onNotification: (listener: typeof notificationListener) => {
      notificationListener = listener;
      return () => undefined;
    },
    onApprovalRequest: () => () => undefined
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(databasePath), store, client);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-auth-reconnect",
      pathKey: "/workspace/auth-reconnect"
    });
    store.claimSession(session.id, "chat-1");
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
    (service as unknown as { attachCodexListeners: () => void }).attachCodexListeners();

    notificationListener?.({ method: "bridge/connection/lost", params: {} });
    assert.equal((service as unknown as { runtimeState: string }).runtimeState, "failed");
    assert.equal(store.getSessionLease(session.id)?.state, "active");

    notificationListener?.({ method: "bridge/auth/reconnected", params: {} });
    assert.equal((service as unknown as { runtimeState: string }).runtimeState, "connected");
    assert.equal(store.getSessionLease(session.id)?.state, "unbound");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an occupied target records selection without changing either owner's lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-switch-owner-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(testConfig(databasePath), store, {} as CodexAppServerClient);
  const chatId = "chat-1";

  try {
    const previous = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-previous",
      pathKey: "/workspace/previous",
      currentCwd: "/workspace/previous"
    });
    const target = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-target",
      pathKey: "/workspace/target",
      currentCwd: "/workspace/target"
    });
    await store.setActiveSession(chatId, previous.id);
    assert.equal(store.claimSession(previous.id, chatId).owned, true);
    assert.equal(store.claimSession(target.id, "other-chat").owned, true);

    await assert.rejects(
      service.activateSession(chatId, target.id),
      (error: unknown) => error instanceof SessionActivationError
    );

    assert.equal((await store.getActiveSession(chatId))?.id, target.id);
    assert.equal(store.getSessionLease(previous.id)?.ownerBindingId, store.getSessionBinding(previous.id, chatId)?.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Slack session selection reports external active-writer conflicts on repeated clicks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-active-writer-selection-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const chatId = "slack:TTEST0001:CTEST0001:thread-1";
  let resumeCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      resumeThread: async () => {
        resumeCount += 1;
        throw new Error("thread thread-active-writer already has an active writer");
      }
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  const edits: MessageSpec[] = [];
  const transport = {
    sendMessageSpec: async (_chatId: string, messageSpec: MessageSpec) => {
      edits.push(messageSpec);
      return null;
    },
    editMessageSpec: async (_chatId: string, _messageId: string, messageSpec: MessageSpec) => {
      edits.push(messageSpec);
      return true;
    }
  } as unknown as SlackMessageTransport;

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-active-writer",
      pathKey: join(directory, "rollout.jsonl"),
      currentCwd: directory,
      displayName: "external session"
    });

    const input = {
      action: `section:${session.id}`,
      context: {
        platform: "slack" as const,
        conversationId: chatId,
        surfaceId: chatId,
        sourceMessageId: "menu-message-1"
      },
      messageBlocks: null,
      messageText: null,
      service,
      transport
    };

    assert.equal(await handleSlackSessionWorkflow(input), true);
    assert.equal(await handleSlackSessionWorkflow(input), true);
    assert.equal(resumeCount, 1);
    assert.equal(edits.length, 2);
    assert.equal(store.getSessionLease(session.id)?.state, "external_unknown");
    assert.equal((await store.getActiveSession(chatId))?.id, session.id);
    for (const message of edits) {
      assert.match(renderLegacyMessage(message), /occupied outside the Bridge/);
      assert.deepEqual(message.actions.map((action) => action.id), ["refresh", "help"]);
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Slack root session selection sends actionable activation errors into the derived thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-root-conflict-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const rootChatId = "slack:TTEST0001:CTEST0001";
  const threadChatId = `${rootChatId}:menu-message-1`;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      resumeThread: async () => {
        throw new Error("thread thread-active-writer already has an active writer");
      }
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  const sends: Array<{ chatId: string; message: MessageSpec }> = [];
  const edits: Array<{ chatId: string; message: MessageSpec }> = [];
  const transport = {
    sendMessageSpec: async (chatId: string, message: MessageSpec) => {
      sends.push({ chatId, message });
      return null;
    },
    editMessageSpec: async (chatId: string, _messageId: string, message: MessageSpec) => {
      edits.push({ chatId, message });
      return true;
    }
  } as unknown as SlackMessageTransport;

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: rootChatId,
      codexThreadId: "thread-active-writer",
      pathKey: join(directory, "rollout.jsonl"),
      currentCwd: directory,
      displayName: "external session"
    });

    assert.equal(await handleSlackSessionWorkflow({
      action: `section:${session.id}`,
      context: {
        platform: "slack",
        conversationId: threadChatId,
        surfaceId: rootChatId,
        sourceMessageId: "menu-message-1"
      },
      messageBlocks: null,
      messageText: null,
      service,
      transport
    }), true);

    assert.equal(edits.length, 0);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.chatId, threadChatId);
    assert.match(renderLegacyMessage(sends[0]!.message), /occupied outside the Bridge/);
    assert.deepEqual(sends[0]?.message.actions.map((action) => action.id), ["refresh", "help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes Slack image payloads as Codex localImage input parts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-image-payload-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const imagePath = join(directory, "image.png");
  await writeFile(imagePath, "png");
  const store = new BridgeStore(databasePath);
  let capturedOptions: { inputParts?: Array<{ type: string; text?: string; path?: string }> } | null = null;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      sendTurn: async (
        _threadId: string,
        _text: string,
        _cwd: string,
        options: { inputParts?: Array<{ type: string; text?: string; path?: string }> }
      ) => {
        capturedOptions = options;
        return { turnId: "turn-image" };
      }
    } as unknown as CodexAppServerClient
  );
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:D:1",
      codexThreadId: "thread-image",
      pathKey: directory,
      currentCwd: directory,
      displayName: directory,
      latestActivityAt: Date.now()
    });
    await store.setActiveSession("slack:T:D:1", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserPayload({
      attachments: [{
        kind: "image",
        localPath: imagePath,
        mimeType: "image/png",
        name: "image.png",
        sizeBytes: 3
      }],
      telegramChatId: "slack:T:D:1",
      telegramMessageId: "msg-image",
      text: "what is this"
    });

    assert.equal(result.routed, true);
    assert.deepEqual(capturedOptions?.inputParts, [
      { type: "text", text: "what is this" },
      { type: "localImage", path: imagePath }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    store.close();
  }
});

test("steers an active Slack turn with its image and persists the user message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-image-steer-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const imagePath = join(directory, "image.png");
  await writeFile(imagePath, "png");
  const store = new BridgeStore(databasePath);
  const calls: Array<{ text: string; inputParts: unknown }> = [];
  const starts: Array<{ text: string; inputParts: unknown }> = [];
  let staleSteer = false;
  const service = new BridgeService(testConfig(databasePath), store, {
    steerTurn: async (_threadId: string, _turnId: string, text: string, inputParts: unknown) => {
      calls.push({ text, inputParts });
      if (staleSteer) throw new Error("Turn already completed");
      return { turnId: "active-turn" };
    },
    sendTurn: async (_threadId: string, text: string, _cwd: string, options: { inputParts?: unknown }) => {
      starts.push({ text, inputParts: options.inputParts });
      return { turnId: "fallback-turn" };
    }
  } as unknown as CodexAppServerClient);
  try {
    const chatId = "slack:T:D:steer";
    const session = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-steer-image",
      pathKey: directory,
      currentCwd: directory,
      displayName: directory
    });
    await store.setActiveSession(chatId, session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
    (service as unknown as { bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> } })
      .bridgeRuntimeState.inFlightTurnIdByThread.set("thread-steer-image", "active-turn");

    const result = await service.handleIncomingUserPayload({
      attachments: [{ kind: "image", localPath: imagePath, mimeType: "image/png", name: "image.png", sizeBytes: 3 }],
      telegramChatId: chatId,
      telegramMessageId: "msg-steer-image",
      text: "inspect this"
    });
    assert.equal(result.routed, true);
    assert.deepEqual(calls, [{
      text: "inspect this",
      inputParts: [
        { type: "text", text: "inspect this" },
        { type: "localImage", path: imagePath }
      ]
    }]);
    const messages = await store.listRecentMessages(session.id, 10);
    assert.equal(messages.filter((message) => message.telegramMessageId === "msg-steer-image").length, 1);

    staleSteer = true;
    const fallback = await service.handleIncomingUserPayload({
      attachments: [{ kind: "image", localPath: imagePath, mimeType: "image/png", name: "image.png", sizeBytes: 3 }],
      telegramChatId: chatId,
      telegramMessageId: "msg-stale-image",
      text: "inspect again"
    });
    assert.equal(fallback.routed, true);
    assert.deepEqual(starts, [{
      text: "inspect again",
      inputParts: [
        { type: "text", text: "inspect again" },
        { type: "localImage", path: imagePath }
      ]
    }]);
    assert.equal((await store.listRecentMessages(session.id, 10))
      .filter((message) => message.telegramMessageId === "msg-stale-image").length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders selected session confirmation for selector replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-selected-session-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readCodexConfigSnapshot: async () => ({ modelProvider: "openai", model: "gpt-test" })
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-selected",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "selected session"
    });

    const text = await service.renderSelectedSessionMessage(session);
    assert.match(text, /^\*\*Codex · .*\/workspace\/project\*\*/);
    assert.match(text, /Session ID thread-selected/);
    assert.match(text, /Thread n\/a/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("archives a session only for its idle Bridge owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-archive-action-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const archivedThreads: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      archiveThread: async (threadId: string) => {
        archivedThreads.push(threadId);
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-archive",
      pathKey: directory,
      currentCwd: directory,
      displayName: "archive me"
    });
    const ownership = store.claimSession(session.id, "chat-1");
    assert.equal(ownership.owned, true);
    const callback = await service.getSessionArchiveCallback("chat-1", session.id);
    assert.match(callback ?? "", new RegExp(`^session-archive:${session.id}:\\d+$`));

    assert.equal(store.setSessionOwnerTurn(session.id, "chat-1", "turn-busy"), true);
    assert.equal(await service.getSessionArchiveCallback("chat-1", session.id), null);
    const busyLease = store.getSessionLease(session.id);
    assert.ok(busyLease);
    const busy = await service.archiveSession("chat-1", session.id, busyLease.version);
    assert.match(renderLegacyMessage(busy), /only when no turn/);
    assert.deepEqual(archivedThreads, []);
    assert.equal(store.clearSessionOwnerTurn(session.id, "turn-busy"), true);

    const idleLease = store.getSessionLease(session.id);
    assert.ok(idleLease);
    const result = await service.archiveSession("chat-1", session.id, idleLease.version);
    assert.match(renderLegacyMessage(result), /Session archived/);
    assert.equal(result.kind, "system");
    assert.equal(result.session?.id, session.codexThreadId);
    assert.deepEqual(result.actions.map((action) => action.id), ["help", "session"]);
    assert.deepEqual(archivedThreads, ["thread-archive"]);
    assert.equal((await store.getSessionById(session.id))?.codexArchivedAt !== null, true);
    assert.equal(store.getSessionLease(session.id)?.state, "archived");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores an archived session with a fresh binding without selecting or claiming it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-unarchive-action-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const restoredThreads: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      unarchiveThread: async (threadId: string) => {
        restoredThreads.push(threadId);
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-unarchive",
      pathKey: directory,
      currentCwd: directory,
      displayName: "restore me"
    });
    await store.markSessionCodexArchived(session.id);
    const menu = await service.renderArchivedSessionMenu("chat-1");
    const button = menuActions(menu).find((candidate) => candidate.callback.startsWith("session-unarchive:"));
    assert.ok(button?.callback);

    const result = await service.unarchiveSession("chat-1", session.id);
    assert.match(renderLegacyMessage(result), /Session restored/);
    assert.match(renderLegacyMessage(result), /Use Sessions to select it/);
    assert.equal(result.kind, "system");
    assert.deepEqual(result.actions.map((action) => action.id), ["help", "session"]);
    assert.deepEqual(restoredThreads, ["thread-unarchive"]);
    assert.equal((await store.getSessionById(session.id))?.codexArchivedAt, null);
    assert.ok(store.getSessionBinding(session.id, "chat-1"));
    assert.equal((await store.getActiveSession("chat-1"))?.id ?? null, null);
    assert.equal(store.getSessionLease(session.id)?.state, "unbound");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session discovery retains sessions absent from list when thread/read succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-discovery-state-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const absentReadable = await store.upsertDiscoveredSession({
    telegramChatId: "chat-1",
    codexThreadId: "thread-readable",
    pathKey: directory,
    currentCwd: directory,
    displayName: "still readable"
  });
  const deleted = await store.upsertDiscoveredSession({
    telegramChatId: "chat-1",
    codexThreadId: "thread-deleted",
    pathKey: directory,
    currentCwd: directory,
    displayName: "gone"
  });
  const absentTransient = await store.upsertDiscoveredSession({
    telegramChatId: "chat-1",
    codexThreadId: "thread-transient",
    pathKey: directory,
    currentCwd: directory,
    displayName: "temporarily unavailable"
  });
  const incorrectlyKeyedListed = await store.upsertDiscoveredSession({
    telegramChatId: "chat-1",
    codexThreadId: "thread-listed",
    pathKey: join(directory, "rollout.jsonl"),
    currentCwd: directory,
    displayName: "old rollout path"
  });
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [{
        threadId: "thread-listed",
        pathKey: join(directory, "rollout.jsonl"),
        rolloutPath: join(directory, "rollout.jsonl"),
        currentCwd: directory,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        name: "listed",
        preview: null,
        archivedAt: null
      }],
      listArchivedThreadsForCwd: async () => [],
      readThreadStatus: async (threadId: string) => {
        if (threadId === "thread-deleted") throw new Error("thread not found");
        if (threadId === "thread-transient") throw new Error("upstream unavailable");
        return { threadId };
      }
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    await service.renderSessionMenu("chat-1", 0, { refresh: true, includeUnknownThreads: true });
    assert.ok(await store.getSessionById(absentReadable.id));
    assert.ok(await store.getSessionById(deleted.id));
    assert.ok(await store.getSessionById(absentTransient.id));
    assert.ok(store.getSessionBinding(absentReadable.id, "chat-1"));
    const refreshedListed = await store.getSessionByThreadId("thread-listed");
    assert.equal(refreshedListed?.id, incorrectlyKeyedListed.id);
    assert.equal(refreshedListed?.pathKey, directory);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session discovery clears stale sessions when complete inventories are empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-discovery-empty-inventory-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [],
      listArchivedThreadsForCwd: async () => [],
      readThreadStatus: async () => {
        throw new Error("thread not found");
      }
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-stale",
      pathKey: directory,
      currentCwd: directory,
      displayName: "stale"
    });

    await service.renderSessionMenu("chat-1", 0, { refresh: true });

    const retained = await store.getSessionByThreadId("thread-stale");
    assert.ok(retained);
    assert.equal(retained.discoveryMissingCount, 1);
    assert.ok(store.getSessionBinding(retained.id, "chat-1"));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session discovery deletes only after repeated not-found confirmation beyond the grace window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-discovery-cleanup-window-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [],
      listArchivedThreadsForCwd: async () => [],
      readThreadStatus: async () => {
        throw new Error("thread not found");
      }
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-confirmed-gone",
      pathKey: directory,
      currentCwd: directory,
      displayName: "confirmed gone"
    });
    await store.markSessionDiscoveryMissing(session.id, Date.now() - 2 * 24 * 60 * 60 * 1_000);

    await service.renderSessionMenu("chat-1", 0, { refresh: true });

    assert.equal(await store.getSessionById(session.id), null);
    assert.equal(store.getSessionBinding(session.id, "chat-1"), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session discovery keeps sessions when the inventory request fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-discovery-failure-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [{
        threadId: "thread-listed",
        pathKey: directory,
        currentCwd: directory,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        name: "listed",
        preview: null,
        archivedAt: null
      }],
      listArchivedThreadsForCwd: async () => {
        throw new Error("upstream unavailable");
      }
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const stale = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-stale",
      pathKey: directory,
      currentCwd: directory,
      displayName: "stale"
    });

    await service.renderSessionMenu("chat-1", 0, { refresh: true });

    assert.ok(await store.getSessionById(stale.id));
    assert.equal(await store.getSessionByThreadId("thread-listed"), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session discovery and notifications reconcile Codex archive membership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-archive-reconcile-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let archiveIsActive = false;
  const listedThread = (threadId: string, name: string, archivedAt: number | null) => ({
    threadId,
    pathKey: directory,
    currentCwd: directory,
    updatedAt: Date.now(),
    createdAt: Date.now() - 60_000,
    name,
    preview: null,
    archivedAt
  });
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [
        listedThread("thread-active", "active", null),
        ...(archiveIsActive ? [listedThread("thread-archive", "restored", null)] : [])
      ],
      listArchivedThreadsForCwd: async () => archiveIsActive
        ? []
        : [listedThread("thread-archive", "archived", Date.now() - 30_000)]
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-active",
      pathKey: directory,
      currentCwd: directory,
      displayName: "active"
    });
    const archivedSession = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-archive",
      pathKey: directory,
      currentCwd: directory,
      displayName: "archived"
    });

    const archivedMenu = await service.renderArchivedSessionMenu("chat-1");
    assert.ok((await store.getSessionById(archivedSession.id))?.codexArchivedAt);
    assert.equal((await store.listKnownSessions("chat-1")).some((session) => session.id === archivedSession.id), false);
    assert.ok(archivedMenu.actions.some((action) => action.callback === `session-unarchive:${archivedSession.id}`));
    assert.equal(archivedMenu.actions.filter((action) => action.callback === "quick:help").length, 1);
    assert.ok(archivedMenu.actions
      .filter((action) => action.callback.startsWith("session-unarchive:"))
      .every((action) => action.group === "Archived sessions"));

    archiveIsActive = true;
    const refreshedArchivedMenu = await service.renderArchivedSessionMenu("chat-1");
    assert.equal((await store.getSessionById(archivedSession.id))?.codexArchivedAt, null);
    assert.ok(store.getSessionBinding(archivedSession.id, "chat-1"));
    assert.equal(refreshedArchivedMenu.actions.some((action) => action.callback === `session-unarchive:${archivedSession.id}`), false);

    const notificationHandler = service as unknown as {
      handleAppServerNotification: (notification: { method: string; params: { threadId: string } }) => Promise<void>;
    };
    await notificationHandler.handleAppServerNotification({
      method: "thread/archived",
      params: { threadId: "thread-archive" }
    });
    assert.ok((await store.getSessionById(archivedSession.id))?.codexArchivedAt);
    assert.equal(store.getSessionBinding(archivedSession.id, "chat-1"), null);

    await notificationHandler.handleAppServerNotification({
      method: "thread/unarchived",
      params: { threadId: "thread-archive" }
    });
    assert.equal((await store.getSessionById(archivedSession.id))?.codexArchivedAt, null);
    assert.ok(store.getSessionBinding(archivedSession.id, "chat-1"));

    await notificationHandler.handleAppServerNotification({
      method: "thread/deleted",
      params: { threadId: "thread-archive" }
    });
    assert.ok((await store.getSessionById(archivedSession.id))?.codexArchivedAt);
    assert.equal(store.getSessionBinding(archivedSession.id, "chat-1"), null);

  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deletes Codex first and Bridge history only after explicit confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-delete-action-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const deletedThreads: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      deleteThread: async (threadId: string) => {
        deletedThreads.push(threadId);
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-delete",
      pathKey: directory,
      currentCwd: directory,
      displayName: "delete me"
    });
    store.claimSession(session.id, "chat-1");
    await store.addMessage({ sessionId: session.id, role: "user", text: "history" });
    const lease = store.getSessionLease(session.id);
    assert.ok(lease);

    const prompt = await service.requestDeleteSession("chat-1", session.id, lease.version);
    assert.match(renderLegacyMessage(prompt), /permanently/);
    assert.match(prompt.actions.map((action) => action.callback).join("\n"), /session-delete-confirm:/);
    assert.equal(prompt.kind, "decision");
    assert.deepEqual(prompt.actions.map((action) => action.id), ["confirm-delete", "cancel"]);
    assert.equal(prompt.actions[0]?.style, "danger");
    assert.equal(deletedThreads.length, 0);
    assert.ok(await store.getSessionById(session.id));

    const confirmation = prompt.actions.find((action) => action.label === "Confirm delete");
    assert.ok(confirmation?.callback);
    const [, sessionId, versionText] = confirmation.callback.split(":");
    const result = await service.deleteSession("chat-1", sessionId ?? "", Number(versionText));
    assert.match(renderLegacyMessage(result), /Session deleted/);
    assert.equal(result.kind, "system");
    assert.deepEqual(result.actions.map((action) => action.id), ["help", "session"]);
    assert.deepEqual(deletedThreads, ["thread-delete"]);
    assert.equal(await store.getSessionById(session.id), null);
    assert.equal((await store.listSessionBindings(session.id)).length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders freshly discovered Telegram sessions before any active session exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-fresh-menu-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [
        {
          threadId: "thread-fresh",
          pathKey: "/workspace/fresh",
          currentCwd: "/workspace/fresh",
          updatedAt: Date.now(),
          createdAt: Date.now() - 60_000,
          name: "fresh",
          preview: null
        }
      ]
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const menu = await service.renderSessionMenu("chat-1", 0);
    const labels = menuActions(menu)
      .map((action) => action.label)
      .join("\n");

    assert.ok(menuActions(menu).some((action) => action.callback.startsWith("session-dir:")));
    assert.match(labels ?? "", /fresh/);
    assert.equal((await store.getActiveSession("chat-1"))?.id ?? null, null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session menu refresh button discovers unknown threads from the first page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-refresh-menu-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const knownDirectory = join(directory, "known");
  const unknownDirectory = join(directory, "unknown");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [
        {
          threadId: "thread-known",
          pathKey: knownDirectory,
          currentCwd: knownDirectory,
          updatedAt: Date.now(),
          createdAt: Date.now() - 120_000,
          name: "codex-thread-name",
          preview: null
        },
        {
          threadId: "thread-unknown",
          pathKey: unknownDirectory,
          currentCwd: unknownDirectory,
          updatedAt: Date.now() - 60_000,
          createdAt: Date.now() - 60_000,
          name: "unknown",
          preview: null
        }
      ]
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-known",
      pathKey: knownDirectory,
      currentCwd: knownDirectory,
      displayName: knownDirectory
    });

    const regularMenu = await service.renderSessionMenu("chat-1", 0, { refresh: true });
    const regularLabels = menuActions(regularMenu)
      .map((action) => `${action.label}:${action.callback}`)
      .join("\n") ?? "";
    assert.match(regularLabels, /Refresh:session-refresh/);
    assert.doesNotMatch(regularLabels, /unknown/);
    const directoryAction = menuActions(regularMenu)
      .find((action) => action.callback.startsWith("session-dir:"))
      ?.callback;
    assert.ok(directoryAction);
    const sectionMenu = await service.renderSessionSectionMenu(
      "chat-1",
      directoryAction.split(":")[1] ?? "",
      0
    );
    const sectionLabels = menuActions(sectionMenu).map((action) => action.label).join("\n");
    assert.match(sectionLabels, /codex-thread-name/);

    const refreshedMenu = await service.renderSessionMenu("chat-1", 0, {
      refresh: true,
      includeUnknownThreads: true
    });
    const refreshedLabels = menuActions(refreshedMenu)
      .map((action) => `${action.label}:${action.callback}`)
      .join("\n") ?? "";
    assert.match(refreshedLabels, /unknown/);

    const sessions = await store.listKnownSessions("chat-1");
    assert.ok(sessions.some((session) => session.codexThreadId === "thread-unknown"));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session menus filter sessions by the effective Codex provider per directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-provider-filter-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const matchingDirectory = join(directory, "matching");
  const hiddenOnlyDirectory = join(directory, "hidden-only");
  const store = new BridgeStore(databasePath);
  let effectiveProvider = "codex-lb";
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => [
        {
          threadId: "thread-openai",
          pathKey: join(matchingDirectory, "openai.jsonl"),
          currentCwd: matchingDirectory,
          updatedAt: Date.now(),
          createdAt: Date.now() - 120_000,
          name: "openai session",
          preview: null,
          modelProvider: "openai",
          modelProviderKnown: true
        },
        {
          threadId: "thread-lb",
          pathKey: join(matchingDirectory, "lb.jsonl"),
          currentCwd: matchingDirectory,
          updatedAt: Date.now() - 60_000,
          createdAt: Date.now() - 60_000,
          name: "lb session",
          preview: null,
          modelProvider: "codex-lb",
          modelProviderKnown: true
        },
        {
          threadId: "thread-hidden-only",
          pathKey: join(hiddenOnlyDirectory, "openai.jsonl"),
          currentCwd: hiddenOnlyDirectory,
          updatedAt: Date.now() - 30_000,
          createdAt: Date.now() - 30_000,
          name: "hidden only",
          preview: null,
          modelProvider: "openai",
          modelProviderKnown: true
        }
      ],
    readThreadStatus: async () => {
      throw new Error("thread/read must not control session-menu visibility");
    },
    readCodexConfigSnapshot: async (cwd: string) => ({
      model: "gpt-test",
      modelProvider: cwd === matchingDirectory ? effectiveProvider : effectiveProvider
    })
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const menu = await service.renderSessionMenu("chat-1", 0);
    const directoryActions = menuActions(menu).filter((action) => action.callback.startsWith("session-dir:"));
    const directoryLabels = directoryActions.map((action) => action.label).join("\n");

    assert.equal(directoryActions.length, 1);
    assert.match(directoryLabels, /matching/);
    assert.doesNotMatch(directoryLabels, /hidden-only/);

    const directoryHash = directoryActions[0]?.callback.split(":")[1];
    assert.ok(directoryHash);
    const sectionMenu = await service.renderSessionSectionMenu("chat-1", directoryHash, 0);
    const sectionLabels = menuActions(sectionMenu).map((action) => action.label).join("\n");

    assert.match(sectionLabels, /lb session/);
    assert.doesNotMatch(sectionLabels, /openai session/);

    const refreshedMenu = await service.renderSessionMenu("chat-1", 0, { refresh: true });
    const refreshedDirectoryActions = refreshedMenu.actions
      .filter((action) => action.callback.startsWith("session-dir:"));
    assert.equal(refreshedDirectoryActions.length, 1);
    const refreshedHash = refreshedDirectoryActions[0]?.callback.split(":")[1];
    assert.ok(refreshedHash);
    const refreshedSectionMenu = await service.renderSessionSectionMenu("chat-1", refreshedHash, 0);
    const refreshedSectionLabels = menuActions(refreshedSectionMenu).map((action) => action.label).join("\n");
    assert.match(refreshedSectionLabels, /lb session/);
    assert.doesNotMatch(refreshedSectionLabels, /openai session/);

    effectiveProvider = "openai";
    const reopenedMenu = await service.renderSessionMenu("chat-1");
    const reopenedDirectoryActions = menuActions(reopenedMenu)
      .filter((action) => action.callback.startsWith("session-dir:"));
    assert.equal(reopenedDirectoryActions.length, 2);

    const reopenedHash = reopenedDirectoryActions
      .find((action) => action.label.includes("matching"))
      ?.callback.split(":")[1];
    assert.ok(reopenedHash);
    const reopenedSectionMenu = await service.renderSessionSectionMenu("chat-1", reopenedHash, 0);
    const reopenedSectionLabels = menuActions(reopenedSectionMenu).map((action) => action.label).join("\n");
    assert.match(reopenedSectionLabels, /openai session/);
    assert.doesNotMatch(reopenedSectionLabels, /lb session/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session menus keep an uncached session visible instead of using historical thread/read provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-menu-native-provider-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let threadStatusReads = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => {
        threadStatusReads += 1;
        return { modelProvider: "openai" };
      },
      readCodexConfigSnapshot: async () => ({ model: "gpt-test", modelProvider: "custom" })
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-without-fresh-listing",
      pathKey: directory,
      currentCwd: directory,
      displayName: "native provider pending refresh"
    });

    const menu = await service.renderSessionMenu("chat-1", 0);
    assert.ok(menuActions(menu).some((action) => action.callback.startsWith("session-dir:")));
    assert.equal(threadStatusReads, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap connects without eagerly discovering all sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-bootstrap-lazy-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let connected = false;
  let discoveryCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      connect: async () => {
        connected = true;
      },
      listThreadsForCwd: async () => {
        discoveryCount += 1;
        return [];
      },
      onNotification: () => undefined,
      onApprovalRequest: () => undefined
    } as unknown as CodexAppServerClient
  );

  try {
    await service.bootstrap();

    assert.equal(connected, true);
    assert.equal(discoveryCount, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap reconciles durable active turns without deleting their progress cards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-bootstrap-active-turn-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const edits: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      connect: async () => {},
      onNotification: () => undefined,
      onApprovalRequest: () => undefined,
      readThreadStatus: async (threadId: string) => ({
        threadId,
        cwd: directory,
        threadName: null,
        model: null,
        modelProvider: null,
        serviceTier: null,
        approvalPolicy: null,
        sandboxMode: null,
        reasoningEffort: null,
        activity: threadId === "thread-running" ? "running" : "idle",
        activityType: threadId === "thread-running"
          ? "running"
          : threadId === "thread-not-loaded"
            ? "notLoaded"
            : "idle",
        contextLeftPercent: null,
        contextUsedTokens: null,
        contextMaxTokens: null
      })
    } as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test", canHandle: () => true,
    sendMessage: async () => null,
    editMessageText: async (_chatId, _messageId, text) => { edits.push(text); return true; },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const idle = await store.upsertDiscoveredSession({
      telegramChatId: "chat-idle", codexThreadId: "thread-idle", pathKey: directory, currentCwd: directory
    });
    const running = await store.upsertDiscoveredSession({
      telegramChatId: "chat-running", codexThreadId: "thread-running", pathKey: directory, currentCwd: directory
    });
    const notLoaded = await store.upsertDiscoveredSession({
      telegramChatId: "chat-not-loaded", codexThreadId: "thread-not-loaded", pathKey: directory, currentCwd: directory
    });
    store.recordTurnRoute({ turnId: "turn-idle", sessionId: idle.id, codexThreadId: idle.codexThreadId, bindingId: null, sourceId: idle.telegramChatId });
    store.recordTurnRoute({ turnId: "turn-running", sessionId: running.id, codexThreadId: running.codexThreadId, bindingId: null, sourceId: running.telegramChatId });
    store.recordTurnRoute({ turnId: "turn-not-loaded", sessionId: notLoaded.id, codexThreadId: notLoaded.codexThreadId, bindingId: null, sourceId: notLoaded.telegramChatId });
    const phase = store.createProgressPhaseMessage({
      sessionId: idle.id,
      codexThreadId: idle.codexThreadId,
      turnId: "turn-idle",
      phaseKind: "called",
      sourceId: idle.telegramChatId,
      platformMessageId: "42",
      directory,
      text: "Called · project\nread file"
    });
    const notLoadedPhase = store.createProgressPhaseMessage({
      sessionId: notLoaded.id,
      codexThreadId: notLoaded.codexThreadId,
      turnId: "turn-not-loaded",
      phaseKind: "called",
      sourceId: notLoaded.telegramChatId,
      platformMessageId: "43",
      directory,
      text: "Called · project\nread file"
    });

    await service.bootstrap();

    assert.equal(store.getActiveTurnRoute(idle.codexThreadId), null);
    assert.equal(store.getProgressPhaseMessage(phase.id)?.state, "interrupted");
    assert.match(edits.join("\n"), /Interrupted/);
    assert.equal(store.getActiveTurnRoute(running.codexThreadId)?.turnId, "turn-running");
    assert.equal((service as unknown as { bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> } })
      .bridgeRuntimeState.inFlightTurnIdByThread.get("thread-running"), "turn-running");
    assert.equal(store.getActiveTurnRoute(notLoaded.codexThreadId)?.turnId, "turn-not-loaded");
    assert.equal(store.getProgressPhaseMessage(notLoadedPhase.id)?.state, "active");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("no active session prompt uses cached sessions without discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-no-active-lazy-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let discoveryCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => {
        discoveryCount += 1;
        return [];
      }
    } as unknown as CodexAppServerClient
  );

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "project",
      latestActivityAt: Date.now() - 60_000
    });
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserText({
      telegramChatId: "chat-1",
      telegramMessageId: "message-1",
      text: "hello"
    });

    assert.equal(result.routed, false);
    assert.ok(result.prompt?.actions.some((action) => action.callback.startsWith("session-dir:")));
    assert.equal(discoveryCount, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider changes leave a bound session untouched and offer Session and Help", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-provider-mismatch-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let configReadCount = 0;
  let sendTurnCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => ({ modelProvider: "openai" }),
      readCodexConfigSnapshot: async () => {
        configReadCount += 1;
        return { modelProvider: "codex-lb" };
      },
      sendTurn: async () => {
        sendTurnCount += 1;
        return { turnId: "turn-unexpected" };
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C:1.000",
      codexThreadId: "thread-provider-mismatch",
      pathKey: "/rollouts/thread-provider-mismatch.jsonl",
      currentCwd: "/workspace/project",
      displayName: "project"
    });
    await store.setActiveSession("slack:T:C:1.000", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserText({
      telegramChatId: "slack:T:C:1.000",
      telegramMessageId: "message-provider-mismatch",
      text: "hello"
    });

    assert.equal(result.routed, false);
    assert.equal(configReadCount, 1);
    assert.equal(sendTurnCount, 0);
    assert.equal((await store.listRecentMessages(session.id, 10)).length, 0);
    assert.equal((await store.getActiveSession("slack:T:C:1.000"))?.id, session.id);
    assert.match(result.prompt ? renderLegacyMessage(result.prompt) : "", /uses provider openai/);
    assert.match(result.prompt ? renderLegacyMessage(result.prompt) : "", /Codex config now uses codex-lb/);
    assert.deepEqual(result.prompt?.actions.map((action) => action.id), ["session", "help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("config authentication failures stop the turn with Session and Help", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-config-auth-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let sendTurnCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readCodexConfigSnapshot: async () => {
        throw new Error("401 INVALID_API_KEY");
      },
      sendTurn: async () => {
        sendTurnCount += 1;
        return { turnId: "turn-unexpected" };
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-config-auth",
      pathKey: "/rollouts/thread-config-auth.jsonl",
      currentCwd: "/workspace/project",
      displayName: "project"
    });
    await store.setActiveSession("chat-1", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserText({
      telegramChatId: "chat-1",
      telegramMessageId: "message-config-auth",
      text: "hello"
    });

    assert.equal(result.routed, false);
    assert.equal(sendTurnCount, 0);
    assert.match(result.prompt ? renderLegacyMessage(result.prompt) : "", /401 INVALID_API_KEY/);
    assert.deepEqual(result.prompt?.actions.map((action) => action.id), ["session", "help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing config environment variables are named without exposing their value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-config-env-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let sendTurnCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readCodexConfigSnapshot: async () => {
        throw new Error("Missing environment variable: CODEX_API_KEY");
      },
      sendTurn: async () => {
        sendTurnCount += 1;
        return { turnId: "turn-unexpected" };
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-env",
      codexThreadId: "thread-config-env",
      pathKey: "/rollouts/thread-config-env.jsonl",
      currentCwd: "/workspace/project",
      displayName: "project"
    });
    await store.setActiveSession("chat-env", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserText({
      telegramChatId: "chat-env",
      telegramMessageId: "message-config-env",
      text: "hello"
    });

    assert.equal(result.routed, false);
    assert.equal(sendTurnCount, 0);
    assert.match(renderLegacyMessage(result.prompt ?? { title: "", kind: "error", body: [], actions: [] }), /missing environment variable CODEX_API_KEY/);
    assert.doesNotMatch(renderLegacyMessage(result.prompt ?? { title: "", kind: "error", body: [], actions: [] }), /secret|token-value/i);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("active writer conflicts preserve the session and mark external occupation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-active-writer-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let discoveryCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      sendTurn: async () => {
        throw new Error("thread thread-1 already has an active writer");
      },
      listThreadsForCwd: async () => {
        discoveryCount += 1;
        return [];
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "project",
      latestActivityAt: Date.now() - 60_000
    });
    await store.setActiveSession("chat-1", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserText({
      telegramChatId: "chat-1",
      telegramMessageId: "message-1",
      text: "hello"
    });

    assert.equal(result.routed, false);
    assert.match(result.prompt ? renderLegacyMessage(result.prompt) : "", /occupied outside the Bridge/);
    assert.match(result.prompt ? renderLegacyMessage(result.prompt) : "", /refresh/);
    assert.equal(result.prompt?.title, "Codex error · /workspace/project");
    assert.deepEqual(result.prompt?.actions.map((action) => action.id), ["refresh", "help"]);
    assert.equal((await store.getSessionLease(session.id))?.state, "external_unknown");
    assert.equal((await store.getActiveSession("chat-1"))?.id, session.id);
    assert.equal(discoveryCount, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale idle Bridge leases are released before another conversation claims the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-stale-lease-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let sendTurnCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => ({
        activity: "idle",
        activityType: "notLoaded"
      }),
      sendTurn: async () => {
        sendTurnCount += 1;
        return { turnId: "turn-1" };
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "owner-chat",
      codexThreadId: "thread-stale",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "project",
      latestActivityAt: Date.now() - 60_000
    });
    store.claimSession(session.id, "owner-chat");
    await store.ensureChat("new-chat");
    store.ensureSessionBinding(session.id, "new-chat");
    await store.setActiveSession("new-chat", session.id);
    const sqlite = (store as unknown as { sqlite: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).sqlite;
    sqlite.prepare("UPDATE session_leases SET updated_at = ? WHERE session_id = ?").run(Date.now() - 2 * 24 * 60 * 60 * 1_000, session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserText({
      telegramChatId: "new-chat",
      telegramMessageId: "message-1",
      text: "hello"
    });

    assert.equal(result.routed, true);
    assert.equal(sendTurnCount, 1);
    assert.equal(store.getSessionLease(session.id)?.ownerBindingId, store.getSessionBinding(session.id, "new-chat")?.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale leases with a visible running Codex thread become external locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-external-lease-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let sendTurnCount = 0;
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => ({
        activity: "running",
        activityType: "inProgress"
      }),
      sendTurn: async () => {
        sendTurnCount += 1;
        return { turnId: "turn-1" };
      }
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "owner-chat",
      codexThreadId: "thread-external",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "project",
      latestActivityAt: Date.now() - 60_000
    });
    store.claimSession(session.id, "owner-chat");
    await store.ensureChat("new-chat");
    store.ensureSessionBinding(session.id, "new-chat");
    await store.setActiveSession("new-chat", session.id);
    const sqlite = (store as unknown as { sqlite: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).sqlite;
    sqlite.prepare("UPDATE session_leases SET updated_at = ? WHERE session_id = ?").run(Date.now() - 2 * 24 * 60 * 60 * 1_000, session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const result = await service.handleIncomingUserText({
      telegramChatId: "new-chat",
      telegramMessageId: "message-1",
      text: "hello"
    });

    assert.equal(result.routed, false);
    assert.match(result.prompt ? renderLegacyMessage(result.prompt) : "", /occupied outside the Bridge/);
    assert.equal(sendTurnCount, 0);
    assert.equal(store.getSessionLease(session.id)?.state, "external_unknown");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session refresh reads history without claiming or switching the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-refresh-view-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => ({
        activity: "idle",
        activityType: "notLoaded"
      }),
      listRecentThreadMessages: async () => [
        { role: "assistant", text: "latest", turnId: "turn-1", itemId: "item-1" }
      ]
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const viewed = await store.upsertDiscoveredSession({
      telegramChatId: "owner-chat",
      codexThreadId: "thread-viewed",
      pathKey: "/workspace/viewed/rollout.jsonl",
      currentCwd: "/workspace/viewed",
      displayName: "viewed",
      latestActivityAt: Date.now() - 60_000
    });
    const current = await store.upsertDiscoveredSession({
      telegramChatId: "viewer-chat",
      codexThreadId: "thread-current",
      pathKey: "/workspace/current",
      currentCwd: "/workspace/current",
      displayName: "current",
      latestActivityAt: Date.now() - 120_000
    });
    store.claimSession(viewed.id, "owner-chat");
    store.ensureSessionBinding(viewed.id, "viewer-chat");
    await store.setActiveSession("viewer-chat", current.id);

    const result = await service.refreshSessionView("viewer-chat", viewed.id);

    assert.equal(result.recentMessages[0]?.text, "latest");
    assert.equal((await store.getActiveSession("viewer-chat"))?.id, current.id);
    assert.equal(store.getSessionLease(viewed.id)?.ownerBindingId, store.getSessionBinding(viewed.id, "owner-chat")?.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("external session refresh retries ownership after Codex becomes idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-refresh-external-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => ({
        activity: "idle",
        activityType: "completed"
      }),
      listRecentThreadHistory: async () => []
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "external-chat",
      codexThreadId: "thread-external-refresh",
      pathKey: "/workspace/external/rollout.jsonl",
      currentCwd: "/workspace/external",
      displayName: "external",
      latestActivityAt: Date.now() - 60_000
    });
    store.ensureSessionBinding(session.id, "viewer-chat");
    store.markSessionExternalUnknown(session.id);

    const result = await service.refreshSessionView("viewer-chat", session.id);

    assert.equal(result.session.id, session.id);
    assert.equal(store.getSessionLease(session.id)?.ownerBindingId, store.getSessionBinding(session.id, "viewer-chat")?.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("external refresh keeps the session locked when notLoaded resume is still occupied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-refresh-occupied-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => ({
        activity: "idle",
        activityType: "notLoaded"
      }),
      resumeThread: async () => {
        throw new Error("thread already has an active writer");
      },
      listRecentThreadHistory: async () => []
    } as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "external-chat",
      codexThreadId: "thread-external-occupied-refresh",
      pathKey: "/workspace/external/rollout.jsonl",
      currentCwd: "/workspace/external",
      displayName: "external",
      latestActivityAt: Date.now() - 60_000
    });
    store.ensureSessionBinding(session.id, "viewer-chat");
    store.markSessionExternalUnknown(session.id);

    const result = await service.refreshSessionView("viewer-chat", session.id);

    assert.equal(result.session.id, session.id);
    assert.equal(store.getSessionLease(session.id)?.state, "external_unknown");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refresh status is appended with the final external lock action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-refresh-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sent: Array<{ text: string; callback: string | null }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text, options) => {
      sent.push({
        text,
        callback: options?.messageSpec?.actions[0]?.callback ?? null
      });
      return { message_id: String(sent.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread-refresh-status",
      pathKey: "/workspace/status/rollout.jsonl",
      currentCwd: "/workspace/status",
      displayName: "status",
      latestActivityAt: Date.now()
    });
    store.markSessionExternalUnknown(session.id);

    await service.postSessionRefreshStatus("chat", session);

    assert.match(sent[0]?.text ?? "", /^Codex · /);
    assert.match(sent[0]?.text ?? "", /occupied outside the Bridge/);
    assert.equal(sent[0]?.callback, `session-refresh:${session.id}:${store.getSessionLease(session.id)?.version}`);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders Slack sessions from known directories after a session is active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-menu-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => []
    } as unknown as CodexAppServerClient
  );
  const chatId = "slack:TTEST0001:DTEST0001";

  try {
    const first = await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "project",
      latestActivityAt: Date.now() - 60_000
    });
    await store.upsertDiscoveredSession({
      telegramChatId: chatId,
      codexThreadId: "thread-2",
      pathKey: "/workspace/other",
      currentCwd: "/workspace/other",
      displayName: "other",
      latestActivityAt: Date.now() - 120_000
    });
    await store.setActiveSession(chatId, first.id);

    const menu = await service.renderSessionMenu(chatId, 0, { refresh: false });
    const labels = menuActions(menu)
      .map((action) => action.label)
      .join("\n");

    assert.match(labels ?? "", /project/);
    assert.match(labels ?? "", /other/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("renders Slack thread sessions from the root selector without copying all sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-thread-menu-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      listThreadsForCwd: async () => []
    } as unknown as CodexAppServerClient
  );
  const rootChatId = "slack:TTEST0001:CTEST0001";
  const threadChatId = "slack:TTEST0001:CTEST0001:1786524000.000000";

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: rootChatId,
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "project",
      latestActivityAt: Date.now() - 60_000
    });
    await store.upsertDiscoveredSession({
      telegramChatId: rootChatId,
      codexThreadId: "thread-2",
      pathKey: "/workspace/demo-app",
      currentCwd: "/workspace/demo-app",
      displayName: "demo-app",
      latestActivityAt: Date.now() - 120_000
    });

    const menu = await service.renderSessionMenu(threadChatId, 0, { refresh: false });
    const labels = menuActions(menu)
      .map((action) => action.label)
      .join("\n");

    assert.ok(menuActions(menu).some((action) => action.callback.startsWith("session-dir:")));
    assert.match(labels ?? "", /project/);
    assert.match(labels ?? "", /demo-app/);
    assert.equal((await store.listKnownSessions(threadChatId)).length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session switch transcript shows saved active and new providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-provider-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const rolloutPath = join(directory, "rollout.jsonl");
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "thread-provider",
        cwd: "/workspace/project",
        model_provider: "openai"
      }
    })}\n`
  );
  const store = new BridgeStore(databasePath);
  const sentMessages: string[] = [];
  const sentSpecs: MessageSpec[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      readThreadStatus: async () => ({
        approvalPolicy: null,
        contextLeftPercent: null,
        contextMaxTokens: null,
        contextUsedTokens: null,
        cwd: "/workspace/project",
        model: null,
        modelProvider: "openai",
        reasoningEffort: null,
        sandboxMode: null,
        serviceTier: null,
        threadId: "thread-provider",
        threadName: null
      }),
      readCodexConfigSnapshot: async () => ({ modelProvider: "codex-lb", model: "gpt-config" })
    } as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text, options) => {
      sentMessages.push(text);
      if (options?.messageSpec) sentSpecs.push(options.messageSpec);
      return { message_id: String(sentMessages.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-provider",
      pathKey: rolloutPath,
      currentCwd: "/workspace/project",
      displayName: "provider test",
      latestActivityAt: Date.now()
    });
    await store.setActiveSession("chat-1", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    await service.postSessionSwitchTranscript("chat-1", session, [
      { role: "user", text: "restore question" },
      { role: "assistant", text: "**Goal**\nrestore answer" }
    ]);

    assert.match(sentMessages[0] ?? "", /Switched to session/);
    assert.doesNotMatch(sentMessages[0] ?? "", /Provider/);
    assert.match(sentMessages[1] ?? "", /User · \/workspace\/project/);
    assert.match(sentMessages[1] ?? "", /restore question/);
    assert.match(sentMessages[2] ?? "", /Codex · \/workspace\/project/);
    assert.match(sentMessages[2] ?? "", /\*\*Goal\*\*/);
    assert.match(sentMessages[3] ?? "", /Provider · \/workspace\/project/);
    assert.match(sentMessages[3] ?? "", /Provider/);
    assert.match(sentMessages[3] ?? "", /Config: codex-lb/);
    assert.match(sentMessages[3] ?? "", /Thread: openai/);
    assert.deepEqual(sentSpecs[3]?.actions, []);
    assert.match(sentMessages[4] ?? "", /Actions · \/workspace\/project/);
    assert.deepEqual(sentSpecs[4]?.actions, [
      { id: "go", label: "Go", callback: "quick:go", execution: { type: "send-text", text: "go" } },
      { id: "next", label: "Next", callback: "quick:next", execution: { type: "send-text", text: "next" }, sameRowAsPrevious: true },
      { id: "help", label: "Help", callback: "quick:help",
        execution: { type: "session-tool", tool: "help" }, sameRowAsPrevious: true }
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session refresh keeps the last five conversation messages and ends with Actions after external status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-refresh-transcript-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const sent: Array<{ chatId: string; text: string; actions: string[] }> = [];
  const service = new BridgeService(testConfig(join(directory, "bridge.sqlite")), store, {} as CodexAppServerClient);
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sent.push({ chatId, text, actions: options?.messageSpec?.actions.map((action) => action.label) ?? [] });
      return { message_id: String(sent.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread-refresh-transcript",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      latestActivityAt: Date.now()
    });
    await store.setActiveSession("chat", session.id);
    store.markSessionExternalUnknown(session.id);
    await service.postSessionSwitchTranscript("chat", session, [
      { role: "user", text: "old question" },
      { role: "assistant", text: "old answer" },
      { role: "system", text: "not a conversation message" },
      { role: "user", text: "question two" },
      { role: "assistant", text: "answer two" },
      { role: "user", text: "question three" },
      { role: "assistant", text: "answer three" }
    ], { purpose: "session_refresh" });

    assert.equal(sent.length, 9);
    assert.ok(sent.every(({ chatId }) => chatId === "chat"));
    assert.deepEqual(sent.slice(1, 6).map(({ text }) => text.split("\n").slice(1).join("\n")), [
      "old answer", "question two", "answer two", "question three", "answer three"
    ]);
    assert.match(sent[6]?.text ?? "", /^Provider · /);
    assert.match(sent[7]?.text ?? "", /occupied outside the Bridge/);
    assert.deepEqual(sent[7]?.actions, ["Refresh"]);
    assert.match(sent[8]?.text ?? "", /^Actions · /);
    assert.deepEqual(sent[8]?.actions, ["Go", "Next", "Help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only refresh does not offer Go Next for a different active session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-readonly-transcript-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const sent: Array<{ chatId: string; text: string }> = [];
  const service = new BridgeService(testConfig(join(directory, "bridge.sqlite")), store, {} as CodexAppServerClient);
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: String(sent.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const viewed = await store.upsertDiscoveredSession({
      telegramChatId: "owner-chat",
      codexThreadId: "thread-readonly-view",
      pathKey: "/workspace/viewed",
      currentCwd: "/workspace/viewed",
      latestActivityAt: Date.now()
    });
    const active = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread-active-chat",
      pathKey: "/workspace/active",
      currentCwd: "/workspace/active",
      latestActivityAt: Date.now()
    });
    await store.setActiveSession("chat", active.id);
    await service.postSessionSwitchTranscript("chat", viewed, [{ role: "assistant", text: "viewed answer" }], {
      purpose: "session_refresh"
    });

    assert.ok(sent.every(({ chatId }) => chatId === "chat"));
    assert.ok(sent.some(({ text }) => text.includes("viewed answer")));
    assert.ok(sent.every(({ text }) => !text.startsWith("Actions · ")));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session transcript restores pending approval without offering Go Next Help", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-transcript-approval-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const sent: Array<{ text: string; actions: string[] }> = [];
  const service = new BridgeService(testConfig(join(directory, "bridge.sqlite")), store, {} as CodexAppServerClient);
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text, options) => {
      sent.push({ text, actions: options?.messageSpec?.actions.map((action) => action.label) ?? [] });
      return { message_id: String(sent.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread-transcript-approval",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      latestActivityAt: Date.now()
    });
    await store.createOrReplacePendingDecision({
      sessionId: session.id,
      telegramChatId: "chat",
      approvalId: "approval-transcript",
      kind: "item/commandExecution/requestApproval",
      title: "Run command",
      summary: "command: yarn lint",
      requiresUserInput: false
    });
    await service.postSessionSwitchTranscript("chat", session, [{ role: "user", text: "review pending work" }]);

    assert.ok(sent.some(({ text }) => text.startsWith("Provider · ")));
    assert.ok(sent.some(({ actions }) => actions.some((label) => /Approve|Deny/.test(label))));
    assert.ok(sent.every(({ text }) => !text.startsWith("Actions · ")));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("status renders provider and limits as formatted sections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const rolloutPath = join(directory, "rollout.jsonl");
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "thread-status",
        cwd: "/workspace/project",
        model_provider: "openai"
      }
    })}\n`
  );
  const store = new BridgeStore(databasePath);
  const config = testConfig(databasePath);
  const service = new BridgeService(
    config,
    store,
    {
      getRuntimeInfo: () => ({ version: "0.test" }),
      readRuntimeCapabilities: async () => ({
        diagnostics: { state: "unavailable", value: null },
        requirements: { state: "unsupported", value: null },
        provider: { state: "unavailable", value: null }
      }),
      readAccountStatus: async () => ({ email: null, plan: null }),
      readCodexConfigSnapshot: async () => ({
        model: "gpt-config",
        modelProvider: "codex-lb",
        reasoningEffort: "low"
      }),
      readRateLimitsStatus: async () => ({
        byLimitId: {},
        limitId: "codex",
        limitName: "Codex",
        planType: null,
        primary: {
          label: "weekly",
          leftPercent: 87,
          resetsAt: null,
          usedPercent: null,
          windowDurationMins: 10080
        },
        resetCreditsAvailable: null,
        secondary: null
      }),
      readThreadStatus: async () => ({
        approvalPolicy: "on-request",
        contextLeftPercent: null,
        contextMaxTokens: null,
        contextUsedTokens: null,
        cwd: "/workspace/project",
        model: "gpt-test",
        modelProvider: "openai",
        reasoningEffort: "medium",
        sandboxMode: "workspace-write",
        serviceTier: null,
        threadId: "thread-status",
        threadName: "status test"
      })
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-status",
      pathKey: rolloutPath,
      currentCwd: "/workspace/project",
      displayName: "status test",
      latestActivityAt: Date.now()
    });
    await store.setActiveSession("chat-1", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const statusMessage = await service.statusActiveSessionMessage("chat-1");
    const status = renderLegacyMessage(statusMessage);

    assert.match(statusMessage.title, /^Codex status · /);
    assert.equal(statusMessage.body[0]?.type, "markdown");
    assert.deepEqual(statusMessage.actions.map((action) => action.id), ["status-full", "help"]);
    assert.equal(statusMessage.actions[0]?.callback, "status:view:full");
    assert.match(status, /^Codex status · /);
    assert.match(status, /\*\*Provider\*\*/);
    assert.match(status, /\*\*Config\*\* codex-lb/);
    assert.match(status, /\*\*Thread\*\* openai/);
    assert.match(status, /\*\*Model\*\* gpt-test/);
    assert.match(status, /\*\*Model\*\* gpt-config/);
    assert.match(status, /\*\*Reasoning\*\* low/);
    assert.match(status, /\*\*Managed policy\*\* unsupported/);
    assert.match(status, /\*\*Configured provider capabilities\*\* unavailable/);
    assert.match(status, /\*\*Limits\*\*/);
    assert.match(status, /\*\*weekly\*\* 87% left/);
    assert.doesNotMatch(status, /Limits:/);
    assert.doesNotMatch(status, /Provider:/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("full status separates MCP server status from model-visible tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-tools-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const rolloutPath = join(directory, "rollout.jsonl");
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "thread-tools-status",
        cwd: "/workspace/project",
        model_provider: "codex-lb"
      }
    })}\n`
  );
  const store = new BridgeStore(databasePath);
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      getRuntimeInfo: () => ({ version: "0.test" }),
      readRuntimeCapabilities: async () => ({
        diagnostics: { state: "available", value: { processId: 123, residentMemoryBytes: 1024 * 1024, physicalFootprintBytes: null, gauges: [{ name: "active_threads", value: 1 }] } },
        requirements: { state: "available", value: { configured: true, modelProvider: "managed", allowedApprovalPolicies: ["on-request"], allowedApprovalsReviewers: null, allowedSandboxModes: ["workspace-write"], allowedWebSearchModes: [], featureRequirements: { web_search: false } } },
        provider: { state: "available", value: { imageGeneration: false, webSearch: true } }
      }),
      readAccountStatus: async () => ({ email: null, plan: null }),
      readAccountUsageStatus: async () => null,
      readLoadedThreadsStatus: async () => ({ total: 1, activeLoaded: true }),
      readMcpServerStatus: async () => ({
        total: 3,
        running: 2,
        failed: 1,
        unknown: 0,
        error: null,
        servers: [
          { name: "serena", status: "running", toolCount: 25 },
          { name: "playwright", status: "running", toolCount: 24 },
          { name: "notion", status: "failed", toolCount: 8 }
        ]
      }),
      readModelCatalog: async () => null,
      readProviderConfiguration: async () => ({
        provider: "openai",
        source: "system default"
      }),
      readRateLimitsStatus: async () => ({
        byLimitId: {},
        limitId: "codex",
        limitName: "Codex",
        planType: null,
        primary: null,
        resetCreditsAvailable: null,
        secondary: null
      }),
      readSkillsCatalog: async () => null,
      readThreadStatus: async () => ({
        approvalPolicy: "on-request",
        contextLeftPercent: null,
        contextMaxTokens: null,
        contextUsedTokens: null,
        cwd: "/workspace/project",
        model: "gpt-test",
        modelProvider: "codex-lb",
        reasoningEffort: "medium",
        sandboxMode: "workspace-write",
        serviceTier: null,
        threadId: "thread-tools-status",
        threadName: "tools status"
      }),
      readWorkspaceMessagesStatus: async () => null
    } as unknown as CodexAppServerClient
  );

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-tools-status",
      pathKey: rolloutPath,
      currentCwd: "/workspace/project",
      displayName: "tools status",
      latestActivityAt: Date.now()
    });
    await store.setActiveSession("chat-1", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const statusMessage = await service.statusActiveSessionMessage("chat-1", true);
    const status = renderLegacyMessage(statusMessage);

    assert.match(statusMessage.title, /^Codex status · /);
    assert.equal(statusMessage.body[0]?.type, "markdown");
    assert.deepEqual(statusMessage.actions.map((action) => action.id), ["status", "help"]);
    assert.equal(statusMessage.actions[0]?.callback, "status:view:basic");
    assert.match(status, /\*\*Tools\*\*/);
    assert.match(status, /\*\*MCP servers\*\* 2\/3 running, 1 failed/);
    assert.match(status, /\*\*MCP startup\*\* 2\/3 ready, 1 failed \(notion\)/);
    assert.match(status, /\*\*MCP tools\*\* 57 listed \(serena 25, playwright 24, notion 8\)/);
    assert.match(status, /\*\*Model tool calls\*\* requires probe for 0.test/);
    assert.match(status, /\*\*Configured provider capabilities\*\* Image generation: not supported · Web search: supported/);
    assert.match(status, /\*\*Allowed Web search\*\* none allowed/);
    assert.match(status, /\*\*Required features\*\* web_search: disabled/);
    assert.match(status, /\*\*Resident memory\*\* 1.0 MiB/);
    assert.match(status, /\*\*active_threads\*\* 1/);
    assert.doesNotMatch(status, /\*\*MCP\*\*/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("working status renders with a session header", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-working-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sentMessages: string[] = [];
  const sentCallbacks: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text, options) => {
      sentMessages.push(text);
      for (const action of options?.messageSpec?.actions ?? []) {
        sentCallbacks.push(action.callback);
      }
      return { message_id: String(sentMessages.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-working",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "working test",
      latestActivityAt: Date.now()
    });

    await (
      service as unknown as {
        applyStatusUpdate: (
          session: unknown,
          update: {
            kind: string;
            threadId: string;
            label: string | null;
            detail: string | null;
            detailMode: string | null;
          }
        ) => Promise<void>;
      }
    ).applyStatusUpdate(session, {
      kind: "update",
      threadId: "thread-working",
      label: "Working",
      detail: null,
      detailMode: null
    });

    assert.match(sentMessages[0] ?? "", /^Codex · \/workspace\/project\nWorking · Working · \d+s$/);
    assert.doesNotMatch(sentMessages[0] ?? "", /Model:/);
    assert.doesNotMatch(sentMessages[0] ?? "", /\/interrupt/);
    assert.deepEqual(sentCallbacks, ["quick:queue", "quick:interrupt"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("working status is finalized with elapsed time instead of deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-working-final-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sentMessages: string[] = [];
  const edits: Array<{ messageId: string; text: string; options?: BridgeMessageOptions }> = [];
  const deletes: Array<{ chatId: string; messageId: string }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sentMessages.push(text);
      return { message_id: String(sentMessages.length) };
    },
    editMessageText: async (_chatId, messageId, text, options) => {
      edits.push({ messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      deletes.push({ chatId, messageId });
      return true;
    },
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-working",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "working test",
      latestActivityAt: Date.now()
    });

    const statusService = service as unknown as {
      applyStatusUpdate(
        session: unknown,
        update: {
          kind: string;
          threadId: string;
          label: string | null;
          detail: string | null;
          detailMode: string | null;
        }
      ): Promise<void>;
    };
    await statusService.applyStatusUpdate(session, {
      kind: "update",
      threadId: "thread-working",
      label: "Thinking",
      detail: null,
      detailMode: null
    });
    await statusService.applyStatusUpdate(session, {
      kind: "clear",
      threadId: "thread-working",
      label: null,
      detail: null,
      detailMode: null
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.messageId, "1");
    assert.match(edits[0]?.text ?? "", /^Codex · \/workspace\/project\nWorking · Done · \d+s$/);
    assert.deepEqual(edits[0]?.options?.messageSpec?.actions, []);
    assert.deepEqual(deletes, []);

    await statusService.applyStatusUpdate(session, {
      kind: "update",
      threadId: "thread-working",
      label: "Thinking",
      detail: null,
      detailMode: null
    });
    assert.equal(sentMessages.length, 2);
    assert.equal(edits.length, 1);
    assert.match(sentMessages[1] ?? "", /^Codex · \/workspace\/project\nWorking · Thinking · \d+s$/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("working status leaves Slack interrupt rendering to Slack transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-working-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sentOptions: BridgeMessageOptions[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "slack-test",
    canHandle: (chatId) => chatId.startsWith("slack:"),
    sendMessage: async (_chatId, _text, options) => {
      sentOptions.push(options ?? {});
      return { message_id: String(sentOptions.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:D123:111.222",
      codexThreadId: "thread-slack-working",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "slack working",
      latestActivityAt: Date.now()
    });

    await (
      service as unknown as {
        applyStatusUpdate: (
          session: unknown,
          update: {
            kind: string;
            threadId: string;
            label: string | null;
            detail: string | null;
            detailMode: string | null;
          }
        ) => Promise<void>;
      }
    ).applyStatusUpdate(session, {
      kind: "update",
      threadId: "thread-slack-working",
      label: "Thinking",
      detail: null,
      detailMode: null
    });

    assert.equal(sentOptions[0]?.reply_markup, undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retrying backend errors update the working status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-recovering-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sentMessages: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sentMessages.push(text);
      return { message_id: String(sentMessages.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-recovering",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });

    await (service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    }).handleAppServerNotification({
      method: "error",
      params: {
        threadId: "thread-recovering",
        msg: "Reconnecting... 1/5",
        willRetry: true
      }
    });

    assert.match(sentMessages[0] ?? "", /^Codex · \/workspace\/project\nWorking · Recovering · \d+s\nIssue · Reconnecting 1\/5$/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal backend errors finalize status and restore actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-terminal-error-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ text: string; options?: BridgeMessageOptions }> = [];
  const edits: Array<{ text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text, options) => {
      sends.push({ text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async (_chatId, _messageId, text, options) => {
      edits.push({ text, options });
      return true;
    },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-terminal-error",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    const internal = service as unknown as {
      bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> };
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    internal.bridgeRuntimeState.inFlightTurnIdByThread.set("thread-terminal-error", "turn-1");

    await internal.handleAppServerNotification({
      method: "error",
      params: {
        threadId: "thread-terminal-error",
        msg: "stream disconnected before completion: Upstream websocket closed before response.completed"
      }
    });
    await internal.handleAppServerNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-terminal-error",
        turn: { id: "turn-1", status: "failed" }
      }
    });
    await sleep(550);

    assert.equal(internal.bridgeRuntimeState.inFlightTurnIdByThread.has("thread-terminal-error"), false);
    const error = sends.find((item) => item.text.includes("Codex error"));
    assert.match(error?.text ?? "", /stream disconnected before completion/);
    assert.deepEqual(error?.options?.messageSpec?.actions.map((action) => action.id), ["bot-connect", "help"]);
    assert.match(edits.at(-1)?.text ?? "", /Working · Done/);
    assert.deepEqual(edits.at(-1)?.options?.messageSpec?.actions, []);
    const actions = sends.find((item) => item.text.startsWith("Actions · "));
    assert.ok(actions);
    assert.deepEqual(
      actions?.options?.messageSpec?.actions.map((action) => action.label),
      ["Go", "Next", "Help"]
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolved single decisions retain a terminal original message without actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-decision-clear-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const edits: Array<{ chatId: string; messageId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      resolveApproval: async () => undefined
    } as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async () => null,
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-decision",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    const decision = await store.createOrReplacePendingDecision({
      sessionId: session.id,
      telegramChatId: "chat-1",
      approvalId: "approval-1",
      kind: "item/commandExecution/requestApproval",
      title: "Run command",
      summary: "command: yarn lint",
      requiresUserInput: false
    });
    await store.attachDecisionMessage(decision.id, "42");

    const result = await service.handleDecision(decision.id, "accept");
    assert.equal(result.ok, true);
    assert.equal(edits.length, 1);
    assert.equal(edits[0]?.chatId, "chat-1");
    assert.equal(edits[0]?.messageId, "42");
    assert.match(edits[0]?.text ?? "", /^Approved · \/workspace\/project/);
    assert.match(edits[0]?.text ?? "", /Status: Approved/);
    assert.deepEqual(
      {
        title: edits[0]?.options?.messageSpec?.title,
        firstBodyPart: edits[0]?.options?.messageSpec?.body[0],
        actions: edits[0]?.options?.messageSpec?.actions.map((action) => action.id)
      },
      {
        title: "Approved · /workspace/project",
        firstBodyPart: { type: "code", text: "yarn lint" },
        actions: []
      }
    );
    assert.equal(edits[0]?.options?.reply_markup, undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP input prompts use the session message spec", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-mcp-input-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    { resolveApproval: async () => undefined } as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return null;
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-mcp",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    const decision = await store.createOrReplacePendingDecision({
      sessionId: session.id,
      telegramChatId: "chat-1",
      approvalId: "approval-mcp",
      kind: "mcpServer/elicitation/request",
      title: 'MCP tool "write_memory" requests input',
      summary: "fields: memory_name, content",
      requiresUserInput: true
    });

    const result = await service.handleDecision(decision.id, "accept");

    assert.equal(result.ok, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.options?.messageSpec?.title, "MCP Input Required · /workspace/project");
    assert.deepEqual(sends[0]?.options?.messageSpec?.actions.map((action) => action.id), ["help"]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("adjacent called progress becomes a retained completion summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-progress-message-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const edits: Array<{ chatId: string; messageId: string; text: string; options?: BridgeMessageOptions }> = [];
  const deletes: Array<{ chatId: string; messageId: string }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      deletes.push({ chatId, messageId });
      return true;
    },
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-progress",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    const existingAssistant = await store.addMessage({
      sessionId: session.id,
      role: "assistant",
      text: "done"
    });
    const notificationService = service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    };

    await notificationService.handleAppServerNotification({
      method: "turn/started",
      params: { threadId: "thread-progress", turn: { id: "turn-progress", status: "inProgress" } }
    });

    await notificationService.handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-progress",
        item: {
          type: "mcp",
          toolName: "mcp__notion__search",
          input: { query: "sessions" },
          output: "searching"
        }
      }
    });
    await notificationService.handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-progress",
        item: {
          type: "mcp",
          toolName: "mcp__notion__fetch",
          input: { id: "page" },
          output: "fetching"
        }
      }
    });
    await notificationService.handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-progress",
        item: {
          type: "agentMessage",
          text: existingAssistant.text
        }
      }
    });

    assert.ok(sends.length >= 1);
    assert.ok(edits.some((entry) =>
      entry.messageId === "2" &&
      /^Called · .+\nnotion\.search ×1 → notion\.fetch ×1$/.test(entry.text)
    ));
    assert.deepEqual(deletes, []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("late progress and terminal events from an old turn do not alter the newer turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-progress-turn-boundary-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const edits: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async (_chatId, _messageId, text) => {
      edits.push(text);
      return true;
    },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-progress",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    const notificationService = service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    };

    await notificationService.handleAppServerNotification({
      method: "turn/started",
      params: { threadId: "thread-progress", turn: { id: "turn-1", status: "inProgress" } }
    });
    await notificationService.handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-progress",
        turnId: "turn-1",
        item: { type: "mcp", toolName: "mcp__notion__search", input: { query: "old" }, output: "old" }
      }
    });
    const firstPhase = store.getActiveProgressPhaseMessage("thread-progress", "turn-1");
    assert.ok(firstPhase);

    await notificationService.handleAppServerNotification({
      method: "turn/started",
      params: { threadId: "thread-progress", turn: { id: "turn-2", status: "inProgress" } }
    });
    await notificationService.handleAppServerNotification({
      method: "turn/completed",
      params: { threadId: "thread-progress", turn: { id: "turn-1", status: "completed" } }
    });
    await notificationService.handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-progress",
        turnId: "turn-1",
        item: { type: "mcp", toolName: "mcp__notion__fetch", input: { id: "old" }, output: "old" }
      }
    });
    await notificationService.handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-progress",
        turnId: "turn-2",
        item: { type: "mcp", toolName: "mcp__notion__fetch", input: { id: "new" }, output: "new" }
      }
    });

    assert.equal(store.getProgressPhaseMessage(firstPhase.id)?.state, "interrupted");
    assert.equal(store.getActiveTurnRoute("thread-progress")?.turnId, "turn-2");
    const activePhase = store.getActiveProgressPhaseMessage("thread-progress", "turn-2");
    assert.deepEqual(activePhase?.aggregate.operations, [{ name: "notion.fetch", count: 1 }]);
    assert.equal(store.getActiveProgressPhaseMessage("thread-progress", "turn-1"), null);
    assert.ok(edits.some((text) => /^Called · .+\nInterrupted/.test(text)));
    assert.ok(edits.every((text) => !/Working · Done/.test(text)));
    assert.equal(sends.filter((text) => /notion\.fetch\nkeys=id/.test(text)).length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("different progress types preserve ordered phase summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-called-run-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const edits: Array<{ chatId: string; messageId: string; text: string; options?: BridgeMessageOptions }> = [];
  const deletes: Array<{ chatId: string; messageId: string }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      deletes.push({ chatId, messageId });
      return true;
    },
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-progress",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    (service as unknown as { bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> } })
      .bridgeRuntimeState.inFlightTurnIdByThread.set("thread-progress", "turn-progress");
    const progressService = service as unknown as {
      sendProgressMessage(
        session: unknown,
        event: import("../src/bridge/progress/normalizer.js").ProgressNotificationEvent
      ): Promise<void>;
    };

    await progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Called",
      toolName: "mcp__notion__search",
      action: null,
      target: null,
      input: "query=sessions",
      changes: null,
      failed: false,
      text: "searching"
    });
    await progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Edited",
      toolName: null,
      action: null,
      target: null,
      input: null,
      changes: [{ path: "/workspace/project/src/a.ts", type: "update", added: 1, removed: 0, lineStatsAvailable: true }],
      itemId: "edit-a",
      completed: true,
      failed: false,
      text: "edited"
    });
    await progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Called",
      toolName: "mcp__notion__fetch",
      action: null,
      target: null,
      input: "id=page",
      changes: null,
      failed: false,
      text: "fetching"
    });

    assert.equal(sends.length, 3);
    assert.match(sends[0]?.text ?? "", /^Called · .*project\nnotion\.search/m);
    assert.equal(edits.length, 2);
    assert.match(edits[0]?.text ?? "", /^Called · .*project\nnotion\.search ×1$/m);
    assert.doesNotMatch(edits[0]?.text ?? "", /query=sessions/);
    assert.match(edits[1]?.text ?? "", /^Edited · .*project\nsrc\/a.ts \(\+1 -0\)$/m);
    assert.match(sends[1]?.text ?? "", /^Edited · .*project/);
    assert.match(sends[2]?.text ?? "", /^Called · .*project\nnotion\.fetch/m);
    assert.deepEqual(deletes, []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("continuous Run activity updates one card in arrival order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-progress-coalesce-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const edits: Array<{ chatId: string; messageId: string; text: string; options?: BridgeMessageOptions }> = [];
  let releaseFirstSend!: () => void;
  let sendStarted!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => { sendStarted = resolve; });
  const firstSendReleased = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      if (sends.length === 1) {
        sendStarted();
        await firstSendReleased;
      }
      return { message_id: String(sends.length) };
    },
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-progress",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    (service as unknown as { bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> } })
      .bridgeRuntimeState.inFlightTurnIdByThread.set("thread-progress", "turn-progress");
    const progressService = service as unknown as {
      sendProgressMessage(session: unknown, event: {
        threadId: string;
        label: string;
        toolName: string | null;
        action: string | null;
        target: string | null;
        input: string | null;
        changes: Array<{ path: string; added: number; removed: number }> | null;
        failed: boolean;
        text: string;
      }): Promise<void>;
    };

    const first = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Run",
      toolName: "pwd",
      action: "run",
      target: null,
      input: null,
      changes: null,
      failed: false,
      text: "running"
    });
    await firstSendStarted;
    const second = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Run",
      toolName: "yarn test",
      action: "run",
      target: null,
      input: null,
      changes: null,
      failed: false,
      text: "testing"
    });
    const third = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Run",
      toolName: "yarn lint",
      action: "run",
      target: null,
      input: null,
      changes: null,
      failed: false,
      text: "linting"
    });

    assert.equal(sends.length, 1);
    releaseFirstSend();
    await Promise.all([first, second, third]);

    assert.equal(sends.length, 1);
    assert.equal(edits.length, 2);
    assert.match(edits[0]?.text ?? "", /yarn test/);
    assert.match(edits[1]?.text ?? "", /yarn lint/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing a Run phase during a send keeps its phase summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-progress-close-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const edits: string[] = [];
  const deletes: string[] = [];
  let releaseSend!: () => void;
  let sendStarted!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => { sendStarted = resolve; });
  const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      sendStarted();
      await sendReleased;
      return { message_id: "1" };
    },
    editMessageText: async (_chatId, _messageId, text) => {
      edits.push(text);
      return true;
    },
    deleteMessage: async (_chatId, messageId) => {
      deletes.push(messageId);
      return true;
    },
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-progress",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    (service as unknown as { bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> } })
      .bridgeRuntimeState.inFlightTurnIdByThread.set("thread-progress", "turn-progress");
    const progressService = service as unknown as {
      sendProgressMessage(session: unknown, event: {
        threadId: string;
        label: string;
        toolName: string | null;
        action: string | null;
        target: string | null;
        input: string | null;
        changes: Array<{ path: string; added: number; removed: number }> | null;
        failed: boolean;
        text: string;
      }): Promise<void>;
      clearProgressMessageForThread(threadId: string): Promise<void>;
    };

    const first = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Run",
      toolName: "pwd",
      action: "run",
      target: null,
      input: null,
      changes: null,
      failed: false,
      text: "running"
    });
    await firstSendStarted;
    const latest = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Run",
      toolName: "yarn test",
      action: "run",
      target: null,
      input: null,
      changes: null,
      failed: false,
      text: "testing"
    });
    const clearing = progressService.clearProgressMessageForThread("thread-progress");
    releaseSend();
    await Promise.all([first, latest, clearing]);

    assert.equal(sends.length, 1);
    assert.match(edits.at(-1) ?? "", /^Run · .*project\nRun ×\d+ · Reported successes ×\d+ · Reported failures ×\d+$/);
    assert.deepEqual(deletes, []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("continuous Edited activity updates the existing phase card", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-edited-rate-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const edits: Array<{ chatId: string; messageId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  (service as unknown as { bridgeRuntimeState: { editedProgressMinIntervalMs: number } })
    .bridgeRuntimeState.editedProgressMinIntervalMs = 30;
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-progress",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    (service as unknown as { bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> } })
      .bridgeRuntimeState.inFlightTurnIdByThread.set("thread-progress", "turn-progress");
    const progressService = service as unknown as {
      sendProgressMessage(
        session: unknown,
        event: {
          threadId: string;
          label: string;
          toolName: string | null;
          action: string | null;
          target: string | null;
          input: string | null;
          changes: Array<{ path: string; added: number; removed: number }> | null;
          failed: boolean;
          text: string;
          completed?: boolean;
        }
      ): Promise<void>;
    };

    await progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Edited",
      toolName: null,
      action: null,
      target: null,
      input: null,
      changes: [{ path: "/workspace/project/src/a.ts", added: 1, removed: 0 }],
      failed: false,
      text: "edited a"
    });
    const second = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Edited",
      toolName: null,
      action: null,
      target: null,
      input: null,
      changes: [{ path: "/workspace/project/src/b.ts", added: 2, removed: 0 }],
      failed: false,
      text: "edited b"
    });
    const third = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Edited",
      toolName: null,
      action: null,
      target: null,
      input: null,
      changes: [{ path: "/workspace/project/src/c.ts", added: 3, removed: 1 }],
      failed: false,
      text: "edited c"
    });

    assert.equal(sends.length, 1);
    assert.match(sends[0]?.text ?? "", /^Edited · .*project/);
    assert.match(sends[0]?.text ?? "", /src\/a\.ts/);
    await Promise.all([second, third]);

    assert.equal(sends.length, 1);
    assert.equal(edits.length, 2);
    assert.equal(edits[0]?.messageId, "1");
    assert.match(edits[0]?.text ?? "", /^Edited · .*project/);
    assert.match(edits[0]?.text ?? "", /src\/b\.ts/);
    assert.match(edits[1]?.text ?? "", /src\/c\.ts/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing an Edited phase retains its phase summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-edited-retain-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const edits: Array<{ chatId: string; messageId: string; text: string; options?: BridgeMessageOptions }> = [];
  const deletes: Array<{ chatId: string; messageId: string }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  (service as unknown as { bridgeRuntimeState: { editedProgressMinIntervalMs: number } })
    .bridgeRuntimeState.editedProgressMinIntervalMs = 10_000;
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async (chatId, messageId, text, options) => {
      edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      deletes.push({ chatId, messageId });
      return true;
    },
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-progress",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    (service as unknown as { bridgeRuntimeState: { inFlightTurnIdByThread: Map<string, string> } })
      .bridgeRuntimeState.inFlightTurnIdByThread.set("thread-progress", "turn-progress");
    const progressService = service as unknown as {
      sendProgressMessage(
        session: unknown,
        event: import("../src/bridge/progress/normalizer.js").ProgressNotificationEvent
      ): Promise<void>;
      clearProgressMessageForThread(threadId: string): Promise<void>;
    };

    await progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Edited",
      toolName: null,
      action: null,
      target: null,
      input: null,
      changes: [{ path: "/workspace/project/src/a.ts", type: "update", added: 1, removed: 0, lineStatsAvailable: true }],
      itemId: "edit-a",
      completed: true,
      failed: false,
      text: "edited a"
    });
    const pending = progressService.sendProgressMessage(session, {
      threadId: "thread-progress",
      label: "Edited",
      toolName: null,
      action: null,
      target: null,
      input: null,
      changes: [{ path: "/workspace/project/src/c.ts", type: "update", added: 3, removed: 1, lineStatsAvailable: true }],
      itemId: "edit-c",
      failed: false,
      text: "edited c",
      completed: true
    });
    await progressService.clearProgressMessageForThread("thread-progress");
    await pending;

    assert.equal(sends.length, 1);
    assert.equal(edits.length, 2);
    assert.match(edits.at(-1)?.text ?? "", /^Edited · .*project\nsrc\/a.ts \(\+1 -0\)\nsrc\/c.ts \(\+3 -1\)$/);
    assert.deepEqual(deletes, []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual compact returns a compact started event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-manual-compact-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const compactedThreads: string[] = [];
  const resumedThreads: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      resumeThread: async (threadId: string) => {
        resumedThreads.push(threadId);
        return { displayPath: null, messages: [] };
      },
      startCompactThread: async (threadId: string) => {
        compactedThreads.push(threadId);
      }
    } as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async () => ({ message_id: "1" }),
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    await store.setActiveSession("chat-1", session.id);

    const message = renderLegacyMessage(await service.compactActiveSessionMessage("chat-1"));

    assert.deepEqual(resumedThreads, ["thread-compact"]);
    assert.deepEqual(compactedThreads, ["thread-compact"]);
    assert.match(message, /^Compact started · \/workspace\/project/);
    assert.match(message, /\nTriggered by you$/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual compact restores an existing unloaded thread before compacting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-manual-compact-restore-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const calls: string[] = [];
  const resumes: Array<{ threadId: string; cwd: string | undefined }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      resumeThread: async (threadId: string, cwd?: string) => {
        resumes.push({ threadId, cwd });
        return { displayPath: null, messages: [] };
      },
      startCompactThread: async (threadId: string) => {
        calls.push(threadId);
      }
    } as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async () => ({ message_id: "1" }),
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    await store.setActiveSession("chat-1", session.id);

    const message = renderLegacyMessage(await service.compactActiveSessionMessage("chat-1"));

    assert.deepEqual(calls, ["thread-compact"]);
    assert.deepEqual(resumes, [{ threadId: "thread-compact", cwd: "/workspace/project" }]);
    assert.match(message, /^Compact started · \/workspace\/project/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual compact reports explicit failure when missing thread cannot be restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-compact-restore-fail-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const calls: string[] = [];
  const resumes: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      resumeThread: async (threadId: string) => {
        resumes.push(threadId);
        throw new Error("Thread not found");
      },
      startCompactThread: async (threadId: string) => {
        calls.push(threadId);
        throw new Error("Should not be called");
      }
    } as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async () => ({ message_id: "1" }),
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    await store.setActiveSession("chat-1", session.id);

    const message = renderLegacyMessage(await service.compactActiveSessionMessage("chat-1"));

    assert.deepEqual(calls, []);
    assert.deepEqual(resumes, ["thread-compact"]);
    assert.match(message, /Compact failed\.\nThread not found/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("thread compacted notification sends compact completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-compact-complete-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    await (service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    }).handleAppServerNotification({
      method: "thread/compacted",
      params: { threadId: "thread-compact" }
    });

    assert.match(sends.join("\n"), /Compact completed · \/workspace\/project/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("contextCompaction item/completed notification sends compact completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-compact-complete-context-item-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    await (service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    }).handleAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "thread-compact",
        item: {
          type: "contextCompaction",
          id: "compact-item"
        }
      }
    });

    assert.match(sends.join("\n"), /Compact completed · \/workspace\/project/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("contextCompaction item lifecycle sends compact started before completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-compact-context-lifecycle-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    const handleNotification = (notification: unknown) => (service as unknown as {
      handleAppServerNotification(value: unknown): Promise<void>;
    }).handleAppServerNotification(notification);

    await handleNotification({
      method: "item/started",
      params: {
        threadId: "thread-compact",
        item: { type: "contextCompaction", id: "compact-item" }
      }
    });
    await handleNotification({
      method: "item/completed",
      params: {
        threadId: "thread-compact",
        item: { type: "contextCompaction", id: "compact-item" }
      }
    });

    const compactEvents = sends.filter((text) => text.startsWith("Compact "));
    assert.equal(compactEvents.length, 2);
    assert.match(compactEvents[0] ?? "", /^Compact started · \/workspace\/project/);
    assert.match(compactEvents[1] ?? "", /^Compact completed · \/workspace\/project/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("contextCompaction item/completed with item.threadId routes compact completed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-compact-complete-context-item-inner-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    await (service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    }).handleAppServerNotification({
      method: "item/completed",
      params: {
        item: {
          type: "contextCompaction",
          id: "compact-item",
          threadId: "thread-compact"
        }
      }
    });

    assert.match(sends.join("\n"), /Compact completed · \/workspace\/project/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual compact completion finalizes working status to Done", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-compact-finalize-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const edits: Array<{ messageId: string; text: string; options?: BridgeMessageOptions["messageSpec"] }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async (_chatId, messageId, text, options) => {
      edits.push({ messageId, text, options });
      return true;
    },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    const statusService = service as unknown as {
      applyStatusUpdate(
        session: unknown,
        update: {
          kind: string;
          threadId: string;
          label: string | null;
          detail: string | null;
          detailMode: string | null;
        }
      ): Promise<void>;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };

    await statusService.applyStatusUpdate(session, {
      kind: "update",
      threadId: "thread-compact",
      label: "Compacting",
      detail: null,
      detailMode: null
    });

    await statusService.handleAppServerNotification({
      method: "thread/compacted",
      params: { threadId: "thread-compact" }
    });

    assert.match(sends.join("\n"), /Compact completed · \/workspace\/project/);
    assert.match(edits.at(-1)?.text ?? "", /Working · Done · \d+s/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("auto-compact recovery completion does not clear status via compacted event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-auto-compact-finalize-status-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const edits: string[] = [];
  const turns: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      sendTurn: async (_threadId: string, text: string) => {
        turns.push(text);
        return { turnId: null };
      }
    } as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async (_chatId, messageId, text) => {
      edits.push(text);
      return true;
    },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    const autoService = service as unknown as {
      bridgeRuntimeState: { lastUserInputBySession: Map<string, string> };
      handleIncompatibleHistoryError(session: unknown, errorMessage: string): Promise<void>;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };

    autoService.bridgeRuntimeState.lastUserInputBySession.set(session.id, "retry me");
    await autoService.handleIncompatibleHistoryError(session, "incompatible history");
    await autoService.handleAppServerNotification({
      method: "thread/compacted",
      params: { threadId: "thread-compact" }
    });

    assert.match(turns.join("|"), /compact|retry me/);
    assert.match(sends.join("\n"), /Compact completed · \/workspace\/project/);
    assert.equal(
      edits.filter((text) => /Working · Done/.test(text)).length,
      0
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime compacting status emits one compact started event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-runtime-compact-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    const statusService = service as unknown as {
      applyStatusUpdate(session: unknown, update: {
        kind: string;
        threadId: string;
        label: string | null;
        detail: string | null;
        detailMode: string | null;
      }): Promise<void>;
    };

    await statusService.applyStatusUpdate(session, {
      kind: "update",
      threadId: "thread-compact",
      label: "Compacting",
      detail: null,
      detailMode: null
    });
    await statusService.applyStatusUpdate(session, {
      kind: "update",
      threadId: "thread-compact",
      label: "Compacting",
      detail: null,
      detailMode: null
    });

    assert.equal(sends.filter((text) => text.startsWith("Compact started ·")).length, 1);
    assert.match(sends.join("\n"), /Triggered by Codex/);
    assert.doesNotMatch(sends.join("\n"), /Source:/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge auto compact completion includes retry next step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-auto-compact-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: string[] = [];
  const turns: string[] = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {
      sendTurn: async (_threadId: string, text: string) => {
        turns.push(text);
        return { turnId: null };
      }
    } as unknown as CodexAppServerClient
  );
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-compact",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "compact test"
    });
    const autoService = service as unknown as {
      bridgeRuntimeState: { lastUserInputBySession: Map<string, string> };
      handleIncompatibleHistoryError(session: unknown, errorMessage: string): Promise<void>;
      handleRecoveryTaskComplete(session: unknown): Promise<boolean>;
    };
    autoService.bridgeRuntimeState.lastUserInputBySession.set(session.id, "retry me");

    await autoService.handleIncompatibleHistoryError(session, "incompatible history");
    const recoveryContinues = await autoService.handleRecoveryTaskComplete(session);

    assert.equal(recoveryContinues, true);
    assert.deepEqual(turns, ["compact", "retry me"]);
    assert.match(sends.join("\n"), /Compact started · \/workspace\/project/);
    assert.match(sends.join("\n"), /Reason: incompatible history/);
    assert.match(sends.join("\n"), /Triggered by Bridge/);
    assert.match(sends.join("\n"), /Compact completed · \/workspace\/project\nNext: Retrying last message/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates a same-directory session and switches the active session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-new-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const codexClient = {
    startThread: async (cwd: string) => {
      assert.equal(cwd, directory);
      return { threadId: "thread-new" };
    }
  };
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    codexClient as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const active = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-active",
      pathKey: directory,
      currentCwd: directory,
      displayName: "active session"
    });
    await store.setActiveSession("chat-1", active.id);

    const message = renderLegacyMessage(await service.requestCreateSessionForCurrentDirectory("chat-1"));
    const stillActive = await store.getActiveSession("chat-1");
    const sessions = await store.listKnownSessions("chat-1");
    const created = sessions.find((session) => session.codexThreadId === "thread-new");

    assert.equal(stillActive?.id, created?.id);
    assert.notEqual(stillActive?.id, active.id);
    assert.ok(created);
    assert.match(created?.displayName ?? "", /codex-bridge-session-new-test-/);
    assert.match(created?.displayName ?? "", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(message, /^Session created · /);
    assert.match(message, /^Path: /m);
    assert.match(message, /Switched to the new active session/);
    assert.doesNotMatch(message, /Not switched/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session creation follows Codex configuration without a provider picker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-provider-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  let startedProvider: string | null | undefined;
  const codexClient = {
    startThread: async (
      cwd: string,
      _permissionMode?: unknown,
      _model?: unknown,
      modelProvider?: string | null
    ) => {
      assert.equal(cwd, directory);
      startedProvider = modelProvider;
      return { threadId: "thread-provider-new" };
    }
  };
  const config = {
    ...testConfig(databasePath),
    codexAppServerArgs: [
      "app-server",
      "-c",
      "model_providers.codex-lb.base_url=\"http://127.0.0.1:2455\""
    ]
  };
  const service = new BridgeService(
    config,
    store,
    codexClient as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const active = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-active",
      pathKey: directory,
      currentCwd: directory,
      displayName: "active session"
    });
    await store.setActiveSession("chat-1", active.id);

    const prompt = await service.requestCreateSessionForCurrentDirectory("chat-1");
    assert.match(renderLegacyMessage(prompt), /Session created/);
    assert.match(prompt.title ?? "", /^Session created · /);
    assert.deepEqual(prompt.actions.map((action) => action.id), ["help", "session"]);

    const message = renderLegacyMessage(prompt);
    assert.equal(startedProvider, undefined);
    assert.match(message, /^Session created · /);
    assert.doesNotMatch(message, /codex-lb/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not replace a missing session merely because its path key is its working directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-recreate-provider-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sentThreadIds: string[] = [];
  const codexClient = {
    sendTurn: async (threadId: string) => {
      sentThreadIds.push(threadId);
      if (threadId === "thread-stale") {
        throw new Error("thread not found: thread-stale");
      }
      return { turnId: "turn-recreated" };
    }
  };
  const service = new BridgeService(
    {
      ...testConfig(databasePath),
      codexAppServerArgs: [
        "app-server",
        "-c",
        "model_providers.codex-lb.base_url=\"http://127.0.0.1:2455\""
      ]
    },
    store,
    codexClient as unknown as CodexAppServerClient
  );
  (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

  try {
    const stale = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-stale",
      pathKey: directory,
      currentCwd: directory,
      displayName: "lb stale",
    });
    await store.setActiveSession("chat-1", stale.id);

    const result = await service.handleIncomingUserText({
      telegramChatId: "chat-1",
      telegramMessageId: "message-1",
      text: "hello"
    });

    const active = await store.getActiveSession("chat-1");
    assert.equal(result.routed, false);
    assert.match(renderLegacyMessage(result.prompt!), /No replacement session was created/);
    assert.deepEqual(sentThreadIds, ["thread-stale"]);
    assert.equal(active?.codexThreadId, "thread-stale");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
