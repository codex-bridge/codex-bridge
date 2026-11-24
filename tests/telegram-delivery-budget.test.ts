import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { TelegramDeliveryBudget, telegramBudgetFor } from "../src/telegram/delivery-budget.js";
import { configureTelegramApi } from "../src/telegram/api-policy.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });
const botInfo = { id: 123, is_bot: true as const, first_name: "Bridge", username: "bridge_test", can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };

function clock() {
  let now = 100_000;
  const waits: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; }, waits };
}

test("raw writes share one physical-chat budget across topics, formats and transport instances", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time);
  const bot = new Bot("123:test", { botInfo });
  const calls: Array<{ method: string; at: number }> = [];
  bot.api.config.use(async (_previous, method) => {
    calls.push({ method, at: time.now() });
    if (method === "sendRichMessage") return { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" };
    return { ok: true, result: { message_id: 1 } } as never;
  });
  configureTelegramApi(bot, 10_000, { budget });
  const one = new TelegramMessageTransport(bot, text => text), two = new TelegramMessageTransport(bot, text => text);
  const spec = createMessage({ kind: "codex", scope: "global", body: [{ type: "text", text: "Hello" }] });
  await one.sendMessageSpec("telegram:-100001:10", spec);
  await two.editMessageText("telegram:-100001:20", "1", "Changed");
  assert.deepEqual(calls, [{ method: "sendRichMessage", at: 100_000 }, { method: "sendMessage", at: 101_000 }, { method: "editMessageText", at: 102_000 }]);
  assert.equal(telegramBudgetFor(bot), budget);
});

test("the group rolling-minute ceiling also counts unsuccessful attempts", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time);
  const sent: number[] = [];
  for (let index = 0; index < 19; index++) { await budget.acquire("-1"); sent.push(time.now()); }
  assert.equal(sent[17], 117_000);
  assert.equal(sent[18], 160_000, "the nineteenth attempt waits until the first leaves the 60-second window");
  await budget.acquire("-2"); assert.equal(time.now(), 160_000, "a different chat keeps its own quota");
});

test("Bot-wide budget is shared by different physical chats", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time);
  for (let index = 0; index < 26; index++) await budget.acquire(String(index));
  assert.deepEqual(time.waits, [1_000]);
});

test("private chats retain per-chat pacing without inheriting the group-minute ceiling", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time);
  for (let index = 0; index < 30; index++) await budget.acquire("123");
  assert.equal(time.now(), 129_000);
});

test("429 cooldown is shared across chats and is not an automatic retry", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time), bot = new Bot("123:test", { botInfo });
  let calls = 0;
  bot.api.config.use(async () => ++calls === 1
    ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } }
    : { ok: true, result: true } as never);
  configureTelegramApi(bot, 10_000, { budget });
  await assert.rejects(bot.api.sendMessage(-1, "First"));
  assert.equal(calls, 1);
  await bot.api.sendMessage(-2, "Another chat");
  assert.equal(time.now(), 130_000); assert.equal(calls, 2);
});

test("background refreshes rotate between sessions and cancellation releases waiting entries", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const budget = new TelegramDeliveryBudget(), controller = new AbortController();
  assert.equal(await budget.waitForRefresh("telegram:-1:10", "A", controller.signal), true);
  const order: string[] = [];
  const a = budget.waitForRefresh("telegram:-1:10", "A", controller.signal).then(ready => { if (ready) order.push("A"); });
  const b = budget.waitForRefresh("telegram:-1:20", "B", controller.signal).then(ready => { if (ready) order.push("B"); });
  t.mock.timers.tick(10_000); await new Promise(setImmediate);
  assert.deepEqual(order, ["B"]);
  t.mock.timers.tick(10_000); await Promise.all([a, b]);
  assert.deepEqual(order, ["B", "A"]);
  const waiting = budget.waitForRefresh("-1", "C", controller.signal);
  controller.abort(); assert.equal(await waiting, false);
});

test("three sessions get a turn before a session with many queued blocks gets another", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const budget = new TelegramDeliveryBudget(), controller = new AbortController();
  await budget.waitForRefresh("-1", "A", controller.signal);
  const order: string[] = [];
  const pending = ["A", "A", "B", "C"].map(session => budget.waitForRefresh("-1", session, controller.signal)
    .then(ready => { if (ready) order.push(session); }));
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(10_000); await new Promise(setImmediate); }
  assert.deepEqual(order, ["B", "C", "A"]);
  controller.abort(); await Promise.all(pending);
});

test("waiting background refreshes do not take the transport queue or delay a foreground response", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const budget = new TelegramDeliveryBudget(), controller = new AbortController(), bot = new Bot("123:test", { botInfo });
  const calls: string[] = [];
  bot.api.config.use(async (_previous, method) => { calls.push(method); return { ok: true, result: { message_id: 1 } } as never; });
  configureTelegramApi(bot, 10_000, { budget });
  const transport = new TelegramMessageTransport(bot, text => text);
  await transport.waitForBackgroundRefresh("telegram:-1:10", "A", controller.signal);
  let admitted = false;
  const pending = transport.waitForBackgroundRefresh("telegram:-1:20", "B", controller.signal).then(ready => { admitted = ready; });
  await transport.sendMessage("telegram:-1:10", "Foreground reply");
  assert.deepEqual(calls, ["sendMessage"]); assert.equal(admitted, false);
  controller.abort(); await pending;
});

test("a stale refresh is rechecked after raw quota waiting and is never sent", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time), bot = new Bot("123:test", { botInfo });
  let calls = 0, eligible = true;
  bot.api.config.use(async () => { calls++; return { ok: true, result: { message_id: 1 } } as never; });
  configureTelegramApi(bot, 10_000, { budget });
  const transport = new TelegramMessageTransport(bot, text => text);
  await transport.sendMessage("-1", "First");
  const previous = time.sleep;
  time.sleep = async ms => { eligible = false; await previous(ms); };
  assert.equal(await transport.editMessageText("-1", "1", "Old status", { canSend: async () => eligible }), false);
  assert.equal(calls, 1);
});

test("cancelling a background request interrupts raw budget waiting without a network write", async () => {
  const bot = new Bot("123:test", { botInfo }), controller = new AbortController();
  let calls = 0;
  bot.api.config.use(async () => { calls++; return { ok: true, result: { message_id: 1 } } as never; });
  configureTelegramApi(bot);
  const transport = new TelegramMessageTransport(bot, text => text);
  await transport.sendMessage("-1", "First");
  const pending = transport.editMessageText("-1", "1", "Old status", { deliverySignal: controller.signal });
  await new Promise(setImmediate); controller.abort();
  assert.equal(await pending, false); assert.equal(calls, 1);
});

test("background admission lost to foreground yields immediately instead of holding the transport queue", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time), bot = new Bot("123:test", { botInfo });
  let calls = 0, deferred = 0;
  bot.api.config.use(async () => { calls++; return { ok: true, result: { message_id: 1 } } as never; });
  configureTelegramApi(bot, 10_000, { budget });
  const transport = new TelegramMessageTransport(bot, text => text);
  await transport.waitForBackgroundRefresh("-1", "A", new AbortController().signal);
  await transport.sendMessage("-1", "Foreground took the slot");
  assert.equal(await transport.editMessageText("-1", "1", "Background", { onRateDeferred: () => { deferred++; } }), false);
  assert.equal(time.waits.length, 0); assert.equal(deferred, 1); assert.equal(calls, 1);
  await transport.sendMessage("-1", "Next foreground");
  assert.equal(calls, 2);
});

test("admitted background writes complete format fallback with each attempt charged", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time), bot = new Bot("123:test", { botInfo });
  let calls = 0, deferred = 0;
  bot.api.config.use(async () => ++calls === 1
    ? { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" }
    : { ok: true, result: true } as never);
  configureTelegramApi(bot, 10_000, { budget });
  const transport = new TelegramMessageTransport(bot, text => text);
  const spec = createMessage({ kind: "progress", scope: "global", body: [{ type: "text", text: "Changed" }] });
  assert.equal(await transport.editMessageSpec("-1", "1", spec, { onRateDeferred: () => { deferred++; } }), true);
  assert.equal(calls, 2); assert.equal(deferred, 0); assert.deepEqual(time.waits, [1_000]);
});

test("background 429 leaves its owner pending without sleeping in the chronological queue", async () => {
  const time = clock(), budget = new TelegramDeliveryBudget(time), bot = new Bot("123:test", { botInfo });
  let calls = 0, deferred = 0;
  bot.api.config.use(async () => { calls++; return { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } }; });
  configureTelegramApi(bot, 10_000, { budget });
  const transport = new TelegramMessageTransport(bot, text => text);
  assert.equal(await transport.editMessageText("-1", "1", "Background", { onRateDeferred: () => { deferred++; } }), false);
  assert.equal(calls, 1); assert.equal(deferred, 1); assert.deepEqual(time.waits, []);
});
