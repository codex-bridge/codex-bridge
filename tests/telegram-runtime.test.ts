import assert from "node:assert/strict";
import test from "node:test";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { buildTelegramBot } from "../src/telegram/bot.js";
import { configureTelegramApi } from "../src/telegram/api-policy.js";
import { startTelegramPolling } from "../src/telegram/polling.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { deliverTelegramInteraction } from "../src/telegram/interactions/responder.js";
import { createSessionActionCallback } from "../src/bridge/sessions/action-callbacks.js";
import type { BridgeTelegramBotPort } from "../src/bridge/contracts.js";
import { logger } from "../src/logging/logger.js";
import { testConfig } from "./bridge-test-config.js";
import { unlimitedTelegramBudget } from "./fixtures/telegram-budget.js";

logger.configureOutput({ console: "none", file: false });
type ApiSignal = NonNullable<Parameters<Bot["api"]["getUpdates"]>[1]>;
type ApiCall = { method: string; payload: Record<string, unknown> };
const botInfo = { id: 123, is_bot: true as const, first_name: "Bridge", username: "bridge_test", can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
const from = { id: 42, is_bot: false, first_name: "Tester" };
const chatId = -100001;
const source = "telegram:-100001:101";
const spec = createMessage({ kind: "system", session: { id: "session", directory: "/work" }, body: [{ type: "text", text: "Selected" }] });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function update(id: number, text: string, topic = 101, callback?: string): Update {
  const message = { message_id: id, date: 1, chat: { id: chatId, type: "supergroup", is_forum: true }, from, text,
    is_topic_message: true, message_thread_id: topic };
  return { update_id: id, ...(callback ? { callback_query: { id: String(id), from, chat_instance: "chat", data: callback, message } }
    : { message }) } as Update;
}

function fixture(overrides: Partial<BridgeTelegramBotPort> = {},
  api?: (method: string, payload: Record<string, unknown>, signal?: ApiSignal) => Promise<unknown>) {
  const calls: ApiCall[] = [];
  const bot = new Bot("123:test", { botInfo });
  bot.api.config.use(async (_previous, method, payload, signal) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = await api?.(method, payload as Record<string, unknown>, signal);
    return { ok: true, result: result ?? { message_id: 99, date: 1, chat: { id: chatId, type: "supergroup" } } } as never;
  });
  const service = {
    ensureChatAllowed: async () => {}, getActiveSessionContext: async () => ({ id: "session", directory: "/work" }),
    getHelpMenuActions: async () => [], handleIncomingUserText: async () => ({ routed: true }),
    ...overrides
  } as unknown as BridgeTelegramBotPort;
  buildTelegramBot(testConfig(":memory:"), service, bot, { budget: unlimitedTelegramBudget() });
  return { bot, calls, receive: (event: Update) => bot.handleUpdate(event),
    writes: () => calls.filter(call => ["sendRichMessage", "sendMessage", "editMessageText", "editMessageReplyMarkup"].includes(call.method)) };
}

test("polling runs topics concurrently, preserves each entry's order and drains accepted work on stop", { timeout: 2000 }, async t => {
  const blocked = gate(), otherDone = gate(), polling = gate();
  t.after(() => blocked.release());
  const order: string[] = [];
  let sentBatch = false, pollAborted = false;
  const f = fixture({ handleIncomingUserText: async input => {
    order.push(`start:${input.text}`);
    if (input.text === "first") await blocked.promise;
    order.push(`end:${input.text}`);
    if (input.text === "other") otherDone.release();
    return { routed: true };
  } }, async (method, _payload, signal) => {
    if (method !== "getUpdates") return;
    if (!sentBatch) { sentBatch = true; return [update(1, "first"), update(2, "second"), update(3, "other", 202)]; }
    polling.release();
    return new Promise((_resolve, reject) => {
      const abort = () => { pollAborted = true; reject(new Error("Polling stopped")); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
  });
  const runtime = await startTelegramPolling(f.bot);
  t.after(() => runtime.stop());
  await otherDone.promise; await polling.promise;
  assert.ok(order.includes("end:other")); assert.equal(order.includes("start:second"), false);
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(pollAborted, true); assert.equal(stopped, false);
  blocked.release(); await stopping;
  assert.ok(order.indexOf("end:first") < order.indexOf("start:second"));
  assert.equal(order.at(-1), "end:second");
  const polls = f.calls.filter(call => call.method === "getUpdates");
  assert.deepEqual(polls[0]?.payload.allowed_updates, []); assert.equal(polls[0]?.payload.timeout, 30);
  assert.equal(polls[0]?.payload.limit, 16);
  assert.equal(f.calls.find(call => call.method === "deleteWebhook")?.payload.drop_pending_updates, false);
});

test("an entry remains ordered after a previous update fails", async () => {
  const blocked = gate(), started = gate(), order: string[] = [];
  const f = fixture({ handleIncomingUserText: async input => {
    order.push(input.text);
    if (input.text === "first") { started.release(); await blocked.promise; throw new Error("Rejected input"); }
    return { routed: true };
  } });
  const first = f.receive(update(1, "first"));
  const rejected = assert.rejects(first, /Rejected input/);
  await started.promise;
  const second = f.receive(update(2, "second"));
  await new Promise(setImmediate); assert.deepEqual(order, ["first"]);
  blocked.release(); await rejected; await second;
  assert.deepEqual(order, ["first", "second"]);
});

test("polling applies backpressure at its concurrency limit and accepts a new entry when a slot opens", { timeout: 2000 }, async t => {
  const holds = Array.from({ length: 17 }, gate), saturated = gate(), lastStarted = gate();
  t.after(() => { for (const hold of holds) hold.release(); });
  let active = 0, peak = 0, fetched = 0;
  const f = fixture({ handleIncomingUserText: async input => {
    const id = Number(input.text);
    active++; peak = Math.max(peak, active);
    if (active === 16) saturated.release();
    if (id === 16) lastStarted.release();
    await holds[id]!.promise;
    active--; return { routed: true };
  } }, async (method, payload, signal) => {
    if (method !== "getUpdates") return;
    fetched++;
    if (fetched === 1) {
      assert.equal(payload.limit, 16);
      return Array.from({ length: 16 }, (_, id) => update(id + 1, String(id), id + 101));
    }
    if (fetched === 2) { assert.equal(payload.limit, 1); return [update(17, "16", 117)]; }
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(new Error("Stopped"));
      else signal?.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
    });
  });
  const runtime = await startTelegramPolling(f.bot);
  t.after(() => runtime.stop());
  await saturated.promise; await new Promise(setImmediate);
  assert.equal(fetched, 1);
  holds[0]!.release(); await lastStarted.promise;
  assert.equal(peak, 16);
  const stopping = runtime.stop();
  for (const hold of holds) hold.release();
  await stopping; assert.equal(active, 0);
});

test("callback feedback can remain in flight while the business action completes exactly once", async t => {
  const blocked = gate(); t.after(() => blocked.release());
  let completed = 0, acknowledged = false;
  const f = fixture({ handleIncomingUserText: async input => {
    assert.equal(input.telegramChatId, source); assert.equal(input.text, "go"); completed++;
    return { routed: true };
  } }, async method => {
    if (method === "answerCallbackQuery") { await blocked.promise; acknowledged = true; return true; }
  });
  await f.receive(update(1, "Go", 101, "quick:go"));
  assert.equal(completed, 1); assert.equal(acknowledged, false);
  assert.equal(f.calls.filter(call => call.method === "answerCallbackQuery").length, 1);
  blocked.release(); await new Promise(setImmediate); assert.equal(acknowledged, true);
});

for (const action of ["decision:expired:a", "decision-batch:session:1:a", "uq:expired:s", "unknown:action"]) {
  test(`failed ${action} stays visible in the original topic even when feedback expires`, async () => {
    const result = { ok: false, message: "This action is no longer available." };
    const f = fixture({ handleDecision: async () => result, handleBatchDecision: async () => result,
      handleUserQuestion: async () => result }, async (method, payload) => {
      if (method === "answerCallbackQuery") throw new GrammyError("expired", {
        ok: false, error_code: 400, description: "Bad Request: query is too old" }, method, payload);
    });
    await f.receive(update(1, "Old action", 101, action));
    const writes = f.writes(); assert.equal(writes.length, 1);
    assert.equal(writes[0]!.method, "sendRichMessage"); assert.equal(writes[0]!.payload.chat_id, String(chatId));
    assert.equal(writes[0]!.payload.message_thread_id, 101);
    const body = JSON.stringify(writes[0]!.payload);
    assert.match(body, /Codex · \/work/);
    assert.match(body, action === "unknown:action" ? /Unknown action/ : /This action is no longer available/);
  });
}

test("successful decisions stay quiet and clear their controls without waiting for toast feedback", async () => {
  const f = fixture({ handleDecision: async () => ({ ok: true, message: "Approved" }) });
  await f.receive(update(1, "Approve", 101, "decision:decision:a"));
  assert.deepEqual(f.writes().map(call => call.method), ["editMessageReplyMarkup"]);
});

test("unchanged handoff receipts still deliver history without sending a replacement card", async () => {
  let history = 0;
  const f = fixture({ requestSessionHandoff: async () => spec,
    postSessionHandoffHistory: async () => { history++; } }, async (method, payload) => {
    if (method === "editMessageText") throw new GrammyError("unchanged", {
      ok: false, error_code: 400, description: "Bad Request: message is not modified" }, method, payload);
  });
  await f.receive(update(1, "Use", 101, createSessionActionCallback("handoff", "session", 1)));
  assert.equal(history, 1); assert.deepEqual(f.writes().map(call => call.method), ["editMessageText"]);
});

test("plain edits and clearing unchanged buttons share the successful no-op policy", async () => {
  const bot = new Bot("123:test", { botInfo });
  bot.api.config.use(async (_previous, method, payload) => {
    throw new GrammyError("unchanged", { ok: false, error_code: 400, description: "Bad Request: message is not modified" }, method, payload);
  });
  const transport = new TelegramMessageTransport(bot, text => text);
  assert.equal(await transport.editMessageText(source, "1", "Unchanged"), true);
  assert.equal(await transport.clearMessageActions(source, "1"), true);
});

for (const error of [new Error("Unknown network outcome"), new GrammyError("missing", {
  ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, "editMessageText", {})]) {
  test(`a real edit error never runs post-delivery history: ${error.message}`, async () => {
    let after = 0, calls = 0;
    const bot = new Bot("123:test", { botInfo });
    bot.api.config.use(async () => { calls++; throw error; });
    const transport = new TelegramMessageTransport(bot, text => text);
    await assert.rejects(deliverTelegramInteraction({ platform: "telegram", conversationId: source, surfaceId: source, sourceMessageId: "1" },
      { mode: "edit", target: "surface", message: spec, afterDelivery: async () => { after++; } }, {
        edit: message => transport.editMessageSpec(source, "1", message), send: async () => assert.fail("no replacement"), clearActions: async () => {}
      }), e => e === error);
    assert.equal(after, 0); assert.equal(calls, 1);
  });
}

test("an explicitly skipped interaction write does not run its follow-up", async () => {
  let after = 0;
  await deliverTelegramInteraction({ platform: "telegram", conversationId: source, surfaceId: source, sourceMessageId: "1" },
    { mode: "edit", target: "surface", message: spec, afterDelivery: async () => { after++; } }, {
      edit: async () => false, send: async () => assert.fail("edit"), clearActions: async () => {}
    });
  assert.equal(after, 0);
});

test("write timeouts abort exactly one API request without retrying it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bot = new Bot("123:test", { botInfo });
  let calls = 0;
  bot.api.config.use(async (_previous, _method, _payload, signal) => {
    calls++;
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Write aborted")), { once: true }));
  });
  configureTelegramApi(bot, 10_000, { budget: unlimitedTelegramBudget() });
  const sending = bot.api.sendMessage(123, "Hello");
  const rejected = assert.rejects(sending, /Write aborted/);
  await new Promise(setImmediate);
  t.mock.timers.tick(10_000); await rejected;
  assert.equal(calls, 1);
});

test("long polling retains the runner's cancellation signal and is not timed out by the write policy", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bot = new Bot("123:test", { botInfo }), controller = new AbortController();
  let observed: ApiSignal | undefined;
  bot.api.config.use(async (_previous, _method, _payload, signal) => {
    observed = signal;
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Polling cancelled")), { once: true }));
  });
  configureTelegramApi(bot, 10_000, { budget: unlimitedTelegramBudget() });
  const fetching = bot.api.getUpdates({ timeout: 30 }, controller.signal as unknown as ApiSignal);
  const rejected = assert.rejects(fetching, /Polling cancelled/);
  t.mock.timers.tick(20_000);
  assert.equal(observed, controller.signal); assert.equal(observed?.aborted, false);
  controller.abort(); await rejected;
});

test("write policy forwards caller cancellation and cleans up its timeout after success", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bot = new Bot("123:test", { botInfo });
  const signals: ApiSignal[] = [];
  bot.api.config.use(async (_previous, _method, _payload, signal) => {
    signals.push(signal!);
    if (signals.length === 1) return { ok: true, result: true } as never;
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Caller cancelled")), { once: true }));
  });
  configureTelegramApi(bot, 10_000, { budget: unlimitedTelegramBudget() });
  await bot.api.sendMessage(123, "First");
  t.mock.timers.tick(10_000); assert.equal(signals[0]!.aborted, false);
  const controller = new AbortController();
  const sending = bot.api.sendMessage(123, "Second", {}, controller.signal as unknown as ApiSignal);
  const rejected = assert.rejects(sending, /Caller cancelled/);
  await new Promise(setImmediate);
  controller.abort(); await rejected;
  assert.equal(signals[1]!.aborted, true);
});
