import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { BridgeStore } from "../src/store/index.js";
import { WebWindowLeaseManager } from "../src/web/window-lease.js";
import { SessionBindingService, sourceLabel, type SessionBindingEvent } from "../src/bridge/sessions/binding.js";
import { NotificationTurnService } from "../src/bridge/notifications/turns.js";
import { IncomingTurnService } from "../src/bridge/input/turn.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { SessionMutationService } from "../src/bridge/sessions/mutation.js";
import { createMessage } from "../src/bridge/messages/factory.js";

test("shared dispatch blocks handoff while start waits for its real turn id, then keeps accepted work with the owner", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "dispatch", pathKey: "/work" });
  const owner = store.claimSession(session.id, "web:local");
  const active = new Map<string, string>();
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: active, getSessionDirectory: () => "/work", notify: async () => {} });
  let finish!: () => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const sender = new IncomingTurnService({ store, turnRouteQueue: new KeyedQueue(), inFlightTurnIdByThread: active,
    runDispatch: (value, operation) => binding.runDispatch(value, operation),
    codexClient: { sendTurn: async () => {
      signalStarted(); await new Promise<void>((resolve) => { finish = resolve; }); return { turnId: "real-turn" };
    } } as never, rememberNotificationSession: () => {}, getSessionDirectory: () => "/work", lastUserInputBySession: new Map(),
    statusRuntimeState: {} as never, sessionOwnershipService: {} as never, findProviderMismatch: async () => null,
    isStaleActiveTurnError: () => false, isMissingRuntimeThreadError: () => false, isActiveWriterConflictError: () => false,
    sessionRefreshCallback: () => "unused", createIncomingPromptSpec: () => { throw new Error("unexpected prompt"); },
    createSessionActionSpec: () => { throw new Error("unexpected prompt"); }, sendLongSpec: async () => {}, setSessionStatus: async () => {} });
  const operation = sender.route(session, { telegramChatId: "web:local", telegramMessageId: "one", text: "hello" });
  await started;
  assert.equal(active.has("dispatch"), false);
  assert.equal(store.getActiveTurnRoute("dispatch"), null);
  assert.equal(binding.hasPendingDispatch("dispatch"), true);
  const mutation = new SessionMutationService({ store, inFlightTurnIdByThread: active, bindingService: binding,
    createSessionActionSpec: (_session, kind, body) => createMessage({ kind, body: [{ type: "text", text: body }] }),
    sessionRefreshCallback: () => "unused" } as never);
  const blockedRelease = await mutation.releaseBridgeSessionLock("web:local", session.id, store.getSessionLease(session.id)!.version);
  assert.equal(blockedRelease.kind, "error");
  assert.equal(store.getSessionLease(session.id)?.ownerBindingId, owner.binding.id);
  assert.equal((await binding.request("123", session.id)).outcome?.pending, true);
  await binding.promote(session);
  assert.equal(store.getSessionLease(session.id)?.ownerBindingId, owner.binding.id);
  finish();
  assert.deepEqual(await operation, { routed: true });
  assert.equal(active.get("dispatch"), "real-turn");
  assert.equal(store.getActiveTurnRoute("dispatch")?.sourceId, "web:local");
  assert.equal(store.getSessionLease(session.id)?.ownerBindingId, owner.binding.id);
  active.delete("dispatch");
  store.completeTurnRoute("real-turn", "completed");
  store.clearSessionOwnerTurn(session.id, "real-turn");
  await binding.promote(session);
  assert.equal(store.getSessionBindingById(store.getSessionLease(session.id)!.ownerBindingId!)?.sourceId, "123");
});

test("explicit Bridge release unsubscribes before dropping ownership and restores it on failure", async (t) => {
  for (const outcome of ["notLoaded", "notSubscribed", "unsubscribed", "disconnected", "failure"] as const) {
    const store = new BridgeStore(":memory:");
    t.after(() => store.close());
    const sourceId = `web:${outcome}`;
    const session = await store.upsertDiscoveredSession({
      telegramChatId: sourceId,
      codexThreadId: `thread-${outcome}`,
      pathKey: "/work"
    });
    store.claimSession(session.id, sourceId);
    await store.setActiveSession(sourceId, session.id);
    const unsubscribeCalls: string[] = [];
    const binding = new SessionBindingService({
      store,
      inFlightTurnIdByThread: new Map(),
      getSessionDirectory: () => "/work",
      notify: async () => {}
    });
    const mutation = new SessionMutationService({
      store,
      inFlightTurnIdByThread: new Map(),
      bindingService: binding,
      isRuntimeConnected: () => outcome !== "disconnected",
      codexClient: {
        unsubscribeThread: async (threadId: string) => {
          unsubscribeCalls.push(threadId);
          if (outcome === "failure") throw new Error("unsubscribe unavailable");
          return outcome === "disconnected" ? "notSubscribed" : outcome;
        }
      },
      createSessionActionSpec: (_session, kind, body) => createMessage({ kind, body: [{ type: "text", text: body }] }),
      sessionRefreshCallback: () => "unused"
    } as never);

    const message = await mutation.releaseBridgeSessionLock(
      sourceId,
      session.id,
      store.getSessionLease(session.id)!.version
    );
    assert.deepEqual(unsubscribeCalls, outcome === "disconnected" ? [] : [session.codexThreadId]);
    if (outcome === "failure") {
      assert.equal(message.kind, "error");
      assert.equal(store.getSessionLease(session.id)?.state, "active");
      assert.equal((await store.getActiveSession(sourceId))?.id, session.id);
    } else {
      assert.equal(message.kind, "system");
      assert.equal(store.getSessionLease(session.id)?.state, "unbound");
      assert.equal(await store.getActiveSession(sourceId), null);
    }
  }
});

test("rejected dispatch releases its fence and promotes only the latest applicant, including nested dispatches", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "rejected", pathKey: "/work" });
  const owner = store.claimSession(session.id, "123");
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work", notify: async () => {} });
  await assert.rejects(binding.runDispatch(session, async () => {
    await binding.runDispatch(session, async () => {
      assert.equal((await binding.request("web:local", session.id)).outcome?.pending, true);
      assert.equal((await binding.request("slack:T:C:1", session.id)).outcome?.replacedSourceId, "web:local");
    });
    assert.equal(store.getSessionLease(session.id)?.ownerBindingId, owner.binding.id);
    throw new Error("send explicitly rejected");
  }), /explicitly rejected/);
  assert.equal(store.getSessionBindingById(store.getSessionLease(session.id)!.ownerBindingId!)?.sourceId, "slack:T:C:1");
  assert.equal(store.getActiveTurnRoute("rejected"), null);
});

test("shared binding keeps accepted work with its owner, replaces applicants and cancels only the requester", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "busy", pathKey: "/work" });
    const owner = store.claimSession(session.id, "123");
    store.setSessionOwnerTurn(session.id, "123", "turn");
    const events: SessionBindingEvent[] = [];
    const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map([["busy", "turn"]]),
      getSessionDirectory: () => "/work", notify: async (event) => { events.push(event); } });
    assert.equal((await binding.request("web:local", session.id)).outcome?.pending, true);
    const version = store.getSessionLease(session.id)!.version;
    const next = (await binding.request("slack:T:C:1", session.id)).outcome!;
    assert.equal(next.replacedSourceId, "web:local");
    assert.ok(events.some((event) => event.kind === "replaced" && event.sourceId === "web:local" && event.otherSourceId === "slack:T:C:1"));
    assert.equal(store.getSessionLease(session.id)?.ownerBindingId, owner.binding.id);
    assert.equal(store.getSessionLease(session.id)?.ownerTurnId, "turn");
    assert.equal((await binding.cancel("web:local", session.id)).reason, "not_pending");
    assert.equal((await binding.cancel("slack:T:C:1", session.id, version)).reason, "stale");
    assert.equal((await binding.cancel("slack:T:C:1", session.id, next.lease.version)).cancelled, true);
    assert.equal(store.getSessionLease(session.id)?.state, "active");
    assert.equal(store.getSessionLease(session.id)?.ownerTurnId, "turn");
    assert.equal((await binding.request("web:local", session.id, version)).outcome?.reason, "stale");
    assert.equal(store.getSessionLease(session.id)?.pendingBindingId, null);
    assert.equal(sourceLabel("web:local"), "Web · web:local");
  } finally { store.close(); }
});

test("shared handoff checks approvals, input and every accepted queue state inside its transaction", async () => {
  for (const blocker of ["pending", "awaitingInput", "submitting", "queued", "unknown", "route"] as const) {
    const store = new BridgeStore(":memory:");
    try {
      const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "blocked", pathKey: "/work" });
      const owner = store.claimSession(session.id, "123");
      let decisionId: string | null = null;
      let queueId: string | null = null;
      if (blocker === "pending" || blocker === "awaitingInput") {
        const decision = await store.createOrReplacePendingDecision({ sessionId: session.id, telegramChatId: "123", approvalId: "approval",
          kind: "test", title: "private", summary: "private", requiresUserInput: blocker === "awaitingInput" });
        decisionId = decision.id;
        if (blocker === "awaitingInput") await store.resolveDecision(decision.id, "awaitingInput");
      } else if (blocker === "route") {
        store.recordTurnRoute({ sessionId: session.id, turnId: "turn", codexThreadId: "blocked", sourceId: "123", bindingId: owner.binding.id });
      } else {
        queueId = (await store.createQueuedSubmission({ sessionId: session.id, telegramChatId: "123", codexThreadId: "blocked",
          codexQueueId: "queue", clientUserMessageId: "client", sourceMessageId: "message", summary: "private", attachmentPaths: [], state: blocker })).id;
      }
      const blockedRelease = store.releaseBridgeSessionLock(session.id, "123", store.getSessionLease(session.id)!.version);
      assert.equal(blockedRelease.released, false, blocker);
      assert.equal(blockedRelease.reason, "busy", blocker);
      const events: SessionBindingEvent[] = [];
      const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work",
        notify: async (event) => { events.push(event); } });
      assert.equal((await binding.request("web:local", session.id)).outcome?.pending, true, blocker);
      const pendingRelease = store.releaseBridgeSessionLock(session.id, "123", store.getSessionLease(session.id)!.version);
      assert.equal(pendingRelease.released, false, `${blocker}: pending handoff`);
      assert.equal(pendingRelease.reason, "busy", `${blocker}: pending handoff`);
      assert.equal(store.releaseStaleBridgeSessionLock(session.id, store.getSessionLease(session.id)!.version), false, blocker);
      await binding.promote(session);
      assert.equal(store.getSessionLease(session.id)?.ownerBindingId, owner.binding.id, blocker);
      if (decisionId) await store.resolveDecision(decisionId, "cancelled");
      if (queueId) await store.updateQueuedSubmission(queueId, { state: "cancelled" });
      if (blocker === "route") store.completeTurnRoute("turn", "completed");
      events.length = 0;
      await binding.promote(session);
      assert.equal(store.getSessionBindingById(store.getSessionLease(session.id)!.ownerBindingId!)?.sourceId, "web:local", blocker);
      assert.deepEqual(events.map((event) => [event.kind, event.sourceId]), [["acquired", "web:local"], ["transferred", "123"]]);
    } finally { store.close(); }
  }
});

test("terminal notifications promote ownership while preserving its requested selection and the finished turn route", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "running", pathKey: "/work" });
    const owner = store.claimSession(session.id, "123");
    store.setSessionOwnerTurn(session.id, "123", "turn");
    store.recordTurnRoute({ sessionId: session.id, codexThreadId: "running", turnId: "turn", sourceId: "123", bindingId: owner.binding.id });
    const running = new Map([["running", "turn"]]);
    const binding = new SessionBindingService({ store, inFlightTurnIdByThread: running, getSessionDirectory: () => "/work", notify: async () => {} });
    await binding.request("web:local", session.id);
    const turns = new NotificationTurnService({ store, inFlightTurnIdByThread: running, assistantOutputByThread: new Map(),
      errorSeenByThread: new Map(), lastAssistantTelegramByThread: new Map(), queuedSubmissionService: { reconcileStartedSubmission: async () => {} },
      resolveNotificationSession: async () => session, applyStatusUpdate: async () => {}, handleRecoveryTaskComplete: async () => false,
      clearProgressMessageForThread: async () => {}, scheduleGoShortcut: () => {}, cancelGoShortcut: () => {},
      rememberRateLimitSession: () => {}, deliverVersionUpdateAfterRootTurn: async () => false,
      promoteSessionHandoff: (value) => binding.promote(value) });
    await turns.handleTurnLifecycle({ kind: "completed", threadId: "running", turnId: "turn", terminalState: "completed" });
    assert.equal(store.getSessionBindingById(store.getSessionLease(session.id)!.ownerBindingId!)?.sourceId, "web:local");
    const route = store.completeTurnRoute("turn", "completed");
    assert.equal(route?.sourceId, "123");
    assert.equal(route?.bindingId, owner.binding.id);
    assert.equal((await store.getActiveSession("123")), null);
    assert.equal((await store.getActiveSession("web:local"))?.id, session.id);
  } finally { store.close(); }
});

test("idle transfer is immediate and notification failure cannot roll back ownership", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "idle", pathKey: "/work" });
    store.claimSession(session.id, "123");
    const events: SessionBindingEvent[] = [];
    const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work",
      notify: async () => { throw new Error("transport offline"); } });
    binding.subscribe((event) => { events.push(event); });
    const result = await binding.request("web:local", session.id);
    assert.equal(result.outcome?.owned, true);
    assert.equal(result.outcome?.pending, false);
    assert.deepEqual(events.map((event) => [event.kind, event.sourceId]), [["acquired", "web:local"], ["transferred", "123"]]);
    assert.equal((await store.getSessionById(session.id))?.telegramChatId, "web:local");
    events.length = 0;
    assert.equal((await binding.request("web:local", session.id)).outcome?.reason, "already_owned");
    assert.deepEqual(events, []);
  } finally { store.close(); }
});

test("external and archived sessions reject applications, and stale cleanup cannot discard an idle pending request", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "external", pathKey: "/work" });
    store.claimSession(session.id, "123");
    const pending = store.requestSessionHandoff(session.id, "web:local", false);
    assert.equal(store.releaseStaleBridgeSessionLock(session.id, pending.lease.version), false);
    const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work", notify: async () => {} });
    assert.equal((await binding.request("123", session.id)).outcome?.reason, "already_owned");
    assert.equal(store.getSessionLease(session.id)?.pendingBindingId, pending.binding.id);
    const external = store.markSessionExternalUnknown(session.id);
    assert.equal((await binding.request("web:local", session.id)).outcome?.reason, "unavailable");
    assert.deepEqual(store.getSessionLease(session.id), external);
    await store.markSessionCodexArchived(session.id);
    assert.equal((await binding.request("web:local", session.id)).outcome, null);
  } finally { store.close(); }
});

test("Slack channel session inventory includes bindings from its historical threads", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const root = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "thread-root",
      pathKey: "/workspace/root"
    });
    const historicalThread = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C:123.456",
      codexThreadId: "thread-history",
      pathKey: "/workspace/history"
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:OTHER:123.456",
      codexThreadId: "thread-other-channel",
      pathKey: "/workspace/other"
    });

    const sessions = await store.listKnownSessions("slack:T:C");
    assert.deepEqual(sessions.map((session) => session.codexThreadId).sort(), [
      root.codexThreadId,
      historicalThread.codexThreadId
    ].sort());
  } finally {
    store.close();
  }
});

test("session lease allows one source binding to own a session", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });

    const first = store.claimSession(session.id, "chat-1");
    assert.equal(first.owned, true);
    assert.equal(first.reason, "claimed");
    assert.equal(first.lease.ownerBindingId, first.binding.id);

    const sameSource = store.claimSession(session.id, "chat-1");
    assert.equal(sameSource.owned, true);
    assert.equal(sameSource.reason, "already_owned");

    const otherSource = store.claimSession(session.id, "slack:T:C:123.456");
    assert.equal(otherSource.owned, false);
    assert.equal(otherSource.reason, "owned_by_other");
    assert.equal(otherSource.lease.ownerBindingId, first.binding.id);
    assert.equal(otherSource.binding.platform, "slack");
    assert.equal(otherSource.binding.channelId, "C");
    assert.equal(otherSource.binding.threadId, "123.456");

    assert.equal(store.setSessionOwnerTurn(session.id, "chat-1", "turn-1"), true);
    assert.equal(store.setSessionOwnerTurn(session.id, "slack:T:C:123.456", "turn-2"), false);
    const pending = store.requestSessionHandoff(session.id, "slack:T:C:123.456", false);
    assert.equal(pending.pending, true);
    const replaced = store.requestSessionHandoff(session.id, "slack:T:C:999.000", false);
    assert.equal(replaced.pending, true);
    assert.equal(store.getSessionLease(session.id)?.pendingBindingId, replaced.binding.id);
    assert.equal(store.clearSessionOwnerTurn(session.id, "turn-1"), true);
    assert.equal(store.promotePendingSessionOwner(session.id, null)?.ownerBindingId, replaced.binding.id);
    assert.equal(store.getSessionLease(session.id)?.ownerTurnId, null);
  } finally {
    store.close();
  }
});

test("Web discovery and explicit binding use the same platform metadata", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const discovered = await store.upsertDiscoveredSession({
      telegramChatId: "web:local", codexThreadId: "thread-web", pathKey: "/workspace/web"
    });
    const binding = store.getSessionBinding(discovered.id, "web:local");
    assert.ok(binding);
    assert.equal(binding.platform, "web");
    assert.equal(binding.botKey, "web");
    assert.equal(binding.channelId, null);
    assert.equal(binding.threadId, null);
    assert.equal(store.ensureSessionBinding(discovered.id, "web:local").id, binding.id);

    const other = await store.upsertDiscoveredSession({
      telegramChatId: "123456", codexThreadId: "thread-tg", pathKey: "/workspace/tg"
    });
    const explicit = store.ensureSessionBinding(other.id, "web:local");
    assert.equal(explicit.platform, "web");
    assert.equal(explicit.sourceId, "web:local");
    assert.equal(store.listSessionBindings(other.id).length, 2);
  } finally {
    store.close();
  }
});

test("Web participates in the existing latest-applicant session handoff", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C:123.456", codexThreadId: "thread-web-handoff", pathKey: "/workspace/handoff"
    });
    const owner = store.claimSession(session.id, "slack:T:C:123.456");
    assert.equal(owner.owned, true);
    assert.equal(store.setSessionOwnerTurn(session.id, owner.binding.sourceId, "running-turn"), true);
    const web = store.requestSessionHandoff(session.id, "web:local", false);
    assert.equal(web.pending, true);
    assert.equal(web.binding.platform, "web");
    assert.equal(store.getSessionLease(session.id)?.ownerBindingId, owner.binding.id);
    assert.equal(store.getSessionLease(session.id)?.ownerTurnId, "running-turn");

    const telegram = store.requestSessionHandoff(session.id, "123456", false);
    assert.equal(telegram.pending, true);
    assert.equal(store.getSessionLease(session.id)?.pendingBindingId, telegram.binding.id);
    const latest = store.requestSessionHandoff(session.id, "web:local", false);
    assert.equal(latest.binding.id, web.binding.id);
    assert.equal(store.getSessionLease(session.id)?.pendingBindingId, web.binding.id);
    assert.equal(store.clearSessionOwnerTurn(session.id, "running-turn"), true);
    assert.equal(store.promotePendingSessionOwner(session.id, null)?.ownerBindingId, web.binding.id);
    assert.equal(store.claimSession(session.id, "web:local").reason, "already_owned");
  } finally {
    store.close();
  }
});

test("invalid Web discovery is rejected before any session or chat is written", async () => {
  const store = new BridgeStore(":memory:");
  try {
    await assert.rejects(store.upsertDiscoveredSession({
      telegramChatId: "web:", codexThreadId: "thread-invalid-web", pathKey: "/workspace/invalid"
    }), /Invalid Web source address/);
    assert.equal(await store.getSessionByThreadId("thread-invalid-web"), null);
    assert.deepEqual(await store.listChatIds(), []);

    const valid = await store.upsertDiscoveredSession({
      telegramChatId: "web:local", codexThreadId: "thread-valid-web", pathKey: "/workspace/original"
    });
    await assert.rejects(store.upsertDiscoveredSession({
      telegramChatId: "web:local:window-a", codexThreadId: "thread-valid-web", pathKey: "/workspace/changed"
    }), /Invalid Web source address/);
    assert.deepEqual(await store.getSessionById(valid.id), valid);
    assert.deepEqual(await store.listChatIds(), ["web:local"]);
  } finally {
    store.close();
  }
});

test("window takeover leaves session ownership and a running turn route untouched", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "web:local", codexThreadId: "thread-web-window", pathKey: "/workspace/window"
    });
    const owner = store.claimSession(session.id, "web:local");
    assert.equal(store.setSessionOwnerTurn(session.id, "web:local", "web-turn"), true);
    store.recordTurnRoute({
      turnId: "web-turn", sessionId: session.id, codexThreadId: session.codexThreadId,
      bindingId: owner.binding.id, sourceId: "web:local"
    });
    const leaseBefore = store.getSessionLease(session.id);
    const routeBefore = store.getActiveTurnRoute(session.codexThreadId);

    const windows = new WebWindowLeaseManager();
    assert.equal(windows.acquire("window-a").acquired, true);
    assert.equal(windows.acquire("window-b", { takeover: true }).acquired, true);
    assert.deepEqual(store.getSessionLease(session.id), leaseBefore);
    assert.deepEqual(store.getActiveTurnRoute(session.codexThreadId), routeBefore);
  } finally {
    store.close();
  }
});

test("session lease release paths keep active turns and external locks safe", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-release",
      pathKey: "/workspace/project"
    });
    const owner = store.claimSession(session.id, "chat-1");
    assert.equal(owner.owned, true);
    assert.equal(store.setSessionOwnerTurn(session.id, "chat-1", "turn-1"), true);

    const busy = store.releaseBridgeSessionLock(session.id, "chat-1", store.getSessionLease(session.id)?.version);
    assert.equal(busy.released, false);
    assert.equal(busy.reason, "busy");

    assert.equal(store.clearSessionOwnerTurn(session.id, "turn-1"), true);
    const released = store.releaseBridgeSessionLock(session.id, "chat-1", store.getSessionLease(session.id)?.version);
    assert.equal(released.released, true);
    assert.equal(store.getSessionLease(session.id)?.state, "unbound");

    store.markSessionExternalUnknown(session.id);
    const releasing = store.beginCodexSessionRelease(session.id, store.getSessionLease(session.id)?.version);
    assert.equal(releasing?.state, "releasing");
    assert.equal(store.finishCodexSessionRelease(session.id, false)?.state, "external_unknown");
    const retry = store.beginCodexSessionRelease(session.id, store.getSessionLease(session.id)?.version);
    assert.equal(retry?.state, "releasing");
    assert.equal(store.finishCodexSessionRelease(session.id, true)?.state, "unbound");
  } finally {
    store.close();
  }
});

test("account changes clear Bridge leases without clearing Codex external locks", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const active = await store.upsertDiscoveredSession({
      telegramChatId: "chat-active",
      codexThreadId: "thread-active",
      pathKey: "/workspace/active"
    });
    const handoff = await store.upsertDiscoveredSession({
      telegramChatId: "chat-handoff",
      codexThreadId: "thread-handoff",
      pathKey: "/workspace/handoff"
    });
    const external = await store.upsertDiscoveredSession({
      telegramChatId: "chat-external",
      codexThreadId: "thread-external",
      pathKey: "/workspace/external"
    });

    store.claimSession(active.id, "chat-active");
    store.claimSession(handoff.id, "chat-handoff");
    assert.equal(store.setSessionOwnerTurn(handoff.id, "chat-handoff", "turn-handoff"), true);
    assert.equal(store.requestSessionHandoff(handoff.id, "chat-next", false).pending, true);
    store.markSessionExternalUnknown(external.id);
    assert.equal(store.getSessionLease(handoff.id)?.state, "handoff_pending");

    assert.equal(store.releaseBridgeLocksAfterAuthChange(), 2);
    assert.equal(store.getSessionLease(active.id)?.state, "unbound");
    assert.equal(store.getSessionLease(handoff.id)?.state, "unbound");
    assert.equal(store.getSessionLease(external.id)?.state, "external_unknown");
  } finally {
    store.close();
  }
});

test("turn routes survive in-memory routing loss and close idempotently", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C:1.000",
      codexThreadId: "thread-route",
      pathKey: "/workspace/project"
    });
    const binding = store.getSessionBinding(session.id, "slack:T:C:1.000");
    assert.ok(binding);
    const route = store.recordTurnRoute({
      turnId: "turn-route-1",
      sessionId: session.id,
      codexThreadId: session.codexThreadId,
      bindingId: binding.id,
      sourceId: binding.sourceId
    });
    assert.equal(route.state, "active");
    assert.equal(store.getActiveTurnRoute(session.codexThreadId)?.sourceId, binding.sourceId);
    assert.equal(store.completeTurnRoute(route.turnId, "completed")?.state, "completed");
    assert.equal(store.getActiveTurnRoute(session.codexThreadId), null);
    assert.equal(store.completeTurnRoute(route.turnId, "completed")?.state, "completed");
  } finally {
    store.close();
  }
});

test("a new turn interrupts the older active route on the same thread", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    const first = store.recordTurnRoute({
      turnId: "turn-1",
      sessionId: session.id,
      codexThreadId: session.codexThreadId,
      bindingId: null,
      sourceId: "chat-1"
    });
    const second = store.recordTurnRoute({
      turnId: "turn-2",
      sessionId: session.id,
      codexThreadId: session.codexThreadId,
      bindingId: null,
      sourceId: "chat-1"
    });

    assert.equal(store.completeTurnRoute(first.turnId, "completed")?.state, "interrupted");
    assert.equal(store.getActiveTurnRoute(session.codexThreadId)?.turnId, second.turnId);
  } finally {
    store.close();
  }
});

test("shared-session migration merges duplicate Codex threads and preserves source bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-shared-session-migration-"));
  const databasePath = join(directory, "bridge.sqlite");

  try {
    const store = new BridgeStore(databasePath);
    const first = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-duplicate",
      pathKey: "/workspace/old",
      latestActivityAt: 100
    });
    await store.ensureChat("slack:T:C:123.456");
    const legacyDuplicateId = "session-legacy-duplicate";
    const sqlite = new Database(databasePath);
    sqlite.exec("DROP INDEX sessions_codex_thread_idx");
    sqlite.prepare(`
      INSERT INTO sessions (
        id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
        batch_decision_message_id, codex_archived_at, latest_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      legacyDuplicateId,
      "slack:T:C:123.456",
      "thread-duplicate",
      "/workspace/current",
      "/workspace/current",
      "current",
      200,
      1,
      200
    );
    sqlite.close();
    const second = await store.getSessionById(legacyDuplicateId);
    assert.ok(second);
    await store.setActiveSession("chat-1", first.id);
    await store.selectSession("slack:T:C:123.456", second.id);
    await store.addMessage({ sessionId: first.id, role: "user", text: "old" });
    await store.addMessage({ sessionId: second.id, role: "assistant", text: "new" });
    store.close();

    const migrationSqlite = new Database(databasePath);
    migrationSqlite.prepare("DELETE FROM session_bindings").run();
    migrationSqlite.prepare("DELETE FROM session_leases").run();
    migrationSqlite.prepare("DELETE FROM schema_migrations WHERE version = '010_shared_session_bindings'").run();
    migrationSqlite.prepare("UPDATE chats SET updated_at = CASE telegram_chat_id WHEN 'chat-1' THEN 1000 ELSE 2000 END").run();
    migrationSqlite.close();

    const migrated = new BridgeStore(databasePath);
    try {
      const sessions = await migrated.listSessionsForPolling({ includeArchived: true });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.codexThreadId, "thread-duplicate");
      assert.ok((sessions[0]?.latestActivityAt ?? 0) >= 200);
      assert.equal((await migrated.listRecentMessages(sessions[0]!.id, 10)).length, 2);
      assert.equal(migrated.listSessionBindings(sessions[0]!.id).length, 2);
      const lease = migrated.getSessionLease(sessions[0]!.id);
      assert.equal(lease?.state, "active");
      const owner = lease?.ownerBindingId ? migrated.getSessionBindingById(lease.ownerBindingId) : null;
      assert.equal(owner?.sourceId, "slack:T:C:123.456");
    } finally {
      migrated.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
