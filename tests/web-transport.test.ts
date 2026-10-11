import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { WebMessageTransport, type WebMessageDelivery } from "../src/web/transport.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { MessageDeliveryService } from "../src/bridge/messages/sender.js";
import { BridgeMessageOperations } from "../src/bridge/messages/operations.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { SessionBindingService } from "../src/bridge/sessions/binding.js";

test("real turn registration keeps early Web messages editable; transfer permanently retires their targets", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "registration", pathKey: "/work" });
  store.claimSession(session.id, "web:local");
  const transport = new WebMessageTransport(store);
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work", notify: async () => {} });
  binding.subscribe((event) => transport.observeBinding(event));
  const received: WebMessageDelivery[] = [];
  transport.subscribe((delivery) => received.push(delivery));
  const spec = createMessage({ kind: "progress", session: { id: session.id, directory: "/work" }, body: [{ type: "text", text: "working" }] });
  const sent = await transport.sendMessageSpec("web:local", spec);
  assert.ok(sent);
  const earlyVersion = received[0]!.event.leaseVersion;
  store.recordTurnRoute({ sessionId: session.id, turnId: "real-turn", codexThreadId: session.codexThreadId, sourceId: "web:local", bindingId: null });
  assert.equal(store.setSessionOwnerTurn(session.id, "web:local", "real-turn"), true);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), true);
  assert.ok(received[1]!.event.leaseVersion > earlyVersion);
  store.completeTurnRoute("real-turn", "completed");
  store.clearSessionOwnerTurn(session.id, "real-turn");
  await binding.request("123", session.id);
  await binding.request("web:local", session.id);
  store.recordTurnRoute({ sessionId: session.id, turnId: "next-turn", codexThreadId: session.codexThreadId, sourceId: "web:local", bindingId: null });
  assert.equal(received[0]!.isCurrent(), false);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), false);
});

test("pending applications do not retire current-owner message edits, but actual transfer does", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "pending", pathKey: "/work" });
  store.claimSession(session.id, "web:local");
  const transport = new WebMessageTransport(store);
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map([["pending", "turn"]]), getSessionDirectory: () => "/work", notify: async () => {} });
  binding.subscribe((event) => transport.observeBinding(event));
  const spec = createMessage({ kind: "progress", session: { id: session.id, directory: "/work" }, body: [{ type: "text", text: "run" }] });
  const sent = await transport.sendMessageSpec("web:local", spec);
  assert.ok(sent);
  await binding.request("123", session.id);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), true);
  await binding.request("slack:T:C:1", session.id);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), true);
  await binding.cancel("slack:T:C:1", session.id);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), true);
  // A transfer invalidates old logical IDs even if Web later acquires the same session again.
  store.requestSessionHandoff(session.id, "123", true);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), false);
});

test("Web receives whole structured messages, stable edits and deletes, with no chat callback controls", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  store.claimSession(session.id, "web:local");
  const transport = new WebMessageTransport(store);
  const received: WebMessageDelivery[] = [];
  const unsubscribe = transport.subscribe((event) => received.push(event));
  const sender = new MessageDeliveryService({ maxLength: 50, queue: new KeyedQueue(), getEnvelopeTitle: async () => "unused" });
  sender.registerTransport(transport);
  const spec = createMessage({ kind: "progress", session: { id: session.id, directory: "/work" },
    body: [{ type: "markdown", text: "long markdown\n".repeat(1000) }],
    actions: [{ id: "fake", label: "Not supported", callback: "private-callback" }] });
  const sent = await sender.sendSpecAndGetLastMessage("web:local", spec);
  assert.ok(sent);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0]!.event.message?.body, spec.body);
  assert.deepEqual(received[0]!.event.message?.actions, []);
  assert.equal(received[0]!.event.threadId, "thread");
  assert.equal(received[0]!.event.sessionId, session.id);
  assert.equal(await sender.editSpec("web:local", sent.messageId, { ...spec, body: [{ type: "text", text: "done" }] }), true);
  assert.equal(await transport.clearMessageActions("web:local", sent.messageId), true);
  assert.equal(await transport.deleteMessage("web:local", sent.messageId), true);
  assert.deepEqual(received.map((item) => item.event.operation), ["send", "edit", "clear-actions", "delete"]);
  assert.equal(new Set(received.map((item) => item.event.messageId)).size, 1);
  unsubscribe();
  await transport.sendMessageSpec("web:local", spec);
  assert.equal(received.length, 4);
});

test("Web transport rejects unowned, sessionless, wrong-session edits and events after handoff", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  const transport = new WebMessageTransport(store);
  const received: WebMessageDelivery[] = [];
  transport.subscribe((delivery) => received.push(delivery));
  const spec = createMessage({ kind: "codex", session: { id: session.id, directory: "/work" }, body: [{ type: "text", text: "reply" }] });
  assert.equal(await transport.sendMessageSpec("web:local", spec), null);
  store.claimSession(session.id, "web:local");
  assert.equal(await transport.sendMessageSpec("web:local", { ...spec, session: { id: null, directory: "/work" } }), null);
  assert.equal(await transport.sendMessage("web:local", "plain text with no identity"), null);
  const sent = await transport.sendMessageSpec("web:local", spec);
  assert.ok(sent);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, { ...spec, session: { id: "other", directory: "/work" } }), false);
  store.requestSessionHandoff(session.id, "123", true);
  assert.equal(received[0]!.isCurrent(), false);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), false);
  store.requestSessionHandoff(session.id, "web:local", true);
  assert.equal(await transport.editMessageSpec("web:local", sent.message_id, spec), false);
  store.recordTurnRoute({ turnId: "old-turn", sessionId: session.id, codexThreadId: "thread", bindingId: null, sourceId: "123" });
  assert.equal(await transport.sendMessageSpec("web:local", spec), null);
  assert.equal(received.length, 1);
});

test("Transcript delivery attaches Bridge session identity, not native thread id or directory guessing", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  store.claimSession(session.id, "web:local");
  const owned = (await store.getSessionById(session.id))!;
  const transport = new WebMessageTransport(store);
  const received: WebMessageDelivery[] = [];
  transport.subscribe((delivery) => received.push(delivery));
  const sender = new MessageDeliveryService({ maxLength: 4000, queue: new KeyedQueue(), getEnvelopeTitle: async () => "unused" });
  sender.registerTransport(transport);
  const operations = new BridgeMessageOperations({ sender, formatCodexTelegramHtml: () => null,
    getSessionDirectory: () => "/work", rememberLastAssistantMessage: () => {} });
  const message = await store.addMessage({ sessionId: owned.id, role: "assistant", text: "answer" });
  await operations.sendTranscriptMessage(owned, message, "thread");
  assert.equal(received[0]?.event.message?.session?.id, owned.id);
  assert.deepEqual(received[0]?.event.message?.body, [{ type: "markdown", text: "answer" }]);
});
