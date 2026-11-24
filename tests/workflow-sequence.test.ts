import assert from "node:assert/strict";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { runInteractionDelivery } from "../src/bridge/interactions/delivery.js";
import { deliverSlackInteraction } from "../src/slack/interactions/responder.js";
import type { SlackMessageTransport } from "../src/slack/transport.js";
import { deliverTelegramInteraction } from "../src/telegram/interactions/responder.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { WorkflowSequence } from "../src/bridge/progress/workflow-sequence.js";
import { fixtureProgressService } from "./fixtures/progress-service.js";
import { BridgeStore } from "../src/store/index.js";
import type { AppServerInteractionRequest, AppServerNotification, AppServerStatusUpdate, CodexAppServerClient } from "../src/codex/client.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { CompactService } from "../src/bridge/sessions/compact-service.js";
import type { NotificationApprovalService } from "../src/bridge/notifications/approval.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { testConfig } from "./bridge-test-config.js";

async function harness(t: test.TestContext) {
  const store = new BridgeStore(":memory:");
  let compactRpc = async () => {};
  const service = new BridgeService(testConfig(":memory:"), store, {
    listQueuedSubmissions: async () => [], isApprovalPending: () => true,
    readUserInputRequest: () => ({ questions: [{ id: "q", header: "Question", question: "Choose", isOther: true, isSecret: false }] }),
    startCompactThread: () => compactRpc(), resumeThread: async () => ({ displayPath: null, messages: [] })
  } as unknown as CodexAppServerClient);
  (service as unknown as { runtimeState: string }).runtimeState = "connected";
  const sent: Array<{ id: string; spec: MessageSpec }> = [];
  const edits: Array<{ id: string; spec: MessageSpec }> = [];
  service.registerMessageTransport({ name: "test", wholeMessageSpecs: true, canHandle: () => true,
    sendMessageSpec: async (_source, spec) => { const id = String(sent.length + 1); sent.push({ id, spec }); return { message_id: id }; },
    editMessageSpec: async (_source, id, spec) => { edits.push({ id, spec }); return true; },
    sendMessage: async () => assert.fail("structured transport"), editMessageText: async () => assert.fail("structured transport"),
    deleteMessage: async () => true, clearMessageActions: async () => true, sendTyping: async () => {} });
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/workspace/project" });
  await store.setActiveSession("chat", session.id);
  store.claimSession(session.id, "chat");
  const internal = service as unknown as {
    handleAppServerNotification(notification: AppServerNotification): Promise<void>;
    applyStatusUpdate(session: typeof session, update: AppServerStatusUpdate): Promise<void>;
    compactService: CompactService;
    notificationApprovalService: NotificationApprovalService;
    goShortcutService: { cancel(threadId: string): void };
  };
  const send = (notification: AppServerNotification) => internal.handleAppServerNotification(notification);
  await send({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", status: "inProgress" } } });
  t.after(async () => { internal.goShortcutService.cancel("thread"); await service.shutdown(); store.close(); });
  const called = (id: string, completed = false, failed = false) => send({
    method: completed ? "item/completed" : "item/started", params: { threadId: "thread", turnId: "turn",
      item: { id, type: "mcpToolCall", server: "demo", tool: "lookup", arguments: { query: "same preview" },
        status: failed ? "failed" : completed ? "completed" : "inProgress", ...(failed ? { error: { message: "Timed out" } } : {}) } }
  });
  const assistant = () => send({ method: "item/completed", params: { threadId: "thread", turnId: "turn",
    item: { id: "answer", type: "agentMessage", text: "Still working", phase: "commentary" } } });
  const latest = () => store.getLatestProgressPhaseMessage("thread", "turn")!;
  const approval = (method = "item/commandExecution/requestApproval") => internal.notificationApprovalService.handleApprovalRequest({
    requestId: `request-${method}`, threadId: "thread", turnId: "turn", itemId: "approval-item", method,
    title: "Allow action", summary: "Review this action", requestedFields: [], elicitationMode: null,
    requiresUserInput: false, availableDecisions: null
  } as AppServerInteractionRequest);
  return { store, service, internal, session, sent, edits, send, called, assistant, latest, approval,
    setCompactRpc: (rpc: () => Promise<void>) => { compactRpc = rpc; } };
}

for (const boundary of ["compact-started", "compact-completed-only", "assistant", "warning", "mcp-failure", "approval", "input"] as const) {
  test(`${boundary} closes Called before another identical tool action`, async t => {
    const f = await harness(t);
    await f.called("first");
    const first = f.latest();
    assert.equal(first.state, "active");
    const before = f.sent.length;
    if (boundary === "compact-started") await f.internal.compactService.notifyCompactStarted(f.session, "runtime");
    if (boundary === "compact-completed-only") await f.internal.compactService.notifyCompactCompleted(f.session);
    if (boundary === "assistant") await f.assistant();
    if (boundary === "warning") await f.send({ method: "warning", params: { threadId: "thread", message: "Public warning" } });
    if (boundary === "mcp-failure") await f.send({ method: "mcpServer/startupStatus/updated", params: {
      threadId: "thread", name: "demo", status: "failed", error: "Unavailable" } });
    if (boundary === "approval") await f.approval();
    if (boundary === "input") await f.internal.notificationApprovalService.handleApprovalRequest({
      requestId: "input", threadId: "thread", turnId: "turn", itemId: "input-item", method: "item/tool/requestUserInput",
      title: "Choose", summary: "Question", requestedFields: [], requiresUserInput: true, elicitationMode: null
    } as AppServerInteractionRequest);
    assert.ok(f.sent.length > before, "the standalone message is actually delivered");
    assert.equal(f.store.getProgressPhaseMessage(first.id)?.state, "phase_complete");
    await f.called("second");
    assert.equal(f.latest().phaseSeq, 2);
    assert.notEqual(f.latest().platformMessageId, first.platformMessageId);
    assert.deepEqual(f.latest().aggregate.operations, [{ name: "demo.lookup", count: 1 }]);
    assert.equal(f.sent.at(-1)?.id, f.latest().platformMessageId);
  });
}

test("duplicate standalone notifications do not split a newer phase", async t => {
  const f = await harness(t);
  await f.called("first"); await f.assistant(); await f.called("second");
  const second = f.latest();
  await f.assistant();
  assert.equal(f.latest().state, "active");
  assert.equal(f.latest().id, second.id);
  await f.internal.compactService.notifyCompactStarted(f.session, "runtime");
  await f.called("third");
  const third = f.latest();
  await f.internal.compactService.notifyCompactStarted(f.session, "runtime");
  assert.equal(f.latest().id, third.id);
  assert.equal(f.latest().state, "active");
});

test("late Called completion updates its original phase, survives reconstruction and does not split new work", async t => {
  const f = await harness(t);
  await f.called("first"); const first = f.latest();
  await f.assistant(); await f.called("second"); const second = f.latest();
  const sends = f.sent.length;
  // A new progress service reads ownership from the persisted aggregate, not its preview cache.
  const progress = fixtureProgressService(f.store, (id, spec, edit) => {
    assert.equal(edit, true); f.edits.push({ id, spec });
  });
  t.after(() => progress.stop());
  const event = { threadId: "thread", itemId: "first", label: "Called", toolName: "demo.lookup", action: null,
    target: null, input: null, changes: null, failed: true, completed: true, text: "Timed out" };
  await progress.sendProgressMessage(f.session, event, "turn");
  assert.equal(f.edits.at(-1)?.id, first.platformMessageId);
  assert.equal(f.store.getProgressPhaseMessage(first.id)?.state, "step_failed");
  assert.match(renderLegacyMessage(f.edits.at(-1)!.spec), /failed|Error: timeout/);
  assert.equal(f.latest().id, second.id); assert.equal(f.latest().state, "active");
  assert.equal(f.sent.length, sends);
  const count = f.edits.length;
  await progress.sendProgressMessage(f.session, event, "turn");
  assert.equal(f.edits.length, count, "duplicate completion does not inflate the old aggregate");
});

test("all Compact sources and manual returned results share the boundary, without holding a queue during RPC", async t => {
  for (const source of ["runtime", "bridge-auto", "manual"] as const) {
    const f = await harness(t);
    await f.called("first");
    await f.internal.compactService.notifyCompactStarted(f.session, source);
    assert.equal(f.latest().state, "phase_complete");
    await f.called("second");
    await f.internal.compactService.notifyCompactCompleted(f.session);
    assert.equal(f.latest().state, "phase_complete");
  }
  const f = await harness(t);
  await f.called("first");
  const reply = await f.internal.compactService.compactSession(f.session);
  assert.equal(f.latest().state, "active", "the RPC does not hold or close the delivery queue");
  await f.service.deliverCompactResult("chat", reply, async () => {
    assert.equal(f.latest().state, "phase_complete", "boundary precedes manual reply delivery");
  });
});

test("sequence isolates turns, sessions and sources, preserves results and recovers after delivery failure", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work" });
  const route = store.recordTurnRoute({ sessionId: session.id, codexThreadId: "thread", turnId: "turn", sourceId: "chat", bindingId: null });
  const closed: string[] = [];
  const sequence = new WorkflowSequence(id => store.getActiveTurnRoute(id), async (_thread, turn) => { closed.push(turn); });
  for (const context of [{ turnId: "old" }, { sourceId: "other" }]) {
    assert.equal(await sequence.append(session, async () => 42, context), 42);
  }
  await sequence.append({ ...session, id: "other-session" }, async () => {});
  store.completeTurnRoute(route.turnId, "completed");
  await sequence.append(session, async () => {});
  assert.deepEqual(closed, []);
  store.recordTurnRoute(route);
  await assert.rejects(sequence.append(session, async () => { throw new Error("delivery failed"); }), /delivery failed/);
  assert.equal(await sequence.append(session, async () => "sent"), "sent");
  assert.deepEqual(closed, ["turn", "turn"]);
});

test("progress and append use one FIFO while unrelated turns proceed", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work" });
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "thread", turnId: "turn", sourceId: "chat", bindingId: null });
  const order: string[] = [];
  const sequence = new WorkflowSequence(id => store.getActiveTurnRoute(id), async () => { order.push("close"); });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = sequence.run("thread:turn", async () => { order.push("progress"); await blocked; });
  const middle = sequence.append(session, async () => { order.push("message"); });
  const last = sequence.run("thread:turn", async () => { order.push("new progress"); });
  await sequence.run("other:turn", async () => { order.push("unrelated"); });
  assert.deepEqual(order, ["progress", "unrelated"]);
  release(); await Promise.all([first, middle, last]); await sequence.drain();
  assert.deepEqual(order, ["progress", "unrelated", "close", "message", "new progress"]);
});

test("failed final-summary delivery does not swallow the boundary or redirect retries to the new phase", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work" });
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "thread", turnId: "turn", sourceId: "chat", bindingId: null });
  let failEdit = true;
  const editedIds: string[] = [];
  const progress = fixtureProgressService(store, (id, _spec, edit) => {
    if (!edit) return;
    editedIds.push(id);
    if (failEdit) throw new Error("Network unavailable");
  });
  t.after(() => progress.stop());
  const event = (itemId: string) => ({ itemId, threadId: "thread", label: "Called", toolName: "demo.lookup",
    action: null, target: null, input: null, changes: null, failed: false, text: "same", completed: true });
  await progress.sendProgressMessage(session, event("a"), "turn");
  const first = store.getLatestProgressPhaseMessage("thread", "turn")!;
  let appended = false;
  await progress.appendWorkflowMessage(session, async () => { appended = true; });
  assert.equal(appended, true);
  assert.equal(store.getProgressPhaseMessage(first.id)?.deliveryState, "pending_finalization");
  await progress.sendProgressMessage(session, event("b"), "turn");
  const second = store.getLatestProgressPhaseMessage("thread", "turn")!;
  failEdit = false;
  await progress.retryPendingFinalDeliveries();
  assert.deepEqual(editedIds, [first.platformMessageId, first.platformMessageId]);
  assert.equal(store.getProgressPhaseMessage(first.id)?.deliveryState, "synced");
  assert.equal(store.getProgressPhaseMessage(second.id)?.state, "active");
});

test("a new plan snapshot after standalone output opens a new phase despite its stable protocol key", async t => {
  const f = await harness(t);
  const plan = (step: string) => f.send({ method: "turn/plan/updated", params: { threadId: "thread", turnId: "turn",
    plan: [{ step, status: "pending" }] } });
  await plan("Inspect"); const first = f.latest();
  await f.assistant();
  await plan("Implement");
  assert.equal(f.latest().phaseSeq, 2);
  assert.notEqual(f.latest().id, first.id);
  assert.match(f.latest().aggregate.activities![0]!.lines.join("\n"), /Implement/);
  assert.match(f.store.getProgressPhaseMessage(first.id)!.aggregate.activities![0]!.lines.join("\n"), /Inspect/);
});

test("duplicate warning and approval card refresh leave the new Called phase active", async t => {
  const f = await harness(t);
  const warning = { method: "warning", params: { threadId: "thread", message: "Public warning" } };
  await f.called("a"); await f.send(warning); await f.called("b");
  const second = f.latest(); await f.send(warning);
  assert.equal(f.latest().state, "active"); assert.equal(f.latest().id, second.id);
  await f.approval(); await f.called("c"); const third = f.latest();
  await f.approval();
  assert.equal(f.latest().state, "active"); assert.equal(f.latest().id, third.id);
});

test("a late assistant item with an explicit older turn cannot close the current phase", async t => {
  const f = await harness(t);
  await f.called("a"); const first = f.latest();
  await f.send({ method: "item/completed", params: { threadId: "thread", turnId: "old",
    item: { id: "old-answer", type: "agentMessage", text: "Previous turn answer" } } });
  assert.equal(f.latest().id, first.id); assert.equal(f.latest().state, "active");
});

test("legacy progress aggregates without item metadata still finalize normally", async t => {
  const f = await harness(t);
  const legacy = f.store.createProgressPhaseMessage({ sessionId: f.session.id, codexThreadId: "thread", turnId: "turn",
    sourceId: "chat", phaseKind: "called", platformMessageId: "legacy", directory: "/work", text: "",
    aggregate: { eventCount: 1, operations: [{ name: "demo.lookup", count: 1 }], files: {}, explored: {},
      run: { updates: 0, succeeded: 0, failed: 0 } } });
  await f.assistant();
  assert.equal(f.store.getProgressPhaseMessage(legacy.id)?.state, "phase_complete");
  await f.called("new"); assert.equal(f.latest().phaseSeq, 2);
});


test("manual Compact RPC can deliver approval and runtime notifications without duplicate starts or queue deadlock", { timeout: 2000 }, async t => {
  const f = await harness(t);
  await f.called("first");
  f.setCompactRpc(async () => {
    await f.internal.compactService.notifyCompactStarted(f.session, "runtime");
    await f.approval();
    await f.called("second");
  });
  const reply = await f.internal.compactService.compactSession(f.session);
  assert.equal(reply.kind, "compact-started");
  assert.equal(f.sent.filter(entry => entry.spec.kind === "compact-started").length, 0,
    "the manual result owns the start even when runtime notifies before the RPC reply");
  assert.equal(f.latest().phaseSeq, 2); assert.equal(f.latest().state, "active");
  await f.service.deliverCompactResult("chat", reply, async () => {});
  assert.equal(f.latest().state, "phase_complete");
});

test("Working panel updates do not split workflow phases", async t => {
  const f = await harness(t);
  await f.called("first"); const first = f.latest();
  for (const label of ["Working", "Waiting"]) {
    await f.internal.applyStatusUpdate(f.session, { threadId: "thread", kind: "running", label, detail: null, detailMode: null });
  }
  assert.ok(f.sent.some(entry => entry.spec.kind === "working"));
  assert.ok(f.edits.some(entry => entry.spec.kind === "working"));
  await f.called("second");
  assert.equal(f.latest().id, first.id); assert.equal(f.latest().state, "active");
});

for (const platform of ["slack", "telegram"] as const) {
  test(`${platform} interaction wraps the actual Compact write and runs follow-up outside the queue`, async () => {
    const order: string[] = [];
    const delivery = { mode: "send" as const, target: "conversation" as const,
      message: createMessage({ kind: "system", scope: "global", body: [] }),
      aroundDelivery: async (write: () => Promise<void>) => { order.push("boundary"); await write(); order.push("release"); },
      afterDelivery: async () => { order.push("follow-up"); } };
    const context = { platform, conversationId: "chat", surfaceId: "chat" };
    if (platform === "slack") {
      await deliverSlackInteraction({ sendMessageSpec: async () => { order.push("write"); return { message_id: "id" }; } } as unknown as SlackMessageTransport,
        context, delivery);
    } else await deliverTelegramInteraction(context, delivery, {
      clearActions: async () => {}, edit: async () => assert.fail("send"), send: async () => { order.push("write"); }
    });
    assert.deepEqual(order, ["boundary", "write", "release", "follow-up"]);
  });
}

test("unsuccessful interaction delivery never runs follow-up and preserves thrown errors", async () => {
  let after = 0;
  const delivery = { mode: "send" as const, target: "conversation" as const,
    message: createMessage({ kind: "system", scope: "global", body: [] }),
    aroundDelivery: async (write: () => Promise<void>) => write(), afterDelivery: async () => { after++; } };
  await runInteractionDelivery(delivery, async () => false);
  await assert.rejects(runInteractionDelivery(delivery, async () => { throw new Error("Unknown outcome"); }), /Unknown outcome/);
  assert.equal(after, 0);
});
