import assert from "node:assert/strict";
import test from "node:test";

import { DecisionDeliveryService } from "../src/bridge/decisions/delivery.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { DecisionRecord, SessionRecord } from "../src/shared/types.js";

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

function createDeliveryHarness() {
  const sent: string[] = [];
  const deleted: string[] = [];
  const edited: string[] = [];
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
    createBatchDecisionMessageSpec: (count, actions) => createMessage({
      kind: "decision",
      body: [{ type: "text", text: String(count) }],
      actions
    }),
    getExecpolicyAmendment: () => null,
    sendMessageSpec: async (chatId) => {
      sent.push(chatId);
      return { message_id: String(nextMessageId++) };
    },
    editMessageSpec: async (chatId, messageId) => {
      edited.push(`${chatId}/${messageId}`);
      return true;
    }
  });

  return { service, sent, deleted, edited, updatedTargets };
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
  assert.deepEqual(harness.sent, ["slack:T:C:100.2"]);
  assert.deepEqual(harness.updatedTargets, [{
    decisionId: "decision-1",
    chatId: "slack:T:C:100.2",
    messageId: "100"
  }]);
});
