import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "grammy";
import type { WebClient } from "@slack/web-api";
import { MessageDeliveryService } from "../src/bridge/messages/sender.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { BridgeStore } from "../src/store/index.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { WebMessageTransport, type WebMessageDelivery } from "../src/web/transport.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });

function fixture() {
  const calls: string[] = [];
  const telegram = new TelegramMessageTransport({ api: {
    sendRichMessage: async (chatId: string) => { calls.push(`telegram:${chatId}`); return { message_id: 1 }; }
  } } as unknown as Bot, (text) => text);
  const slack = new SlackMessageTransport({ conversations: {
    history: async () => ({ ok: true, messages: [{ ts: "123.456" }] })
  }, chat: {
    postMessage: async ({ channel, thread_ts }: { channel: string; thread_ts?: string }) => {
      calls.push(`slack:${channel}`); return { channel, ts: "1.0", message: { thread_ts } };
    }
  } } as unknown as WebClient);
  const store = new BridgeStore(":memory:");
  const web = new WebMessageTransport(store);
  const sender = () => new MessageDeliveryService({ maxLength: 4000, queue: new KeyedQueue(), getEnvelopeTitle: async () => "unused" });
  return { calls, telegram, slack, store, web, sender };
}

test("Telegram, Slack and Web have disjoint routes in every registration order", (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const sources = [["123", "telegram"], ["-100123", "telegram"], ["slack:T:C", "slack"],
    ["slack:T:C:123.456%3Athread", "slack"], ["web:local", "web"]] as const;
  const orders = [[f.telegram, f.slack, f.web], [f.telegram, f.web, f.slack], [f.slack, f.telegram, f.web],
    [f.slack, f.web, f.telegram], [f.web, f.telegram, f.slack], [f.web, f.slack, f.telegram]];
  for (const order of orders) {
    const sender = f.sender(); order.forEach((transport) => sender.registerTransport(transport));
    for (const [source, name] of sources) {
      assert.equal(sender.requireTransport(source).name, name, `${order.map((item) => item.name)}: ${source}`);
      assert.equal(order.filter((transport) => transport.canHandle(source)).length, 1, source);
    }
  }
});

test("actual mixed startup registration delivers Web sends and edits only as native events", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const session = await f.store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "mixed", pathKey: "/test" });
  f.store.claimSession(session.id, "web:local");
  const sender = f.sender();
  // src/index.ts installs Telegram, then Slack, then createWebApi installs Web.
  [f.telegram, f.slack, f.web].forEach((transport) => sender.registerTransport(transport));
  const received: WebMessageDelivery[] = [];
  f.web.subscribe((delivery) => received.push(delivery));
  const message = createMessage({ kind: "codex", session: { id: session.id, directory: "/test" },
    body: [{ type: "markdown", text: "**reply**" }] });
  const sent = await sender.sendSpecAndGetLastMessage("web:local", message);
  assert.ok(sent);
  assert.equal(received.length, 1);
  assert.deepEqual(f.calls, []);
  assert.equal(await sender.editSpec("web:local", sent.messageId, { ...message, body: [{ type: "text", text: "updated" }] }), true);
  assert.deepEqual(received.map((delivery) => delivery.event.operation), ["send", "edit"]);
  assert.equal(received[0]!.event.messageId, received[1]!.event.messageId);
  assert.deepEqual(received[1]!.event.message?.body, [{ type: "text", text: "updated" }]);
  assert.deepEqual(f.calls, []);
  await sender.sendSpecAndGetLastMessage("123", message);
  await sender.sendSpecAndGetLastMessage("slack:T:C:123.456", message);
  assert.deepEqual(f.calls, ["telegram:123", "slack:C"]);
});

test("unknown or malformed sources and absent Web adapters cannot fall back to Telegram", (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const sender = f.sender(); [f.telegram, f.slack, f.web].forEach((transport) => sender.registerTransport(transport));
  for (const source of ["", "chat-1", "telegram:123", "future:local", "web:other", "web:", "web:local:window-1",
    "web:local\n", "slack:", "slack:T", "slack:T:C:", "slack:T:C:bad%", "123\n"]) {
    assert.throws(() => sender.requireTransport(source), /No message transport/, source);
  }
  const withoutWeb = f.sender(); [f.telegram, f.slack].forEach((transport) => withoutWeb.registerTransport(transport));
  assert.throws(() => withoutWeb.requireTransport("web:local"), /No message transport/);
  assert.deepEqual(f.calls, []);
});
