import assert from "node:assert/strict";
import test from "node:test";

import { RuntimePromptFactory } from "../src/bridge/messages/runtime-prompts.js";
import type { DecisionRecord, SessionRecord } from "../src/shared/types.js";

const session: SessionRecord = {
  id: "session-1",
  telegramChatId: "chat-1",
  codexThreadId: "thread-1",
  pathKey: "/workspace/project",
  currentCwd: "/workspace/project",
  displayName: null,
  batchDecisionMessageId: null,
  codexArchivedAt: null,
  latestActivityAt: 0,
  createdAt: 0,
  discoveryMissingSince: null,
  discoveryMissingCount: 0,
  lastDiscoveredAt: 0
};

const decision: DecisionRecord = {
  id: "decision-1",
  sessionId: session.id,
  telegramChatId: session.telegramChatId,
  approvalId: "approval-1",
  kind: "mcpServer/elicitation/request",
  title: "MCP input required",
  summary: null,
  requiresUserInput: true,
  state: "awaitingInput",
  telegramMessageId: null,
  createdAt: 0,
  updatedAt: 0
};

test("runtime prompts include Connect only while Codex is disconnected", () => {
  let connected = false;
  const factory = new RuntimePromptFactory({
    isRuntimeConnected: () => connected,
    getSessionDirectory: (value) => value.currentCwd ?? value.pathKey
  });

  assert.deepEqual(factory.createIncoming("error", "Disconnected").actions, [
    { id: "bot-connect", label: "Connect", callback: "quick:bot_connect", group: "Bot" },
    { id: "help", label: "Help", callback: "quick:help", execution: { type: "session-tool", tool: "help" } }
  ]);

  connected = true;
  assert.deepEqual(factory.createSystemError(session, "stream", "Lost").actions, [
    { id: "help", label: "Help", callback: "quick:help", execution: { type: "session-tool", tool: "help" } }
  ]);
});

test("MCP input prompt preserves session context and Help action", () => {
  const factory = new RuntimePromptFactory({
    isRuntimeConnected: () => true,
    getSessionDirectory: (value) => value.currentCwd ?? value.pathKey
  });
  const prompt = factory.createMcpInput(session, decision, "Malformed JSON.");

  assert.equal(prompt.title, "MCP Input Required · /workspace/project");
  assert.equal(prompt.body[0]?.type, "text");
  assert.match(prompt.body[0]?.type === "text" ? prompt.body[0].text : "", /Malformed JSON/);
  assert.deepEqual(prompt.actions, [{ id: "help", label: "Help", callback: "quick:help",
    execution: { type: "session-tool", tool: "help" } }]);
});
