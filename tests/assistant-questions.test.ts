import assert from "node:assert/strict";
import test from "node:test";
import { extractAssistantMessage } from "../src/codex/assistant-message.js";
import { AssistantReplyService, parseAssistantReplyCallback } from "../src/bridge/interactions/assistant-replies.js";
import { createTranscriptMessageSpec } from "../src/bridge/renderers/thread-history.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { presentWebMessage } from "../src/web/message-presentation.js";
import { BridgeStore } from "../src/store/index.js";
import { LocalTimelineCache } from "../web/src/lib/cache.ts";
import { applyMessage, restoreHistory } from "../web/src/lib/timeline.ts";
import { normalizeFullThreadTurnsPage } from "../src/codex/thread-history.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import { NotificationMessageService } from "../src/bridge/notifications/messages.js";
import { BridgeMessageOperations } from "../src/bridge/messages/operations.js";
import { extractCompletedAgentMessage } from "../src/codex/notification-events.js";
import { handleSlackTurnWorkflow } from "../src/slack/interactions/turn-workflow.js";
import { handleTelegramTurnWorkflow } from "../src/telegram/interactions/turn-workflow.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";

const questions = [{ title: "Choose direction", options: ["Go", "Next"] },
  { title: "Choose tone", options: ["Brief", "Detailed"] }, { title: "Any notes?", options: null }];
const item = { id: "question-call", type: "agentMessage", delivery: "async", phase: "final_answer",
  text: "Choose direction\n- Go\n- Next\n\nChoose tone\n- Brief\n- Detailed\n\nAny notes?", questions };

test("asynchronous questions keep order and free text across live, full, paginated and legacy history", async () => {
  const live = extractAssistantMessage(item)!;
  const page = { data: [{ id: "turn", status: "completed", items: [item] }], nextCursor: null };
  const full = normalizeFullThreadTurnsPage(page, "t").turns[0]!.entries[0]!;
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {}, rememberThreadSettings: () => {}, requestKnownMethod: async () => page,
    request: async () => ({ initialMessages: [{ payload: { ...item, role: "assistant" } }] })
  });
  for (const message of [live, full, (await client.listRecentThreadMessages("t"))[0]!, (await client.resumeThread("t")).messages[0]!]) {
    assert.equal(message.delivery, "async"); assert.deepEqual(message.questions, questions);
  }
  const empty = extractAssistantMessage({ ...item, text: "" })!;
  assert.match(empty.text, /Choose direction\n- Go\n- Next/);
  assert.match(empty.text, /Any notes\?/);
  assert.equal(extractAssistantMessage({ ...item, questions: [{ title: "bad", options: [] }] })!.questions, undefined);
  assert.equal(extractAssistantMessage({ ...item, delivery: "future" })!.questions, undefined);
});

test("restricted replies never retain original questions or create choices", () => {
  for (const display of [{ version: 1, mode: "hide", replacement: { kind: "wellbeingPromptHelpline" } },
    { version: 1, mode: "block", reason: { kind: "cyber" } }, { version: 9, mode: "show" }]) {
    const message = extractAssistantMessage({ ...item, moderation: { moderated: true, display } })!;
    assert.equal(message.questions, undefined); assert.equal(message.delivery, undefined);
    assert.equal(JSON.stringify(message).includes("Choose direction"), false);
  }
});

test("short callbacks preserve full labels, bind session ownership and consume only the answered question", async (t) => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "t", pathKey: "/work", currentCwd: "/work" });
  let version = 1;
  const replies = new AssistantReplyService(() => version);
  const actions = replies.createActions(session, { role: "assistant", ...extractAssistantMessage(item)! });
  assert.equal(actions.length, 4); assert.deepEqual(actions.map(action => action.label), ["Go", "Next", "Brief", "Detailed"]);
  const token = parseAssistantReplyCallback(actions[0]!.callback)!;
  assert.equal(token.length, 16);
  assert.equal(replies.resolve(token, session.id, "chat").text, "Go");
  assert.throws(() => replies.resolve(token, "other-session", "chat"));
  assert.throws(() => replies.resolve(token, session.id, "another-chat"));
  version++; assert.throws(() => replies.resolve(token, session.id, "chat")); version--;
  replies.consume(token, session.id, "chat");
  for (const action of actions.slice(0, 2)) assert.throws(() => replies.resolve(parseAssistantReplyCallback(action.callback)!, session.id, "chat"));
  assert.equal(replies.resolve(parseAssistantReplyCallback(actions[2]!.callback)!, session.id, "chat").text, "Brief");
  const long = "A long choice 😀 ".repeat(100);
  const longActions = replies.createActions(session, { role: "assistant", ...extractAssistantMessage({ ...item,
    questions: [{ title: "Long choice", options: [long] }] })! });
  assert.ok(Buffer.byteLength(longActions[0]!.callback) < 64);
  assert.equal(replies.resolve(parseAssistantReplyCallback(longActions[0]!.callback)!, session.id, "chat").text, long);
  replies.createActions(session, { role: "assistant", sourceItemId: item.id, text: "Blocked" });
  assert.throws(() => replies.resolve(parseAssistantReplyCallback(longActions[0]!.callback)!, session.id, "chat"));
});

test("three renderers share choice text and grouping while history and cache remain non-interactive", async (t) => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "t", pathKey: "/work", currentCwd: "/work" });
  const message = { role: "assistant" as const, ...extractAssistantMessage(item)! };
  const spec = createTranscriptMessageSpec({ directory: "/work", ...message });
  assert.deepEqual(spec.actions, [], "history presentation does not recreate live choices");
  spec.actions = new AssistantReplyService(() => 1).createActions(session, message);
  const telegram = renderTelegramMessageSpec(spec);
  assert.deepEqual(telegram.keyboard!.inline_keyboard.map(row => row.map(button => button.text)), [["Go", "Next"], ["Brief", "Detailed"]]);
  assert.match(JSON.stringify(renderSlackMessageSpec("slack:T:C", spec, null)), /Choose direction/);
  const web = presentWebMessage(spec);
  assert.deepEqual(web.questions, questions);
  assert.equal(web.actions[0]!.execution.type, "send-text");
  const values = new Map<string, string>();
  const cache = new LocalTimelineCache({ getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } });
  cache.save("t", session.id, [{ id: "live", origin: "live", message: web }]);
  const restored = cache.load("t", session.id);
  assert.deepEqual(restored[0]!.message.questions, questions); assert.deepEqual(restored[0]!.message.actions, []);
  assert.equal(JSON.stringify([...values.values()]).includes("reply:"), false);
  const history = restoreHistory([], { threadId: "t", sessionId: session.id, leaseVersion: 1, messages: [message] });
  assert.deepEqual(history[0]!.message.questions, questions); assert.deepEqual(history[0]!.message.actions, []);
  const restricted = { ...web, assistantDisplay: { version: 2, mode: "show" } } as unknown as typeof web;
  const safe = applyMessage([], { operation: "send", messageId: "r", threadId: "t", sessionId: session.id, leaseVersion: 1, message: restricted });
  assert.equal(JSON.stringify(safe).includes("Choose direction"), false);
  cache.save("t", session.id, safe);
  assert.equal(JSON.stringify(cache.load("t", session.id)).includes("Choose direction"), false);
});

test("choices survive explicit owner-turn transitions, but handoffs and disconnects never revive old tokens", async t => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "t", pathKey: "/work" });
  store.claimSession(session.id, "123");
  const replies = new AssistantReplyService(id => store.getSessionLease(id)?.version);
  const create = () => replies.createActions(session, { role: "assistant", ...extractAssistantMessage(item)! });
  let actions = create();
  const first = parseAssistantReplyCallback(actions[0]!.callback)!, second = parseAssistantReplyCallback(actions[2]!.callback)!;
  assert.equal(replies.preserveForTurnTransition(session.id, () => store.setSessionOwnerTurn(session.id, "123", "turn")), true);
  assert.equal(replies.resolve(first, session.id, "123").text, "Go");
  assert.equal(replies.preserveForTurnTransition(session.id, () => store.clearSessionOwnerTurn(session.id, "turn")), true);
  replies.consume(first, session.id, "123");
  assert.equal(replies.preserveForTurnTransition(session.id, () => store.setSessionOwnerTurn(session.id, "123", "reply-turn")), true);
  assert.equal(replies.resolve(second, session.id, "123").text, "Brief", "another question remains answerable in the next turn");
  replies.preserveForTurnTransition(session.id, () => store.clearSessionOwnerTurn(session.id, "reply-turn"));
  store.requestSessionHandoff(session.id, "slack:T:C:1", true);
  store.requestSessionHandoff(session.id, "123", true);
  replies.preserveForTurnTransition(session.id, () => store.setSessionOwnerTurn(session.id, "123", "later-turn"));
  assert.throws(() => replies.resolve(second, session.id, "123"), /no longer available/);
  actions = create();
  const fresh = parseAssistantReplyCallback(actions[0]!.callback)!;
  replies.clear(); assert.throws(() => replies.resolve(fresh, session.id, "123"), /no longer available/);
});

test("live notification delivery attaches choices once and keeps async questions out of MCP result classification", async (t) => {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "t", pathKey: "/work", currentCwd: "/work" });
  const replies = new AssistantReplyService(() => 1), sent: MessageSpec[] = [];
  const operations = new BridgeMessageOperations({ sender: {
    requireTransport: () => ({ sendMessageSpec: async () => ({ message_id: "1" }) }),
    sendSpecAndGetLastMessage: async (_chat, spec) => { sent.push(spec); return { messageId: "1", text: "reply" }; }
  } as never, formatCodexTelegramHtml: () => null, getSessionDirectory: () => "/work", rememberLastAssistantMessage: () => {},
    createAssistantReplyActions: (session, message) => replies.createActions(session, message) });
  const recent = new Map([[session.id, Date.now()]]);
  const service = new NotificationMessageService({ store, assistantOutputByThread: new Map(), recentResolvedMcpBySession: recent,
    resolveNotificationSession: async () => session, resetTypingStatus: () => {}, clearRetryingRecovery: () => {},
    getSessionDirectory: () => "/work", clearProgressMessageForThread: async () => {},
    sendLongSpec: async (_chat, spec) => { sent.push(spec); },
    sendTranscriptMessage: (session, message, thread) => operations.sendTranscriptMessage(session, message, thread) });
  const live = extractCompletedAgentMessage({ method: "item/completed", params: { threadId: "t", item } })!;
  await service.handleCompletedAgentMessage(live); await service.handleCompletedAgentMessage(live);
  assert.equal(sent.length, 1); assert.equal(sent[0]!.kind, "codex"); assert.equal(sent[0]!.actions.length, 4);
  const old = parseAssistantReplyCallback(sent[0]!.actions[0]!.callback)!;
  await service.handleCompletedAgentMessage({ ...live, questions: [{ title: "Updated choice", options: ["Different"] }] });
  assert.equal(sent.length, 2, "changed questions are not deduped by identical text");
  assert.throws(() => replies.resolve(old, session.id, "chat"));
  await service.handleCompletedAgentMessage({ threadId: "t", sourceItemId: "follow-up", text: "Still working" });
  assert.equal(sent[2]!.kind, "codex"); assert.equal(recent.size, 0);
});

test("Slack and Telegram resolve the same opaque callback without editing original question content", async () => {
  const calls: unknown[] = [];
  const token = "abcdefghijklmnop";
  const service = { replyToAssistantOption: async (chat: string, token: string) => {
    calls.push({ chat, token }); return { routed: true };
  } };
  await handleSlackTurnWorkflow({ action: `reply:${token}`, context: { platform: "slack", conversationId: "slack:T:C:1",
    surfaceId: "slack:T:C:1", sourceMessageId: "message" }, messageText: "Original question", openQueueModal: async () => {},
    service: service as never, transport: { editMessageSpec: async () => { assert.fail("original question must remain"); } } as never });
  await handleTelegramTurnWorkflow({ action: `reply:${token}`, callbackId: "callback", acknowledge: async () => {},
    context: { platform: "telegram", conversationId: "chat", surfaceId: "chat" }, service: service as never,
    responder: { send: async () => { assert.fail("no duplicate acknowledgement message"); } } as never });
  assert.deepEqual(calls, [{ chat: "slack:T:C:1", token }, { chat: "chat", token }]);
  assert.equal(parseAssistantReplyCallback("reply:invalid"), null);
});
