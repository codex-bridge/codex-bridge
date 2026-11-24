import assert from "node:assert/strict";
import test from "node:test";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import type { BridgeTelegramBotPort } from "../src/bridge/contracts.js";
import { BridgeService } from "../src/bridge/service.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { MessageDeliveryService } from "../src/bridge/messages/sender.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { TelegramApiScheduler } from "../src/telegram/api-scheduler.js";
import { buildTelegramBot } from "../src/telegram/bot.js";
import { createTelegramInteractionContext } from "../src/telegram/interactions/context.js";
import { parseTelegramAddress, telegramSourceId, telegramSourceForContext } from "../src/shared/telegram-address.js";
import { messageTransportPlatform, parseSourceAddress } from "../src/shared/source-address.js";
import { getSessionSelectorChatId } from "../src/bridge/chat-address.js";
import { NotificationDeliveryTargets } from "../src/bridge/notifications/delivery-target.js";
import { BridgeStore } from "../src/store/index.js";
import { acknowledgeTelegramCallback } from "../src/telegram/interactions/acknowledge.js";
import { createSessionActionCallback } from "../src/bridge/sessions/action-callbacks.js";
import { logger } from "../src/logging/logger.js";
import { testConfig } from "./bridge-test-config.js";

logger.configureOutput({ console: "none", file: false });

const chat = "-100000001";
const a = telegramSourceId(chat, 101), b = telegramSourceId(chat, 202);
const spec = createMessage({ kind: "system", scope: "global", body: [{ type: "text", text: "Reply" }] });
const rejection = (description: string, code = 400, retry_after?: number) => new GrammyError("test rejection", {
  ok: false, error_code: code, description, ...(retry_after === undefined ? {} : { parameters: { retry_after } })
}, "sendMessage", {});

test("topic addresses preserve the physical chat and isolate selection sources without changing legacy addresses", () => {
  for (const root of ["123", chat]) {
    assert.equal(telegramSourceId(root), root);
    assert.deepEqual(parseTelegramAddress(root), { chatId: root, topicId: null });
  }
  assert.deepEqual(parseTelegramAddress(a), { chatId: chat, topicId: 101 });
  assert.equal(messageTransportPlatform(a), "telegram");
  assert.deepEqual(parseSourceAddress(a), { platform: "telegram", botKey: "telegram", channelId: chat, threadId: "101" });
  assert.equal(getSessionSelectorChatId(a), a);
  assert.notEqual(getSessionSelectorChatId(a), getSessionSelectorChatId(b));
  for (const invalid of ["telegram:-1:0", "telegram:-1:-1", "telegram:-1:1.2", "telegram:-1:01", "telegram:-1:9007199254740992",
    "telegram:-1:1:2", "telegram:-1:2\n", "telegram:chat:2", "slack:T:C:1", "web:local"]) {
    assert.equal(parseTelegramAddress(invalid), null, invalid);
  }
  for (const id of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => telegramSourceId(chat, id));
});

test("message and callback contexts use real topic fields, while private/group/General retain their numeric entry", () => {
  assert.equal(telegramSourceForContext({ chat: { id: Number(chat) }, msg: { is_topic_message: true, message_thread_id: 101 } }), a);
  for (const msg of [undefined, {}, { message_thread_id: 77 }]) {
    assert.equal(telegramSourceForContext({ chat: { id: Number(chat) }, msg }), chat);
  }
  // When Telegram explicitly provides a General topic ID, use it as supplied; do not invent one.
  assert.equal(telegramSourceForContext({ chat: { id: Number(chat) }, msg: { is_topic_message: true, message_thread_id: 1 } }), `telegram:${chat}:1`);
  assert.throws(() => telegramSourceForContext({ chat: { id: Number(chat) }, msg: { is_topic_message: true } }), /identity/);
  assert.deepEqual(createTelegramInteractionContext(a, 8), {
    platform: "telegram", conversationId: a, surfaceId: a, sourceMessageId: "8"
  });
});

function transportFixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let failure: ((method: string) => unknown) | undefined;
  const bot = { api: Object.fromEntries(["sendRichMessage", "sendMessage", "editMessageText", "deleteMessage", "editMessageReplyMarkup", "sendChatAction"].map(method =>
    [method, async (...args: unknown[]) => {
      calls.push({ method, args });
      const error = failure?.(method); if (error) throw error;
      return { message_id: 7 };
    }])) } as unknown as Bot;
  return { calls, bot, transport: new TelegramMessageTransport(bot, text => text), setFailure: (fn: typeof failure) => { failure = fn; } };
}

test("new messages and typing target the topic; edits, deletes and keyboard updates use physical chat plus message ID", async () => {
  const f = transportFixture();
  await f.transport.sendMessageSpec(a, spec, { disable_notification: true, purpose: "test", canSend: async () => true });
  await f.transport.sendMessage(a, "plain");
  await f.transport.sendTyping(a);
  await f.transport.editMessageSpec(a, "7", spec);
  await f.transport.editMessageText(a, "7", "plain");
  await f.transport.deleteMessage(a, "7");
  await f.transport.clearMessageActions(a, "7");
  assert.equal(f.calls.length, 7);
  for (const call of f.calls) assert.equal(call.args[0], chat);
  for (const call of f.calls.slice(0, 3)) {
    assert.equal((call.args.at(-1) as { message_thread_id: number }).message_thread_id, 101);
  }
  for (const call of f.calls.slice(3)) {
    assert.equal(call.args[1], 7);
    assert.equal(JSON.stringify(call.args).includes("message_thread_id"), false);
  }
  assert.equal(JSON.stringify(f.calls).includes("canSend"), false);
  assert.equal(JSON.stringify(f.calls).includes("purpose"), false);
});

test("rich, HTML and plain fallback keep the same topic and never escape to General", async () => {
  const f = transportFixture();
  f.setFailure(method => method === "sendRichMessage" || method === "sendMessage" && f.calls.length === 2
    ? rejection("Bad Request: can't parse entities") : undefined);
  await f.transport.sendMessageSpec(a, spec);
  assert.deepEqual(f.calls.map(call => call.method), ["sendRichMessage", "sendMessage", "sendMessage"]);
  for (const call of f.calls) {
    assert.equal(call.args[0], chat);
    assert.equal((call.args.at(-1) as { message_thread_id: number }).message_thread_id, 101);
  }
});

for (const error of [rejection("Bad Request: message thread not found"), rejection("Bad Request: TOPIC_CLOSED"),
  rejection("Forbidden: bot is not a member", 403), new Error("Network timeout, outcome unknown")]) {
  test(`topic delivery does not reroute or replay: ${error.message}`, async () => {
    const f = transportFixture(); f.setFailure(() => error);
    await assert.rejects(f.transport.sendMessageSpec(a, spec), e => e === error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.args[0], chat);
  });
}

test("private and ordinary group sends omit topic parameters", async () => {
  const f = transportFixture();
  for (const source of ["123", chat]) {
    await f.transport.sendMessageSpec(source, spec);
    await f.transport.sendTyping(source);
  }
  assert.ok(f.calls.every(call => !("message_thread_id" in (call.args.at(-1) as object))));
});

test("transport instances for the same Bot share a physical-chat queue across topics", async () => {
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const bot = { api: { sendMessage: async (target: string, text: string) => {
    order.push(text); if (text === "first") await blocked; return { message_id: 1 };
  } } } as unknown as Bot;
  const first = new TelegramMessageTransport(bot, text => text), second = new TelegramMessageTransport(bot, text => text);
  const start = first.sendMessage(a, "first");
  const pending = second.sendMessage(b, "second");
  await second.sendMessage("-100000002", "other group");
  assert.deepEqual(order, ["first", "other group"]);
  release(); await Promise.all([start, pending]);
  assert.deepEqual(order, ["first", "other group", "second"]);
});

function clockFixture() {
  let now = 0;
  const waits: number[] = [];
  const clock = { now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } };
  return { scheduler: new TelegramApiScheduler(clock), waits };
}

test("explicit 429 rejection retries once after server backoff, without giving other topics their own quota", async () => {
  const { scheduler, waits } = clockFixture();
  let attempts = 0;
  await assert.rejects(scheduler.run(chat, async () => { attempts++; throw rejection("Too Many Requests", 429, 2); }));
  assert.equal(attempts, 2); assert.deepEqual(waits, [2000]);
  assert.equal(await scheduler.run(chat, async () => "another topic"), "another topic");
  assert.deepEqual(waits, [2000, 2000], "the rejected second attempt leaves a chat-wide cooldown");
  await scheduler.run(chat, async () => "ready"); assert.equal(waits.length, 2);
});

test("unknown failures are not retried, and backoff rechecks a revocable delivery guard", async () => {
  const { scheduler } = clockFixture();
  let attempts = 0;
  await assert.rejects(scheduler.run(chat, async () => { attempts++; throw new Error("unknown"); }));
  assert.equal(attempts, 1);
  let allowed = true;
  const f = transportFixture(); f.setFailure(() => { allowed = false; return rejection("Too Many Requests", 429, 1); });
  const transport = new TelegramMessageTransport(f.bot, text => text, scheduler);
  assert.equal(await transport.sendMessageSpec(a, spec, { canSend: async () => allowed }), null);
  assert.equal(f.calls.length, 1);
});

test("queued deliveries recheck authorization before writing and do not pass Bridge metadata to Telegram", async () => {
  const f = transportFixture(); let release!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new TelegramApiScheduler();
  const running = scheduler.run(chat, () => block);
  let allowed = true;
  const transport = new TelegramMessageTransport(f.bot, text => text, scheduler);
  const pending = transport.sendMessageSpec(a, spec, { canSend: async () => allowed });
  allowed = false; release(); await running;
  assert.equal(await pending, null); assert.equal(f.calls.length, 0);
});

test("topics retain independent selections and bindings; an accepted turn stays with its original topic through handoff", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const one = await store.upsertDiscoveredSession({ telegramChatId: a, codexThreadId: "one", pathKey: "/work/one" });
  const two = await store.upsertDiscoveredSession({ telegramChatId: b, codexThreadId: "two", pathKey: "/work/two" });
  await store.setActiveSession(a, one.id); await store.setActiveSession(b, two.id);
  const owned = store.claimSession(one.id, a); store.claimSession(two.id, b);
  assert.equal((await store.getActiveSession(a))?.id, one.id);
  assert.equal((await store.getActiveSession(b))?.id, two.id);
  assert.equal(await store.getActiveSession(chat), null);
  assert.equal(await store.getActiveSession("123"), null);
  assert.equal(store.getSessionBinding(one.id, a)?.threadId, "101");
  assert.equal(store.getSessionBinding(two.id, b)?.threadId, "202");
  store.recordTurnRoute({ turnId: "turn", sessionId: one.id, codexThreadId: "one", bindingId: owned.binding.id, sourceId: a });
  store.setSessionOwnerTurn(one.id, a, "turn");
  const targets = new NotificationDeliveryTargets(store, thread => store.getSessionByThreadId(thread));
  assert.equal((await targets.resolve("one"))?.telegramChatId, a);
  assert.equal(store.requestSessionHandoff(one.id, b, false, undefined, true).pending, true);
  assert.equal(store.getActiveTurnRoute("one")?.sourceId, a);
  assert.equal((await targets.resolve("one"))?.telegramChatId, a);
  store.completeTurnRoute("turn", "completed"); store.clearSessionOwnerTurn(one.id, "turn");
  assert.ok(store.promotePendingSessionOwner(one.id, null));
  assert.equal((await store.getSessionById(one.id))?.telegramChatId, b);
  assert.equal((await targets.resolve("one"))?.telegramChatId, a, "late output retains its accepted route");
});

test("the physical group allowlist authorizes its topics without authorizing another group or private chat", async t => {
  const store = new BridgeStore(":memory:"); const service = new BridgeService({ ...testConfig(":memory:"), telegramAllowedChatIds: new Set([chat]) }, store, {} as never);
  t.after(async () => { await service.shutdown(); store.close(); });
  await service.ensureChatAllowed(a); await service.ensureChatAllowed(b); await service.ensureChatAllowed(chat);
  await assert.rejects(service.ensureChatAllowed("telegram:-100000002:101"), /not allowed/);
  await assert.rejects(service.ensureChatAllowed("123"), /not allowed/);
});

async function botFixture(overrides: Partial<BridgeTelegramBotPort> = {}, ackError?: Error) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const sources: string[] = [];
  const bot = new Bot("123:test-token", { botInfo: { id: 123, is_bot: true, first_name: "Bridge", username: "bridge_test", can_join_groups: true,
    can_read_all_group_messages: true, supports_inline_queries: false } });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery" && ackError) throw ackError;
    return { ok: true, result: { message_id: 99, date: 1, chat: { id: Number(chat), type: "supergroup" } } } as never;
  });
  const service = {
    ensureChatAllowed: async (source: string) => { sources.push(source); },
    getActiveSessionContext: async () => null, getHelpMenuActions: async () => [],
    renderSessionMenu: async (source: string) => { sources.push(`menu:${source}`); return spec; },
    handleIncomingUserText: async (input: { telegramChatId: string }) => { sources.push(`text:${input.telegramChatId}`); return { routed: false, prompt: spec }; },
    handleDecision: async (_id: string, _action: string, source: string) => { sources.push(`approval:${source}`); return { ok: true, message: "Done" }; },
    ...overrides
  } as unknown as BridgeTelegramBotPort;
  buildTelegramBot(testConfig(":memory:"), service, bot);
  let id = 0;
  const receive = (text: string, topic?: number, callback?: string, accessible = true) => {
    const msg = { message_id: ++id, date: accessible ? 1 : 0, chat: { id: Number(chat), type: "supergroup", is_forum: true },
      from: { id: 42, is_bot: false, first_name: "Tester" }, text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
      ...(topic === undefined ? {} : { is_topic_message: true, message_thread_id: topic }) };
    return bot.handleUpdate({ update_id: id, ...(callback ? { callback_query: { id: String(id), from: msg.from, chat_instance: "chat", data: callback, message: msg } }
      : { message: msg }) } as Update);
  };
  return { bot, calls, sources, receive };
}

test("real Bot middleware routes text, commands, callback replies and approvals by topic", async () => {
  const f = await botFixture();
  await f.receive("Hello", 101); await f.receive("/sessions", 202); await f.receive("button", 101, "quick:go");
  await f.receive("approval", 202, "decision:decision-test:a");
  assert.ok(f.sources.includes(`text:${a}`)); assert.ok(f.sources.includes(`menu:${b}`));
  assert.ok(f.sources.includes(`approval:${b}`));
  const sends = f.calls.filter(call => call.method === "sendRichMessage");
  assert.deepEqual(sends.map(call => call.payload.message_thread_id), [101, 202, 101]);
  assert.ok(sends.every(call => call.payload.chat_id === chat));
  const clear = f.calls.find(call => call.method === "editMessageReplyMarkup")!;
  assert.equal(clear.payload.chat_id, chat); assert.equal(clear.payload.message_id, 4);
});

test("real Bot keeps General replies, rejects inaccessible callback routing and does not answer service events", async () => {
  const f = await botFixture();
  await f.receive("General message");
  assert.ok(f.sources.includes(`text:${chat}`));
  const send = f.calls.find(call => call.method === "sendRichMessage")!;
  assert.equal(send.payload.message_thread_id, undefined);
  const before = f.sources.length;
  await f.receive("old message", 101, "quick:go", false);
  assert.equal(f.sources.length, before);
  assert.ok(f.calls.some(call => call.method === "answerCallbackQuery" && String(call.payload.text).includes("unavailable")));
  const writes = f.calls.filter(call => call.method === "sendRichMessage").length;
  await f.bot.handleUpdate({ update_id: 90, message: { message_id: 90, date: 1, chat: { id: Number(chat), type: "supergroup", title: "Group" },
    forum_topic_created: { name: "Manual topic", icon_color: 0 }, message_thread_id: 303, is_topic_message: true } } as Update);
  assert.equal(f.calls.filter(call => call.method === "sendRichMessage").length, writes);
  assert.equal(f.calls.some(call => /ForumTopic/.test(call.method)), false);
});


test("session menu pagination and queued commands retain the topic source", async () => {
  const inputs: Array<{ telegramChatId: string; text: string; queue?: boolean }> = [];
  const menus: Array<{ source: string; page: number }> = [];
  const f = await botFixture({
    renderSessionMenu: async (source, page = 0) => { menus.push({ source, page }); return spec; },
    handleIncomingUserText: async input => { inputs.push(input); return { routed: true }; }
  });
  await f.receive("/sessions", 101);
  await f.receive("/sessions", 202);
  await f.receive("page", 101, "session-page:1");
  await f.receive("/queue Continue after this", 202);
  assert.deepEqual(menus, [{ source: a, page: 0 }, { source: b, page: 0 }, { source: a, page: 1 }]);
  assert.equal(inputs[0]?.telegramChatId, b); assert.equal(inputs[0]?.queue, true); assert.equal(inputs[0]?.text, "Continue after this");
  const edit = f.calls.find(call => call.method === "editMessageText")!;
  assert.equal(edit.payload.chat_id, chat); assert.equal(edit.payload.message_id, 3);
});

test("private Bot messages still use the original numeric source and reply path", async () => {
  const f = await botFixture();
  await f.bot.handleUpdate({ update_id: 88, message: { message_id: 88, date: 1,
    chat: { id: 42, type: "private", first_name: "Tester" }, from: { id: 42, is_bot: false, first_name: "Tester" }, text: "Hello" } });
  assert.ok(f.sources.includes("text:42"));
  const send = f.calls.find(call => call.method === "sendRichMessage")!;
  assert.equal(send.payload.chat_id, "42"); assert.equal(send.payload.message_thread_id, undefined);
});

test("split conversation chunks keep the topic source through the shared delivery service", async () => {
  const f = transportFixture();
  const delivery = new MessageDeliveryService({ maxLength: 200, queue: new KeyedQueue(), getEnvelopeTitle: async () => "unused" });
  delivery.registerTransport(f.transport);
  await delivery.sendLongSpec(a, { ...spec, body: [{ type: "text", text: "Long reply 🙂 ".repeat(100) }] });
  assert.ok(f.calls.length > 1);
  for (const call of f.calls) {
    assert.equal(call.args[0], chat);
    assert.equal((call.args.at(-1) as { message_thread_id: number }).message_thread_id, 101);
  }
});

test("a group cooldown does not delay another group's writes", async () => {
  let waiting!: () => void;
  let release!: () => void;
  const asleep = new Promise<void>(resolve => { waiting = resolve; });
  const wake = new Promise<void>(resolve => { release = resolve; });
  let now = 0, attempts = 0;
  const scheduler = new TelegramApiScheduler({ now: () => now, sleep: async ms => { waiting(); await wake; now += ms; } });
  const limited = scheduler.run(chat, async () => { if (++attempts === 1) throw rejection("rate limited", 429, 3); return "sent"; });
  await asleep;
  assert.equal(await scheduler.run("-100000002", async () => "unrelated"), "unrelated");
  release(); assert.equal(await limited, "sent");
});

test("actual Bridge notifications keep parallel sessions in their originating topics", async t => {
  const store = new BridgeStore(":memory:");
  const service = new BridgeService(testConfig(":memory:"), store, { listQueuedSubmissions: async () => [] } as never);
  const f = transportFixture(); service.registerMessageTransport(f.transport);
  t.after(async () => { await service.shutdown(); store.close(); });
  const internal = service as unknown as { handleAppServerNotification(n: { method: string; params: unknown }): Promise<void> };
  for (const [source, thread] of [[a, "one"], [b, "two"]]) {
    const session = await store.upsertDiscoveredSession({ telegramChatId: source!, codexThreadId: thread!, pathKey: `/work/${thread}` });
    await store.setActiveSession(source!, session.id); store.claimSession(session.id, source!);
    await internal.handleAppServerNotification({ method: "turn/started", params: { threadId: thread, turn: { id: `turn-${thread}`, status: "inProgress" } } });
    await internal.handleAppServerNotification({ method: "item/started", params: { threadId: thread, turnId: `turn-${thread}`,
      item: { id: `tool-${thread}`, type: "mcpToolCall", server: "demo", tool: "lookup", status: "inProgress" } } });
    await internal.handleAppServerNotification({ method: "item/completed", params: { threadId: thread, turnId: `turn-${thread}`,
      item: { id: `reply-${thread}`, type: "agentMessage", text: `Reply ${thread}` } } });
  }
  const sends = f.calls.filter(call => call.method === "sendRichMessage");
  assert.ok(sends.some(call => (call.args[1] as { markdown: string }).markdown.includes("Reply one") &&
    (call.args[2] as { message_thread_id: number }).message_thread_id === 101));
  assert.ok(sends.some(call => (call.args[1] as { markdown: string }).markdown.includes("Reply two") &&
    (call.args[2] as { message_thread_id: number }).message_thread_id === 202));
  assert.ok(sends.every(call => call.args[0] === chat && [101, 202].includes((call.args[2] as { message_thread_id: number }).message_thread_id)));
});


for (const ackError of [rejection("Bad Request: query is too old and response timeout expired or query ID is invalid"), new Error("Feedback network failure")]) {
  test(`handoff proceeds once when the Telegram button feedback fails: ${ackError.message}`, async () => {
    const actions: string[] = [];
    const sessionId = "session_00000000-0000-4000-8000-000000000001";
    const f = await botFixture({
      requestSessionHandoff: async (source, id, version) => {
        assert.equal(source, a); assert.equal(id, sessionId); assert.equal(version, 12);
        actions.push("handoff"); return spec;
      },
      postSessionHandoffHistory: async (source, id) => {
        assert.equal(source, a); assert.equal(id, sessionId); actions.push("history");
      }
    }, ackError);
    await f.receive("handoff", 101, createSessionActionCallback("handoff", sessionId, 12));
    assert.deepEqual(actions, ["handoff", "history"]);
    assert.equal(f.calls.filter(call => call.method === "answerCallbackQuery").length, 1, "feedback failure never retries the action");
    assert.ok(f.calls.some(call => call.method === "editMessageText" || call.method === "sendRichMessage"));
  });
}

test("failed approval feedback does not prevent clearing the successfully resolved card", async () => {
  let resolved = 0;
  const f = await botFixture({ handleDecision: async () => { resolved++; return { ok: true, message: "Approved" }; } },
    rejection("Bad Request: query is too old and response timeout expired or query ID is invalid"));
  await f.receive("approval", 101, "decision:decision-test:a");
  assert.equal(resolved, 1);
  assert.ok(f.calls.some(call => call.method === "editMessageReplyMarkup"));
});

test("button feedback is time bounded and does not throw when the request is aborted", async () => {
  let cancelled = false;
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await acknowledgeTelegramCallback(signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
    }), { callbackId: "test" }, 5);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("failed button feedback does not bypass the real stale-lease check", async t => {
  const store = new BridgeStore(":memory:");
  const service = new BridgeService(testConfig(":memory:"), store, {} as never);
  t.after(async () => { await service.shutdown(); store.close(); });
  const session = await store.upsertDiscoveredSession({ telegramChatId: b, codexThreadId: "guarded", pathKey: "/work" });
  await store.setActiveSession(b, session.id); const owner = store.claimSession(session.id, b);
  const before = store.getSessionLease(session.id);
  let requests = 0;
  const f = await botFixture({
    requestSessionHandoff: (source, id, version) => { requests++; return service.requestSessionHandoff(source, id, version); },
    postSessionHandoffHistory: async () => {}
  }, rejection("Bad Request: query is too old and response timeout expired or query ID is invalid"));
  await f.receive("stale handoff", 101, createSessionActionCallback("handoff", session.id, owner.lease.version - 1));
  assert.equal(requests, 1);
  assert.deepEqual(store.getSessionLease(session.id), before);
  assert.notEqual(store.getSessionLease(session.id)?.ownerBindingId, store.getSessionBinding(session.id, a)?.id);
});
