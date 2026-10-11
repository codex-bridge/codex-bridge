import assert from "node:assert/strict";
import test from "node:test";

import { formatCodexTelegramHtml, formatTelegramHtml } from "../src/telegram/text.js";

test("renders no-session Codex title in bold", () => {
  assert.equal(
    formatTelegramHtml("Codex\nNo active session."),
    "<b>Codex</b>\nNo active session."
  );
});

test("preserves raw markdown tables without generated copies", () => {
  const table = ["| File | Status |", "| --- | --- |", "| src/app.ts | changed |"].join("\n");
  const chunks = formatCodexTelegramHtml(`Codex · .../repo\n\n${table}`, 3500);
  assert.equal(chunks?.length, 1);
  assert.equal(chunks?.[0]?.html, `<b>Codex · .../repo</b>\n\n${table}`);
  assert.doesNotMatch(chunks?.[0]?.html ?? "", /<pre>|\[File\]/);
});

test("preserves CJK table rows and ordinary inline formatting", () => {
  const table = ["| Field | Value |", "| --- | --- |", "| **Status** | `Available` |"].join("\n");
  const chunks = formatCodexTelegramHtml(table, 3500);
  assert.equal(chunks?.[0]?.html, ["| Field | Value |", "| --- | --- |", "| <b>Status</b> | <code>Available</code> |"].join("\n"));
});

test("renders markdown bold labels without literal markers", () => {
  const chunks = formatCodexTelegramHtml("**Goal**\nImprove Telegram rendering", 3500);

  assert.equal(
    chunks?.[0]?.html,
    [
      "<b>Goal</b>",
      "Improve Telegram rendering"
    ].join("\n")
  );
});

test("keeps markdown bold markers inside inline code", () => {
  const chunks = formatCodexTelegramHtml("Use `**Goal**` as input", 3500);

  assert.equal(chunks?.[0]?.html, "Use <code>**Goal**</code> as input");
});

test("renders bold status keys in Telegram HTML", () => {
  assert.equal(
    formatTelegramHtml("**Provider**\n**Saved** openai\n**Directory** /workspace/project"),
    [
      "<b>Provider</b>",
      "<b>Saved</b> openai",
      "<b>Directory</b> <code>/workspace/project</code>"
    ].join("\n")
  );
});

test("renders working and go header lines in bold", () => {
  assert.equal(
    formatTelegramHtml("Working · Thinking · 21s\n`.../projects/demo-app`"),
    [
      "<b>Working · Thinking · 21s</b>",
      "<code>.../projects/demo-app</code>"
    ].join("\n")
  );
  assert.equal(
    formatTelegramHtml("Actions · .../projects/demo-app"),
    "<b>Actions · .../projects/demo-app</b>"
  );
});

test("renders called header line in bold without changing details", () => {
  assert.equal(
    formatTelegramHtml("Called · .../projects/api-service\nmcp\ntarget=f1e348"),
    [
      "<b>Called · .../projects/api-service</b>",
      "mcp",
      "target=f1e348"
    ].join("\n")
  );
});

test("renders transcript and system header lines in bold", () => {
  assert.equal(
    formatTelegramHtml(
      [
        "User · .../projects/demo-app",
        "Are you there?",
        "System · .../projects/demo-app",
        "notice",
        "MCP result · .../projects/demo-app",
        "done",
        "Edited · .../projects/demo-app",
        "src/a.ts (+1 -0)",
        "Compact started · .../projects/demo-app",
        "Compact completed · .../projects/demo-app",
        "Codex error · .../projects/demo-app"
      ].join("\n")
    ),
    [
      "<b>User · .../projects/demo-app</b>",
      "Are you there?",
      "<b>System · .../projects/demo-app</b>",
      "notice",
      "<b>MCP result · .../projects/demo-app</b>",
      "done",
      "<b>Edited · .../projects/demo-app</b>",
      "src/a.ts (+1 -0)",
      "<b>Compact started · .../projects/demo-app</b>",
      "<b>Compact completed · .../projects/demo-app</b>",
      "<b>Codex error · .../projects/demo-app</b>"
    ].join("\n")
  );
});
