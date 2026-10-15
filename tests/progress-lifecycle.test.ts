import assert from "node:assert/strict";
import test from "node:test";

import { ProgressService } from "../src/bridge/progress/service.js";
import { NotificationDispatcher } from "../src/bridge/notifications/dispatcher.js";
import { appendPhaseEvent, emptyPhaseAggregate } from "../src/bridge/progress/lifecycle.js";
import { normalizeProgressEvent } from "../src/bridge/progress/normalizer.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { BridgeStore } from "../src/store/index.js";

function event(input: Partial<Parameters<ProgressService["sendProgressMessage"]>[1]> & { label: string }) {
  return {
    threadId: "thread-1",
    toolName: null,
    action: null,
    target: null,
    input: null,
    changes: null,
    failed: false,
    text: "observed",
    completed: true,
    ...input
  };
}

test("called aggregation preserves occurrence order and merges only adjacent tools", () => {
  const first = normalizeProgressEvent(event({ label: "Called", toolName: "mcp__notion__search" }));
  const second = normalizeProgressEvent(event({ label: "Called", toolName: "mcp__notion__search" }));
  const third = normalizeProgressEvent(event({ label: "Called", toolName: "mcp__serena__read_memory" }));
  const fourth = normalizeProgressEvent(event({ label: "Called", toolName: "mcp__notion__search" }));
  assert.ok(first && second && third && fourth);

  const aggregate = [first, second, third, fourth].reduce(appendPhaseEvent, emptyPhaseAggregate());
  assert.deepEqual(aggregate.operations, [
    { name: "notion.search", count: 2 },
    { name: "serena.read_memory", count: 1 },
    { name: "notion.search", count: 1 }
  ]);
});

test("called aggregation does not retain command-like tool names", () => {
  const normalized = normalizeProgressEvent(event({
    label: "Called",
    toolName: "/bin/zsh -lc 'print raw command'"
  }));
  assert.ok(normalized);
  assert.equal(normalized.operation, null);

  const aggregate = appendPhaseEvent(emptyPhaseAggregate(), normalized);
  assert.deepEqual(aggregate.operations, []);
});

test("upstream failure wording does not claim Bridge System ownership", () => {
  assert.equal(normalizeProgressEvent(event({ label: "Unknown", failed: true, text: "connection lost" })), null);
  assert.equal(normalizeProgressEvent(event({ label: "Run", failed: true, text: "connection lost" }))?.kind, "run");
});

test("only unexpected Bridge connection loss records an owned failure for an active route", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1", codexThreadId: "thread-1", pathKey: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    store.recordTurnRoute({
      turnId: "turn-1", sessionId: session.id, codexThreadId: "thread-1", bindingId: null, sourceId: "chat-1"
    });
    const recorded: string[] = [];
    const dispatcher = new NotificationDispatcher({
      store,
      sessionMenuSnapshots: { clear: () => {} },
      notificationTurnService: {} as never,
      notificationRecoveryService: {} as never,
      notificationMessageService: {} as never,
      notificationAuxiliaryService: {} as never,
      resolveNotificationSession: async () => session,
      sendProgressMessage: async () => {},
      recordBridgeConnectionFailure: async (_session, threadId, turnId) => {
        recorded.push(`${threadId}:${turnId}`);
        return true;
      }
    });
    await dispatcher.handle({ method: "bridge/connection/lost", params: { expected: true } });
    assert.deepEqual(recorded, []);
    await dispatcher.handle({ method: "bridge/connection/lost", params: { expected: false } });
    assert.deepEqual(recorded, ["thread-1:turn-1"]);
  } finally {
    store.close();
  }
});

test("a failed step freezes its Run phase and the next Run starts a fresh card", async () => {
  const store = new BridgeStore(":memory:");
  const sends: string[] = [];
  const edits: string[] = [];
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    const service = new ProgressService({
      getSessionDirectory: () => "/workspace/project",
      getInFlightTurnId: () => "turn-1",
      shouldSkipCalledProgress: () => false,
      getActiveProgressPhaseMessage: (threadId, turnId) => store.getActiveProgressPhaseMessage(threadId, turnId),
      getLatestProgressPhaseMessage: (threadId, turnId) => store.getLatestProgressPhaseMessage(threadId, turnId),
      getProgressPhaseMessageForFileEdit: (threadId, turnId, itemId) => store.getProgressPhaseMessageForFileEdit(threadId, turnId, itemId),
      updateFinalProgressPhaseAggregate: (id, aggregate) => store.updateFinalProgressPhaseAggregate(id, aggregate),
      listActiveProgressPhaseMessages: () => store.listActiveProgressPhaseMessages(),
      listPendingProgressPhaseFinalDelivery: () => store.listPendingProgressPhaseFinalDelivery(),
      createProgressPhaseMessage: (input) => store.createProgressPhaseMessage(input),
      updateActiveProgressPhaseMessage: (id, input) => store.updateActiveProgressPhaseMessage(id, input),
      recordSuccessfulRunContentUpdate: (id) => store.recordSuccessfulRunContentUpdate(id),
      finalizeProgressPhaseMessage: (input) => store.finalizeProgressPhaseMessage(input),
      updateFinalProgressPhaseMessageState: (input) => store.updateFinalProgressPhaseMessageState(input),
      markProgressPhaseMessageDeliveryState: (input) => store.markProgressPhaseMessageDeliveryState(input),
      editMessageSpec: async (_chatId, _messageId, spec) => {
        edits.push(renderLegacyMessage(spec));
        return true;
      },
      sendTemporaryMessageSpec: async (_chatId, spec) => {
        const text = renderLegacyMessage(spec);
        sends.push(text);
        return { messageId: String(sends.length), text };
      }
    });

    await service.sendProgressMessage(session, event({ label: "Run", toolName: "yarn check" }));
    await service.sendProgressMessage(session, event({
      label: "Run",
      toolName: "yarn test",
      failed: true,
      text: "raw stderr: secret endpoint timed out"
    }));

    const frozen = store.getLatestProgressPhaseMessage("thread-1", "turn-1");
    assert.equal(frozen?.state, "step_failed");
    assert.equal(frozen?.phaseSeq, 1);
    assert.equal(frozen?.failureReason, "timeout");
    assert.match(edits.at(-1) ?? "", /^Run · .*\nCompleted\nRun ×2 · Reported successes ×1 · Reported failures ×1\nReason: timeout\nTask continued$/);
    assert.doesNotMatch(edits.at(-1) ?? "", /secret endpoint|raw stderr/);

    await service.sendProgressMessage(session, event({ label: "Run", toolName: "yarn lint" }));
    const active = store.getActiveProgressPhaseMessage("thread-1", "turn-1");
    assert.equal(active?.phaseSeq, 2);
    assert.equal(active?.state, "active");
    assert.equal(sends.length, 2);
  } finally {
    store.close();
  }
});

test("Bridge connection failure creates a System card only when no activity phase is active", async () => {
  const store = new BridgeStore(":memory:");
  const sends: string[] = [];
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    const service = new ProgressService({
      getSessionDirectory: () => "/workspace/project",
      getInFlightTurnId: () => "turn-1",
      shouldSkipCalledProgress: () => false,
      getActiveProgressPhaseMessage: (threadId, turnId) => store.getActiveProgressPhaseMessage(threadId, turnId),
      getLatestProgressPhaseMessage: (threadId, turnId) => store.getLatestProgressPhaseMessage(threadId, turnId),
      getProgressPhaseMessageForFileEdit: (threadId, turnId, itemId) => store.getProgressPhaseMessageForFileEdit(threadId, turnId, itemId),
      updateFinalProgressPhaseAggregate: (id, aggregate) => store.updateFinalProgressPhaseAggregate(id, aggregate),
      listActiveProgressPhaseMessages: () => store.listActiveProgressPhaseMessages(),
      listPendingProgressPhaseFinalDelivery: () => store.listPendingProgressPhaseFinalDelivery(),
      createProgressPhaseMessage: (input) => store.createProgressPhaseMessage(input),
      updateActiveProgressPhaseMessage: (id, input) => store.updateActiveProgressPhaseMessage(id, input),
      recordSuccessfulRunContentUpdate: (id) => store.recordSuccessfulRunContentUpdate(id),
      finalizeProgressPhaseMessage: (input) => store.finalizeProgressPhaseMessage(input),
      updateFinalProgressPhaseMessageState: (input) => store.updateFinalProgressPhaseMessageState(input),
      markProgressPhaseMessageDeliveryState: (input) => store.markProgressPhaseMessageDeliveryState(input),
      editMessageSpec: async () => true,
      sendTemporaryMessageSpec: async (_chatId, spec) => {
        const text = renderLegacyMessage(spec);
        sends.push(text);
        return { messageId: String(sends.length), text };
      }
    });

    assert.equal(await service.recordBridgeConnectionFailure(session, "thread-1", "turn-1"), true);
    const record = store.getLatestProgressPhaseMessage("thread-1", "turn-1");
    assert.equal(record?.phaseKind, "system");
    assert.equal(record?.state, "step_failed");
    assert.match(sends[0] ?? "", /^System · /);

    await service.sendProgressMessage(session, event({ label: "Run", toolName: "yarn test" }));
    assert.equal(await service.recordBridgeConnectionFailure(session, "thread-1", "turn-1"), false);
  } finally {
    store.close();
  }
});

test("Run count includes initial send and successful replacements across restart", async () => {
  const store = new BridgeStore(":memory:");
  const edits: string[] = [];
  let failNextEdit = false;
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1", codexThreadId: "thread-1", pathKey: "/workspace/project"
    });
    const makeService = () => new ProgressService({
      getSessionDirectory: () => "/workspace/project",
      getInFlightTurnId: () => "turn-1",
      shouldSkipCalledProgress: () => false,
      getActiveProgressPhaseMessage: (threadId, turnId) => store.getActiveProgressPhaseMessage(threadId, turnId),
      getLatestProgressPhaseMessage: (threadId, turnId) => store.getLatestProgressPhaseMessage(threadId, turnId),
      getProgressPhaseMessageForFileEdit: (threadId, turnId, itemId) => store.getProgressPhaseMessageForFileEdit(threadId, turnId, itemId),
      updateFinalProgressPhaseAggregate: (id, aggregate) => store.updateFinalProgressPhaseAggregate(id, aggregate),
      listActiveProgressPhaseMessages: () => store.listActiveProgressPhaseMessages(),
      listPendingProgressPhaseFinalDelivery: () => store.listPendingProgressPhaseFinalDelivery(),
      createProgressPhaseMessage: (input) => store.createProgressPhaseMessage(input),
      updateActiveProgressPhaseMessage: (id, input) => store.updateActiveProgressPhaseMessage(id, input),
      recordSuccessfulRunContentUpdate: (id) => store.recordSuccessfulRunContentUpdate(id),
      finalizeProgressPhaseMessage: (input) => store.finalizeProgressPhaseMessage(input),
      updateFinalProgressPhaseMessageState: (input) => store.updateFinalProgressPhaseMessageState(input),
      markProgressPhaseMessageDeliveryState: (input) => store.markProgressPhaseMessageDeliveryState(input),
      editMessageSpec: async (_chatId, _messageId, spec) => {
        if (failNextEdit) {
          failNextEdit = false;
          return false;
        }
        edits.push(renderLegacyMessage(spec));
        return true;
      },
      sendTemporaryMessageSpec: async (_chatId, spec) => ({ messageId: "1", text: renderLegacyMessage(spec) })
    });
    const service = makeService();
    await service.sendProgressMessage(session, event({ label: "Run", toolName: "first", completed: false }));
    assert.equal(store.getActiveProgressPhaseMessage("thread-1", "turn-1")?.aggregate.run.updates, 0);
    await service.sendProgressMessage(session, event({ label: "Run", toolName: "second", completed: false }));
    await service.sendProgressMessage(session, event({ label: "Run", toolName: "second", completed: false }));
    failNextEdit = true;
    await service.sendProgressMessage(session, event({ label: "Run", toolName: "third", completed: false }));
    assert.equal(store.getActiveProgressPhaseMessage("thread-1", "turn-1")?.aggregate.run.updates, 1);

    // A new service reads the persisted aggregate; its first event edits the existing card.
    const restarted = makeService();
    await restarted.sendProgressMessage(session, event({ label: "Run", toolName: "fourth", completed: false }));
    await restarted.sendProgressMessage(session, event({ label: "Run", toolName: "fifth", completed: false }));
    assert.equal(store.getActiveProgressPhaseMessage("thread-1", "turn-1")?.aggregate.run.updates, 3);
    await restarted.clearProgressMessageForThread("thread-1", { turnId: "turn-1" });
    const frozen = store.getLatestProgressPhaseMessage("thread-1", "turn-1");
    assert.equal(frozen?.aggregate.run.updates, 3);
    assert.equal(frozen?.aggregate.run.succeeded, 0);
    assert.equal(frozen?.aggregate.run.failed, 0);
    assert.match(edits.at(-1) ?? "", /^Run · .*\nRun ×4 · Reported successes ×0 · Reported failures ×0$/);
  } finally {
    store.close();
  }
});
