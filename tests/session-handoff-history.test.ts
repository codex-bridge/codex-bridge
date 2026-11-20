import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { SessionBindingService } from "../src/bridge/sessions/binding.js";
import { SessionHandoffHistoryService } from "../src/bridge/sessions/handoff-history.js";
import { BridgeService } from "../src/bridge/service.js";
import { testConfig } from "./bridge-test-config.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { handleSessionAction } from "../src/bridge/interactions/handlers/sessions.js";
import { deliverTelegramInteraction } from "../src/telegram/interactions/responder.js";
import { deliverSlackInteraction } from "../src/slack/interactions/responder.js";
import type { SlackMessageTransport } from "../src/slack/transport.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { MessageDeliveryService } from "../src/bridge/messages/sender.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { createMessage } from "../src/bridge/messages/factory.js";

async function fixture(t: TestContext) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "owner", codexThreadId: "target", pathKey: "/target" });
  const other = await store.upsertDiscoveredSession({ telegramChatId: "next", codexThreadId: "other", pathKey: "/other" });
  store.claimSession(session.id, "owner");
  await store.selectSession("next", session.id);
  let reads = 0;
  let beforeRead = async () => {};
  const delivered: string[] = [];
  const history = new SessionHandoffHistoryService({ store,
    reader: { readSessionTranscript: async (value) => {
      reads++; await beforeRead(); return { session: value, recentMessages: [{ role: "assistant", text: "history" }] };
    } },
    deliver: async (source, _session, _messages, canSend) => { if (await canSend()) delivered.push(source); }
  });
  const events: string[] = [];
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(),
    getSessionDirectory: () => "/target", notify: async (event) => {
      events.push(event.kind);
      if (event.kind === "acquired") await history.post(event.sourceId, event.sessionId);
    }
  });
  binding.subscribe((event) => history.observe(event));
  return { store, session, other, history, binding, delivered, events,
    reads: () => reads, beforeRead: (operation: () => Promise<void>) => { beforeRead = operation; } };
}

test("immediate acquisition restores history once, after its caller delivers the receipt", async (t) => {
  const f = await fixture(t);
  await f.binding.request("next", f.session.id);
  assert.equal(f.reads(), 0);
  await Promise.all([f.history.post("next", f.session.id), f.history.post("next", f.session.id)]);
  await f.binding.request("next", f.session.id);
  await f.history.post("next", f.session.id);
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.delivered, ["next"]);
});

test("delayed acquisition restores history automatically only after accepted work finishes", async (t) => {
  const f = await fixture(t);
  f.store.setSessionOwnerTurn(f.session.id, "owner", "turn");
  assert.equal((await f.binding.request("next", f.session.id)).outcome?.pending, true);
  await f.history.post("next", f.session.id);
  await f.binding.promote(f.session);
  assert.equal(f.reads(), 0);
  f.store.clearSessionOwnerTurn(f.session.id, "turn");
  await f.binding.promote(f.session);
  await f.binding.promote(f.session);
  assert.deepEqual(f.delivered, ["next"]);
  assert.equal(f.reads(), 1);
});

test("replaced requests never receive history; only the latest requester acquires it", async (t) => {
  const f = await fixture(t);
  f.store.setSessionOwnerTurn(f.session.id, "owner", "turn");
  await f.binding.request("next", f.session.id);
  await f.binding.request("latest", f.session.id);
  f.store.clearSessionOwnerTurn(f.session.id, "turn");
  await f.binding.promote(f.session);
  assert.ok(f.events.includes("replaced"));
  assert.deepEqual(f.delivered, ["latest"]);
});

test("a newer selection cancels the old pending request without reading history", async (t) => {
  const f = await fixture(t);
  f.store.setSessionOwnerTurn(f.session.id, "owner", "turn");
  await f.binding.request("next", f.session.id);
  await f.store.selectSession("next", f.other.id);
  f.store.clearSessionOwnerTurn(f.session.id, "turn");
  await f.binding.promote(f.session);
  assert.equal(f.reads(), 0);
  assert.equal(f.store.getSessionLease(f.session.id)?.pendingBindingId, null);
});

for (const change of ["selection", "owner", "archive"] as const) {
  test(`a ${change} change while history loads discards the old result`, async (t) => {
    const f = await fixture(t);
    await f.binding.request("next", f.session.id);
    f.beforeRead(async () => {
      if (change === "selection") await f.store.selectSession("next", f.other.id);
      else if (change === "owner") f.store.requestSessionHandoff(f.session.id, "someone-else", true);
      else await f.store.markSessionCodexArchived(f.session.id);
    });
    await f.history.post("next", f.session.id);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.delivered, []);
  });
}

test("Web acquisition continues to retrieve history itself without chat replay", async (t) => {
  const f = await fixture(t);
  await f.binding.request("web:local", f.session.id);
  await f.history.post("web:local", f.session.id);
  assert.equal(f.reads(), 0);
});

test("a new turn under the same owner does not invalidate the acquisition's history", async (t) => {
  const f = await fixture(t);
  await f.binding.request("next", f.session.id);
  f.store.setSessionOwnerTurn(f.session.id, "next", "new-turn");
  await f.history.post("next", f.session.id);
  assert.deepEqual(f.delivered, ["next"]);
});

test("a missing Slack receipt cannot start the history delivery", async () => {
  let restored = false;
  const context = { platform: "slack" as const, conversationId: "slack:T:C:1", surfaceId: "slack:T:C:1" };
  await deliverSlackInteraction({ sendMessageSpec: async () => null } as unknown as SlackMessageTransport, context, {
    mode: "send", target: "conversation", message: createMessage({ kind: "system", scope: "global" }),
    afterDelivery: async () => { restored = true; }
  });
  assert.equal(restored, false);
});

for (const platform of ["slack", "telegram"] as const) {
  test(`${platform} delivers the receipt before the last five conversation messages`, async (t) => {
    const store = new BridgeStore(":memory:"); t.after(() => store.close());
    const source = platform === "slack" ? "slack:T:C:123.456" : "200";
    const sent: MessageSpec[] = [];
    const service = new BridgeService(testConfig(":memory:"), store, {
      listRecentThreadMessages: async (_thread: string, limit: number) => {
        assert.equal(limit, 5);
        return Array.from({ length: 7 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `message ${index + 1}` })).slice(-limit);
      }
    } as unknown as CodexAppServerClient);
    (service as unknown as { runtimeState: string }).runtimeState = "connected";
    const send = async (chat: string, message: MessageSpec) => { if (chat === source) sent.push(message); return { message_id: String(sent.length) }; };
    service.registerMessageTransport({ name: platform, wholeMessageSpecs: true, canHandle: () => true,
      sendMessageSpec: send, sendMessage: async () => { throw new Error("Expected structured messages"); },
      editMessageText: async () => true, clearMessageActions: async () => true,
      deleteMessage: async () => true, sendTyping: async () => {} });
    const session = await store.upsertDiscoveredSession({ telegramChatId: "100", codexThreadId: "target", pathKey: "/project" });
    store.claimSession(session.id, "100");
    const context = { platform, conversationId: source, surfaceId: source, sourceMessageId: "button" };
    const delivery = await handleSessionAction(service, context, { type: "session.handoff", sessionId: session.id });
    assert.equal(sent.some((spec) => spec.body.some((part) => part.type === "text" && part.text.includes("message 3"))), false);
    if (platform === "telegram") {
      await deliverTelegramInteraction(context, delivery, { clearActions: async () => {},
        edit: async (spec) => { sent.push(spec); }, send: async (spec) => { sent.push(spec); } });
    } else {
      await deliverSlackInteraction({ sendMessageSpec: send,
        editMessageSpec: async (_chat: string, _id: string, spec: MessageSpec) => { sent.push(spec); return true; }
      } as unknown as SlackMessageTransport, context, delivery);
    }
    await service.postSessionHandoffHistory(source, session.id);
    assert.match(renderLegacyMessage(sent[0]!), /bound to this conversation/);
    assert.deepEqual(sent.filter((spec) => spec.kind === "user" || spec.kind === "codex")
      .map((spec) => spec.body.filter((part) => part.type === "text" || part.type === "markdown").map((part) => part.text)[0]),
    ["message 3", "message 4", "message 5", "message 6", "message 7"]);
    assert.equal(sent.filter((spec) => spec.actions.some((action) => action.id === "go")).length, 1);
  });
}

for (const outcome of ["recovered", "occupied", "error", "selection-changed"] as const) {
  test(`explicit external acquisition: ${outcome}`, async (t) => {
    const store = new BridgeStore(":memory:"); t.after(() => store.close());
    const session = await store.upsertDiscoveredSession({ telegramChatId: "100", codexThreadId: "external", pathKey: "/external" });
    const other = await store.upsertDiscoveredSession({ telegramChatId: "200", codexThreadId: "other", pathKey: "/other" });
    await store.selectSession("200", session.id);
    const lease = store.markSessionExternalUnknown(session.id);
    let resumes = 0;
    const service = new BridgeService(testConfig(":memory:"), store, {
      readThreadStatus: async () => ({ activity: "idle", activityType: "notLoaded" }),
      resumeThread: async () => {
        resumes++;
        if (outcome === "occupied") throw new Error("thread already has an active writer");
        if (outcome === "error") throw new Error("authentication unavailable");
        if (outcome === "selection-changed") await store.selectSession("200", other.id);
        return { messages: [] };
      }
    } as unknown as CodexAppServerClient);
    (service as unknown as { runtimeState: string }).runtimeState = "connected";
    // Old Refresh buttons are inert even with an obsolete lease version.
    const before = store.getSessionLease(session.id);
    await service.refreshSessionView("200", session.id, 0);
    assert.deepEqual(store.getSessionLease(session.id), before);
    assert.equal(resumes, 0);
    const stale = await service.requestSessionHandoff("200", session.id, lease.version - 1);
    assert.match(renderLegacyMessage(stale), /latest available actions/);
    assert.equal(resumes, 0);
    const result = await service.requestSessionHandoff("200", session.id, lease.version);
    assert.equal(resumes, 1);
    assert.ok(result.actions.every((action) => action.id !== "refresh"));
    if (outcome === "recovered") {
      assert.match(renderLegacyMessage(result), /bound to this conversation/);
      assert.equal(store.getSessionLease(session.id)?.ownerBindingId, store.getSessionBinding(session.id, "200")?.id);
    } else if (outcome === "selection-changed") {
      assert.match(renderLegacyMessage(result), /selection changed/);
      assert.equal((await store.getActiveSession("200"))?.id, other.id);
      assert.equal(store.getSessionLease(session.id)?.ownerBindingId, null);
    } else {
      assert.match(renderLegacyMessage(result), outcome === "error" ? /authentication unavailable/ : /occupied outside/);
      assert.equal(result.actions[0]?.label, "Use this session next");
      assert.equal(store.getSessionLease(session.id)?.state, "external_unknown");
    }
  });
}

for (const structured of [false, true]) {
  test(`queued ${structured ? "structured" : "plain"} history rechecks authorization before sending`, async () => {
    const queue = new KeyedQueue();
    const sender = new MessageDeliveryService({ queue, maxLength: 4_000, getEnvelopeTitle: async () => "Codex" });
    let sent = 0;
    sender.registerTransport({ name: "test", wholeMessageSpecs: true, canHandle: () => true,
      ...(structured ? { sendMessageSpec: async () => { sent++; return { message_id: "sent" }; } } : {}),
      sendMessage: async () => { sent++; return { message_id: "sent" }; },
      editMessageText: async () => true, clearMessageActions: async () => true,
      deleteMessage: async () => true, sendTyping: async () => {} });
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const blocked = queue.run("200", async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); });
    await ready;
    let allowed = true;
    const pending = sender.sendLongSpec("200", createMessage({ kind: "user", scope: "global",
      body: [{ type: "text", text: "history" }] }), { canSend: async () => allowed });
    allowed = false; release();
    await Promise.all([blocked, pending]);
    assert.equal(sent, 0);
  });
}
