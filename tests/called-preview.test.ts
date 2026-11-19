import assert from "node:assert/strict";
import test from "node:test";

import { extractProgressEvent } from "../src/codex/notification-events.js";
import { extractProgressEventFromItem } from "../src/codex/extractors/progress.js";
import { createProgressMessageSpec, createProgressHistoryMessageSpec } from "../src/bridge/renderers/progress.js";
import { truncateTemporaryMessageSpec } from "../src/bridge/messages/temporary.js";
import { BridgeStore } from "../src/store/index.js";
import { fixtureProgressService } from "./fixtures/progress-service.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { presentWebMessage } from "../src/web/message-presentation.js";

const directory = "/workspace/src/_appio/_inbox/codex-bridge";
function observation(input: Record<string, unknown>, completed = false) {
  return extractProgressEvent({ method: completed ? "item/completed" : "item/started", params: {
    threadId: "thread", turnId: "turn", item: { id: "call", type: "mcpToolCall", server: "tools", tool: "inspect", ...input }
  } })!;
}

test("Called live previews retain full nested arguments and use the existing code rendering on all clients", () => {
  const event = observation({ arguments: { script: "inspect(<node>)", options: { depths: [0, 2], enabled: false } }, result: "Do not display tool results" });
  const spec = createProgressMessageSpec({ directory, event, includeLivePreview: true });
  assert.equal(spec.title, "Called · .../_inbox/codex-bridge");
  assert.equal(spec.presentation, "activity");
  assert.deepEqual(spec.body, [{ type: "text", text: "tools.inspect" }, { type: "code",
    text: '{\n  "script": "inspect(<node>)",\n  "options": {\n    "depths": [\n      0,\n      2\n    ],\n    "enabled": false\n  }\n}' }]);
  const slack = renderSlackMessageSpec("slack:T:C:1", spec, null);
  assert.deepEqual(slack.map(block => block.type), ["context", "section"]);
  assert.match(JSON.stringify(slack), /inspect\(&lt;node&gt;\)/);
  const tg = renderTelegramMessageSpec(spec);
  assert.match(tg.markdown, /<pre><code>/);
  assert.match(tg.html, /inspect\(&lt;node&gt;\)/);
  assert.deepEqual(presentWebMessage(spec).body, spec.body);
  assert.equal(JSON.stringify(spec).includes("Do not display tool results"), false);
  assert.equal(createProgressHistoryMessageSpec({ directory, event }).body.some(part => part.type === "code"), false);
});

test("Called accepts explicit input fields and JSON values without guessing missing arguments", () => {
  for (const [input, expected] of [
    [{ arguments: { nested: { value: 3 } } }, '{\n  "nested": {\n    "value": 3\n  }\n}'],
    [{ payload: { params: [0, false, null] } }, '[\n  0,\n  false,\n  null\n]'],
    [{ input: "line one\nline two" }, "line one\nline two"],
    [{ arguments: false }, "false"], [{ arguments: 0 }, "0"], [{ arguments: null }, "null"],
    [{ arguments: {} }, "{}"], [{ output: { arguments: { invented: true } }, cwd: "/work" }, undefined]
  ] as const) {
    assert.equal(observation(input).inputPreview, expected);
  }
  const dynamic = observation({ type: "dynamicToolCall", namespace: "custom", tool: "probe", arguments: { nested: ["actual input"] },
    contentItems: [{ text: "Output is not input" }] });
  assert.match(dynamic.inputPreview!, /actual input/);
  assert.equal(JSON.stringify(dynamic).includes("Output is not input"), false);
  assert.equal(extractProgressEventFromItem({ threadId: "thread", item: { type: "dynamicToolCall", tool: "probe", arguments: { nested: ["actual input"] } } })!.inputPreview,
    undefined, "restored items do not extract live-only argument details");
  assert.equal(observation({ type: "commandExecution", command: "echo ok", arguments: { ignored: true } }).inputPreview, undefined);
});

test("Called details are replaced by the existing final summary and are not persisted in phase records", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: directory });
  const sent: Array<{ id: string; spec: MessageSpec; edit: boolean }> = [];
  const service = fixtureProgressService(store, (id, spec, edit) => sent.push({ id, spec, edit }));
  for (const completed of [false, true]) {
    await service.sendProgressMessage(session, observation({ arguments: { script: "Unique argument preview" } }, completed), "turn");
  }
  assert.equal(sent[0]!.spec.body.some(part => part.type === "code" && part.text.includes("Unique argument preview")), true);
  assert.equal(JSON.stringify(store.getLatestProgressPhaseMessage("thread", "turn")).includes("Unique argument preview"), false);
  await service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.equal(sent.at(-1)!.id, sent[0]!.id);
  assert.equal(sent.at(-1)!.edit, true);
  assert.equal(sent.at(-1)!.spec.body.some(part => part.type === "code"), false);
  assert.equal(JSON.stringify(sent.at(-1)!.spec).includes("Unique argument preview"), false);
  assert.match(JSON.stringify(sent.at(-1)!.spec.body), /tools.inspect ×1/);
});

test("Called previews retain failure placement and share the existing Unicode character limit", () => {
  const failed = observation({ status: "failed", arguments: { filename: "output.png" }, error: { message: "timeout" } }, true);
  const spec = createProgressMessageSpec({ directory, event: failed, includeLivePreview: true });
  assert.equal(spec.body[1]!.type, "code");
  assert.deepEqual(spec.body.at(-1), { type: "text", text: "Error: other failure" });
  const long = observation({ arguments: { script: "🙂".repeat(1000) } });
  const truncated = truncateTemporaryMessageSpec(createProgressMessageSpec({ directory, event: long, includeLivePreview: true }));
  const bodyText = truncated.body.map(part => part.type === "field" ? part.value : part.text).join("");
  assert.equal(Array.from(bodyText).length, 800);
  assert.match(bodyText, /…$/);
  assert.equal(truncated.body.at(-1)!.type, "code");
  assert.equal(truncated.title, "Called · .../_inbox/codex-bridge");
});
