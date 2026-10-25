import assert from "node:assert/strict";
import test from "node:test";

import { BridgeMessageFactory } from "../src/bridge/messages/factory.js";
import { BridgeService } from "../src/bridge/service.js";
import { IncomingPreflightService } from "../src/bridge/input/preflight.js";
import { CompactService } from "../src/bridge/sessions/compact-service.js";
import { SessionStopService } from "../src/bridge/sessions/stop.js";
import type { SessionOwnershipService } from "../src/bridge/sessions/ownership.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import { BridgeStore } from "../src/store/index.js";
import { testConfig } from "./bridge-test-config.js";

const disconnected = "Codex runtime is disconnected.\nUse /bot_connect to reconnect.";
const unexpected = (): never => { throw new Error("Unexpected Codex or lifecycle operation"); };
const client = {
  startThread: unexpected,
  startCompactThread: unexpected,
  interruptThread: unexpected,
  resumeThread: unexpected,
  readThread: unexpected,
  listThreads: unexpected,
  connect: unexpected
} as unknown as CodexAppServerClient;

for (const chatId of ["123", "slack:T1:C1", "slack:T1:C1:123.456"]) {
  test(`disconnected commands preserve the initiating selection for ${chatId}`, async () => {
    const store = new BridgeStore(":memory:");
    const service = new BridgeService(testConfig(":memory:"), store, client);
    try {
      const session = await store.upsertDiscoveredSession({
        telegramChatId: chatId, codexThreadId: "thread-current",
        pathKey: "/workspace/stale", currentCwd: "/workspace/current"
      });
      const other = await store.upsertDiscoveredSession({
        telegramChatId: "other-chat", codexThreadId: "thread-other", pathKey: "/workspace/other"
      });
      await store.setActiveSession(chatId, session.id);
      await store.setActiveSession("other-chat", other.id);
      store.claimSession(session.id, chatId);

      const incoming = await service.handleIncomingUserText({ telegramChatId: chatId, telegramMessageId: "input", text: "hello" });
      assert.ok(incoming.prompt);
      const replies = [
        incoming.prompt,
        await service.stopActiveSessionMessage(chatId),
        await service.compactActiveSessionMessage(chatId),
        await service.requestCreateSessionForCurrentDirectory(chatId),
        await service.requestCreateSessionFromDirectorySelector(chatId, "unknown-directory")
      ];
      for (const reply of replies) {
        assert.equal(reply.kind, "error");
        assert.equal(reply.title, "Codex error · /workspace/current");
        assert.equal(reply.session?.directory, "/workspace/current");
        assert.deepEqual(reply.body, [{ type: "text", text: disconnected }]);
      }
      assert.equal((await store.getActiveSession(chatId))?.id, session.id);
      assert.equal((await store.getActiveSession("other-chat"))?.id, other.id);
      assert.equal((await store.listKnownSessions(chatId)).length, 1);
    } finally {
      await service.shutdown();
      store.close();
    }
  });
}

test("disconnected commands without a selection do not borrow another conversation's directory", async () => {
  const store = new BridgeStore(":memory:");
  const service = new BridgeService(testConfig(":memory:"), store, client);
  try {
    const other = await store.upsertDiscoveredSession({
      telegramChatId: "other-chat", codexThreadId: "thread-other", pathKey: "/workspace/other"
    });
    await store.setActiveSession("other-chat", other.id);
    const incoming = await service.handleIncomingUserText({ telegramChatId: "empty-chat", telegramMessageId: "input", text: "hello" });
    assert.ok(incoming.prompt);
    const replies = [
      incoming.prompt,
      await service.stopActiveSessionMessage("empty-chat"),
      await service.compactActiveSessionMessage("empty-chat"),
      await service.requestCreateSessionForCurrentDirectory("empty-chat"),
      await service.requestCreateSessionFromDirectorySelector("empty-chat", "unknown-directory")
    ];
    for (const reply of replies) {
      assert.equal(reply.kind, "error");
      assert.equal(reply.session, undefined);
      assert.doesNotMatch(reply.title, / · /);
      assert.deepEqual(reply.body, [{ type: "text", text: disconnected }]);
    }
    assert.equal(await store.getActiveSession("empty-chat"), null);
  } finally {
    await service.shutdown();
    store.close();
  }
});

test("explicit-session stop and compact replies use their target without resolving navigation or mutating runtime", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "source", codexThreadId: "thread-explicit", pathKey: "/workspace/target"
    });
    const factory = new BridgeMessageFactory((value) => value.currentCwd ?? value.pathKey);
    const stop = new SessionStopService({
      store: { getActiveSession: unexpected } as unknown as BridgeStore,
      codexClient: client,
      inFlightTurnIdByThread: new Map(),
      sessionOwnershipService: { getSessionOwnershipPrompt: unexpected } as unknown as SessionOwnershipService,
      isRuntimeConnected: () => false,
      createSessionCommandResultSpec: factory.createSessionCommandResultSpec.bind(factory),
      clearTypingState: unexpected,
      setSessionStatus: unexpected
    });
    const compact = new CompactService({
      store: { getActiveSession: unexpected },
      codexClient: client,
      isRuntimeConnected: () => false,
      getLastUserInput: unexpected,
      getSessionDirectory: (value) => value.currentCwd ?? value.pathKey,
      formatCompactTokenCount: unexpected,
      isMissingRuntimeThreadError: unexpected,
      resumeThread: unexpected,
      rememberNotificationSession: unexpected,
      setSessionStatus: unexpected,
      sendSystemErrorMessage: unexpected,
      sendLongSpec: unexpected
    });
    for (const reply of [await stop.stopSession(session, "web"), await compact.compactSession(session)]) {
      assert.equal(reply.title, "Codex error · /workspace/target");
      assert.deepEqual(reply.body, [{ type: "text", text: disconnected }]);
    }
  } finally {
    store.close();
  }
});

test("session command factory preserves no-session labels and actions", () => {
  const factory = new BridgeMessageFactory(unexpected);
  for (const kind of ["system", "error"] as const) {
    assert.deepEqual(
      factory.createSessionCommandResultSpec(null, kind, "No selection"),
      factory.createCommandResultSpec(kind, "No selection")
    );
  }
});

test("an expired MCP form refers to its original session rather than the newly selected session", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const original = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "original", pathKey: "/work/original" });
    const selected = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "selected", pathKey: "/work/selected" });
    await store.setActiveSession("chat", selected.id);
    const decision = await store.createOrReplacePendingDecision({
      sessionId: original.id, telegramChatId: "chat", approvalId: "approval", kind: "mcpServer/elicitation/request",
      title: "Input", summary: "fields: value", requiresUserInput: true
    });
    await store.resolveDecision(decision.id, "awaitingInput");
    const preflight = new IncomingPreflightService({
      store, codexClient: client,
      sessionOwnershipService: { getSessionOwnershipPrompt: async () => null } as unknown as SessionOwnershipService,
      ensureChatAllowed: async () => {}, isRuntimeConnected: () => true,
      getActiveSession: (chat) => store.getActiveSession(chat), recoverSlackDmActiveSession: unexpected,
      getSessionDirectory: (value) => value.currentCwd ?? value.pathKey,
      createIncomingPromptSpec: unexpected, createMcpInputPromptSpec: unexpected, sendLongSpec: unexpected,
      syncBatchDecisionMessageForSessionId: unexpected, renderSessionMenu: unexpected
    });
    const result = await preflight.run({ telegramChatId: "chat", telegramMessageId: "input", text: "{}" });
    assert.equal(result.kind, "response");
    if (result.kind !== "response") assert.fail("The expired form must not start a turn");
    assert.equal(result.response.routed, false);
    assert.equal(result.response.prompt?.title, "MCP Input Required · /work/original");
    assert.equal(result.response.prompt?.session?.id, original.id);
    assert.equal((await store.getDecision(decision.id))?.state, "stale");
    assert.equal((await store.getActiveSession("chat"))?.id, selected.id);
  } finally { store.close(); }
});
