import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { NotificationApprovalService } from "../src/bridge/notifications/approval.js";
import { NotificationAuxiliaryService } from "../src/bridge/notifications/auxiliary.js";
import { NotificationDispatcher } from "../src/bridge/notifications/dispatcher.js";
import { DecisionCommandService } from "../src/bridge/decisions/commands.js";
import { DecisionDeliveryService } from "../src/bridge/decisions/delivery.js";
import { SessionDecisionOperationQueue } from "../src/bridge/decisions/session-operation-queue.js";
import { createDecisionMessageSpec, createBatchDecisionMessageSpec, describeDecision,
  getExecpolicyAmendment, isBatchableDecision } from "../src/bridge/decisions/formatters.js";
import type { AppServerApprovalRequest } from "../src/codex/client.js";
import type { DecisionAction } from "../src/shared/types.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";

async function fixture(t: TestContext, source = "slack:T:C:1") {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: source, codexThreadId: "thread", pathKey: "/work" });
  await store.setActiveSession(source, session.id);
  store.claimSession(session.id, source);
  const sent: MessageSpec[] = [], edited: MessageSpec[] = [];
  const pending = new Set<string>();
  const answers: Array<{ id: string; action: DecisionAction }> = [];
  const codex = {
    isApprovalPending: (id: string) => pending.has(id),
    resolveApproval: async (id: string, action: DecisionAction) => {
      assert.ok(pending.delete(id), "single use");
      answers.push({ id, action });
    }
  };
  const delivery = new DecisionDeliveryService({ store, sessionOperationQueue: new SessionDecisionOperationQueue(),
    isBatchableDecision, createDecisionMessageSpec, createBatchDecisionMessageSpec, getExecpolicyAmendment,
    getSessionDirectory: () => "/work", requireMessageTransport: () => ({ clearMessageActions: async () => {} }) as never,
    createMcpInputPromptSpec: () => assert.fail("not an input request"),
    sendMessageSpec: async (_source, spec) => { sent.push(spec); return { message_id: String(sent.length) }; },
    editMessageSpec: async (_source, _id, spec) => { edited.push(spec); return true; }
  });
  const commands = new DecisionCommandService({ store, decisionDelivery: delivery, codexClient: codex,
    sessionOwnershipService: { getSessionOwnershipPrompt: async () => null },
    createMcpInputPromptSpec: () => assert.fail("not an input request"), sendLongSpec: async () => {} });
  const notifications = new NotificationApprovalService({
    appendWorkflowMessage: (_session, operation) => operation(), store, codexClient: codex as never,
    subagents: { route: () => null } as never, earlyApprovals: new Map(),
    resolveNotificationSession: async () => session, getSessionDirectory: () => "/work", cancelGoShortcut: () => {},
    setSessionStatus: async () => {}, sendDecisionMessage: (s, d) => delivery.sendDecisionMessage(s, d),
    syncBatchDecisionMessage: (s) => delivery.syncBatchDecisionMessage(s), sendLongSpec: async () => {} });
  let sequence = 0;
  async function receive(overrides: Partial<AppServerApprovalRequest> = {}) {
    const request: AppServerApprovalRequest = { requestId: `opaque-${++sequence}`, threadId: "thread", turnId: "turn",
      itemId: "item", method: "item/commandExecution/requestApproval", commandApprovalKind: "humanCommand",
      availableDecisions: null, title: "Run command", summary: "command: yarn test\nManaged human checkpoint\ncwd: /work",
      requiresUserInput: false, requestedFields: [], elicitationMode: null, ...overrides };
    pending.add(request.requestId);
    await notifications.handleApprovalRequest(request);
    return (await store.getDecisionByApprovalId(request.requestId))!;
  }
  return { store, session, sent, edited, pending, answers, delivery, commands, receive };
}

test("Slack and Telegram human cards use the same three one-time actions and never auto-approve", async (t) => {
  for (const source of ["slack:T:C:1", "123"]) {
    const f = await fixture(t, source);
    const decision = await f.receive();
    assert.equal(decision.commandApprovalKind, "humanCommand");
    assert.deepEqual(f.answers, []);
    assert.equal(f.sent[0]!.title, "Human Approval Required · /work");
    assert.deepEqual(f.sent[0]!.actions.map((a) => a.label), ["Approve Once", "Decline", "Cancel"]);
    assert.deepEqual(f.sent[0]!.decision!.availableActions, ["accept", "decline", "cancel"]);
    for (const action of ["acceptForSession", "acceptWithExecpolicyAmendment"] as const) {
      assert.equal((await f.commands.handle(decision.id, action, source)).ok, false);
      assert.deepEqual(f.answers, []);
    }
    const results = await Promise.all([f.commands.handle(decision.id, "accept", source), f.commands.handle(decision.id, "accept", source)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.deepEqual(f.answers, [{ id: decision.approvalId, action: "accept" }]);
    assert.deepEqual(f.edited.at(-1)!.actions, []);
  }
});

test("human requests stay out of all batch operations, even alongside ordinary approvals", async (t) => {
  const f = await fixture(t);
  const human = await f.receive();
  for (const action of ["accept", "decline", "cancel"] as const) {
    assert.equal((await f.commands.handleBatch(f.session.id, action)).ok, false);
  }
  const ordinary = await f.receive({ commandApprovalKind: "command" });
  assert.equal((await f.commands.handleBatch(f.session.id, "accept")).ok, true);
  assert.deepEqual(f.answers, [{ id: ordinary.approvalId, action: "accept" }]);
  assert.equal((await f.store.getDecision(human.id))!.state, "pending");
  assert.equal(f.sent.some((spec) => spec.kind === "decision-batch"), false);
  const ordinaryA = await f.receive({ commandApprovalKind: "command" });
  const ordinaryB = await f.receive({ commandApprovalKind: "command" });
  const batch = f.sent.find((spec) => spec.kind === "decision-batch")!;
  assert.deepEqual(batch.body, [{ type: "text", text: "2 pending approvals" }]);
  assert.equal((await f.commands.handleBatch(f.session.id, "decline")).ok, true);
  assert.deepEqual(f.answers.slice(1).map((answer) => answer.id).sort(), [ordinaryA.approvalId, ordinaryB.approvalId].sort());
  assert.ok(f.answers.slice(1).every((answer) => answer.action === "decline"));
  assert.equal((await f.store.getDecision(human.id))!.state, "pending");
});

test("typed server decisions are authoritative, including empty and unspecified decisions", async (t) => {
  const f = await fixture(t);
  const restricted = await f.receive({ availableDecisions: ["decline"], summary: "availableDecisions: accept" });
  assert.deepEqual(describeDecision(restricted).availableActions, ["decline"]);
  assert.deepEqual(f.sent.at(-1)!.actions.map((a) => a.label), ["Decline"]);
  assert.equal((await f.commands.handle(restricted.id, "accept")).ok, false);
  assert.equal((await f.commands.handle(restricted.id, "decline")).ok, true);
  const none = await f.receive({ availableDecisions: [] });
  assert.deepEqual(describeDecision(none).availableActions, []);
  const unspecified = await f.receive({ availableDecisions: null, summary: "availableDecisions: decline" });
  assert.deepEqual(describeDecision(unspecified).availableActions, ["accept", "decline", "cancel"]);
});

test("ordinary approvals preserve session/command permissions and legacy summary restrictions", async (t) => {
  const f = await fixture(t);
  const ordinary = await f.receive({ commandApprovalKind: "writeStdin" });
  assert.deepEqual(f.sent.at(-1)!.actions.map((a) => a.label), ["Approve Once", "Allow Session", "Decline", "Cancel"]);
  assert.equal((await f.commands.handle(ordinary.id, "acceptForSession")).ok, true);
  const legacy = await f.store.createOrReplacePendingDecision({ sessionId: f.session.id, telegramChatId: f.session.telegramChatId,
    approvalId: "old", kind: "item/commandExecution/requestApproval", title: "old", requiresUserInput: false,
    summary: 'execpolicyAmendment: ["yarn","test"]\navailableDecisions: acceptWithExecpolicyAmendment, decline' });
  assert.deepEqual(describeDecision(legacy).availableActions, ["acceptForSession", "decline"]);
});

test("upstream resolution expires the card without inventing an approval or execution result", async (t) => {
  const f = await fixture(t);
  const d = await f.receive();
  const auxiliary = new NotificationAuxiliaryService({
    appendWorkflowMessage: (_session, operation) => operation(), store: f.store,
    clearDecisionMessageActions: (decision) => f.delivery.clearDecisionMessageActions(decision),
    syncBatchDecisionMessageForSessionId: (id) => f.delivery.syncBatchDecisionMessageForSessionId(id)
  } as ConstructorParameters<typeof NotificationAuxiliaryService>[0]);
  await auxiliary.handleResolvedRequest(d.approvalId);
  assert.equal((await f.store.getDecision(d.id))!.state, "stale");
  assert.deepEqual(f.edited.at(-1)!.actions, []);
  assert.deepEqual(f.answers, []);
  assert.equal((await f.commands.handle(d.id, "accept")).ok, false);
});

test("expiry cannot replace an already recorded human response", async (t) => {
  const f = await fixture(t);
  const d = await f.receive();
  await f.commands.handle(d.id, "accept");
  assert.equal((await f.store.resolveDecision(d.id, "stale"))!.state, "approved");
});

test("resolved notifications share their thread queue with approval delivery", () => {
  const dispatcher = new NotificationDispatcher({} as ConstructorParameters<typeof NotificationDispatcher>[0]);
  assert.equal(dispatcher.getQueueKey({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "opaque" } }), "thread");
  assert.equal(dispatcher.getQueueKey({ method: "account/updated", params: {} }), "global");
});
