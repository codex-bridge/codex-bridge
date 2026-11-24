import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { buildTelegramBot } from "../src/telegram/bot.js";
import { drainTelegramMediaGroups } from "../src/telegram/media-groups.js";
import { downloadTelegramImages } from "../src/telegram/attachments.js";
import type { BridgeTelegramBotPort } from "../src/bridge/contracts.js";
import { testConfig } from "./bridge-test-config.js";
import { unlimitedTelegramBudget } from "./fixtures/telegram-budget.js";
import { logger } from "../src/logging/logger.js";
import { IncomingPayloadService } from "../src/bridge/input/payload.js";
import { createMessage } from "../src/bridge/messages/factory.js";

logger.configureOutput({ console: "none", file: false });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const botInfo = { id: 123, is_bot: true as const, first_name: "Bridge", username: "bridge_test", can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
function image(id: number, options: { album?: string; caption?: string; document?: boolean; voice?: boolean; audio?: boolean; mime?: string; topic?: number; text?: string; private?: boolean } = {}): Update {
  return { update_id: id, message: { message_id: id, date: 1, from: { id: 42, is_bot: false, first_name: "User" },
    chat: { id: options.private ? 42 : -100001, type: options.private ? "private" : "supergroup" },
    ...(options.topic ? { is_topic_message: true, message_thread_id: options.topic } : {}),
    ...(options.album ? { media_group_id: options.album } : {}), caption: options.caption,
    ...(options.text ? { text: options.text } : options.voice
      ? { voice: { file_id: `file-${id}`, file_unique_id: `unique-${id}`, duration: 1, mime_type: "audio/ogg", file_size: 4 } } : options.audio
      ? { audio: { file_id: `file-${id}`, file_unique_id: `unique-${id}`, duration: 1, mime_type: "audio/mpeg", file_name: "memo.mp3", file_size: 4 } } : options.document
      ? { document: { file_id: `file-${id}`, file_unique_id: `unique-${id}`, file_name: "screen.png", mime_type: options.mime ?? "image/png", file_size: png.length } }
      : { photo: [{ file_id: `small-${id}`, file_unique_id: "small", width: 10, height: 10 }, { file_id: `file-${id}`, file_unique_id: `unique-${id}`, width: 100, height: 100, file_size: png.length }] })
  } } as Update;
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "bridge-tg-images-"));
  const previous = process.env.TELEGRAM_ATTACHMENT_DIR;
  process.env.TELEGRAM_ATTACHMENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.TELEGRAM_ATTACHMENT_DIR; else process.env.TELEGRAM_ATTACHMENT_DIR = previous; });
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const inputs: Parameters<BridgeTelegramBotPort["handleIncomingUserPayload"]>[0][] = [];
  const order: string[] = [];
  let session = true, fail = false;
  let fetchImplementation: typeof fetch | undefined;
  let payloadImplementation: BridgeTelegramBotPort["handleIncomingUserPayload"] = async () => ({ routed: true });
  t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => fetchImplementation ? fetchImplementation(...args)
    : fail ? new Response("private error", { status: 403 }) : new Response(png));
  const bot = new Bot("123:test", { botInfo });
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: method === "getFile" ? { file_id: "file", file_unique_id: "unique", file_path: "photos/file.png", file_size: png.length }
      : { message_id: 900 } } as never;
  });
  const service = { ensureChatAllowed: async () => {}, getActiveSessionContext: async () => session ? { id: "session", directory: "/project" } : undefined,
    handleIncomingUserPayload: async (input: typeof inputs[number]) => { inputs.push(input); order.push("image"); return payloadImplementation(input); },
    handleIncomingUserText: async () => { order.push("text"); return { routed: true }; }
  } as unknown as BridgeTelegramBotPort;
  buildTelegramBot(testConfig(":memory:"), service, bot, { budget: unlimitedTelegramBudget() });
  t.after(() => drainTelegramMediaGroups(bot));
  return { bot, calls, inputs, order, root, setSession: (value: boolean) => { session = value; }, setFailure: () => { fail = true; },
    setFetch: (implementation: typeof fetch) => { fetchImplementation = implementation; },
    setPayload: (implementation: typeof payloadImplementation) => { payloadImplementation = implementation; } };
}

test("Telegram selects the largest photo, preserves caption/topic and stores a managed image", async t => {
  const f = await fixture(t);
  await f.bot.handleUpdate(image(1, { topic: 28, caption: "Inspect this" }));
  assert.equal(f.calls.find(call => call.method === "getFile")!.payload.file_id, "file-1");
  assert.equal(f.inputs[0]!.telegramChatId, "telegram:-100001:28");
  assert.equal(f.inputs[0]!.text, "Inspect this");
  assert.equal(f.inputs[0]!.attachments[0]!.kind, "image");
  const path = f.inputs[0]!.attachments[0]!.localPath;
  assert.deepEqual(new Uint8Array(await readFile(path)), png);
  assert.equal(JSON.parse(await readFile(`${path}.json`, "utf8")).status, "sent-to-codex");
});

test("image documents work in private chats; arbitrary files get a clear same-entry response", async t => {
  const f = await fixture(t);
  await f.bot.handleUpdate(image(1, { document: true, private: true }));
  assert.equal(f.inputs[0]!.telegramChatId, "42");
  await f.bot.handleUpdate(image(2, { document: true, mime: "application/pdf", topic: 28 }));
  assert.equal(f.inputs.length, 1);
  const notice = f.calls.filter(call => call.method === "sendRichMessage").at(-1)!;
  assert.equal(notice.payload.message_thread_id, 28);
  assert.match(JSON.stringify(notice.payload), /Only supported/);
});

test("albums become one ordered input before the following text and drain on shutdown", async t => {
  const f = await fixture(t);
  await f.bot.handleUpdate(image(1, { album: "album", caption: "Compare", topic: 28 }));
  await f.bot.handleUpdate(image(2, { album: "album", topic: 28 }));
  assert.equal(f.inputs.length, 0);
  await f.bot.handleUpdate(image(3, { text: "next", topic: 28 }));
  assert.deepEqual(f.order, ["image", "text"]);
  assert.equal(f.inputs[0]!.attachments.length, 2); assert.equal(f.inputs[0]!.text, "Compare");
  await f.bot.handleUpdate(image(4, { album: "second", topic: 29 }));
  await drainTelegramMediaGroups(f.bot);
  assert.equal(f.inputs.length, 2); assert.equal(f.inputs[1]!.telegramChatId, "telegram:-100001:29");
});

test("no session avoids downloading; download failures do not silently drop an image or leak tokens", async t => {
  const f = await fixture(t); f.setSession(false);
  await f.bot.handleUpdate(image(1, { topic: 28 }));
  assert.equal(f.calls.some(call => call.method === "getFile"), false);
  f.setSession(true); f.setFailure();
  await f.bot.handleUpdate(image(2, { topic: 28 }));
  assert.equal(f.inputs.length, 0);
  const notices = f.calls.filter(call => call.method === "sendRichMessage");
  assert.match(JSON.stringify(notices), /HTTP 403/);
  assert.equal(JSON.stringify(notices).includes("123:test"), false);
});

test("invalid image bytes and declared oversized files are rejected before Codex input", async () => {
  const bot = { token: "123:test", api: { getFile: async () => ({ file_path: "file" }) } } as unknown as Bot;
  const { Context } = await import("grammy");
  const ctx = new Context(image(1), bot.api, botInfo);
  await assert.rejects(downloadTelegramImages(bot, [ctx], (async () => new Response("not an image")) as typeof fetch), /Unsupported or invalid/);
  ctx.message!.photo!.at(-1)!.file_size = 11 * 1024 * 1024;
  await assert.rejects(downloadTelegramImages(bot, [ctx]), /10 MiB/);
});

test("Telegram voice downloads OGG then reuses the shared transcription-to-text pipeline", async t => {
  const f = await fixture(t);
  const turns: Array<{ text: string; telegramChatId: string }> = [];
  let transcriptions = 0;
  f.setFetch(async (url, options) => {
    if (String(url).includes("/audio/transcriptions")) {
      transcriptions++;
      const body = options!.body as FormData;
      assert.equal(body.get("model"), "test-transcriber");
      assert.equal((body.get("file") as File).type, "audio/ogg");
      return Response.json({ text: "Inspect the latest change" });
    }
    return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
  });
  const payload = new IncomingPayloadService({ openaiApiKey: "test-key", transcriptionModel: "test-transcriber",
    createPromptSpec: (_kind, text) => createMessage({ kind: "error", directory: "/project", body: [{ type: "text", text }] }),
    handleIncomingUserText: async input => { turns.push(input); return { routed: true }; } });
  f.setPayload(input => payload.handle(input));
  await f.bot.handleUpdate(image(1, { voice: true, topic: 28 }));
  assert.equal(transcriptions, 1); assert.equal(turns.length, 1);
  assert.equal(turns[0]!.telegramChatId, "telegram:-100001:28");
  assert.match(turns[0]!.text, /Audio transcript 1:\nInspect the latest change/);
  assert.equal(f.inputs[0]!.attachments[0]!.kind, "audio");
});

test("missing transcription configuration reports a scoped error without an API call or empty turn", async t => {
  const f = await fixture(t);
  let transcriptions = 0, turns = 0;
  f.setFetch(async url => {
    if (String(url).includes("/audio/transcriptions")) transcriptions++;
    return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
  });
  const payload = new IncomingPayloadService({ openaiApiKey: null,
    createPromptSpec: (_kind, text, source) => {
      assert.equal(source, "telegram:-100001:28");
      return createMessage({ kind: "error", directory: "/project", body: [{ type: "text", text }] });
    }, handleIncomingUserText: async () => { turns++; return { routed: true }; } });
  f.setPayload(input => payload.handle(input));
  await f.bot.handleUpdate(image(1, { voice: true, topic: 28 }));
  assert.equal(transcriptions, 0); assert.equal(turns, 0);
  const notice = f.calls.find(call => call.method === "sendRichMessage")!;
  assert.equal(notice.payload.message_thread_id, 28);
  assert.match(JSON.stringify(notice.payload), /OPENAI_API_KEY/);
  assert.equal(JSON.stringify(notice.payload).includes("Slack audio"), false);
});

test("audio files and failed transcription share the same payload handling as voice notes", async t => {
  const f = await fixture(t);
  let turns = 0;
  f.setFetch(async url => String(url).includes("/audio/transcriptions")
    ? Response.json({ error: { message: "Temporary transcription failure" } }, { status: 503 })
    : new Response(new Uint8Array([0x49, 0x44, 0x33, 0])));
  const payload = new IncomingPayloadService({ openaiApiKey: "test-key",
    createPromptSpec: (_kind, text) => createMessage({ kind: "error", directory: "/project", body: [{ type: "text", text }] }),
    handleIncomingUserText: async () => { turns++; return { routed: true }; } });
  f.setPayload(input => payload.handle(input));
  await f.bot.handleUpdate(image(1, { audio: true, topic: 28 }));
  assert.equal(f.inputs[0]!.attachments[0]!.mimeType, "audio/mpeg");
  assert.equal(turns, 0);
  assert.match(JSON.stringify(f.calls.find(call => call.method === "sendRichMessage")!.payload), /Temporary transcription failure/);
});
