import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { BridgeStore } from "../src/store/index.js";
import { WebAttentionService, type WebAttentionDelivery } from "../src/web/attention.js";
import { SessionBindingService } from "../src/bridge/sessions/binding.js";
import { WebMessageTransport } from "../src/web/transport.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { NotificationTurnService } from "../src/bridge/notifications/turns.js";

async function fixture(t: test.TestContext) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "thread", pathKey: "/project" });
  store.claimSession(session.id, "web:local");
  const attention = new WebAttentionService(store, () => "/project");
  const deliveries: WebAttentionDelivery[] = [];
  attention.subscribe((delivery) => deliveries.push(delivery));
  const route = (sourceId = "web:local", turnId = "turn") => store.recordTurnRoute({ sessionId: session.id,
    codexThreadId: "thread", turnId, bindingId: null, sourceId });
  return { store, session, attention, deliveries, route };
}

test("attention follows terminal state and original Web route, not message text or a selected session", async (t) => {
  const h = await fixture(t);
  h.route();
  const event = { kind: "completed" as const, threadId: "thread", turnId: "turn", terminalState: "completed" as const };
  h.attention.turnSettled(h.session, event);
  h.attention.turnSettled(h.session, { ...event, terminalState: "failed" });
  h.attention.turnSettled(h.session, { ...event, terminalState: "interrupted" });
  h.attention.turnSettled(h.session, { ...event, terminalState: "interrupted", error: "Approval denied" });
  h.attention.turnSettled(h.session, { ...event, turnId: "stale" });
  assert.deepEqual(h.deliveries.map(({ event }) => event.kind), ["turn-ended", "turn-failed", "turn-failed"]);
  h.store.completeTurnRoute("turn", "completed");
  h.route("123", "external");
  h.attention.turnSettled(h.session, { ...event, turnId: "external" });
  assert.equal(h.deliveries.length, 3);
});

test("ownership transfer immediately invalidates attention and cannot revive it on reacquisition", async (t) => {
  const h = await fixture(t);
  h.route();
  h.attention.runtimeStopped(h.session, "turn");
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0]!.isCurrent(), true);
  h.store.requestSessionHandoff(h.session.id, "123", true);
  h.store.completeTurnRoute("turn", "interrupted");
  h.store.promotePendingSessionOwner(h.session.id, null);
  assert.equal(h.deliveries[0]!.isCurrent(), false);
  h.attention.runtimeStopped(h.session, "turn");
  h.store.requestSessionHandoff(h.session.id, "web:local", true);
  assert.equal(h.deliveries[0]!.isCurrent(), false);
  assert.equal(h.deliveries.length, 1);
});

test("actionable decision metadata creates attention; progress, replies and terminal decisions do not", async (t) => {
  const h = await fixture(t);
  const transport = new WebMessageTransport(h.store);
  transport.subscribe((delivery) => { void h.attention.observeMessage(delivery); });
  const base = createMessage({ kind: "decision", session: { id: h.session.id, directory: "/project" } });
  const decision = { id: "decision", state: "pending" as const, requiresUserInput: false,
    requestedFields: [], availableActions: ["accept" as const], inputAllowed: false };
  for (const kind of ["progress", "edited", "called", "codex", "compact-completed", "error"] as const) {
    await transport.sendMessageSpec("web:local", { ...base, kind });
  }
  await transport.sendMessageSpec("web:local", { ...base, decision });
  await transport.sendMessageSpec("web:local", { ...base, decision: { ...decision, id: "input", state: "awaitingInput",
    requiresUserInput: true, inputAllowed: true } });
  await transport.sendMessageSpec("web:local", { ...base, decision: { ...decision, state: "approved" } });
  await transport.sendMessageSpec("web:local", { ...base, decision: { ...decision, unavailableReason: "runtime_disconnected" } });
  await settle();
  assert.deepEqual(h.deliveries.map(({ event }) => event.kind), ["approval-required", "input-required"]);
});

test("only genuinely pending bindings create acquired notifications; cancellation and replacement erase intent", async (t) => {
  const h = await fixture(t);
  const running = new Map<string, string>();
  const binding = new SessionBindingService({ store: h.store, inFlightTurnIdByThread: running,
    getSessionDirectory: () => "/project", notify: async () => {} });
  binding.subscribe((event) => { void h.attention.observeBinding(event); });
  await binding.request("123", h.session.id);
  await binding.request("web:local", h.session.id); // Immediate, not a notification.
  assert.equal(h.deliveries.length, 0);
  await binding.request("123", h.session.id);
  running.set("thread", "external-turn");
  await binding.request("web:local", h.session.id);
  await binding.request("slack:T:C:1", h.session.id); // Replaces Web intent.
  running.clear();
  await binding.promote(h.session);
  await settle();
  assert.equal(h.deliveries.length, 0);
  running.set("thread", "external-turn-2");
  await binding.request("web:local", h.session.id);
  await binding.cancel("web:local", h.session.id);
  running.clear();
  await binding.promote(h.session);
  await settle();
  assert.equal(h.deliveries.length, 0);
  running.set("thread", "external-turn-3");
  await binding.request("web:local", h.session.id);
  running.clear();
  await binding.promote(h.session);
  await settle();
  assert.deepEqual(h.deliveries.map(({ event }) => event.kind), ["binding-acquired"]);
});

test("turn integration emits only after terminal processing, suppresses automatic recovery and retires duplicate terminals", async (t) => {
  for (const recovery of [false, true]) {
    const h = await fixture(t);
    h.route();
    const turns = new NotificationTurnService({ store: h.store, inFlightTurnIdByThread: new Map([["thread", "turn"]]),
      assistantOutputByThread: new Map(), errorSeenByThread: new Map(), lastAssistantTelegramByThread: new Map(),
      queuedSubmissionService: { reconcileStartedSubmission: async () => false } as never,
      resolveNotificationSession: async () => h.session, applyStatusUpdate: async () => {},
      handleRecoveryTaskComplete: async () => recovery, clearProgressMessageForThread: async () => {},
      scheduleGoShortcut: () => {}, cancelGoShortcut: () => {}, rememberRateLimitSession: () => {},
      deliverVersionUpdateAfterRootTurn: async () => false, promoteSessionHandoff: async () => {},
      onTurnSettled: (session, event) => h.attention.turnSettled(session, event) });
    const status = { threadId: "thread", kind: "clear" as const, label: null, detail: null, detailMode: null };
    await turns.handleStatusUpdate(status, "turn", "failed", "Terminal reason");
    assert.deepEqual(h.deliveries.map(({ event }) => event.kind), recovery ? [] : ["turn-failed"]);
    await turns.handleTurnLifecycle({ kind: "completed", threadId: "thread", turnId: "turn", terminalState: "failed" });
    await turns.handleStatusUpdate(status, "turn", "failed", "Terminal reason");
    assert.equal(h.deliveries.length, recovery ? 0 : 1);
  }
});
