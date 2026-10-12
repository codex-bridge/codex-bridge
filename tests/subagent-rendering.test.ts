import assert from "node:assert/strict";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import type { Bot } from "grammy";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { formatTelegramHtml } from "../src/telegram/text.js";

for (const kind of ["Codex", "Called", "Edited"]) {
  const title = `${kind} · .../projects/codex-bridge · check [123456]`;
  const body = kind === "Called" ? "mcp__test__read\nRead complete." : "Result `file.ts`";
  test(`Slack ${kind} subagent header is bold and remains inside the originating thread`, async () => {
    let payload: Record<string, unknown> | undefined;
    const client = { conversations: {
      history: async () => ({ ok: true, messages: [{ ts: "1.0001" }] })
    }, chat: { postMessage: async (value: Record<string, unknown>) => {
      payload = value; return { channel: "C", ts: "2.0001", message: { thread_ts: "1.0001" } };
    } } } as unknown as WebClient;
    await new SlackMessageTransport(client).sendMessage("slack:T:C:1.0001", `${title}\n${body}`, { textFormat: "html" });
    assert.equal(payload?.channel, "C");
    assert.equal(payload?.thread_ts, "1.0001");
    const blocks = payload?.blocks as Array<{ type: string; text?: { text: string } }>;
    assert.ok(blocks.some((block) => block.text?.text.includes(`*${title.replace("[123456]", "`123456`")}*`)));
    assert.ok(blocks.every((block) => block.type !== "actions"));
  });

  test(`Telegram ${kind} subagent header uses HTML bold`, async () => {
    let received = "";
    const bot = { api: { sendMessage: async (chatId: string, text: string, options: { parse_mode: string }) => {
      assert.equal(chatId, "123"); assert.equal(options.parse_mode, "HTML");
      received = text; return { message_id: 1 };
    } } } as unknown as Bot;
    await new TelegramMessageTransport(bot, formatTelegramHtml).sendMessage("123", `${title}\n${body}`, { textFormat: "html" });
    assert.ok(received.includes(`<b>${title}</b>`));
  });
}
