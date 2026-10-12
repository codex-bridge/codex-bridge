import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { SessionBindingService } from "../src/bridge/sessions/binding.js";
import { SessionActivationService } from "../src/bridge/sessions/activation.js";
import { SessionActivationError } from "../src/bridge/sessions/ownership.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import type { WebClient } from "@slack/web-api";
import { BridgeService } from "../src/bridge/service.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import { testConfig } from "./bridge-test-config.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";

const old = "slack:TTEST:CTEST:old";
const next = "slack:TTEST:CTEST:next";

for (const delayed of [false, true]) {
  test(`${delayed ? "delayed" : "immediate"} handoff selects the requested session instead of an old one`, async (t) => {
    const store = new BridgeStore(":memory:");
    t.after(() => store.close());
    const target = await store.upsertDiscoveredSession({ telegramChatId: old, codexThreadId: "target", pathKey: "/target" });
    const previous = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "previous", pathKey: "/previous" });
    store.claimSession(target.id, old);
    store.claimSession(previous.id, next);
    await store.selectSession(next, previous.id);
    const running = new Map<string, string>();
    if (delayed) { running.set("target", "turn"); store.setSessionOwnerTurn(target.id, old, "turn"); }
    const binding = new SessionBindingService({ store, inFlightTurnIdByThread: running,
      getSessionDirectory: () => "/target", notify: async () => {} });
    const result = await binding.request(next, target.id);
    assert.equal(result.outcome?.pending, delayed);
    assert.equal((await store.getActiveSession(next))?.id, target.id);
    if (delayed) {
      running.clear(); store.clearSessionOwnerTurn(target.id, "turn");
      await binding.promote(target);
    }
    assert.equal(store.getSessionLease(target.id)?.ownerBindingId, store.getSessionBinding(target.id, next)?.id);
    assert.equal((await store.getActiveSession(next))?.id, target.id);
  });
}

test("a newer selection invalidates an old pending handoff rather than acquiring its session", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const target = await store.upsertDiscoveredSession({ telegramChatId: old, codexThreadId: "target", pathKey: "/target" });
  const newer = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "newer", pathKey: "/newer" });
  const owner = store.claimSession(target.id, old);
  const running = new Map([["target", "turn"]]);
  store.setSessionOwnerTurn(target.id, old, "turn");
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: running,
    getSessionDirectory: () => "/target", notify: async () => {} });
  await binding.request(next, target.id);
  await store.selectSession(next, newer.id);
  running.clear(); store.clearSessionOwnerTurn(target.id, "turn");
  await binding.promote(target);
  assert.equal((await store.getActiveSession(next))?.id, newer.id);
  assert.equal(store.getSessionLease(target.id)?.ownerBindingId, owner.binding.id);
  assert.equal(store.getSessionLease(target.id)?.pendingBindingId, null);
});

test("a stale binding request cannot change selection", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const target = await store.upsertDiscoveredSession({ telegramChatId: old, codexThreadId: "target", pathKey: "/target" });
  const previous = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "previous", pathKey: "/previous" });
  store.claimSession(target.id, old);
  await store.selectSession(next, previous.id);
  assert.equal(store.requestSessionHandoff(target.id, next, true, -1).reason, "stale");
  assert.equal((await store.getActiveSession(next))?.id, previous.id);
});

test("slow activation cannot restore an older selection or expose its history", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const first = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "first", pathKey: "/first" });
  const newer = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "newer", pathKey: "/newer" });
  let finish!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const activation = new SessionActivationService({ store,
    sessionOwnershipService: { getSessionOwnershipPrompt: async () => null,
      assertSessionSwitchCanRelease: async () => {}, releasePreviousSessionAfterClaim: async () => {} },
    sessionReader: { resumeSession: async (session) => {
      started(); await new Promise<void>((resolve) => { finish = resolve; });
      return { session, recentMessages: [{ role: "assistant", text: "private history" }] };
    } }, isActiveWriterConflictError: () => false,
    clearBatchDecisionMessage: async () => {}, sessionRefreshCallback: () => "unused",
    createSessionActionSpec: (_session, kind, text) => createMessage({ kind, body: [{ type: "text", text }] }) });
  const result = activation.activateSession(next, first.id);
  await reading;
  await store.selectSession(next, newer.id);
  finish();
  await assert.rejects(result, SessionActivationError);
  assert.equal((await store.getActiveSession(next))?.id, newer.id);
});

test("Slack parent cards are edited in place without operational buttons, and missing parents are not recreated", async () => {
  const edits: Array<{ channel: string; ts: string; blocks?: Array<{ type: string }> }> = [];
  let missing = false;
  const transport = new SlackMessageTransport({ chat: {
    update: async (input: typeof edits[number]) => { edits.push(input); if (missing) throw new Error("message_not_found"); return {}; },
    postMessage: async () => { throw new Error("Must not recreate parent"); }
  } } as unknown as WebClient);
  const message = createMessage({ kind: "system", body: [{ type: "text", text: "Selected session" }] });
  await transport.updateConversationSession(next, message);
  assert.equal(edits[0]?.channel, "CTEST");
  assert.equal(edits[0]?.ts, "next");
  assert.ok(edits[0]?.blocks?.every((block) => block.type !== "actions"));
  missing = true;
  await transport.updateConversationSession(next, message);
  await transport.updateConversationSession("slack:TTEST:CTEST", message);
  assert.equal(edits.length, 2);
});

test("binding in a chat permits the next text immediately and refreshes both owners' parent cards", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const sentTo: string[] = [];
  const cards = new Map<string, MessageSpec>();
  const service = new BridgeService(testConfig(":memory:"), store, {
    sendTurn: async (threadId: string) => { sentTo.push(threadId); return { turnId: "turn" }; }
  } as unknown as CodexAppServerClient);
  (service as unknown as { runtimeState: string }).runtimeState = "connected";
  service.registerMessageTransport({ name: "slack", canHandle: () => true,
    updateConversationSession: async (source, message) => { cards.set(source, message); },
    sendMessage: async () => ({ message_id: "sent" }), editMessageText: async () => true,
    deleteMessage: async () => true, clearMessageActions: async () => true, sendTyping: async () => {} });
  const target = await store.upsertDiscoveredSession({ telegramChatId: old, codexThreadId: "target", pathKey: "/target" });
  const previous = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "previous", pathKey: "/previous" });
  store.claimSession(target.id, old);
  await store.selectSession(old, target.id);
  store.claimSession(previous.id, next);
  await store.selectSession(next, previous.id);
  await service.requestSessionHandoff(next, target.id);
  assert.equal((await service.handleIncomingUserText({ telegramChatId: next, telegramMessageId: "input", text: "hello" })).routed, true);
  assert.deepEqual(sentTo, ["target"]);
  const fields = (source: string) => cards.get(source)?.body.filter((part) => part.type === "field");
  assert.ok(fields(next)?.some((part) => part.label === "Binding" && part.value === "Bound here"));
  assert.ok(fields(old)?.some((part) => part.label === "Binding" && part.value === "In use in another conversation"));
  assert.ok(fields(old)?.some((part) => part.label === "Thread" && part.value === "old"));
});

test("changing selection while a previous task is running leaves that task and lease intact", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const previous = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "previous", pathKey: "/previous" });
  const target = await store.upsertDiscoveredSession({ telegramChatId: next, codexThreadId: "target", pathKey: "/target" });
  const owner = store.claimSession(previous.id, next);
  await store.selectSession(next, previous.id);
  store.setSessionOwnerTurn(previous.id, next, "running");
  store.recordTurnRoute({ sessionId: previous.id, codexThreadId: "previous", turnId: "running", sourceId: next, bindingId: owner.binding.id });
  const service = new BridgeService(testConfig(":memory:"), store, {
    unsubscribeThread: async () => { throw new Error("Must not unsubscribe busy thread"); }
  } as unknown as CodexAppServerClient);
  await service.activateSession(next, target.id);
  assert.equal((await store.getActiveSession(next))?.id, target.id);
  assert.equal(store.getSessionLease(previous.id)?.ownerTurnId, "running");
  assert.equal(store.getActiveTurnRoute("previous")?.sourceId, next);
});
