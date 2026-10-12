import assert from "node:assert/strict";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import { GrammyError, type Bot } from "grammy";

import { createEditedMessage, createMessage } from "../src/bridge/messages/factory.js";
import { actionRow, helpAction, refreshAction } from "../src/bridge/messages/actions.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { renderSlackMessageSpec, renderSlackMessageSpecChunks } from "../src/slack/message-renderer.js";
import { TelegramMessageTransport } from "../src/telegram/transport.js";
import { renderTelegramMessageSpecChunks } from "../src/telegram/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

const message = createEditedMessage({
  session: {
    id: "thread-1",
    directory: "/Users/example/workspace/projects/demo-app"
  },
  body: [
    { type: "text", text: "src/index.ts (+1 -0)" },
    { type: "code", text: "Proceed" }
  ],
  actions: actionRow(helpAction(), refreshAction("session-refresh:thread-1"))
});

test("Codex update has the same concise content on Slack and Telegram", () => {
  const update = createMessage({
    kind: "version-update",
    session: { id: "thread-1", directory: "/Users/example/workspace/projects/api-service" },
    body: [{ type: "text", text: "0.158.0 → 0.159.0" }]
  });
  const slack = renderSlackMessageSpec("slack:T:C:1", update, null)[0];
  const telegram = renderTelegramMessageSpec(update);

  assert.deepEqual(slack, {
    type: "markdown",
    text: "**Codex update · \\.\\.\\.\\/projects\\/api\\-service**\n0\\.158\\.0 → 0\\.159\\.0"
  });
  assert.equal(telegram.html, "<b>Codex update · .../projects/api-service</b>\n0.158.0 → 0.159.0");
});

test("Slack renders an explicit message spec without inferring actions from text", async () => {
  let payload: Record<string, unknown> | undefined;
  const client = {
    conversations: { history: async () => ({ ok: true, messages: [{ ts: "1.0001" }] }) },
    chat: {
      postMessage: async (value: Record<string, unknown>) => {
        payload = value;
        return { channel: "C", ts: "2.0001", message: { thread_ts: "1.0001" } };
      }
    }
  } as unknown as WebClient;

  await new SlackMessageTransport(client).sendMessageSpec(
    "slack:T:C:1.0001",
    message,
    { textFormat: "plain" }
  );

  const blocks = payload?.blocks as Array<{
    type: string;
    text?: string | { text: string };
    elements?: Array<{ value?: string }>;
  }>;
  assert.equal(blocks[0]?.type, "markdown");
  const content = typeof blocks[0]?.text === "string" ? blocks[0].text : "";
  assert.ok(content.startsWith("**Edited · \\.\\.\\.\\/projects\\/demo\\-app**"));
  assert.doesNotMatch(content, /stale/);
  assert.equal(blocks.at(-1)?.type, "actions");
  assert.equal(blocks.at(-1)?.elements?.length, 2);
});

test("Slack does not repeat an action group already represented by the message title", () => {
  const blocks = renderSlackMessageSpec("slack:T:C:1", {
    kind: "menu",
    title: "Sessions · /workspace/project",
    body: [{ type: "text", text: "Choose a directory." }],
    actions: [{ id: "directory", label: "Project", callback: "session-dir:project:0", group: "Sessions" }]
  }, null);

  assert.deepEqual(
    blocks.filter((block) => block.type === "section").map((block) => block.type === "section" ? block.text.text : ""),
    []
  );
  assert.equal(blocks[0]?.type === "markdown" ? blocks[0].text : "", "**Sessions · \\/workspace\\/project**\nChoose a directory\\.");
  assert.equal(blocks.filter((block) => block.type === "actions").length, 1);
});

test("Slack keeps action groups in separate rows before applying the five-button limit", () => {
  const blocks = renderSlackMessageSpec("slack:T:C:1", {
    kind: "menu",
    title: "Menu",
    body: [],
    actions: [
      { id: "release", label: "Release", callback: "release", group: "Current session" },
      { id: "archive", label: "Archive", callback: "archive", group: "Current session" },
      { id: "directory", label: "Directory", callback: "directory", group: "Sessions" },
      { id: "refresh", label: "Refresh", callback: "refresh", group: "Sessions" },
      { id: "help", label: "Help", callback: "help" }
    ]
  }, null);

  assert.deepEqual(
    blocks.filter((block) => block.type === "section").map((block) => block.type === "section" ? block.text.text : ""),
    ["*Current session*", "*Sessions*"]
  );
  assert.equal(blocks[0]?.type === "markdown" ? blocks[0].text : "", "**Menu**");
  assert.deepEqual(
    blocks.filter((block) => block.type === "actions").map((block) =>
      block.type === "actions" ? block.elements.map((element) => element.text.text) : []
    ),
    [["Release", "Archive"], ["Directory", "Refresh"], ["Help"]]
  );
});

test("Slack preserves assistant Markdown in a native markdown block", () => {
  const blocks = renderSlackMessageSpec("slack:T:C:1", {
    kind: "codex",
    title: "Codex · project",
    body: [{ type: "markdown", text: "- first\n- second with `code`\n\n[Docs](https://example.com)" }],
    actions: []
  }, null);

  assert.deepEqual(blocks[0], {
    type: "markdown",
    text: "**Codex · project**\n- first\n- second with `code`\n\n[Docs](https://example.com)"
  });
});

test("Slack keeps structured plain text literal inside native Markdown", () => {
  const blocks = renderSlackMessageSpec("slack:T:C:1", {
    kind: "system",
    title: "Literal <title>",
    body: [{ type: "text", text: "> quote | cell ~~removed~~ <tag>" }],
    actions: []
  }, null);

  assert.deepEqual(blocks[0], {
    type: "markdown",
    text: "**Literal \\<title\\>**\n\\> quote \\| cell \\~\\~removed\\~\\~ \\<tag\\>"
  });
});

test("Slack splits long message specs by rendered markdown length", () => {
  const chunks = renderSlackMessageSpecChunks({
    ...message,
    body: [{ type: "text", text: "<& content\n".repeat(1000) }]
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => {
    const contentBlock = renderSlackMessageSpec("slack:T:C:1", chunk, null)[0];
    return contentBlock?.type === "markdown" && contentBlock.text.length <= 12_000;
  }));
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.actions.length === 0));
  assert.deepEqual(chunks.at(-1)?.actions.map((action) => action.id), ["help", "refresh"]);
});

test("Telegram renders an explicit message spec with its declared keyboard", async () => {
  let receivedRichMessage: Record<string, unknown> | undefined;
  let receivedOptions: Record<string, unknown> | undefined;
  const bot = {
    api: {
      sendRichMessage: async (
        _chatId: string,
        richMessage: Record<string, unknown>,
        options: Record<string, unknown>
      ) => {
        receivedRichMessage = richMessage;
        receivedOptions = options;
        return { message_id: 1 };
      }
    }
  } as unknown as Bot;

  await new TelegramMessageTransport(bot, (text) => text).sendMessageSpec(
    "123",
    message,
    { textFormat: "plain" }
  );

  assert.equal(receivedRichMessage?.markdown, [
    "<p><b>Edited · .../projects/demo-app</b></p>",
    "<p>src/index.ts (+1 -0)</p>",
    "<p><code>Proceed</code></p>"
  ].join("\n\n"));
  assert.deepEqual(
    JSON.parse(JSON.stringify(receivedOptions?.reply_markup)),
    {
      inline_keyboard: [[{ text: "Help", callback_data: "quick:help" },
        { text: "Refresh", callback_data: "session-refresh:thread-1" }
      ]]
    }
  );
});

test("Telegram edits message specs as rich markdown", async () => {
  let receivedRichMessage: Record<string, unknown> | undefined;
  let receivedOptions: Record<string, unknown> | undefined;
  const bot = {
    api: {
      editMessageText: async (
        _chatId: string,
        _messageId: number,
        richMessage: Record<string, unknown>,
        options: Record<string, unknown>
      ) => {
        receivedRichMessage = richMessage;
        receivedOptions = options;
        return true;
      }
    }
  } as unknown as Bot;

  await new TelegramMessageTransport(bot, (text) => text).editMessageSpec(
    "123",
    "42",
    message
  );

  assert.match(String(receivedRichMessage?.markdown), /^<p><b>Edited · \.\.\.\/projects\/demo-app<\/b><\/p>/);
  assert.ok(receivedOptions?.reply_markup);
});

test("Telegram falls back to HTML only after a definitive rich-message rejection", async () => {
  let fallbackText = "";
  let fallbackOptions: Record<string, unknown> | undefined;
  const rejection = new GrammyError("rich message rejected", {
    ok: false,
    error_code: 400,
    description: "Bad Request: can't parse rich message"
  }, "sendRichMessage", {});
  const bot = {
    api: {
      sendRichMessage: async () => {
        throw rejection;
      },
      sendMessage: async (_chatId: string, text: string, options: Record<string, unknown>) => {
        fallbackText = text;
        fallbackOptions = options;
        return { message_id: 1 };
      }
    }
  } as unknown as Bot;

  await new TelegramMessageTransport(bot, (text) => text).sendMessageSpec("123", message);

  assert.match(fallbackText, /^<b>Edited · \.\.\.\/projects\/demo-app<\/b>/);
  assert.equal(fallbackOptions?.parse_mode, "HTML");
});

test("Telegram does not retry a rich message after an indeterminate transport failure", async () => {
  let fallbackCalls = 0;
  const networkFailure = new Error("socket closed before response");
  const bot = {
    api: {
      sendRichMessage: async () => {
        throw networkFailure;
      },
      sendMessage: async () => {
        fallbackCalls += 1;
        return { message_id: 1 };
      }
    }
  } as unknown as Bot;

  await assert.rejects(
    new TelegramMessageTransport(bot, (text) => text).sendMessageSpec("123", message),
    networkFailure
  );
  assert.equal(fallbackCalls, 0);
});

test("Telegram splits long message specs while keeping actions on the final chunk", () => {
  const chunks = renderTelegramMessageSpecChunks({
    ...message,
    body: [{ type: "text", text: "line\n".repeat(3000) }]
  }, 500);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.markdown.length <= 500 && chunk.html.length <= 500));
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.spec.actions.length === 0));
  assert.deepEqual(chunks.at(-1)?.spec.actions.map((action) => action.id), ["help", "refresh"]);
});
