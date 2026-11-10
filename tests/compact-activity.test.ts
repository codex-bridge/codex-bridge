import assert from "node:assert/strict";
import test from "node:test";

import type { MessageSpec } from "../src/bridge/messages/types.js";
import { createThreadHistoryEntrySpec } from "../src/bridge/renderers/thread-history.js";
import { CompactService } from "../src/bridge/sessions/compact-service.js";
import type { BridgeMessageOptions } from "../src/bridge/transport.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { BridgeStore } from "../src/store/index.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

async function harness(t: test.TestContext, connected = true) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({
    telegramChatId: "chat", codexThreadId: "thread", pathKey: "/workspace/project"
  });
  await store.setActiveSession("chat", session.id);
  const sent: Array<{ spec: MessageSpec; options: Omit<BridgeMessageOptions, "messageSpec"> | undefined }> = [];
  const service = new CompactService({
    store,
    codexClient: {
      startCompactThread: async () => {},
      resumeThread: async () => ({ displayPath: null, messages: [] }),
      sendTurn: async () => {}
    },
    isRuntimeConnected: () => connected,
    getLastUserInput: () => undefined,
    getSessionDirectory: () => "/workspace/project",
    formatCompactTokenCount: () => "",
    isMissingRuntimeThreadError: () => false,
    resumeThread: async () => ({ displayPath: null, messages: [] }),
    rememberNotificationSession: () => {},
    setSessionStatus: async () => {},
    sendSystemErrorMessage: async () => {},
    sendLongSpec: async (_chat, spec, options) => { sent.push({ spec, options }); }
  });
  return { service, session, sent };
}

function assertActivity(spec: MessageSpec, expected: string[]) {
  assert.equal(spec.presentation, "activity");
  assert.deepEqual(spec.actions, []);
  const blocks = renderSlackMessageSpec("slack:T:C", spec, null);
  const text = expected.length > 1 ? `${expected[0]} ·\n${expected.slice(1).join("\n")}` : expected[0];
  assert.deepEqual(blocks, [{
    type: "context", elements: [{ type: "plain_text", text, emoji: false }]
  }]);
  const telegram = renderTelegramMessageSpec(spec);
  assert.equal(telegram.markdown, `<footer>${expected.join("<br>")}</footer>`);
  assert.equal(telegram.html, expected.join("\n"));
}

test("manual compact replies use subdued activity without Help", async (t) => {
  const { service } = await harness(t);
  assertActivity(await service.compactActiveSession("chat"), [
    "Compact started · /workspace/project", "Triggered by you"
  ]);
});

test("compact notifications keep source, recovery details and quiet delivery without Help", async (t) => {
  for (const [source, label] of [["runtime", "Codex"], ["bridge-auto", "Bridge"], ["manual", "you"]] as const) {
    const { service, session, sent } = await harness(t);
    await service.notifyCompactStarted(session, source, { reason: "incompatible history", next: "retrying once" });
    await service.notifyCompactCompleted(session, { next: "Retrying last message" });
    assert.equal(sent.length, 2);
    assertActivity(sent[0]!.spec, ["Compact started · /workspace/project", `Triggered by ${label}`,
      "Reason: incompatible history", "Next: retrying once"]);
    assertActivity(sent[1]!.spec, ["Compact completed · /workspace/project", "Next: Retrying last message"]);
    assert.ok(sent.every(({ options }) => options?.disable_notification === true));
  }
});

test("completion without a start and historical compaction use the same button-free activity style", async (t) => {
  const { service, session, sent } = await harness(t);
  await service.notifyCompactCompleted(session);
  assertActivity(sent[0]!.spec, ["Compact completed · /workspace/project"]);
  assertActivity(createThreadHistoryEntrySpec({
    directory: "/workspace/project", entry: { kind: "compaction", itemId: "item", turnId: "turn" }
  }), ["Compact completed · /workspace/project"]);
});

test("compact errors retain the ordinary error presentation", async (t) => {
  const { service } = await harness(t, false);
  const spec = await service.compactActiveSession("chat");
  assert.equal(spec.kind, "error");
  assert.equal(spec.presentation, undefined);
  assert.equal(spec.title, "Codex error · /workspace/project");
});
