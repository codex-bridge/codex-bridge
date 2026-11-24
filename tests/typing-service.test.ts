import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "grammy";
import { TypingService } from "../src/bridge/progress/typing.js";
import type { BridgeMessageTransport } from "../src/bridge/transport.js";
import type { SessionRecord } from "../src/shared/types.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });
const session = { id: "session", codexThreadId: "thread", telegramChatId: "123" } as SessionRecord;

test("typing waits outside foreground work and completion cancels it before any request", async () => {
  const queue = new KeyedQueue(); let release!: () => void, sent = 0;
  const foreground = queue.run("thread", () => new Promise<void>(resolve => { release = resolve; }));
  const typing = new TypingService({ intervalMs: 4000,
    waitForThreadIdle: (thread, signal) => queue.waitForIdle(thread, signal),
    requireMessageTransport: () => ({ sendTyping: async () => { sent++; } }) as BridgeMessageTransport });
  const pending = typing.sendOnce(session);
  await new Promise(setImmediate);
  typing.clear(session.id); await pending;
  assert.equal(sent, 0);
  release(); await foreground;
});

test("a stale typing completion cannot release the newer request's in-flight guard", async t => {
  let now = 100_000; t.mock.method(Date, "now", () => now);
  let calls = 0, releaseFirst!: () => void, releaseSecond!: () => void;
  const typing = new TypingService({ intervalMs: 4000, requireMessageTransport: () => ({
    sendTyping: async () => {
      const call = ++calls;
      if (call === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      if (call === 2) await new Promise<void>(resolve => { releaseSecond = resolve; });
    }
  }) as BridgeMessageTransport });
  const first = typing.sendOnce(session);
  typing.clear(session.id);
  const second = typing.sendOnce(session);
  releaseFirst(); await first;
  now += 5000;
  await typing.sendOnce(session); assert.equal(calls, 2);
  releaseSecond(); await second;
  await typing.sendOnce(session); assert.equal(calls, 3);
  typing.stop(); await typing.sendOnce(session); assert.equal(calls, 3);
});

test("a queued Telegram typing write is skipped after its session's state expires", async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const transport = new TelegramMessageTransport({ api: {
    sendMessage: async () => { entered(); await blocked; return { message_id: 1 }; },
    sendChatAction: async () => { calls++; }
  } } as unknown as Bot, text => text);
  const first = transport.sendMessage("123", "Foreground"); await started;
  const typing = new TypingService({ intervalMs: 4000, requireMessageTransport: () => transport });
  const pending = typing.sendOnce(session);
  typing.clear(session.id);
  release(); await first; await pending;
  assert.equal(calls, 0);
});
