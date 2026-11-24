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

test("Actions keeps its body empty and carries only its controls", async () => {
  const sent: MessageSpec[] = [];
  const service = new GoShortcutService({
    store: { getSessionLease: () => null, getSessionBindingById: () => null,
      listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null, getActiveSession: async () => session },
    messageOperations: { sendMessageSpec: async (_source, spec) => { sent.push(spec); return null; } },
    lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/project"
  });
  await service.flush(session);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0]!.body, []);
  assert.match(sent[0]!.title, /Actions · .*project/); assert.equal(sent[0]!.actions.length, 3);
});

test("go shortcut sends actions on the next timer tick and clears the assistant marker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: Array<{ chatId: string; message: MessageSpec; disableNotification?: boolean }> = [];
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
    lastAssistantMessageByThread: lastAssistant,
    getSessionDirectory: (value) => value.currentCwd ?? value.pathKey
  });

  service.schedule(session);
    assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  await nextEventLoop();

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
  const lastAssistant = new Map<string, LastAssistantMessage>();
  const sent: MessageSpec[] = [];
  const service = new GoShortcutService({
    store: { getSessionLease: () => null, getSessionBindingById: () => null,
      getActiveSession: async () => session, listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
    messageOperations: { sendMessageSpec: async (_source, message) => { sent.push(message); return null; } },
    lastAssistantMessageByThread: lastAssistant, getSessionDirectory: () => "/project",
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


test("Actions are suppressed after ownership moves while a reminder is pending", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let owner = session.telegramChatId;
  let release!: () => void, ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const service = new GoShortcutService({
    store: { getActiveSession: async () => session,
      getSessionLease: () => ({ state: "active", ownerBindingId: "binding" }) as never,
      getSessionBindingById: () => ({ sourceId: owner }) as never,
      listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
    messageOperations: { sendMessageSpec: async () => { sends++; return null; } },
    lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/work",
    beforeActions: async () => { ready(); await blocked; }
  });
  const completion = service.schedule(session); t.mock.timers.tick(1); await started;
  owner = "other-topic"; release(); await completion;
  assert.equal(sends, 0);
});

for (const first of ["history", "completion"] as const) {
  test(`overlapping ${first}-first requests share one Actions send`, async () => {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let sends = 0;
    const service = new GoShortcutService({
      store: { getActiveSession: async () => session, getSessionLease: () => null, getSessionBindingById: () => null,
        listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
      messageOperations: { sendMessageSpec: async () => { sends++; return { message_id: "actions" }; } },
      lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/work",
      beforeActions: async () => { entered(); await blocked; }
    });
    const start = (kind: typeof first) => kind === "history" ? service.sendAfterTranscript(session, "chat-1")
      : service.schedule(session, { turnId: "turn" });
    const initial = start(first); await ready;
    const concurrent = start(first === "history" ? "completion" : "history");
    await nextEventLoop(); release();
    await Promise.all([initial, concurrent]);
    assert.equal(sends, 1);
    await service.sendAfterTranscript(session, "chat-1");
    assert.equal(sends, 2, "a later explicit history recovery still gets its own controls");
  });
}

test("cancellation during async eligibility lookup prevents the pending send", async () => {
  let release!: () => void, entered!: () => void, calls = 0, sends = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const service = new GoShortcutService({
    store: { getActiveSession: async () => session, getSessionLease: () => null, getSessionBindingById: () => null,
      listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => {
        if (++calls === 2) { entered(); await blocked; } return null;
      } },
    messageOperations: { sendMessageSpec: async () => { sends++; return null; } },
    lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/work"
  });
  const sending = service.flush(session); await ready;
  service.invalidate(session.codexThreadId); release(); await sending; await service.drain();
  assert.equal(sends, 0);
});
