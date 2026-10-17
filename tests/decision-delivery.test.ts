import assert from "node:assert/strict";
import test from "node:test";

import { DecisionDeliveryService } from "../src/bridge/decisions/delivery.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { DecisionRecord, SessionRecord } from "../src/shared/types.js";
import type { BridgeMessageOptions } from "../src/bridge/transport.js";
import { BridgeStore } from "../src/store/index.js";
import { createBatchDecisionMessageSpec, createDecisionMessageSpec } from "../src/bridge/decisions/formatters.js";

function session(chatId: string): SessionRecord {
  return {
    id: "session-1",
    telegramChatId: chatId,
    codexThreadId: "codex-thread-1",
    pathKey: "/workspace/project",
    currentCwd: "/workspace/project",
    displayName: null,
    batchDecisionMessageId: null,
    codexArchivedAt: null,
    latestActivityAt: 1,
    createdAt: 1
  };
}

function decision(chatId: string, messageId: string | null): DecisionRecord {
  return {
    id: "decision-1",
    sessionId: "session-1",
    telegramChatId: chatId,
    approvalId: "approval-1",
    kind: "item/commandExecution/requestApproval",
    title: "Run command",
    summary: "yarn test",
    requiresUserInput: false,
    state: "pending",
    telegramMessageId: messageId,
    createdAt: 1,
    updatedAt: 1
  };
}

function createDeliveryHarness(delivered = true) {
  const sent: string[] = [];
  const sentOptions: Array<BridgeMessageOptions | undefined> = [];
  const deleted: string[] = [];
  const edited: string[] = [];
  const editedSpecs: MessageSpec[] = [];
  const updatedTargets: Array<{ decisionId: string; chatId: string; messageId: string }> = [];
  let nextMessageId = 100;
  const transport = {
    deleteMessage: async (chatId: string, messageId: string) => {
      deleted.push(`${chatId}/${messageId}`);
      return true;
    }
  };
  const service = new DecisionDeliveryService({
    store: {
      attachDecisionMessage: async () => undefined,
      getActiveSession: async () => null,
      getSessionById: async () => null,
      getSessionLease: () => null,
      getSessionBindingById: () => null,
      listPendingDecisions: async () => [],
      updateDecisionMessageTarget: async (decisionId, chatId, messageId) => {
        updatedTargets.push({ decisionId, chatId, messageId });
      },
      updateSessionBatchDecisionMessageId: async () => undefined
    },
    requireMessageTransport: () => transport as never,
    sessionOperationQueue: { run: async (_sessionId, operation) => operation() },
    isBatchableDecision: () => true,
    createDecisionMessageSpec: (target, currentDecision, actions): MessageSpec => createMessage({
      kind: "decision",
      titleLabel: currentDecision.title,
      session: { id: target.id, directory: target.pathKey },
      actions
    }),
    getSessionDirectory: (target) => target.currentCwd ?? target.pathKey,
    createBatchDecisionMessageSpec: (session, count, actions) => createMessage({
      session,
      kind: "decision",
      body: [{ type: "text", text: String(count) }],
      actions
    }),
    getExecpolicyAmendment: () => null,
    sendMessageSpec: async (chatId, _spec, options) => {
      sent.push(chatId);
      sentOptions.push(options);
      return delivered ? { message_id: String(nextMessageId++) } : null;
    },
    editMessageSpec: async (chatId, messageId, spec) => {
      edited.push(`${chatId}/${messageId}`);
      editedSpecs.push(spec);
      return true;
    }
  });

  return { service, sent, sentOptions, deleted, edited, editedSpecs, updatedTargets };
}

test("does not resend a pending decision to the same Slack thread", async () => {
  const harness = createDeliveryHarness();

  await harness.service.sendDecisionMessage(
    session("slack:T:C:100.1"),
    decision("slack:T:C:100.1", "42")
  );

  assert.deepEqual(harness.sent, []);
  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.updatedTargets, []);
});

test("retires the old decision message when a session moves to another Slack thread", async () => {
  const harness = createDeliveryHarness();

  await harness.service.sendDecisionMessage(
    session("slack:T:C:100.2"),
    decision("slack:T:C:100.1", "42")
  );

  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.edited, ["slack:T:C:100.1/42"]);
  assert.equal(harness.editedSpecs[0]?.title, "Decision Moved · /workspace/project");
  assert.equal(harness.editedSpecs[0]?.session?.id, "session-1");
  assert.deepEqual(harness.sent, ["slack:T:C:100.2"]);
  assert.deepEqual(harness.sentOptions, [{ unavailableThreadNotice: { kind: "action-required" } }]);
  assert.deepEqual(harness.updatedTargets, [{
    decisionId: "decision-1",
    chatId: "slack:T:C:100.2",
    messageId: "100"
  }]);
});

test("an undelivered decision with a separate root reminder is not attached as an actionable card", async () => {
  const harness = createDeliveryHarness(false);
  await harness.service.sendDecisionMessage(session("slack:T:C:100.2"), decision("slack:T:C:100.2", null));
  assert.deepEqual(harness.sentOptions, [{ unavailableThreadNotice: { kind: "action-required" } }]);
  assert.deepEqual(harness.updatedTargets, []);
});

test("batch approval creation and closure use the actual session directory before delivery", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const target = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work/stale", currentCwd: "/work/current"
    });
    await store.setActiveSession("chat", target.id);
    const decisions = await Promise.all(["first", "second"].map((approvalId) => store.createOrReplacePendingDecision({
      sessionId: target.id, telegramChatId: "chat", approvalId, kind: "item/commandExecution/requestApproval",
      title: "Run command", summary: "command: yarn test", requiresUserInput: false
    })));
    const sent: MessageSpec[] = [];
    const edited: MessageSpec[] = [];
    const service = new DecisionDeliveryService({
      store, sessionOperationQueue: { run: async (_id, operation) => operation() },
      getSessionDirectory: (session) => session.currentCwd ?? session.pathKey,
      isBatchableDecision: () => true, createDecisionMessageSpec, createBatchDecisionMessageSpec,
      getExecpolicyAmendment: () => null,
      requireMessageTransport: () => { throw new Error("Unexpected fallback"); },
      sendMessageSpec: async (chat, spec) => {
        assert.equal(chat, "chat");
        sent.push(structuredClone(spec));
        return { message_id: "batch" };
      },
      editMessageSpec: async (chat, id, spec) => {
        assert.equal(chat, "chat"); assert.equal(id, "batch"); edited.push(spec); return true;
      }
    });
    await service.syncBatchDecisionMessage(target);
    assert.equal(sent[0]?.title, "Decisions · /work/current");
    assert.deepEqual(sent[0]?.session, { id: target.id, directory: "/work/current" });
    await store.resolveDecision(decisions[0]!.id, "approved");
    await service.syncBatchDecisionMessage(target);
    assert.equal(sent.length, 1);
    assert.equal(edited[0]?.title, "No Pending Approvals · /work/current");
    assert.deepEqual(edited[0]?.session, sent[0]?.session);
    assert.deepEqual(edited[0]?.actions, []);
    assert.equal((await store.getSessionById(target.id))?.batchDecisionMessageId, null);
  } finally { store.close(); }
});
