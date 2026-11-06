import assert from "node:assert/strict";
import test from "node:test";

import { groupActivityContent, messagePlainText } from "../src/bridge/messages/content.js";
import { createActivityMessage, createMessage } from "../src/bridge/messages/factory.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { createProgressMessageSpec, type ProgressRenderEvent } from "../src/bridge/renderers/progress.js";
import { createThreadHistoryEntrySpec } from "../src/bridge/renderers/thread-history.js";
import type { AppServerProgressEvent } from "../src/codex/client.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

test("activity content preserves literal text, field meaning, newlines and consecutive code boundaries", () => {
  const spec = createActivityMessage({
    kind: "edited", directory: "/workspace/project",
    body: [
      { type: "text", text: "file_*<&>.ts (+1 -1)\n🧪" },
      { type: "field", label: "Reason", value: "timeout" },
      { type: "code", text: "@@\n-old\n+<new>" },
      { type: "code", text: "next_code()" },
      { type: "heading", text: "Details" },
      { type: "markdown", text: "literal **markers**" }
    ]
  });
  const before = structuredClone(spec);
  assert.deepEqual(groupActivityContent(spec), [
    { type: "text", text: "Edited · /workspace/project\nfile_*<&>.ts (+1 -1)\n🧪\nReason: timeout" },
    { type: "code", text: "@@\n-old\n+<new>" },
    { type: "code", text: "next_code()" },
    { type: "text", text: "Details\nliteral **markers**" }
  ]);
  const expected = ["Edited · /workspace/project", "file_*<&>.ts (+1 -1)\n🧪", "Reason: timeout",
    "@@\n-old\n+<new>", "next_code()", "Details", "literal **markers**"].join("\n");
  assert.equal(messagePlainText(spec), expected);
  assert.equal(renderLegacyMessage(spec), expected);
  assert.deepEqual(spec, before);
});

test("activity content retains empty code and blank lines without inventing text blocks", () => {
  assert.deepEqual(groupActivityContent({ title: "", body: [] }), []);
  assert.deepEqual(groupActivityContent({ title: "Run", body: [
    { type: "text", text: "" }, { type: "text", text: "next" }, { type: "code", text: "" }
  ] }), [{ type: "text", text: "Run\n\nnext" }, { type: "code", text: "" }]);
});

test("all live progress branches are activity at construction while history keeps its existing presentation", () => {
  for (const label of ["Run", "Called", "Edited", "Explored", "System"]) {
    for (const failed of [false, true]) {
      const event: ProgressRenderEvent & AppServerProgressEvent = {
        threadId: "thread-1", action: null,
        label, toolName: "basic-memory.bm_read", target: null, input: null,
        changes: label === "Edited" ? [{ path: "/workspace/project/a.ts", type: "update", added: 1, removed: 0,
          lineStatsAvailable: true, diffPreview: "@@\n+new" }] : null,
        failed, text: "observed", failureReason: failed ? "timeout" : null
      };
      const live = createProgressMessageSpec({ directory: "/workspace/project", event });
      const history = createThreadHistoryEntrySpec({ directory: "/workspace/project", entry: {
        kind: "progress", event, itemId: "item-1", turnId: "turn-1"
      } });
      assert.equal(live.presentation, "activity", label);
      assert.equal(history.presentation, undefined, label);
      const { presentation: _presentation, ...content } = live;
      void _presentation;
      assert.deepEqual(content, history);
      assert.equal(renderSlackMessageSpec("slack:T:C", live, null)[0]?.type, "context");
      assert.match(renderTelegramMessageSpec(live).markdown, /^<footer>/);
      assert.equal(renderSlackMessageSpec("slack:T:C", history, null)[0]?.type, "markdown");
      assert.match(renderTelegramMessageSpec(history).markdown, /^<p><b>/);
    }
  }
  const reply = createMessage({ kind: "codex", directory: "/workspace/project",
    body: [{ type: "markdown", text: "**Reply**" }] });
  assert.equal(reply.presentation, undefined);
  assert.equal(renderSlackMessageSpec("slack:T:C", reply, null)[0]?.type, "markdown");
});
