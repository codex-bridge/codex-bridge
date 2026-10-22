import assert from "node:assert/strict";
import test from "node:test";
import type { Button, KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import { buildSlackButton } from "../src/slack/buttons.js";
import { decodeSlackCallbackValue } from "../src/slack/callback.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { BridgeService } from "../src/bridge/service.js";
import { BridgeStore } from "../src/store/index.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { testConfig } from "./bridge-test-config.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });

function buttons(blocks: KnownBlock[]): Button[] {
  return blocks.flatMap((block) => block.type === "actions"
    ? block.elements.filter((element): element is Button => element.type === "button") : []);
}

function slackFixture() {
  const payloads: KnownBlock[][] = [];
  const validate = async ({ blocks = [] }: { blocks?: KnownBlock[] }) => {
    for (const button of buttons(blocks)) {
      assert.ok(Array.from(button.text.text).length > 0);
      assert.ok(Array.from(button.text.text).length <= 75, "Slack rejects oversized button text");
    }
    payloads.push(blocks);
    return { ok: true, channel: "C", ts: "2", message: { thread_ts: "1" } };
  };
  const transport = new SlackMessageTransport({
    conversations: { history: async () => ({ ok: true, messages: [{ ts: "1" }] }) },
    chat: { postMessage: validate, update: validate }
  } as unknown as WebClient, "secret");
  return { transport, payloads };
}

for (const [label, expected] of [
  ["x".repeat(74), "x".repeat(74)],
  ["x".repeat(75), "x".repeat(75)],
  ["x".repeat(76), `${"x".repeat(74)}…`],
  ["😀".repeat(75), "😀".repeat(75)],
  ["😀".repeat(76), `${"😀".repeat(74)}…`],
  ["  Action  ", "Action"],
  ["  ", "Action"]
]) {
  test(`send and edit enforce the button text boundary (${Array.from(label!).length} characters)`, async () => {
    const f = slackFixture();
    const spec = createMessage({ scope: "global", kind: "menu", actions: [{ id: "item", label: label!, callback: "session:full-id" }] });
    await f.transport.sendMessageSpec("slack:T:C:1", spec);
    await f.transport.editMessageSpec("slack:T:C:1", "2", spec);
    for (const payload of f.payloads) {
      const button = buttons(payload)[0]!;
      assert.equal(button.text.text, expected);
      assert.deepEqual(decodeSlackCallbackValue(button.value!, "secret"), { chatId: "slack:T:C:1", action: "session:full-id" });
    }
    assert.equal(spec.actions[0]!.label, label);
  });
}

test("shared builder preserves URL, identity and style while truncating only its label", () => {
  const button = buildSlackButton({ chatId: "slack:T:C", label: "x".repeat(90),
    actionId: "bridge_url_0_0", callbackSecret: null, destination: { url: "https://example.com/full-path" }, style: "primary" });
  assert.equal(button.text.text, `${"x".repeat(74)}…`);
  assert.equal(button.url, "https://example.com/full-path");
  assert.equal(button.value, undefined);
  assert.equal(button.action_id, "bridge_url_0_0");
  assert.equal(button.style, "primary");
});

test("legacy text send/edit keep their callbacks through the shared button path", async () => {
  const f = slackFixture();
  await f.transport.sendMessage("slack:T:C:1", "**Codex**\nReady\n/go · /next · /help");
  await f.transport.editMessageText("slack:T:C:1", "2", "**Codex**\nReady\n/go · /next · /help");
  for (const payload of f.payloads) {
    assert.deepEqual(buttons(payload).map((button) => decodeSlackCallbackValue(button.value!, "secret")?.action),
      ["quick:go", "quick:next", "quick:help"]);
  }
});

test("real directory second page, section and archive menus satisfy Slack limits without changing callbacks", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const service = new BridgeService(testConfig(":memory:"), store, {
    listThreadsForCwd: async () => [], listRecentThreadHistory: async () => []
  } as unknown as CodexAppServerClient);
  const chatId = "slack:T:C:1";
  const now = Date.now();
  for (let index = 0; index < 9; index++) {
    await store.upsertDiscoveredSession({ telegramChatId: chatId, codexThreadId: `thread-${index}`,
      pathKey: `/workspace/project-${index}-${"long-directory".repeat(7)}`,
      displayName: "long-session-name-".repeat(10), latestActivityAt: now - index * 60_000 });
  }
  const menu = await service.renderSessionMenu(chatId, 1);
  assert.ok(menu.actions.some((action) => action.callback === "session-page:0"));
  const directory = menu.actions.find((action) => action.callback.startsWith("session-dir:"))!;
  assert.ok(directory.label.length > 75);
  const section = await service.renderSessionSectionMenu(chatId, directory.callback.split(":")[1]!, 0);
  assert.ok(section.actions.some((action) => action.callback.startsWith("section:") && action.label.length > 75));
  const selected = (await store.listKnownSessions(chatId))[0]!;
  await store.markSessionCodexArchived(selected.id);
  const archived = await service.renderArchivedSessionMenu(chatId, 0);
  assert.ok(archived.actions.some((action) => action.callback.startsWith("session-unarchive:") && action.label.length > 75));
  const f = slackFixture();
  for (const spec of [menu, section, archived]) {
    await f.transport.sendMessageSpec(chatId, spec);
    await f.transport.editMessageSpec(chatId, "2", spec);
    for (const payload of f.payloads.slice(-2)) {
      assert.deepEqual(buttons(payload).map((button) => decodeSlackCallbackValue(button.value!, "secret")?.action),
        spec.actions.map((action) => action.callback));
    }
  }
});
