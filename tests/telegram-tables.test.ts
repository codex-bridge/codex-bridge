import assert from "node:assert/strict";
import test from "node:test";
import { separateTelegramTables } from "../src/telegram/markdown.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { createMessage } from "../src/bridge/messages/factory.js";

const table = "| Field | Purpose |\n|---|---|\n| `accountKey` | optional |";
test("Telegram separates the parsed table from a preceding bold paragraph without changing its cells", () => {
  const input = `**1. wallets**\n${table}`;
  const expected = `**1. wallets**\n\n${table}`;
  assert.equal(separateTelegramTables(input), expected);
  assert.equal(separateTelegramTables(expected), expected);
  const spec = createMessage({ kind: "codex", directory: "/project", body: [{ type: "markdown", text: input }] });
  assert.equal(renderTelegramMessageSpec(spec).markdown, `<p><b>Codex · /project</b></p>\n\n${expected}`);
  assert.equal(spec.body[0]!.type === "markdown" && spec.body[0]!.text, input, "other consumers retain original Markdown");
});
test("tables at the start, separated tables, pipe literals and fenced code remain unchanged", () => {
  for (const input of [table, `Intro\n\n${table}`, `\`a | b\``, `\`\`\`md\nTitle\n${table}\n\`\`\``, "plain | text\nwithout a delimiter"]) {
    assert.equal(separateTelegramTables(input), input);
  }
});
test("multiple tables preserve order, Unicode, escaped pipes and CRLF line endings", () => {
  const second = "| A | B |\n|---|---|\n| a\\|b | \u4e2d\u6587 |";
  const input = `First\n${table}\n\nSecond\n${second}`;
  const expected = `First\n\n${table}\n\nSecond\n\n${second}`;
  assert.equal(separateTelegramTables(input), expected);
  assert.equal(separateTelegramTables(input.replaceAll("\n", "\r\n")), expected.replaceAll("\n", "\r\n"));
});
