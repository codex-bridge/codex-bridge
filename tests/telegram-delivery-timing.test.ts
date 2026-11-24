import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GrammyError, type Bot } from "grammy";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { TelegramApiScheduler } from "../src/telegram/api-scheduler.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });
type Timing = { chatId: string; physicalChatId: string; topicId: number; messageKind: string; operation: string;
  queueWaitMs: number; operationMs: number; totalMs: number; retryWaitMs: number; outcome: string;
  apiCalls: Array<{ method: string; errorCode?: string; outcome: string; elapsedMs: number }> };
function capture(t: test.TestContext) {
  const logs: Timing[] = [];
  t.mock.method(logger, "info", (event: string, data: unknown) => { if (event === "telegram.delivery.timing") logs.push(data as Timing); });
  return logs;
}
const privateText = "PRIVATE_BODY_MUST_NOT_BE_LOGGED";
const spec = createMessage({ kind: "actions", scope: "global", body: [{ type: "text", text: privateText }] });

test("Telegram timing records physical queue wait, topic, message kind and each format fallback without message content", async t => {
  const logs = capture(t);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  const bot = { api: {
    sendRichMessage: async () => { throw new GrammyError("rejected", { ok: false, error_code: 400,
      description: "Bad Request: can't parse rich message" }, "sendRichMessage", {}); },
    sendMessage: async () => { if (first) { first = false; started(); await blocked; } return { message_id: 1 }; }
  } } as unknown as Bot;
  const transport = new TelegramMessageTransport(bot, text => text);
  const a = transport.sendMessageSpec("telegram:-100001:10", spec);
  await sending;
  const b = transport.sendMessageSpec("telegram:-100001:20", spec);
  await delay(10); release(); await Promise.all([a, b]);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(row => row.chatId), ["telegram:-100001:10", "telegram:-100001:20"]);
  assert.deepEqual(logs.map(row => row.topicId), [10, 20]);
  assert.ok(logs[1]!.queueWaitMs >= 5);
  for (const row of logs) {
    assert.equal(row.physicalChatId, "-100001"); assert.equal(row.messageKind, "actions"); assert.equal(row.operation, "send");
    assert.equal(row.outcome, "returned");
    assert.deepEqual(row.apiCalls.map(call => [call.method, call.outcome, call.errorCode]), [
      ["sendRichMessage", "threw", "400"], ["sendMessage", "returned", undefined]
    ]);
    assert.ok(Math.abs(row.totalMs - row.queueWaitMs - row.operationMs) < 0.05);
  }
  assert.equal(JSON.stringify(logs).includes(privateText), false);
});

test("Telegram timing separates server-directed backoff from API request time", async t => {
  const logs = capture(t);
  let now = 0, calls = 0;
  const scheduler = new TelegramApiScheduler({ now: () => now, sleep: async ms => { await delay(5); now += ms; } });
  const bot = { api: { sendRichMessage: async () => {
    if (++calls === 1) throw new GrammyError("rate limited", { ok: false, error_code: 429, description: "Too Many Requests",
      parameters: { retry_after: 1 } }, "sendRichMessage", {});
    return { message_id: 1 };
  } } } as unknown as Bot;
  await new TelegramMessageTransport(bot, text => text, scheduler).sendMessageSpec("telegram:-100001:10", spec);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.apiCalls.length, 2);
  assert.equal(logs[0]!.apiCalls[0]!.errorCode, "429");
  assert.ok(logs[0]!.retryWaitMs >= 1);
  assert.ok(logs[0]!.operationMs >= logs[0]!.retryWaitMs);
});

test("skipped writes have no API calls and are not logged as confirmed sends", async t => {
  const logs = capture(t);
  const transport = new TelegramMessageTransport({ api: {} } as Bot, text => text);
  assert.equal(await transport.sendMessageSpec("telegram:-100001:10", spec, { canSend: async () => false }), null);
  assert.equal(logs[0]!.outcome, "unconfirmed"); assert.deepEqual(logs[0]!.apiCalls, []);
});

test("timing logging failures preserve both successful sends and original request errors", async t => {
  t.mock.method(logger, "info", () => { throw new Error("logger unavailable"); });
  let failure: Error | null = null;
  const bot = { api: { sendRichMessage: async () => { if (failure) throw failure; return { message_id: 8 }; } } } as unknown as Bot;
  const transport = new TelegramMessageTransport(bot, text => text);
  assert.deepEqual(await transport.sendMessageSpec("123", spec), { message_id: "8" });
  failure = new Error("unknown request outcome");
  await assert.rejects(transport.sendMessageSpec("123", spec), error => error === failure);
});
