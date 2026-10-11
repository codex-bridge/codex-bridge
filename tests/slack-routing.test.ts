import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupSlackAttachments,
  formatLocalDate,
  writeSlackAttachmentMetadata
} from "../src/slack/attachments.js";
import {
  classifySlackFile,
  getSlackRootTextCommand,
  isSlackRootEntryCommand,
  isSlackRootManagementCommand,
  makeChatId,
  normalizeSlackCommand,
  sanitizeSlackFileName
} from "../src/slack/bot.js";
import { resolveSlackInteractionContext } from "../src/slack/interactions/context.js";
import { parseSessionWorkflowAction } from "../src/slack/interactions/session-workflow.js";
import { parseTurnWorkflowAction } from "../src/slack/interactions/turn-workflow.js";
import {
  parseApprovalInteractionAction,
  parseGoalInteractionAction,
  parsePrimaryInteractionAction,
  parseSessionInteractionAction,
  parseStatusInteractionAction,
  parseTurnInteractionAction
} from "../src/bridge/interactions/action.js";

test("classifies Slack root commands separately from freeform turns", () => {
  assert.equal(normalizeSlackCommand("sessions now"), "sessions");
  assert.equal(isSlackRootEntryCommand("sessions"), true);
  assert.equal(isSlackRootEntryCommand("session_new"), true);
  assert.equal(isSlackRootManagementCommand("status"), true);
  assert.equal(isSlackRootManagementCommand("model"), false);
  assert.equal(isSlackRootManagementCommand("model_reset_all"), false);
  assert.equal(isSlackRootManagementCommand("permissions"), false);
  assert.equal(isSlackRootManagementCommand("session_new"), true);
  assert.equal(isSlackRootManagementCommand("bot_connect"), true);
  assert.equal(isSlackRootManagementCommand("bot_disconnect"), true);
  assert.equal(isSlackRootManagementCommand("bot_restart"), true);
  assert.equal(isSlackRootManagementCommand("connect_bot"), false);
  assert.equal(isSlackRootManagementCommand("disconnect_bot"), false);
  assert.equal(isSlackRootManagementCommand("restart_bot"), false);
  assert.equal(isSlackRootManagementCommand("session_open"), false);
  assert.equal(isSlackRootManagementCommand("go"), false);
  assert.equal(isSlackRootManagementCommand("next"), false);
  assert.equal(isSlackRootManagementCommand("Are you there?"), false);
});

test("treats every Slack session-thread message as ordinary Codex input", () => {
  const rootChatId = makeChatId({ channelId: "C1", teamId: "T1" });
  const threadChatId = makeChatId({ channelId: "C1", teamId: "T1", threadTs: "123.456" });

  assert.equal(getSlackRootTextCommand(rootChatId, "status now"), "status");
  assert.equal(getSlackRootTextCommand(threadChatId, "status now"), "");
  assert.equal(getSlackRootTextCommand(threadChatId, "sessions"), "");
  assert.equal(getSlackRootTextCommand(threadChatId, "/compact"), "");
  assert.equal(getSlackRootTextCommand(threadChatId, "queue do this later"), "");
  assert.equal(getSlackRootTextCommand(threadChatId, "go"), "");
});

test("classifies Slack image and audio files", () => {
  assert.equal(classifySlackFile({ mimetype: "image/png" }), "image");
  assert.equal(classifySlackFile({ filetype: "jpg" }), "image");
  assert.equal(classifySlackFile({ mimetype: "audio/mp4" }), "audio");
  assert.equal(classifySlackFile({ filetype: "m4a" }), "audio");
  assert.equal(classifySlackFile({ mimetype: "application/pdf", filetype: "pdf" }), null);
});

test("sanitizes Slack file names for local storage", () => {
  assert.equal(sanitizeSlackFileName("../voice memo?.m4a", "fallback"), "..-voice_memo_.m4a");
  assert.equal(sanitizeSlackFileName("", "fallback"), "fallback");
});

test("formats Slack attachment directories with local date parts", () => {
  const date = new Date(2026, 7, 22, 0, 5, 0);
  assert.equal(formatLocalDate(date), "2026-08-22");
});

test("cleans up expired Slack attachment files with sidecar metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-slack-attachments-"));
  const filePath = join(root, "attachment.png");
  await writeFile(filePath, "image");
  await writeSlackAttachmentMetadata({
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-21T00:00:00.000Z",
    id: "F123",
    kind: "image",
    mimeType: "image/png",
    name: "attachment.png",
    path: filePath,
    size: 5
  }, {
    chatId: "slack:T:D:1",
    messageId: "msg-1",
    status: "sent-to-codex"
  });

  const result = await cleanupSlackAttachments(root, Date.parse("2026-08-22T00:00:00.000Z"));
  assert.deepEqual(result, { deleted: 1, scanned: 1 });
  await assert.rejects(readFile(filePath));
  await assert.rejects(readFile(`${filePath}.json`));
});

test("keeps Slack DM chat ids canonical without message timestamps", () => {
  assert.equal(
    makeChatId({
      channelId: "D123",
      channelType: "im",
      rootCreatesThread: true,
      teamId: "T123",
      ts: "111.222"
    }),
    "slack:T123:D123"
  );
  assert.equal(
    makeChatId({
      channelId: "D123",
      channelType: "im",
      rootCreatesThread: false,
      teamId: "T123",
      ts: "111.222"
    }),
    "slack:T123:D123"
  );
});

test("keeps Slack DM thread replies scoped to the thread", () => {
  assert.equal(
    makeChatId({
      channelId: "D123",
      channelType: "im",
      rootCreatesThread: false,
      teamId: "T123",
      threadTs: "111.222",
      ts: "333.444"
    }),
    "slack:T123:D123:111.222"
  );
});

test("resolves Slack callback business and delivery contexts once", () => {
  const rootSource = {
    channelId: "C123",
    containerType: "message",
    messageTs: "111.222",
    teamId: "T123",
    threadTs: null
  };
  assert.deepEqual(
    resolveSlackInteractionContext("slack:T123:C123", "quick:help", rootSource, "trigger-1"),
    {
      platform: "slack",
      conversationId: "slack:T123:C123",
      surfaceId: "slack:T123:C123",
      sourceMessageId: "111.222",
      triggerId: "trigger-1"
    }
  );
  assert.deepEqual(
    resolveSlackInteractionContext("slack:T123:C123", "session:session-1", rootSource),
    {
      platform: "slack",
      conversationId: "slack:T123:C123:111.222",
      surfaceId: "slack:T123:C123",
      sourceMessageId: "111.222"
    }
  );
  assert.deepEqual(
    resolveSlackInteractionContext("slack:T123:C123", "quick:sessions", {
      ...rootSource,
      messageTs: "333.444",
      threadTs: "111.222"
    }),
    {
      platform: "slack",
      conversationId: "slack:T123:C123:111.222",
      surfaceId: "slack:T123:C123:111.222",
      sourceMessageId: "333.444"
    }
  );
  assert.deepEqual(
    resolveSlackInteractionContext("slack:T123:D123", "section:section-1", {
      channelId: "D123",
      containerType: "message",
      messageTs: "444.555",
      teamId: "T123",
      threadTs: null
    }),
    {
      platform: "slack",
      conversationId: "slack:T123:D123:444.555",
      surfaceId: "slack:T123:D123",
      sourceMessageId: "444.555"
    }
  );
  assert.equal(
    resolveSlackInteractionContext("slack:T123:D123", "quick:sessions", {
      channelId: "",
      containerType: "view",
      messageTs: null,
      teamId: "T123",
      threadTs: null
    }),
    null
  );
});

test("parses only callbacks migrated to primary interaction handlers", () => {
  assert.deepEqual(parsePrimaryInteractionAction("quick:help"), { type: "help" });
  assert.deepEqual(parsePrimaryInteractionAction("quick:sessions"), { type: "sessions.open" });
  assert.deepEqual(parsePrimaryInteractionAction("quick:bot_connect"), { type: "runtime.connect" });
  assert.deepEqual(parsePrimaryInteractionAction("quick:bot_disconnect"), { type: "runtime.disconnect" });
  assert.equal(parsePrimaryInteractionAction("quick:status"), null);
});

test("parses session management callbacks into typed actions", () => {
  assert.deepEqual(parseSessionInteractionAction("session-handoff:s1:4"), {
    type: "session.handoff",
    sessionId: "s1",
    expectedLeaseVersion: 4
  });
  assert.deepEqual(parseSessionInteractionAction("session-release-codex:s1:5"), {
    type: "session.release",
    owner: "codex",
    sessionId: "s1",
    expectedLeaseVersion: 5
  });
  assert.deepEqual(parseSessionInteractionAction("session-dir:dir:2"), {
    type: "session.directory.open",
    directoryHash: "dir",
    page: 2
  });
  assert.deepEqual(parseSessionInteractionAction("section-page:dir:not-a-page"), {
    type: "session.directory.page",
    directoryHash: "dir",
    page: 0
  });
  assert.deepEqual(parseSessionInteractionAction("session-refresh"), { type: "session.menu.refresh" });
  assert.deepEqual(parseSessionInteractionAction("session-archived-page:3"), {
    type: "session.archived.page",
    page: 3
  });
  assert.equal(parseSessionInteractionAction("session-refresh:s1:5"), null);
  assert.equal(parseSessionInteractionAction("session:s1"), null);
});

test("parses goal and status navigation without delivery inference in the bot", () => {
  assert.deepEqual(parseGoalInteractionAction("quick:goal"), {
    type: "goal.navigate",
    delivery: "send",
    view: "current",
    page: 0
  });
  assert.deepEqual(parseGoalInteractionAction("goal:set:p:goal-1"), {
    type: "goal.set-status",
    goalId: "goal-1",
    status: "paused"
  });
  assert.deepEqual(parseGoalInteractionAction("goal:clear:confirm"), {
    type: "goal.clear.confirm"
  });
  assert.equal(parseGoalInteractionAction("goal:status:unknown"), null);
  assert.deepEqual(parseStatusInteractionAction("status:view:full"), {
    type: "status.view",
    delivery: "edit",
    full: true
  });
});

test("parses direct turn and queue actions", () => {
  assert.deepEqual(parseTurnInteractionAction("quick:interrupt"), { type: "turn.interrupt" });
  assert.deepEqual(parseTurnInteractionAction("quick:compact"), { type: "turn.compact" });
  assert.deepEqual(parseTurnInteractionAction("quick:bot_restart"), { type: "runtime.restart" });
  assert.deepEqual(parseTurnInteractionAction("queue:cancel:q1"), {
    type: "queue.cancel",
    submissionId: "q1"
  });
  assert.equal(parseTurnInteractionAction("quick:go"), null);
});

test("parses approval callbacks and rejects malformed decisions explicitly", () => {
  assert.deepEqual(parseApprovalInteractionAction("decision:d1:s"), {
    type: "approval.resolve",
    decisionId: "d1",
    decision: "acceptForSession"
  });
  assert.deepEqual(parseApprovalInteractionAction("decision-batch:s1:4:d"), {
    type: "approval.batch.resolve",
    sessionId: "s1",
    decision: "decline",
    expectedLeaseVersion: 4
  });
  assert.deepEqual(parseApprovalInteractionAction("decision:d1:x"), { type: "approval.invalid" });
  assert.equal(parseApprovalInteractionAction("quick:help"), null);
});

test("parses multi-step session workflows separately from single-delivery actions", () => {
  assert.deepEqual(parseSessionWorkflowAction("quick:session_new"), { type: "session.create-current" });
  assert.deepEqual(parseSessionWorkflowAction("session:s1"), {
    type: "session.select",
    sessionId: "s1",
    legacySection: false
  });
  assert.deepEqual(parseSessionWorkflowAction("section:s1"), {
    type: "session.select",
    sessionId: "s1",
    legacySection: true
  });
  assert.deepEqual(parseSessionWorkflowAction("session-refresh:s1:7"), {
    type: "session.refresh",
    sessionId: "s1",
    expectedLeaseVersion: 7
  });
  assert.equal(parseSessionWorkflowAction("session-page:1"), null);
});

test("parses Slack-only turn workflows", () => {
  assert.deepEqual(parseTurnWorkflowAction("quick:queue"), { type: "queue.open" });
  assert.deepEqual(parseTurnWorkflowAction("quick:go"), { type: "turn.continue", text: "go" });
  assert.deepEqual(parseTurnWorkflowAction("quick:next"), { type: "turn.continue", text: "next" });
  assert.equal(parseTurnWorkflowAction("quick:compact"), null);
});

test("creates thread-scoped chat ids for Slack channel root entry commands", () => {
  assert.equal(
    makeChatId({
      channelId: "C123",
      rootCreatesThread: true,
      teamId: "T123",
      threadTs: "333.444",
      ts: "111.222"
    }),
    "slack:T123:C123:333.444"
  );
});
