import assert from "node:assert/strict";
import test from "node:test";

import {
  archiveAction,
  deleteAction,
  helpAction,
  refreshAction
} from "../src/bridge/messages/actions.js";
import {
  createCalledMessage,
  createEditedMessage,
  createMessage
} from "../src/bridge/messages/factory.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

const session = {
  id: "thread-1",
  directory: "/Users/example/workspace/projects/demo-app"
};

test("message factory derives generated titles from the short session path", () => {
  const edited = createEditedMessage({
    session,
    body: [{ type: "text", text: "src/index.ts (+1 -0)" }]
  });
  const called = createCalledMessage({ session });

  assert.equal(edited.title, "Edited · .../projects/demo-app");
  assert.equal(called.title, "Called · .../projects/demo-app");
  assert.equal(edited.session?.id, "thread-1");
});

test("message factory does not use a Codex thread name as a generated title", () => {
  const message = createMessage({
    kind: "codex",
    session,
    body: [{ type: "text", text: "Proceed" }]
  });

  assert.equal(message.title, "Codex · .../projects/demo-app");
  assert.equal(renderLegacyMessage(message), "Codex · .../projects/demo-app\nProceed");
});

test("Telegram renderer formats markdown body parts without title inference", () => {
  const rendered = renderTelegramMessageSpec(createMessage({
    kind: "codex",
    session,
    body: [{ type: "markdown", text: "**Goal**\nUse `codex`" }]
  }));

  assert.equal(rendered.markdown, "<p><b>Codex · .../projects/demo-app</b></p>\n\n**Goal**\nUse `codex`");
  assert.equal(rendered.html, "<b>Codex · .../projects/demo-app</b>\n<b>Goal</b>\nUse <code>codex</code>");
});

test("actions are explicit data and survive the legacy compatibility adapter", () => {
  const message = createMessage({
    kind: "refresh",
    session,
    actions: [
      helpAction(),
      refreshAction("session-refresh:thread-1"),
      archiveAction("session-archive:thread-1"),
      deleteAction("session-delete:thread-1")
    ]
  });

  assert.deepEqual(message.actions.map((action) => action.id), ["help", "refresh", "archive", "delete"]);
  assert.equal(renderLegacyMessage(message), "Codex · .../projects/demo-app");
});
