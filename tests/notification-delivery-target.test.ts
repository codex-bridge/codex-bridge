import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { canDeliverSession, NotificationDeliveryTargets } from "../src/bridge/notifications/delivery-target.js";
import { NotificationDispatcher } from "../src/bridge/notifications/dispatcher.js";

test("terminal route retirement and handoff never retarget late notifications to the new owner", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "late", pathKey: "/work" });
  const owner = store.claimSession(session.id, "123");
  const targets = new NotificationDeliveryTargets(store, (threadId) => store.getSessionByThreadId(threadId));
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "late", turnId: "old-turn", bindingId: owner.binding.id, sourceId: "123" });
  assert.equal((await targets.resolve("late"))?.telegramChatId, "123");
  store.completeTurnRoute("old-turn", "completed");
  store.requestSessionHandoff(session.id, "web:local", true);
  assert.equal((await targets.resolve("late"))?.telegramChatId, "123");
  assert.equal((await store.getSessionById(session.id))?.telegramChatId, "web:local");
  targets.remember((await store.getSessionById(session.id))!);
  assert.equal((await targets.resolve("late"))?.telegramChatId, "web:local");
});

test("progress and bridge failures reach owned Web sessions without selecting them, but not another source's route", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "progress", pathKey: "/work" });
  const owner = store.claimSession(session.id, "web:local");
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "progress", turnId: "turn", bindingId: owner.binding.id, sourceId: "web:local" });
  let progress = 0;
  let failures = 0;
  const dispatcher = new NotificationDispatcher({ store, sessionMenuSnapshots: { clear: () => {} },
    notificationTurnService: { handleStatusUpdate: async () => {}, handleTurnLifecycle: async () => {} } as never,
    notificationRecoveryService: {} as never, notificationMessageService: {} as never, notificationAuxiliaryService: {} as never,
    resolveNotificationSession: async () => (await store.getSessionById(session.id))!,
    sendProgressMessage: async () => { progress++; }, recordBridgeConnectionFailure: async () => { failures++; return true; } });
  const event = { method: "item/started", params: { threadId: "progress", turnId: "turn",
    item: { id: "command", type: "commandExecution", command: "yarn check", status: "inProgress" } } };
  await dispatcher.handle(event);
  await dispatcher.handle({ method: "bridge/connection/lost", params: { expected: false } });
  assert.equal(progress, 1);
  assert.equal(failures, 1);
  assert.equal(await store.getActiveSession("web:local"), null);
  store.recordTurnRoute({ sessionId: session.id, codexThreadId: "progress", turnId: "turn", bindingId: null, sourceId: "123" });
  await dispatcher.handle(event);
  await dispatcher.handle({ method: "bridge/connection/lost", params: { expected: false } });
  assert.equal(progress, 1);
  assert.equal(failures, 1);
});

test("Web delivery uses confirmed occupation, never active selection; chat still uses selection", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  assert.equal(await canDeliverSession(store, session, "web:local"), false);
  store.claimSession(session.id, "web:local");
  assert.equal(await store.getActiveSession("web:local"), null);
  assert.equal(await canDeliverSession(store, session, "web:local"), true);
  store.requestSessionHandoff(session.id, "123", false);
  assert.equal(await canDeliverSession(store, session, "web:local"), true);
  store.requestSessionHandoff(session.id, "123", true);
  assert.equal(await canDeliverSession(store, session, "web:local"), false);
  assert.equal(await canDeliverSession(store, session, "123"), false);
  await store.setActiveSession("123", session.id);
  assert.equal(await canDeliverSession(store, session, "123"), true);
});
