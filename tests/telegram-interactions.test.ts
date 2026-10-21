import assert from "node:assert/strict";
import test from "node:test";

import { createMessage } from "../src/bridge/messages/factory.js";
import { createTelegramInteractionContext } from "../src/telegram/interactions/context.js";
import { deliverTelegramInteraction } from "../src/telegram/interactions/responder.js";
import { handleTelegramSessionWorkflow } from "../src/telegram/interactions/session-workflow.js";
import type { BridgeTelegramSessionWorkflowPort } from "../src/bridge/contracts.js";
import { createTelegramHelpMessage } from "../src/telegram/interactions/help.js";
import { helpMenuActions } from "../src/bridge/messages/actions.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

const message = createMessage({
  scope: "global",
  kind: "system",
  titleLabel: "Codex",
  body: [{ type: "text", text: "Result" }]
});

test("Telegram Help is a button menu without command descriptions, matching Slack", () => {
  for (const hasActiveTurn of [false, true]) {
    const actions = helpMenuActions({ hasActiveSession: true, hasActiveTurn, runtimeConnected: true });
    const help = createTelegramHelpMessage({ id: "session-1", directory: "/workspace/project" }, actions);
    assert.equal(help.title, "Help · /workspace/project");
    assert.deepEqual(help.body, []);
    assert.deepEqual(help.actions, actions);
    const rendered = renderTelegramMessageSpec(help);
    assert.equal(rendered.html, "<b>Help · /workspace/project</b>");
    assert.equal(rendered.keyboard?.inline_keyboard.flat().length, actions.length);
  }
  const global = createTelegramHelpMessage();
  assert.equal(global.title, "Help");
  assert.deepEqual(global.body, []);
  assert.ok(global.actions.length > 0);
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

test("Telegram refresh accepts compact and legacy callbacks without losing the lease version", async () => {
  const sessionId = "session_01234567-89ab-4cde-8fab-0123456789ab";
  for (const prefix of ["sr", "session-refresh"]) {
    const calls: string[] = [];
    const service = {
      refreshSessionView: async (chatId: string, id: string, version: number) => {
        assert.equal(chatId, "123"); assert.equal(id, sessionId); assert.equal(version, 1123);
        return { session: { id: sessionId }, recentMessages: [] };
      },
      removeSessionRefreshStatus: async () => { calls.push("remove-status"); },
      postSessionSwitchTranscript: async () => { calls.push("transcript"); }
    } as unknown as BridgeTelegramSessionWorkflowPort;
    assert.equal(await handleTelegramSessionWorkflow({
      action: `${prefix}:${sessionId}:1123`,
      context: createTelegramInteractionContext("123", 456),
      acknowledge: async () => { calls.push("acknowledge"); },
      responder: {
        clearActions: async () => { calls.push("clear"); },
        edit: async () => { assert.fail("Unexpected error reply"); },
        send: async () => { assert.fail("Unexpected send"); }
      }, service
    }), true);
    assert.deepEqual(calls, ["acknowledge", "clear", "remove-status", "transcript"]);
  }
});
