import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { GoShortcutService } from "../src/bridge/interactions/go-shortcut.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { LastAssistantMessage } from "../src/bridge/runtime-state.js";
import type { SessionRecord } from "../src/shared/types.js";

const session: SessionRecord = {
  id: "session-1",
  telegramChatId: "chat-1",
  codexThreadId: "thread-1",
  pathKey: "/workspace/project",
  currentCwd: "/workspace/project",
  displayName: "shortcut test",
  batchDecisionMessageId: null,
  codexArchivedAt: null,
  latestActivityAt: 0,
  createdAt: 0,
  discoveryMissingSince: null,
  discoveryMissingCount: 0,
  lastDiscoveredAt: 0
};

test("go shortcut sends delayed actions and clears the assistant marker", async () => {
  const sent: Array<{ chatId: string; message: MessageSpec; disableNotification?: boolean }> = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastAssistant = new Map<string, LastAssistantMessage>([
    [session.codexThreadId, { chatId: session.telegramChatId, messageId: "message-1", text: "done" }]
  ]);
  const service = new GoShortcutService({
    store: {
      listPendingDecisions: async () => [],
      getAwaitingInputDecisionForSession: async () => null,
      getActiveSession: async () => session
    },
    messageOperations: {
      sendMessageSpec: async (chatId, message, options) => {
        sent.push({ chatId, message, disableNotification: options?.disable_notification });
        return null;
      }
    },
    pendingByThread: pending,
    lastAssistantMessageByThread: lastAssistant,
    getSessionDirectory: (value) => value.currentCwd ?? value.pathKey,
    delayMs: 20
  });

  service.schedule(session);
  assert.equal(pending.has(session.codexThreadId), true);
  await sleep(5);
  assert.equal(sent.length, 0);
  await sleep(30);

  assert.equal(pending.has(session.codexThreadId), false);
  assert.equal(lastAssistant.has(session.codexThreadId), false);
  assert.deepEqual(sent, [
    {
      chatId: "chat-1",
      message: {
        kind: "actions",
        title: "Actions · /workspace/project",
        session: { id: "session-1", directory: "/workspace/project" },
        body: [],
        actions: [
          { id: "go", label: "Go", callback: "quick:go", execution: { type: "send-text", text: "go" } },
          { id: "next", label: "Next", callback: "quick:next", execution: { type: "send-text", text: "next" }, sameRowAsPrevious: true },
          { id: "help", label: "Help", callback: "quick:help",
            execution: { type: "session-tool", tool: "help" }, sameRowAsPrevious: true }
        ]
      },
      disableNotification: true
    }
  ]);
});

test("go shortcut cancels and suppresses actions while a decision is pending", async () => {
  const sent: MessageSpec[] = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastAssistant = new Map<string, LastAssistantMessage>([
    [session.codexThreadId, { chatId: session.telegramChatId, messageId: "message-1", text: "done" }]
  ]);
  const service = new GoShortcutService({
    store: {
      listPendingDecisions: async () => [{}] as never[],
      getAwaitingInputDecisionForSession: async () => null,
      getActiveSession: async () => session
    },
    messageOperations: {
      sendMessageSpec: async (_chatId, message) => {
        sent.push(message);
        return null;
      }
    },
    pendingByThread: pending,
    lastAssistantMessageByThread: lastAssistant,
    getSessionDirectory: (value) => value.pathKey,
    delayMs: 20
  });

  service.schedule(session);
  service.cancel(session.codexThreadId);
  await sleep(30);
  assert.equal(sent.length, 0);
  assert.equal(lastAssistant.has(session.codexThreadId), true);

  await service.flush(session);
  assert.equal(sent.length, 0);
  assert.equal(lastAssistant.has(session.codexThreadId), false);
});
