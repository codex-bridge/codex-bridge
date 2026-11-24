import assert from "node:assert/strict";
import { setImmediate as nextEventLoop } from "node:timers/promises";
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

test("go shortcut sends actions on the next timer tick and clears the assistant marker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: Array<{ chatId: string; message: MessageSpec; disableNotification?: boolean }> = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastAssistant = new Map<string, LastAssistantMessage>([
    [session.codexThreadId, { chatId: session.telegramChatId, messageId: "message-1", text: "done" }]
  ]);
  const service = new GoShortcutService({
    store: {
      getSessionLease: () => null, getSessionBindingById: () => null,
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
    getSessionDirectory: (value) => value.currentCwd ?? value.pathKey
  });

  service.schedule(session);
  assert.equal(pending.has(session.codexThreadId), true);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  await nextEventLoop();

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

test("go shortcut cancels and suppresses actions while a decision is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: MessageSpec[] = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastAssistant = new Map<string, LastAssistantMessage>([
    [session.codexThreadId, { chatId: session.telegramChatId, messageId: "message-1", text: "done" }]
  ]);
  const service = new GoShortcutService({
    store: {
      getSessionLease: () => null, getSessionBindingById: () => null,
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
    getSessionDirectory: (value) => value.pathKey
  });

  service.schedule(session);
  service.cancel(session.codexThreadId);
  t.mock.timers.tick(1);
  await nextEventLoop();
  assert.equal(sent.length, 0);
  assert.equal(lastAssistant.has(session.codexThreadId), true);

  await service.flush(session);
  assert.equal(sent.length, 0);
  assert.equal(lastAssistant.has(session.codexThreadId), false);
});

test("new work cancels Actions even while a preceding reminder is being delivered", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;
  let started!: () => void;
  const sendingReminder = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastAssistant = new Map<string, LastAssistantMessage>();
  const sent: MessageSpec[] = [];
  const service = new GoShortcutService({
    store: { getSessionLease: () => null, getSessionBindingById: () => null,
      getActiveSession: async () => session, listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
    messageOperations: { sendMessageSpec: async (_source, message) => { sent.push(message); return null; } },
    pendingByThread: pending, lastAssistantMessageByThread: lastAssistant, getSessionDirectory: () => "/project",
    beforeActions: async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); }
  });
  service.schedule(session); t.mock.timers.tick(1);
  await sendingReminder;
  service.cancel(session.codexThreadId);
  lastAssistant.set(session.codexThreadId, { chatId: session.telegramChatId, messageId: "new-turn", text: "new output" });
  release(); await nextEventLoop();
  assert.deepEqual(sent, []);
  assert.equal(lastAssistant.get(session.codexThreadId)?.messageId, "new-turn");
});
