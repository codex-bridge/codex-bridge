import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { presentAssistantText, protectPresentedAssistantText } from "../src/shared/assistant-display.js";
import { extractCompletedAgentMessage } from "../src/codex/notification-events.js";
import { normalizeFullThreadTurnsPage } from "../src/codex/thread-history.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import { NotificationMessageService } from "../src/bridge/notifications/messages.js";
import { BridgeStore } from "../src/store/index.js";
import { logger } from "../src/logging/logger.js";
import { createTranscriptMessageSpec } from "../src/bridge/renderers/thread-history.js";
import { presentWebMessage } from "../src/web/message-presentation.js";
import { LocalTimelineCache } from "../web/src/lib/cache.ts";
import { applyMessage, dialogueText, restoreHistory, type TimelineItem } from "../web/src/lib/timeline.ts";
import { RolloutReader } from "../src/bridge/sessions/rollout-reader.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

const ORIGINAL = "PRIVATE_ORIGINAL_ASSISTANT_TEXT";
const hidden = { moderated: true, display: { version: 1, mode: "hide", replacement: { kind: "wellbeingPromptHelpline" } } };
const blocked = { moderated: true, display: { version: 1, mode: "block", reason: { kind: "protection", protectionType: "policy" } } };

test("legacy and supported show messages preserve content; annotations are applied once", () => {
  for (const moderation of [undefined, null, { moderated: false, display: null }])
    assert.deepEqual(presentAssistantText(ORIGINAL, moderation), { text: ORIGINAL });
  for (const trustedContacts of ["check", "skip"]) {
    const result = presentAssistantText(ORIGINAL, { moderated: true,
      display: { version: 1, mode: "show", trustedContacts, annotation: { kind: "wellbeingHelpline", subject: "prompt" } } });
    assert.ok(result.text.startsWith(ORIGINAL));
    assert.match(result.text, /local crisis helpline/);
    assert.deepEqual(protectPresentedAssistantText(result.text, result.assistantDisplay), result);
  }
});

test("hide, block, unreadable and unsupported instructions never fall back to original text", () => {
  for (const moderation of [hidden, blocked,
    { moderated: true, display: { version: 1, mode: "block", reason: { kind: "cyber", trustedAccess: false } } },
    { moderated: true, display: null }, {}, false,
    { moderated: false, display: { version: 2, mode: "show", trustedContacts: "skip" } },
    { moderated: false, display: { version: 1, mode: "future" } },
    { moderated: false, display: { version: 1, mode: "show", trustedContacts: "skip", annotation: { kind: "future" } } }
  ]) {
    const result = presentAssistantText(ORIGINAL, moderation);
    assert.ok(result.text.length > 0);
    assert.equal(JSON.stringify(result).includes(ORIGINAL), false);
    assert.equal(JSON.stringify(protectPresentedAssistantText(ORIGINAL, result.assistantDisplay)).includes(ORIGINAL), false);
    assert.deepEqual(protectPresentedAssistantText(result.text, result.assistantDisplay), result);
  }
  assert.match(presentAssistantText("", hidden).text, /Support is available/);
});

test("live, full history, paginated dialogue and legacy resume share display interpretation", async () => {
  for (const moderation of [hidden, blocked, { moderated: true, display: null }]) {
    const item = { type: "agentMessage", id: "native-item", text: ORIGINAL, moderation };
    const live = extractCompletedAgentMessage({ method: "item/completed", params: { threadId: "t", item } })!;
    const page = { data: [{ id: "turn", status: "completed", items: [item] }], nextCursor: null };
    const full = normalizeFullThreadTurnsPage(page, "t").turns[0]!.entries[0]!;
    assert.equal(full.kind, "message");
    if (full.kind !== "message") throw new Error("Expected message");
    const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
      connect: async () => {}, rememberThreadSettings: () => {},
      requestKnownMethod: async () => page,
      request: async () => ({ initialMessages: [{ payload: { ...item, role: "assistant" } }] })
    });
    const recent = (await client.listRecentThreadMessages("t"))[0]!;
    const resumed = (await client.resumeThread("t")).messages[0]!;
    for (const result of [live, full, recent, resumed]) {
      assert.equal(result.text, live.text);
      assert.deepEqual(result.assistantDisplay, live.assistantDisplay);
      assert.equal(JSON.stringify(result).includes(ORIGINAL), false);
    }
    assert.equal(live.sourceItemId, "native-item");
  }
});

test("restricted live messages are sanitized before logging, storage, delivery and browser caching", async () => {
  const store = new BridgeStore(":memory:");
  const logs: unknown[] = [], delivered: unknown[] = [];
  const originalInfo = logger.info;
  logger.info = (...args) => { logs.push(args); };
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "t", pathKey: "/work", currentCwd: "/work" });
    const service = new NotificationMessageService({ store, assistantOutputByThread: new Map(), recentResolvedMcpBySession: new Map(),
      resolveNotificationSession: async () => session, resetTypingStatus: () => {}, clearRetryingRecovery: () => {},
      getSessionDirectory: () => "/work", clearProgressMessageForThread: async () => {}, sendLongSpec: async () => {},
      sendTranscriptMessage: async (_session, message) => {
        const spec = createTranscriptMessageSpec({ directory: "/work", ...message });
        for (const rendered of [renderSlackMessageSpec("slack:T:C", spec, null), renderTelegramMessageSpec(spec)]) {
          assert.equal(JSON.stringify(rendered).includes(ORIGINAL), false);
          assert.match(JSON.stringify(rendered), /Support is available/);
        }
        delivered.push(presentWebMessage(spec));
      } });
    const message = extractCompletedAgentMessage({ method: "item/completed", params: {
      threadId: "t", item: { type: "agentMessage", id: "native-item", text: ORIGINAL, moderation: hidden }
    } })!;
    await service.handleCompletedAgentMessage(message);
    assert.equal(JSON.stringify(await store.listRecentMessages(session.id, 5)).includes(ORIGINAL), false);
    assert.equal(JSON.stringify(logs).includes(ORIGINAL), false);
    assert.equal(JSON.stringify(delivered).includes(ORIGINAL), false);
    assert.equal(delivered.length, 1);
    await service.handleCompletedAgentMessage(message);
    assert.equal(delivered.length, 1, "same native item is not sent twice");
    await service.handleCompletedAgentMessage({ threadId: "t", sourceItemId: "native-item", text: ORIGINAL });
    assert.equal(delivered.length, 1, "missing metadata does not revoke a known restriction");
    await service.handleCompletedAgentMessage({ ...message, sourceItemId: "another-native-item" });
    assert.equal(delivered.length, 2, "distinct restricted answers retain separate history traces");
    const values = new Map<string, string>();
    const cache = new LocalTimelineCache({ getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } });
    cache.save("t", "s", [{ id: "platform-id", origin: "live", message: delivered[0] as TimelineItem["message"] }]);
    const restored = cache.load("t", "s");
    assert.equal(restored[0]!.message.sourceItemId, "native-item");
    assert.deepEqual(restored[0]!.message.assistantDisplay, message.assistantDisplay);
    assert.equal(JSON.stringify([...values.values()]).includes(ORIGINAL), false);
  } finally { logger.info = originalInfo; store.close(); }
});

test("history replaces a cached answer by native identity when its display decision changes", () => {
  const old: TimelineItem = { id: "platform-id", origin: "cache", message: { kind: "codex", title: "Codex",
    sourceItemId: "native-item", body: [{ type: "markdown", text: ORIGINAL }], actions: [] } };
  const safe = presentAssistantText(ORIGINAL, blocked);
  const history = { threadId: "t", sessionId: "s", leaseVersion: 1,
    messages: [{ role: "assistant" as const, sourceItemId: "native-item", ...safe }] };
  const restored = restoreHistory([old], history);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.id, "platform-id");
  assert.equal(dialogueText(restored[0]!.message), safe.text);
  assert.equal(JSON.stringify(restored).includes(ORIGINAL), false);
  assert.deepEqual(restoreHistory(restored, history), restored);
  const unverified = { ...history, messages: [{ role: "assistant" as const, sourceItemId: "native-item", text: ORIGINAL }] };
  assert.equal(JSON.stringify(restoreHistory(restored, unverified)).includes(ORIGINAL), false);
  const malformed = { ...old.message, assistantDisplay: { mode: "show", version: 2 } } as unknown as TimelineItem["message"];
  const live = applyMessage([], { operation: "send", messageId: "p", threadId: "t", sessionId: "s", leaseVersion: 1, message: malformed });
  assert.equal(JSON.stringify(live).includes(ORIGINAL), false);
  const repeated = applyMessage(live, { operation: "send", messageId: "another-platform-id", threadId: "t", sessionId: "s",
    leaseVersion: 1, message: old.message });
  assert.equal(repeated.length, 1);
  assert.equal(JSON.stringify(repeated).includes(ORIGINAL), false);
  const shown = restoreHistory(restored, { ...history, messages: [{ ...unverified.messages[0]!,
    assistantDisplay: { version: 1, mode: "show", trustedContacts: "skip" } }] });
  assert.equal(dialogueText(shown[0]!.message), ORIGINAL, "explicit supported show can replace a restriction");
});

test("legacy resume retains wrapper display instructions and native identity without altering user messages", async () => {
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {}, rememberThreadSettings: () => {}, request: async () => ({ initialMessages: [
      { id: "wrapped", moderation: blocked, payload: { role: "assistant", text: ORIGINAL } },
      { moderation: blocked, payload: { role: "user", text: ORIGINAL } }
    ] })
  });
  const messages = (await client.resumeThread("t")).messages;
  assert.equal(messages[0]!.sourceItemId, "wrapped");
  assert.equal(messages[0]!.assistantDisplay?.mode, "block");
  assert.equal(messages[0]!.text.includes(ORIGINAL), false);
  assert.deepEqual(messages[1], { role: "user", text: ORIGINAL });
});

test("a restricted history reply does not remove unrelated cached dialogue", () => {
  const older: TimelineItem = { id: "older", origin: "cache", message: { kind: "codex", title: "Codex",
    body: [{ type: "markdown", text: "older legacy reply" }], actions: [] } };
  const user: TimelineItem = { id: "user", origin: "cache", message: { kind: "user", title: "You",
    sourceItemId: "u", body: [{ type: "text", text: "question" }], actions: [] } };
  const safe = presentAssistantText(ORIGINAL, blocked);
  const restored = restoreHistory([older, user], { threadId: "t", sessionId: "s", leaseVersion: 1,
    messages: [{ role: "user", sourceItemId: "u", text: "question" },
      { role: "assistant", sourceItemId: "a", ...safe }] });
  assert.deepEqual(restored.map(item => dialogueText(item.message)), ["older legacy reply", "question", safe.text]);
});

test("rollout recovery prefers formal assistant events and restricts unverified raw model answers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-display-rollout-"));
  const path = join(directory, "rollout.jsonl");
  const raw = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: ORIGINAL }] } };
  const user = { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "question" }] } };
  const write = (entries: unknown[]) => writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n"));
  try {
    const reader = new RolloutReader();
    await write([user, raw]);
    const fallback = await reader.readRecentMessages(path);
    assert.equal(fallback.length, 2);
    assert.deepEqual(fallback[0], { role: "user", text: "question" });
    assert.equal(fallback[1]!.assistantDisplay?.mode, "restricted");
    assert.equal(JSON.stringify(fallback).includes(ORIGINAL), false);
    await write([user, raw, { type: "event_msg", payload: { type: "agent_message", message: ORIGINAL, moderation: hidden } }]);
    const formal = await reader.readRecentMessages(path);
    assert.equal(formal.length, 2);
    assert.equal(formal[1]!.assistantDisplay?.mode, "hide");
    assert.equal(JSON.stringify(formal).includes(ORIGINAL), false);
    await write([raw, { type: "event_msg", payload: { type: "agent_message", message: "legacy formal answer" } }]);
    assert.deepEqual(await reader.readRecentMessages(path), [{ role: "assistant", text: "legacy formal answer" }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
