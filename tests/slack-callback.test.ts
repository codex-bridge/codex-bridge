import assert from "node:assert/strict";
import test from "node:test";

import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import {
  decodeSlackCallbackValue,
  encodeSlackCallbackValue,
  SLACK_CALLBACK_ACTION_ID_PATTERN
} from "../src/slack/callback.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { buildSlackQueueModal, readSlackQueueModalText } from "../src/slack/bot.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { actionRow, messageAction } from "../src/bridge/messages/actions.js";
import { createMessage } from "../src/bridge/messages/factory.js";

test("encodes Slack callback values with bridge chat context", () => {
  const chatId = "slack:TTEST0001:DTEST0001";
  const encoded = encodeSlackCallbackValue(chatId, "session:abc:123");
  assert.match(encoded, /^bridge:v1:/);
  assert.deepEqual(decodeSlackCallbackValue(encoded), {
    action: "session:abc:123",
    chatId
  });
  assert.equal(decodeSlackCallbackValue("session:legacy"), null);
});

test("signs Slack callback values when a callback secret is configured", () => {
  const chatId = "slack:TTEST0001:DTEST0001";
  const encoded = encodeSlackCallbackValue(chatId, "session:abc:123", "secret");
  assert.deepEqual(decodeSlackCallbackValue(encoded, "secret"), {
    action: "session:abc:123",
    chatId
  });
  assert.equal(decodeSlackCallbackValue(encoded), null);
  assert.equal(decodeSlackCallbackValue(encoded.replace("session%3Aabc%3A123", "session%3Aother"), "secret"), null);
});

test("structured Slack buttons use the registered Bridge callback action id", () => {
  const blocks = renderSlackMessageSpec("slack:T:C:1", {
    kind: "help",
    title: "Codex",
    body: [],
    actions: [{ id: "session", label: "Session", callback: "quick:sessions" }]
  }, "secret");
  const actions = blocks.find((block) => block.type === "actions");
  const actionId = actions?.type === "actions" ? actions.elements[0]?.action_id : null;

  assert.equal(typeof actionId, "string");
  assert.match(actionId ?? "", SLACK_CALLBACK_ACTION_ID_PATTERN);
  assert.deepEqual(
    actions?.type === "actions" && actions.elements[0]?.type === "button"
      ? decodeSlackCallbackValue(actions.elements[0].value ?? "", "secret")
      : null,
    { action: "quick:sessions", chatId: "slack:T:C:1" }
  );
  assert.match("bridge_spec_session_0", SLACK_CALLBACK_ACTION_ID_PATTERN);
});

test("Slack queue modal preserves its originating thread and trims submitted text", () => {
  const chatId = "slack:T:C:123.456";
  const modal = buildSlackQueueModal(chatId, "secret");
  assert.equal(modal.callback_id, "bridge_queue_submit");
  assert.deepEqual(decodeSlackCallbackValue(modal.private_metadata, "secret"), { action: "queue:submit", chatId });
  assert.equal(readSlackQueueModalText({ queue: { text: { value: "  follow up  " } } }), "follow up");
});

test("Slack transport wraps button callback data with the target chat id", async () => {
  let postedBlocks: KnownBlock[] | undefined;
  const client = {
    chat: {
      postMessage: async (input: { blocks?: KnownBlock[] }) => {
        postedBlocks = input.blocks;
        return { ts: "123.456" };
      }
    }
  } as unknown as WebClient;
  const transport = new SlackMessageTransport(client);
  const chatId = "slack:TTEST0001:DTEST0001";

  await transport.sendMessageSpec(chatId, createMessage({
    scope: "global",
    kind: "system",
    titleLabel: "Choose",
    actions: [messageAction("open", "Open", "session:one")]
  }));

  const actions = postedBlocks?.find((block) => block.type === "actions");
  assert.equal(actions?.type, "actions");
  const value = actions?.elements[0]?.type === "button" ? actions.elements[0].value : null;
  assert.equal(typeof value, "string");
  assert.deepEqual(decodeSlackCallbackValue(value ?? ""), {
    action: "session:one",
    chatId
  });
});

test("Slack transport signs wrapped button callback data when configured", async () => {
  let postedBlocks: KnownBlock[] | undefined;
  const client = {
    chat: {
      postMessage: async (input: { blocks?: KnownBlock[] }) => {
        postedBlocks = input.blocks;
        return { ts: "123.456" };
      }
    }
  } as unknown as WebClient;
  const transport = new SlackMessageTransport(client, "secret");
  const chatId = "slack:TTEST0001:DTEST0001";

  await transport.sendMessageSpec(chatId, createMessage({
    scope: "global",
    kind: "system",
    titleLabel: "Choose",
    actions: [messageAction("open", "Open", "session:one")]
  }));

  const actions = postedBlocks?.find((block) => block.type === "actions");
  const value = actions?.type === "actions" && actions.elements[0]?.type === "button"
    ? actions.elements[0].value
    : null;
  assert.equal(typeof value, "string");
  assert.deepEqual(decodeSlackCallbackValue(value ?? "", "secret"), {
    action: "session:one",
    chatId
  });
  assert.equal(decodeSlackCallbackValue(value ?? ""), null);
});

test("Slack transport clears actions while preserving the original message content", async () => {
  let updated: { text?: string; blocks?: KnownBlock[] } | undefined;
  const client = {
    chat: {
      update: async (input: { text?: string; blocks?: KnownBlock[] }) => {
        updated = input;
        return { ok: true };
      }
    }
  } as unknown as WebClient;
  const transport = new SlackMessageTransport(client);

  await transport.clearMessageActions(
    "slack:TTEST0001:DTEST0001",
    "123.456",
    "*Codex · .../projects/demo-app*\nThis session is occupied outside the Bridge."
  );

  assert.equal(updated?.text, "*Codex · .../projects/demo-app*\nThis session is occupied outside the Bridge.");
  assert.ok(updated?.blocks);
  assert.equal(updated?.blocks?.some((block) => block.type === "actions"), false);
  assert.equal(updated?.blocks?.[0]?.type, "section");
});

test("Slack transport reuses callback content blocks when clearing actions", async () => {
  let updated: { text?: string; blocks?: KnownBlock[] } | undefined;
  const client = {
    chat: {
      update: async (input: { text?: string; blocks?: KnownBlock[] }) => {
        updated = input;
        return { ok: true };
      }
    }
  } as unknown as WebClient;
  const transport = new SlackMessageTransport(client);
  const originalBlocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: "*Codex*\nNormal body" } },
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Refresh" }, action_id: "refresh" }]
    }
  ];

  await transport.clearMessageActions(
    "slack:TTEST0001:DTEST0001",
    "123.456",
    "raw fallback text",
    originalBlocks
  );

  assert.deepEqual(updated?.blocks, [originalBlocks[0]]);
  assert.equal(updated?.text, "raw fallback text");
});

test("Slack transport renders sessions as native Slack blocks with actions", async () => {
  const postedBlocks = renderSlackMessageSpec("slack:TTEST0001:DTEST0001", createMessage({
    scope: "global",
    kind: "menu",
    titleLabel: "Sessions",
    body: [
      { type: "text", text: "[.../projects/demo-app]" },
      { type: "field", label: "u", value: "15:30 **c** 10:00 **a** yes" }
    ],
    actions: [messageAction("open", "Open", "session:one")]
  }), null);

  assert.equal(postedBlocks[0]?.type, "markdown");
  assert.equal(postedBlocks[0]?.type === "markdown" ? postedBlocks[0].text : null, [
    "**Sessions**",
    String.raw`\[\.\.\.\/projects\/demo\-app\]`,
    "**u**  15:30 **c** 10:00 **a** yes"
  ].join("\n"));
  assert.equal(postedBlocks.find((block) => block.type === "actions")?.type, "actions");
});

test("Slack transport moves session menu headings to action group titles", async () => {
  const postedBlocks = renderSlackMessageSpec("slack:TTEST0001:DTEST0001", createMessage({
    kind: "menu",
    titleLabel: "Codex",
    session: { id: "thread-1", directory: ".../projects/demo-app" },
    body: [{ type: "text", text: "Thread 1785599685.088929" }],
    actions: [
      ...actionRow(
        messageAction("release", "Release to Codex", "session-release-bridge:session-1:1", "Current session"),
        messageAction("help", "Help", "quick:help", "Current session")
      ),
      ...actionRow(
        messageAction("archive", "Archive", "session-archive:session-1:1", "Current session"),
        messageAction("delete", "Delete", "session-delete:session-1:1", "Current session")
      ),
      messageAction("directory", "Directory", "session-dir:directory-1:0", "Sessions"),
      ...actionRow(
        messageAction("refresh", "Refresh", "session-refresh", "Sessions"),
        messageAction("help", "Help", "quick:help", "Sessions")
      )
    ]
  }), null);

  assert.equal(postedBlocks[0]?.type, "markdown");
  assert.deepEqual(sectionTexts(postedBlocks), ["*Current session*", "*Sessions*"]);
});

test("Slack transport leaves a help-only row without an action group title", async () => {
  const postedBlocks = renderSlackMessageSpec("slack:TTEST0001:DTEST0001", createMessage({
    kind: "system",
    titleLabel: "Codex",
    session: { id: "thread-1", directory: ".../projects/demo-app" },
    body: [{ type: "text", text: "Provider\nConfig built-in default" }],
    actions: [messageAction("help", "Help", "quick:help")]
  }), null);

  assert.deepEqual(sectionTexts(postedBlocks), []);
  assert.equal(postedBlocks.filter((block) => block.type === "actions").length, 1);
});

test("Slack transport renders root session picker as Choose a directory", async () => {
  const postedBlocks = await postSlackMessage("Sessions\nChoose a directory.\nu = latest message time.");

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, [
    "*Choose a directory*",
    "u = latest message time."
  ].join("\n"));
});

test("Slack transport preserves native session picker after Codex title envelope", async () => {
  const postedBlocks = await postSlackMessage("Codex\nSessions\nChoose a directory.\nu = latest message time.");

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, "*Codex*");
  assert.equal(postedBlocks[1]?.type, "section");
  assert.equal(postedBlocks[1]?.type === "section" ? postedBlocks[1].text?.text : null, [
    "*Choose a directory*",
    "u = latest message time."
  ].join("\n"));
});

test("Slack transport groups help action rows with section labels", async () => {
  const postedBlocks = renderSlackMessageSpec("slack:TTEST0001:DTEST0001", createMessage({
    scope: "global",
    kind: "help",
    titleLabel: "codex-bridge",
    actions: [
      ...actionRow(
        messageAction("sessions", "Session", "quick:sessions", "Session"),
        messageAction("status", "Status", "quick:status", "Session")
      ),
      ...actionRow(
        messageAction("go", "Go", "quick:go", "Run"),
        messageAction("next", "Next", "quick:next", "Run"),
        messageAction("compact", "Compact", "quick:compact", "Run")
      ),
      ...actionRow(
        messageAction("disconnect", "Disconnect", "quick:bot_disconnect", "Bot"),
        messageAction("connect", "Connect", "quick:bot_connect", "Bot"),
        messageAction("restart", "Restart", "quick:bot_restart", "Bot")
      )
    ]
  }), null);

  assert.deepEqual(sectionTexts(postedBlocks), [
    "*Session*",
    "*Run*",
    "*Bot*"
  ]);
});

test("Slack transport does not use header blocks for message content", async () => {
  const samples = [
    "Sessions\n[.../projects/demo-app]",
    "Sections · .../projects\nDefault",
    "Switched to section\n[.../projects/demo-app]",
    "**Provider**\n**Saved** openai"
  ];

  for (const sample of samples) {
    const postedBlocks = await postSlackMessage(sample);
    assert.equal(postedBlocks.some((block) => block.type === "header"), false);
  }
});

test("Slack transport renders compact working status with interrupt", async () => {
  const postedBlocks = await postSlackMessage("Working · Thinking · 21s");

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, "*Working* · Thinking · 21s");
  assert.equal(postedBlocks[1]?.type, "actions");
  const values = postedBlocks[1]?.type === "actions"
    ? postedBlocks[1].elements.map((element) => element.type === "button" ? decodeSlackCallbackValue(element.value ?? "")?.action : null)
    : [];
  assert.deepEqual(values, ["quick:queue", "quick:interrupt"]);
});

test("Slack transport renders session-headed working status with interrupt", async () => {
  const postedBlocks = await postSlackMessage("Codex · .../projects/codex-bridge\nWorking · Recovering · 2m\nIssue · Reconnecting 1/5");

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(
    postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null,
    "*Codex · .../projects/codex-bridge*\nWorking · Recovering · 2m\nIssue · Reconnecting 1/5"
  );
  assert.equal(postedBlocks[1]?.type, "actions");
  const values = postedBlocks[1]?.type === "actions"
    ? postedBlocks[1].elements.map((element) => element.type === "button" ? decodeSlackCallbackValue(element.value ?? "")?.action : null)
    : [];
  assert.deepEqual(values, ["quick:queue", "quick:interrupt"]);
});

test("Slack transport renders finalized working status without interrupt", async () => {
  const postedBlocks = await postSlackMessage("Codex · .../projects/codex-bridge\nWorking · Done · 2m");

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(
    postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null,
    "*Codex · .../projects/codex-bridge*\nWorking · Done · 2m"
  );
  assert.equal(postedBlocks.some((block) => block.type === "actions"), false);
});

test("Slack transport preserves raw markdown tables without generated copies", async () => {
  const table = ["| Field | Value |", "| --- | --- |", "| Status | Available |"].join("\n");
  const postedBlocks = await postSlackMessage(`Codex · .../repo\n\n${table}`);
  assert.equal(postedBlocks.length, 1);
  const block = postedBlocks[0];
  assert.equal(block?.type === "section" ? block.text?.text : null, `*Codex · .../repo*\n\n${table}`);
});

test("Slack transport renders status sections and provider fields", async () => {
  const postedBlocks = await postSlackMessage(
    "**Codex status**\n**Core**\n**Model** gpt-5-codex\n**Provider** openai\n**Limit**\n**Weekly** 100% left"
  );

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, [
    "*Codex status*",
    "",
    "*Core*",
    "*Model*  gpt-5-codex",
    "*Provider*  openai",
    "",
    "*Limit*",
    "*Weekly*  100% left"
  ].join("\n"));
});

test("Slack transport renders provider details without legacy auto-actions", async () => {
  const postedBlocks = await postSlackMessage(
    "**Provider**\n**Saved** openai\n**Active** openai\n**New** openai (system default)"
  );

  assert.equal(postedBlocks.length, 1);
  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, [
    "*Provider*",
    "*Saved*  openai",
    "*Active*  openai",
    "*New*  openai (system default)"
  ].join("\n"));
  assert.equal(postedBlocks.some((block) => block.type === "actions"), false);
});

test("Slack transport renders created sessions as structured status", async () => {
  const postedBlocks = await postSlackMessage([
    "**Session created · codex-lb**",
    "**Path** .../projects/api-service",
    "**Name** api-service 2026-08-03 15:30",
    "",
    "Switched to the new active session."
  ].join("\n"));

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, [
    "*Session created · codex-lb*",
    "*Path*  .../projects/api-service",
    "*Name*  api-service 2026-08-03 15:30",
    "Switched to the new active session."
  ].join("\n"));
});

test("Slack transport renders created session follow-up actions", async () => {
  const postedBlocks = renderSlackMessageSpec("slack:TTEST0001:DTEST0001", createMessage({
    kind: "system",
    scope: "global",
    titleLabel: "Session created · codex-lb",
    actions: actionRow(
      messageAction("help", "Help", "quick:help"),
      messageAction("session", "Session", "quick:sessions")
    )
  }), null);

  const actions = postedBlocks.find((block) => block.type === "actions");
  const values = actions?.type === "actions"
    ? actions.elements.map((element) => element.type === "button" ? decodeSlackCallbackValue(element.value ?? "")?.action : null)
    : [];
  assert.deepEqual(values, ["quick:help", "quick:sessions"]);
});

test("Slack transport renders Codex shortcuts as buttons", async () => {
  const postedBlocks = renderSlackMessageSpec("slack:TTEST0001:DTEST0001", createMessage({
    kind: "actions",
    session: { id: "thread-1", directory: ".../projects/demo-app" },
    actions: actionRow(
      messageAction("go", "Go", "quick:go"),
      messageAction("next", "Next", "quick:next"),
      messageAction("help", "Help", "quick:help")
    )
  }), null);

  assert.equal(postedBlocks[0]?.type, "markdown");
  assert.equal(postedBlocks[1]?.type, "actions");
  const values = postedBlocks[1]?.type === "actions"
    ? postedBlocks[1].elements.map((element) => element.type === "button" ? decodeSlackCallbackValue(element.value ?? "")?.action : null)
    : [];
  assert.deepEqual(values, ["quick:go", "quick:next", "quick:help"]);
});

test("Slack transport lets explicit help-only buttons replace Codex shortcuts", async () => {
  const postedBlocks = renderSlackMessageSpec("slack:TTEST0001:DTEST0001", createMessage({
    kind: "actions",
    session: { id: "thread-1", directory: ".../projects/demo-app" },
    actions: [messageAction("help", "Help", "quick:help")]
  }), null);

  const actionBlocks = postedBlocks.filter((block) => block.type === "actions");
  assert.equal(actionBlocks.length, 1);
  const values = actionBlocks[0]?.type === "actions"
    ? actionBlocks[0].elements.map((element) => element.type === "button" ? decodeSlackCallbackValue(element.value ?? "")?.action : null)
    : [];
  assert.deepEqual(values, ["quick:help"]);
});

test("Slack transport renders Codex messages without splitting path into a header", async () => {
  const postedBlocks = await postSlackMessage("Codex · /Users/example\nHere. Go ahead.");

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, "*Codex · /Users/example*\nHere. Go ahead.");
});

test("Slack transport renders no-session Codex title in bold", async () => {
  const postedBlocks = await postSlackMessage("Codex\nNo active session.");

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null, "*Codex*\nNo active session.");
});

test("Slack transport preserves Slack links even when wrapped in inline code", async () => {
  const postedBlocks = await postSlackMessage(
    "Production verification passed: `<https://service-a.example|service-a.example> `and` <https://service-b.example|service-b.example> `both present new certificates. `worker-a` remains disabled with its failure recorded while the certificate mount path and correct reload method for `worker-b` are confirmed."
  );

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null,
    "Production verification passed: <https://service-a.example|service-a.example>and<https://service-b.example|service-b.example>both present new certificates. `worker-a` remains disabled with its failure recorded while the certificate mount path and correct reload method for `worker-b` are confirmed."
  );
});

test("Slack transport adds stable boundaries around adjacent inline code", async () => {
  const postedBlocks = await postSlackMessage(
    "Located the independent Good Job project at `/data/good_job_docker`; it is unrelated to Sing."
  );

  assert.equal(postedBlocks[0]?.type, "section");
  assert.equal(postedBlocks[0]?.type === "section" ? postedBlocks[0].text?.text : null,
    "Located the independent Good Job project at `/data/good_job_docker` ; it is unrelated to Sing."
  );
});

test("Slack transport renders transcript and called headers in bold", async () => {
  const userBlocks = await postSlackMessage("User · .../projects/demo-app\nAre you there?");
  assert.equal(userBlocks[0]?.type, "section");
  assert.equal(userBlocks[0]?.type === "section" ? userBlocks[0].text?.text : null, "*User · .../projects/demo-app*\nAre you there?");

  const calledBlocks = await postSlackMessage("Called · .../projects/api-service\nmcp\ntarget=f1e348");
  assert.equal(calledBlocks[0]?.type, "section");
  assert.equal(calledBlocks[0]?.type === "section" ? calledBlocks[0].text?.text : null, [
    "*Called · .../projects/api-service*",
    "mcp",
    "target=f1e348"
  ].join("\n"));

  const editedBlocks = await postSlackMessage("Edited · .../projects/demo-app\nsrc/a.ts (+1 -0)");
  assert.equal(editedBlocks[0]?.type, "section");
  assert.equal(editedBlocks[0]?.type === "section" ? editedBlocks[0].text?.text : null, [
    "*Edited · .../projects/demo-app*",
    "src/a.ts (+1 -0)"
  ].join("\n"));

  const compactBlocks = await postSlackMessage(
    "Compact started · .../projects/codex-bridge\nTriggered by Codex"
  );
  assert.equal(compactBlocks[0]?.type, "section");
  assert.equal(compactBlocks[0]?.type === "section" ? compactBlocks[0].text?.text : null, [
    "*Compact started · .../projects/codex-bridge*",
    "Triggered by Codex"
  ].join("\n"));

  const systemBlocks = await postSlackMessage(
    "System · .../projects/codex-bridge\nTurn completed\nElapsed 12s"
  );
  assert.equal(systemBlocks[0]?.type, "section");
  assert.equal(systemBlocks[0]?.type === "section" ? systemBlocks[0].text?.text : null, [
    "*System · .../projects/codex-bridge*",
    "Turn completed",
    "Elapsed 12s"
  ].join("\n"));
});

async function postSlackMessage(
  text: string,
  options?: Parameters<SlackMessageTransport["sendMessage"]>[2]
): Promise<KnownBlock[]> {
  let postedBlocks: KnownBlock[] | undefined;
  const client = {
    chat: {
      postMessage: async (input: { blocks?: KnownBlock[] }) => {
        postedBlocks = input.blocks;
        return { ts: "123.456" };
      }
    }
  } as unknown as WebClient;
  const transport = new SlackMessageTransport(client);
  await transport.sendMessage("slack:TTEST0001:DTEST0001", text, options);
  assert.ok(postedBlocks);
  return postedBlocks;
}

function sectionTexts(blocks: KnownBlock[]): Array<string | undefined> {
  return blocks
    .filter((block) => block.type === "section")
    .map((block) => block.type === "section" ? block.text?.text : undefined);
}
