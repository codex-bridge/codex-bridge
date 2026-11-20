import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import type { WebClient } from "@slack/web-api";
import { logger } from "../src/logging/logger.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { helpMenuActions } from "../src/bridge/messages/actions.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { SlackContinuations } from "../src/slack/continuations.js";
import { dispatchSlackInteraction } from "../src/slack/interactions/router.js";
import type { BridgeSlackInteractionPort } from "../src/bridge/contracts.js";
import { BridgeStore } from "../src/store/index.js";

const source = "slack:T:C:1";
type Timing = {
  deliveryId: string; operation: string; messageLabel: string; outcome: string;
  queueWaitMs: number; operationMs: number; totalMs: number; retryWaitMs: number;
  apiCalls: Array<{ method: string; elapsedMs: number; outcome: string; errorCode?: string }>;
};
function capture(t: TestContext): Timing[] {
  const records: Timing[] = [];
  t.mock.method(logger, "info", (event: string, details: unknown) => {
    if (event === "slack.delivery.timing") records.push(details as Timing);
  });
  return records;
}
const reply = () => createMessage({ kind: "codex", directory: "/project", body: [{ type: "text", text: "PRIVATE BODY" }] });

test("Help timing measures its parent lookup and Slack write without recording body, tokens or API arguments", async t => {
  const records = capture(t); let now = 0;
  t.mock.method(performance, "now", () => now);
  const client = {
    conversations: { history: async () => { now += 20; return { ok: true, messages: [{ ts: "1" }] }; } },
    chat: { postMessage: async () => { now += 80; return { channel: "C", ts: "2", message: { thread_ts: "1" } }; } }
  } as unknown as WebClient;
  await dispatchSlackInteraction({ action: "quick:help", context: { platform: "slack", conversationId: source, surfaceId: source },
    messageBlocks: null, messageText: "PRIVATE BODY", openQueueModal: async () => assert.fail("unexpected modal"),
    service: { getActiveSessionContext: async () => ({ id: "thread", directory: "/project" }),
      getHelpMenuActions: async () => helpMenuActions({ runtimeConnected: true, hasActiveSession: true }) } as BridgeSlackInteractionPort,
    transport: new SlackMessageTransport(client, "PRIVATE CALLBACK SECRET") });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.messageLabel, "Help");
  assert.equal(records[0]!.queueWaitMs, 0);
  assert.equal(records[0]!.operationMs, 100);
  assert.equal(records[0]!.totalMs, 100);
  assert.deepEqual(records[0]!.apiCalls, [
    { method: "conversations.history", elapsedMs: 20, outcome: "returned" },
    { method: "chat.postMessage", elapsedMs: 80, outcome: "returned" }
  ]);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|blocks|headers|Authorization/);
});

test("same-conversation queue wait is separate from API time and concurrent traces do not mix", async t => {
  const records = capture(t); let now = 0, histories = 0;
  t.mock.method(performance, "now", () => now);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const client = {
    conversations: { history: async () => {
      if (++histories === 1) { entered(); await blocked; }
      return { ok: true, messages: [{ ts: "1" }] };
    } },
    chat: { postMessage: async () => { now += 5; return { channel: "C", ts: "2", message: { thread_ts: "1" } }; } }
  } as unknown as WebClient;
  const continuations = { resolveSource: (id: string) => id, target: () => ({ channelId: "C", threadTs: "1" }),
    remember: () => {} } as unknown as SlackContinuations;
  const transport = new SlackMessageTransport(client, null, continuations);
  const first = transport.sendMessageSpec(source, reply());
  await started;
  now = 10;
  const second = transport.sendMessageSpec(source, reply());
  now = 50;
  release();
  await Promise.all([first, second]);
  assert.equal(records.length, 2);
  assert.notEqual(records[0]!.deliveryId, records[1]!.deliveryId);
  assert.deepEqual(records.map(r => [r.queueWaitMs, r.operationMs, r.totalMs]), [[0, 55, 55], [45, 5, 50]]);
  assert.deepEqual(records.map(r => r.apiCalls.map(a => a.elapsedMs)), [[50, 5], [0, 5]]);
});

test("failed parent lookup is timed, remains unconfirmed and never posts a fallback", async t => {
  const records = capture(t); let now = 0;
  t.mock.method(performance, "now", () => now);
  const client = { conversations: { history: async () => {
    now += 10_000; throw Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" });
  } }, chat: { postMessage: async () => assert.fail("unexpected post") } } as unknown as WebClient;
  assert.equal(await new SlackMessageTransport(client).sendMessageSpec(source, reply()), null);
  assert.equal(records[0]!.outcome, "unconfirmed");
  assert.equal(records[0]!.totalMs, 10_000);
  assert.deepEqual(records[0]!.apiCalls, [{ method: "conversations.history", elapsedMs: 10_000,
    outcome: "threw", errorCode: "ETIMEDOUT" }]);
});

test("edit failures preserve the original exception and root sends skip parent lookup", async t => {
  const records = capture(t); let now = 0;
  t.mock.method(performance, "now", () => now);
  const failure = Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" });
  const client = { chat: {
    update: async () => { now += 7; throw failure; },
    postMessage: async () => { now += 3; return { channel: "C", ts: "2" }; }
  } } as unknown as WebClient;
  const transport = new SlackMessageTransport(client);
  await assert.rejects(transport.editMessageSpec("slack:T:C", "1", reply()), error => error === failure);
  await transport.sendMessageSpec("slack:T:C", reply());
  assert.deepEqual(records.map(r => [r.operation, r.outcome, r.totalMs]), [["edit", "threw", 7], ["send", "returned", 3]]);
  assert.deepEqual(records.map(r => r.apiCalls.map(a => a.method)), [["chat.update"], ["chat.postMessage"]]);
});

test("bounded Slack rate-limit wait is measured separately from individual SDK attempts", async t => {
  const records = capture(t); let now = 0, attempts = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = { chat: { postMessage: async () => {
    now += 5;
    if (++attempts === 1) throw { code: "slack_webapi_rate_limited_error", retryAfter: 0.01 };
    return { channel: "C", ts: "2" };
  } } } as unknown as WebClient;
  const result = new SlackMessageTransport(client).sendMessageSpec("slack:T:C", reply());
  await new Promise<void>(resolve => setImmediate(resolve));
  now += 10;
  t.mock.timers.tick(10);
  await result;
  assert.equal(attempts, 2);
  assert.equal(records[0]!.retryWaitMs, 10);
  assert.equal(records[0]!.totalMs, 20);
  assert.deepEqual(records[0]!.apiCalls.map(a => [a.elapsedMs, a.outcome]), [[5, "threw"], [5, "returned"]]);
});

test("thread continuation APIs remain within the triggering delivery's timing record", async t => {
  const records = capture(t); let now = 0, posts = 0;
  t.mock.method(performance, "now", () => now);
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const client = {
    conversations: { history: async (input: { oldest: string }) => {
      now += 2; return { ok: true, messages: input.oldest === "1" ? [] : [{ ts: "2" }] };
    } },
    chat: {
      postMessage: async (input: { thread_ts?: string }) => {
        now += 3; return { ok: true, channel: "C", ts: String(++posts + 1),
          message: input.thread_ts ? { thread_ts: input.thread_ts } : {} };
      },
      update: async () => { now += 4; return { ok: true }; }
    }
  } as unknown as WebClient;
  const continuations = new SlackContinuations({ client, store: store.slackContinuations,
    botUserId: () => "BOT", rootSpec: async () => createMessage({ kind: "menu", directory: "/project", surface: "session-status" }) });
  await new SlackMessageTransport(client, null, continuations).sendMessageSpec(source,
    createMessage({ kind: "codex", session: { id: "thread", directory: "/project" } }));
  assert.equal(posts, 2);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.totalMs, 14);
  assert.deepEqual(records[0]!.apiCalls.map(a => a.method),
    ["conversations.history", "chat.postMessage", "chat.update", "conversations.history", "chat.postMessage"]);
});

test("a diagnostic logging failure cannot convert a successful write into an error", async t => {
  t.mock.method(logger, "info", (event: string) => { if (event === "slack.delivery.timing") throw new Error("log unavailable"); });
  const client = { chat: { postMessage: async () => ({ channel: "C", ts: "2" }) } } as unknown as WebClient;
  assert.deepEqual(await new SlackMessageTransport(client).sendMessageSpec("slack:T:C", reply()), { message_id: "2" });
});

test("a skipped status edit is unconfirmed without making a write request", async t => {
  const records = capture(t);
  const client = { conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: { update: async () => assert.fail("unexpected update") } } as unknown as WebClient;
  const status = createMessage({ kind: "menu", directory: "/project", surface: "session-status" });
  assert.equal(await new SlackMessageTransport(client).editMessageSpec(source, "1", status), false);
  assert.equal(records[0]!.outcome, "unconfirmed");
  assert.deepEqual(records[0]!.apiCalls.map(api => api.method), ["conversations.history"]);
});
