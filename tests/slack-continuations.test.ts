import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import { BridgeStore } from "../src/store/index.js";
import { SlackContinuations } from "../src/slack/continuations.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { renderSessionStatus } from "../src/bridge/sessions/state-presentation.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { resolveSlackInteractionContext } from "../src/slack/interactions/context.js";
import { createSlackMessageHandler } from "../src/slack/message-handler.js";
import type { BridgeSlackMessagePort } from "../src/bridge/contracts.js";
import { testConfig } from "./bridge-test-config.js";
import { logger } from "../src/logging/logger.js";
import { slackApiCall } from "../src/slack/api-call.js";

logger.configureOutput({ console: "none", file: false });
const source = "slack:TTEST:CTEST:1.0001";
type Posted = { channel: string; ts: string; thread_ts?: string; text: string;
  blocks?: unknown[]; metadata?: { event_type: string; event_payload: Record<string, unknown> }; user: string };

function fixture(file = ":memory:") {
  let store = new BridgeStore(file);
  const posts: Posted[] = [];
  const edits: Array<{ channel: string; ts: string; text?: string; blocks?: unknown[] }> = [];
  const deletes: Array<{ channel: string; ts: string }> = [];
  const missing = new Set(["1.0001"]);
  const behavior = { createError: null as unknown, createAfterWrite: false,
    parentError: null as unknown, eligible: true, editError: null as unknown, wrongDestination: false,
    rootRefreshes: 0, ready: 0, replyError: null as unknown, raceToRoot: false };
  const client = {
    conversations: { history: async (input: { oldest: string; latest?: string; cursor?: string }) => {
      if (behavior.parentError) throw behavior.parentError;
      if (!input.latest) return { ok: true, messages: posts.filter((p) => !p.thread_ts) };
      return { ok: true, messages: missing.has(input.oldest) ? [] : [{ ts: input.oldest }] };
    } },
    chat: {
      postMessage: async (input: Omit<Posted, "ts" | "user">) => {
        if (input.thread_ts && behavior.replyError) throw behavior.replyError;
        if (!input.thread_ts && behavior.createError && !behavior.createAfterWrite) throw behavior.createError;
        if (input.thread_ts && behavior.raceToRoot) {
          behavior.raceToRoot = false;
          missing.add(input.thread_ts);
          input = { ...input, thread_ts: undefined };
        }
        const p = { ...input, ts: `${posts.length + 2}.0001`, user: "UBOT" };
        posts.push(p);
        if (!input.thread_ts && behavior.createError) throw behavior.createError;
        return { ok: true, channel: behavior.wrongDestination ? "COTHER" : input.channel, ts: p.ts,
          message: { ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}) } };
      },
      update: async (input: typeof edits[number]) => {
        if (behavior.editError) throw behavior.editError;
        edits.push(input); return { ok: true };
      },
      delete: async (input: typeof deletes[number]) => { deletes.push(input); return { ok: true }; }
    }
  } as unknown as WebClient;
  let continuations: SlackContinuations;
  let transport: SlackMessageTransport;
  const connect = () => {
    continuations = new SlackContinuations({ client, store: store.slackContinuations, botUserId: () => "UBOT",
      rootSpec: async (_sourceId, threadTs, sessionId) => {
        behavior.rootRefreshes++;
        return behavior.eligible && sessionId === "codex-session" ? renderSessionStatus({ session: { id: "codex-session", directory: "/workspace/project" },
          binding: "bound", thread: threadTs, actions: [] }) : null;
      }, onReady: async () => { behavior.ready++; } });
    transport = new SlackMessageTransport(client, "test-secret", continuations);
  };
  connect();
  return { posts, edits, deletes, missing, behavior, get store() { return store; },
    get transport() { return transport; }, get continuations() { return continuations; },
    reconnect: () => { store.close(); store = new BridgeStore(file); connect(); }, close: () => store.close() };
}

const reply = () => createMessage({ kind: "codex", session: { id: "codex-session", directory: "/workspace/project" },
  body: [{ type: "text", text: "REPLY" }] });

test("missing parent creates one status root, delivers current content, and reuses it for concurrent replies", async () => {
  const f = fixture();
  try {
    await Promise.all([f.transport.sendMessageSpec(source, reply()), f.transport.sendMessageSpec(source, reply())]);
    assert.equal(f.posts.filter((p) => !p.thread_ts).length, 1);
    assert.equal(f.posts[0]?.text, "Codex · /workspace/project");
    assert.ok(JSON.stringify(f.posts[0]?.blocks).includes("Session ID"));
    assert.equal(f.posts[1]?.thread_ts, "2.0001");
    assert.equal(f.posts[2]?.thread_ts, "2.0001");
    assert.equal(f.transport.resolveConversationId("slack:TTEST:CTEST:2.0001"), source);
    assert.ok(JSON.stringify(f.edits[0]?.blocks).includes("2.0001"));
    assert.equal(f.store.getActiveTurnRoute("codex-session"), null, "transport does not fabricate routes or leases");
  } finally { f.close(); }
});

test("editing a legacy card triggers recovery; later edits and control clearing use its replacement", async () => {
  const f = fixture();
  try {
    assert.equal(await f.transport.editMessageSpec(source, "1.5000", reply()), true);
    const replacement = f.posts[1]!.ts;
    assert.equal(await f.transport.editMessageSpec(source, "1.5000", reply()), true);
    assert.equal(f.posts.length, 2);
    assert.equal(f.edits.at(-1)?.ts, replacement);
    await f.transport.clearMessageActions(source, "1.5000", "Resolved");
    assert.equal(f.edits.at(-1)?.ts, replacement);
    await f.transport.deleteMessage(source, "1.5000");
    assert.equal(f.deletes.at(-1)?.ts, replacement);
  } finally { f.close(); }
});

test("a second expired root replaces the physical card while retaining all older message handles", async () => {
  const f = fixture();
  try {
    await f.transport.editMessageSpec(source, "1.5000", reply());
    const first = f.posts[1]!.ts;
    f.missing.add("2.0001");
    await f.transport.editMessageSpec(source, "1.5000", reply());
    const second = f.posts.at(-1)!.ts;
    assert.notEqual(second, first);
    await f.transport.editMessageSpec(source, "1.5000", reply());
    await f.transport.editMessageSpec(source, first, reply());
    assert.equal(f.edits.at(-1)?.ts, second);
    assert.equal(f.posts.filter((p) => !p.thread_ts).length, 2);
  } finally { f.close(); }
});

test("state-only root refresh never recreates an entry point, and later refresh edits the new root", async () => {
  const f = fixture();
  try {
    const status = renderSessionStatus({ session: { id: "s", directory: "/workspace/project" }, binding: "bound", thread: "1.0001", actions: [] });
    await f.transport.updateConversationSession(source, status);
    assert.equal(f.posts.length, 0);
    await f.transport.sendMessageSpec(source, reply());
    await f.transport.updateConversationSession(source, status);
    assert.equal(f.edits.at(-1)?.ts, "2.0001");
    assert.ok(JSON.stringify(f.edits.at(-1)?.blocks).includes("2.0001"));
  } finally { f.close(); }
});

test("unknown parent reads, ineligible sessions, and child edit failures do not create a root", async () => {
  const f = fixture();
  try {
    f.behavior.parentError = new Error("timeout");
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.posts.length, 0);
    f.behavior.parentError = null;
    f.behavior.eligible = false;
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.posts.length, 0);
    f.missing.clear(); f.behavior.eligible = true;
    f.behavior.editError = { data: { error: "message_not_found" } };
    await assert.rejects(f.transport.editMessageSpec(source, "child", reply()));
    assert.equal(f.posts.length, 0);
  } finally { f.close(); }
});

test("session-less content and stale output for a different session cannot create an entry point", async () => {
  const f = fixture();
  try {
    await f.transport.sendMessageSpec(source, createMessage({ scope: "global", kind: "menu" }));
    const stale = reply(); stale.session = { id: "previous-session", directory: "/workspace/project" };
    await f.transport.sendMessageSpec(source, stale);
    assert.deepEqual(f.posts, []);
  } finally { f.close(); }
});

test("uncertain create is reconciled by operation metadata after reopening the database", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "bridge-slack-continuation-")), "test.sqlite");
  const f = fixture(file);
  try {
    f.behavior.createError = new Error("response lost"); f.behavior.createAfterWrite = true;
    assert.equal(await f.transport.sendMessageSpec(source, reply()), null);
    assert.equal(f.store.slackContinuations.get(source)?.state, "pending");
    f.reconnect(); f.behavior.createError = null;
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.posts.filter((p) => !p.thread_ts).length, 1);
    assert.equal(f.posts.at(-1)?.thread_ts, "2.0001");
    f.reconnect();
    assert.equal(f.transport.resolveConversationId("slack:TTEST:CTEST:2.0001"), source);
    await f.transport.editMessageSpec(source, f.posts.at(-1)!.ts, reply());
    assert.equal(f.posts.length, 2);
  } finally { f.close(); }
});

test("an empty reconciliation never authorizes another uncertain create", async () => {
  const f = fixture();
  try {
    f.behavior.createError = new Error("timeout");
    await f.transport.sendMessageSpec(source, reply());
    f.behavior.createError = null;
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.posts.length, 0);
    assert.equal(f.store.slackContinuations.get(source)?.state, "pending");
  } finally { f.close(); }
});

test("confirmed create rejection can be retried without converting it to an uncertain write", async () => {
  const f = fixture();
  try {
    f.behavior.createError = { data: { ok: false, error: "invalid_blocks" } };
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.store.slackContinuations.get(source)?.state, "ready");
    f.behavior.createError = null;
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.posts.length, 2);
  } finally { f.close(); }
});

test("a failed status update does not discard a confirmed root or create another one", async () => {
  const f = fixture();
  try {
    f.behavior.editError = new Error("status refresh failed");
    await f.transport.sendMessageSpec(source, reply());
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.posts.filter((p) => !p.thread_ts).length, 1);
    assert.equal(f.posts.length, 3);
  } finally { f.close(); }
});

test("new-thread text and button actions normalize to the original business conversation", async () => {
  const f = fixture();
  try {
    await f.transport.sendMessageSpec(source, reply());
    const received: string[] = [];
    const handler = createSlackMessageHandler({ config: testConfig("/tmp/unused.sqlite"), getBotUserId: () => null,
      service: { ensureChatAllowed: async () => {}, handleIncomingUserText: async (input: { telegramChatId: string }) => {
        received.push(input.telegramChatId); return { routed: true };
      } } as unknown as BridgeSlackMessagePort, transport: f.transport });
    await handler.handleText({ channelId: "CTEST", teamId: "TTEST", messageId: "input", rawText: "continue", threadTs: "2.0001" });
    assert.deepEqual(received, [source]);
    const context = resolveSlackInteractionContext(source, "decision:id:a", { channelId: "CTEST", teamId: "TTEST",
      containerType: "message", messageTs: "3.0001", threadTs: "2.0001" })!;
    assert.equal(f.transport.resolveConversationId(context.conversationId), source);
    assert.equal(f.transport.normalizeInteraction(context)?.conversationId, source);
    assert.equal(f.transport.normalizeInteraction({ ...context, surfaceId: source }), null,
      "retired physical surfaces cannot keep using old approval controls");
  } finally { f.close(); }
});

test("a parent deletion racing a send is recovered only after confirmed retraction", async () => {
  const f = fixture();
  try {
    f.missing.clear(); f.behavior.raceToRoot = true;
    await f.transport.sendMessageSpec(source, reply());
    assert.equal(f.deletes.length, 1);
    assert.equal(f.deletes[0]?.ts, f.posts[0]?.ts);
    assert.equal(f.posts[1]?.thread_ts, undefined);
    assert.equal(f.posts[2]?.thread_ts, f.posts[1]?.ts);
  } finally { f.close(); }
});

test("unconfirmed replacement sends are not repeated by later edits", async () => {
  const f = fixture();
  try {
    f.behavior.replyError = new Error("unknown reply result");
    assert.equal(await f.transport.editMessageSpec(source, "old-card", reply()), false);
    f.behavior.replyError = null;
    assert.equal(await f.transport.editMessageSpec(source, "old-card", reply()), false);
    assert.equal(f.posts.length, 1, "only the confirmed root exists; no blind replacement retry");
  } finally { f.close(); }
});

test("confirmed replacement rejection permits a later retry in the same root", async () => {
  const f = fixture();
  try {
    f.behavior.replyError = { data: { error: "invalid_blocks" } };
    assert.equal(await f.transport.editMessageSpec(source, "old-card", reply()), false);
    f.behavior.replyError = null;
    assert.equal(await f.transport.editMessageSpec(source, "old-card", reply()), true);
    assert.equal(f.posts.length, 2);
  } finally { f.close(); }
});

test("a root response for the wrong channel is not trusted and never receives conversation content", async () => {
  const f = fixture();
  try {
    f.behavior.wrongDestination = true;
    assert.equal(await f.transport.sendMessageSpec(source, reply()), null);
    assert.equal(f.posts.length, 1);
    assert.equal(f.store.slackContinuations.get(source)?.state, "pending");
  } finally { f.close(); }
});

test("only explicit short rate limits retry, once; unknown writes and long waits do not", async () => {
  let calls = 0;
  const result = await slackApiCall(async () => {
    if (++calls === 1) throw { code: "slack_webapi_rate_limited_error", retryAfter: 0 };
    return "ok";
  });
  assert.equal(result, "ok"); assert.equal(calls, 2);
  for (const failure of [new Error("timeout"), { code: "slack_webapi_rate_limited_error", retryAfter: 60 }]) {
    calls = 0;
    await assert.rejects(slackApiCall(async () => { calls++; throw failure; }));
    assert.equal(calls, 1);
  }
});
