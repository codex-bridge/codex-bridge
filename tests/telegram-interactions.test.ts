import assert from "node:assert/strict";
import test from "node:test";

import { createMessage } from "../src/bridge/messages/factory.js";
import { createTelegramInteractionContext } from "../src/telegram/interactions/context.js";
import { deliverTelegramInteraction } from "../src/telegram/interactions/responder.js";

const message = createMessage({
  scope: "global",
  kind: "system",
  titleLabel: "Codex",
  body: [{ type: "text", text: "Result" }]
});

test("Telegram callbacks use one conversation and surface context", () => {
  assert.deepEqual(createTelegramInteractionContext("123", 456), {
    platform: "telegram",
    conversationId: "123",
    surfaceId: "123",
    sourceMessageId: "456"
  });
});

test("Telegram interaction delivery edits callback messages and sends otherwise", async () => {
  const calls: string[] = [];
  const responder = {
    clearActions: async () => { calls.push("clear"); },
    edit: async () => { calls.push("edit"); },
    send: async () => { calls.push("send"); }
  };

  await deliverTelegramInteraction(
    createTelegramInteractionContext("123", 456),
    { mode: "edit", target: "surface", message },
    responder
  );
  await deliverTelegramInteraction(
    createTelegramInteractionContext("123"),
    { mode: "edit", target: "surface", message },
    responder
  );
  await deliverTelegramInteraction(
    createTelegramInteractionContext("123", 456),
    { mode: "send", target: "conversation", message },
    responder
  );

  assert.deepEqual(calls, ["edit", "send", "send"]);
});
