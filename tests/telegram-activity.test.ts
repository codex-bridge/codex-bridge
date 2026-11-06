import assert from "node:assert/strict";
import test from "node:test";
import { GrammyError, type Bot } from "grammy";

import { createMessage } from "../src/bridge/messages/factory.js";
import { helpAction } from "../src/bridge/messages/actions.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { renderTelegramMessageSpec, renderTelegramMessageSpecChunks } from "../src/telegram/message-renderer.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";

function activity(title: string, lines: string[]) {
  return createMessage({
    kind: "progress", titleLabel: title, directory: "/workspace/project", presentation: "activity",
    body: lines.map((text) => ({ type: "text" as const, text }))
  });
}

test("Telegram renders activity titles and ordered summaries as one footer without dropping content", () => {
  for (const [title, lines] of [
    ["Run", ["Run ×3 · Unreported ×1 · Reported successes ×1 · Reported failures ×1", "Reason: timeout", "Task continued"]],
    ["Called", ["basic-memory.bm_read ×1 → basic-memory.bm_edit ×1 (failed)", "Error: timeout"]],
    ["Edited", ["README.md (+8 -1)", "docs/next-actions.md (+4 -0)"]]
  ] as const) {
    const spec = activity(title, [...lines]);
    const rendered = renderTelegramMessageSpec(spec);
    assert.equal(rendered.markdown, `<footer>${title} · /workspace/project<br>${lines.join("<br>")}</footer>`);
    assert.equal(rendered.html, [title + " · /workspace/project", ...lines].join("\n"));
    assert.equal(renderLegacyMessage(spec), rendered.html);
  }
});

test("Telegram keeps literal text escaped and file-edit code outside inline-only footers", () => {
  const spec = activity("Edited", ["file_*<&>.ts (+1 -1)\nsecond line"]);
  spec.body.push({ type: "code", text: "@@\n-old\n+<new>&" });
  spec.body.push({ type: "text", text: "next.ts (+1 -0)" });
  const rendered = renderTelegramMessageSpec(spec);
  assert.equal(rendered.markdown, [
    "<footer>Edited · /workspace/project<br>file_*&lt;&amp;&gt;.ts (+1 -1)<br>second line</footer>",
    "<pre><code>@@\n-old\n+&lt;new&gt;&amp;</code></pre>",
    "<footer>next.ts (+1 -0)</footer>"
  ].join("\n\n"));
  assert.equal(rendered.html, [
    "Edited · /workspace/project", "file_*&lt;&amp;&gt;.ts (+1 -1)\nsecond line",
    "<code>@@\n-old\n+&lt;new&gt;&amp;</code>", "next.ts (+1 -0)"
  ].join("\n"));
});

test("Telegram activity chunks repeat the plain title and keep footer markup within the limit", () => {
  const chunks = renderTelegramMessageSpecChunks(activity("Edited", Array.from({ length: 20 }, (_, i) =>
    `src/file-${i}.ts (+8 -1) & 🧪`)), 250);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.markdown.startsWith("<footer>Edited · /workspace/project<br>"));
    assert.ok(chunk.markdown.endsWith("</footer>"));
    assert.ok(chunk.markdown.length <= 250);
    assert.ok(chunk.html.length <= 250);
    assert.doesNotMatch(chunk.html, /<footer>|<b>/);
  }
});

test("Telegram sends and edits activity footers with the same keyboard and notification options", async () => {
  const calls: Array<{ chat: string; content: unknown; options: Record<string, unknown> }> = [];
  const bot = { api: {
    sendRichMessage: async (chat: string, content: unknown, options: Record<string, unknown>) => {
      calls.push({ chat, content, options }); return { message_id: 7 };
    },
    editMessageText: async (chat: string, id: number, content: unknown, options: Record<string, unknown>) => {
      assert.equal(id, 7); calls.push({ chat, content, options }); return true;
    }
  } } as unknown as Bot;
  const spec = activity("Run", ["Run ×1 · Unreported ×1 · Reported successes ×0 · Reported failures ×0"]);
  spec.actions = [helpAction()];
  const transport = new TelegramMessageTransport(bot, (text) => text);
  assert.deepEqual(await transport.sendMessageSpec("123", spec, { disable_notification: true }), { message_id: "7" });
  await transport.editMessageSpec("123", "7", spec, { disable_notification: true });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.chat, "123");
    assert.deepEqual(call.content, { markdown: renderTelegramMessageSpec(spec).markdown });
    assert.equal(call.options.disable_notification, true);
    assert.deepEqual(JSON.parse(JSON.stringify(call.options.reply_markup)), {
      inline_keyboard: [[{ text: "Help", callback_data: "quick:help" }]]
    });
  }
});

test("Telegram activity falls back to an unbolded HTML title on a definite rich-format rejection", async () => {
  const rejection = new GrammyError("format rejected", {
    ok: false, error_code: 400, description: "Bad Request: can't parse rich message"
  }, "sendRichMessage", {});
  for (const operation of ["send", "edit"] as const) {
    const fallback: Array<{ content: string; options: Record<string, unknown> }> = [];
    const bot = { api: {
      sendRichMessage: async () => { throw rejection; },
      sendMessage: async (_chat: string, content: string, options: Record<string, unknown>) => {
        fallback.push({ content, options }); return { message_id: 7 };
      },
      editMessageText: async (_chat: string, id: number, content: unknown, options: Record<string, unknown>) => {
        assert.equal(id, 7);
        if (typeof content !== "string") throw rejection;
        fallback.push({ content, options }); return true;
      }
    } } as unknown as Bot;
    const transport = new TelegramMessageTransport(bot, (text) => text);
    const spec = activity("Called", ["basic-memory.bm_read ×1"]);
    if (operation === "send") await transport.sendMessageSpec("123", spec);
    else await transport.editMessageSpec("123", "7", spec);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0]!.content, "Called · /workspace/project\nbasic-memory.bm_read ×1");
    assert.equal(fallback[0]!.options.parse_mode, "HTML");
  }
});
