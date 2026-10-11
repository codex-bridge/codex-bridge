import assert from "node:assert/strict";
import test from "node:test";
import { createMessage } from "../src/bridge/messages/factory.js";
import { helpAction, statusViewAction, userTextAction } from "../src/bridge/messages/actions.js";
import { presentWebMessage } from "../src/web/message-presentation.js";

test("Web message projection keeps typed actions and removes platform callbacks", () => {
  const message = createMessage({
    kind: "actions",
    actions: [userTextAction("continue", "Continue", "platform:callback", "continue"), helpAction()]
  });
  const presented = presentWebMessage(message);
  assert.deepEqual(presented.actions, [
    { id: "continue", label: "Continue", execution: { type: "send-text", text: "continue" } },
    { id: "help", label: "Help", execution: { type: "session-tool", tool: "help" } }
  ]);
  assert.equal(JSON.stringify(presented).includes("platform:callback"), false);
  assert.equal(JSON.stringify(presented).includes("quick:help"), false);
});

test("Web status actions preserve the requested detail mode as typed data", () => {
  const presented = presentWebMessage(createMessage({
    kind: "system",
    actions: [statusViewAction(false), statusViewAction(true)]
  }));
  assert.deepEqual(presented.actions.map((action) => action.execution), [
    { type: "session-tool", tool: "status", full: true },
    { type: "session-tool", tool: "status", full: false }
  ]);
});
