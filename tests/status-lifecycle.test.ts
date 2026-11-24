import assert from "node:assert/strict";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import { StatusLifecycleService, type StatusLifecycleDependencies } from "../src/bridge/status/lifecycle.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { SessionRecord } from "../src/shared/types.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { logger } from "../src/logging/logger.js";
import { presentWebMessage } from "../src/web/message-presentation.js";

const session = { id: "session", codexThreadId: "thread", telegramChatId: "slack:T:C:1" } as SessionRecord;

function fixture() {
  const sent: MessageSpec[] = [], edits: Array<{ id: string; spec: MessageSpec }> = [];
  let edit = async (): Promise<boolean> => true;
  const deps: StatusLifecycleDependencies = {
    store: { countPendingQueuedSubmissions: async () => 0, getSessionById: async () => session },
    statusMessageBySession: new Map(), statusStartedAtBySession: new Map(), statusLabelBySession: new Map(),
    statusDetailBySession: new Map(), statusLastEditAtBySession: new Map(), statusOpBySession: new Map(),
    sendMessageSpec: async (_chatId, spec) => { sent.push(spec); return { message_id: `status-${sent.length}` }; },
    editMessageSpec: async (_chatId, id, spec) => { edits.push({ id, spec }); return edit(); },
    getSessionDirectory: () => "/project", isCompactStatusUpdate: () => false,
    notifyCompactStarted: async () => {}, clearTypingState: () => {}, sendTypingOnce: async () => {}
  };
  return { lifecycle: new StatusLifecycleService(deps), deps, sent, edits,
    setEdit: (implementation: typeof edit) => { edit = implementation; } };
}

test("Working preserves its ID and clock across repeated timeouts, retries identical detail and finalizes in place", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  await f.lifecycle.setSessionStatus(session, "Working");
  f.setEdit(async () => { throw Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }); });
  now += 10_000;
  await f.lifecycle.setSessionStatus(session, "Thinking", { detail: "**Planning**", detailMode: "replace" });
  assert.equal(f.sent.length, 1);
  now += 1_000;
  await f.lifecycle.setSessionStatus(session, "Thinking");
  assert.equal(f.edits.length, 1, "a pending edit is still throttled");
  now += 5_000;
  await f.lifecycle.setSessionStatus(session, "Thinking");
  assert.equal(f.edits.length, 2, "identical detail retries after the throttle");
  f.setEdit(async () => true);
  now += 5_000;
  await f.lifecycle.setSessionStatus(session, "Thinking");
  assert.match(renderLegacyMessage(f.edits.at(-1)!.spec), /Working · Thinking · 21s$/);
  now += 5_000;
  await f.lifecycle.clearSessionStatus(session);
  assert.equal(f.sent.length, 1);
  assert.ok(f.edits.every(edit => edit.id === "status-1"));
  assert.match(renderLegacyMessage(f.edits.at(-1)!.spec), /Working · Done · 26s$/);
  assert.deepEqual(f.edits.at(-1)!.spec.actions, []);
  assert.equal(f.deps.statusMessageBySession.size, 0);
});

test("only a confirmed missing message is replaced, preserving elapsed time on Slack and Telegram", async t => {
  for (const error of [{ data: { error: "message_not_found" } },
    { error_code: 400, description: "Bad Request: message to edit not found" }]) {
    let now = 100_000;
    t.mock.method(Date, "now", () => now);
    const f = fixture();
    await f.lifecycle.setSessionStatus(session, "Working");
    f.setEdit(async () => { throw error; });
    now += 12_000;
    await f.lifecycle.setSessionStatus(session, "Thinking");
    assert.equal(f.sent.length, 2);
    assert.match(renderLegacyMessage(f.sent[1]!), /Working · Thinking · 12s$/);
    f.setEdit(async () => true);
    now += 5_000;
    await f.lifecycle.clearSessionStatus(session);
    assert.equal(f.edits.at(-1)!.id, "status-2");
    assert.match(renderLegacyMessage(f.edits.at(-1)!.spec), /Working · Done · 17s$/);
  }
});

test("permission failures, unavailable threads and false edit results never cause a Working replacement", async () => {
  for (const rejection of [false, { error_code: 403 }, { data: { error: "cant_update_message" } },
    { data: { error: "thread_not_found" } }, { data: { error: "missing_scope" } }, { statusCode: 503 }]) {
    const f = fixture();
    await f.lifecycle.setSessionStatus(session, "Working");
    f.setEdit(async () => { if (rejection === false) return false; throw rejection; });
    await f.lifecycle.setSessionStatus(session, "Thinking");
    assert.equal(f.sent.length, 1);
    assert.equal(f.deps.statusMessageBySession.get(session.id)?.messageId, "status-1");
    f.setEdit(async () => true);
    await f.lifecycle.clearSessionStatus(session);
    assert.equal(f.edits.at(-1)!.id, "status-1");
  }
});

test("Telegram unchanged acknowledgement counts as a synchronized Working edit", async () => {
  const f = fixture();
  await f.lifecycle.setSessionStatus(session, "Working");
  f.setEdit(async () => { throw { error_code: 400, description: "Bad Request: message is not modified" }; });
  await f.lifecycle.setSessionStatus(session, "Thinking");
  await f.lifecycle.setSessionStatus(session, "Thinking");
  assert.equal(f.sent.length, 1);
  assert.equal(f.edits.length, 1);
  assert.match(f.deps.statusMessageBySession.get(session.id)!.text, /Working · Thinking/);
});

test("a finalization timeout never sends another Working and the next turn starts fresh", async () => {
  const f = fixture();
  await f.lifecycle.setSessionStatus(session, "Thinking");
  f.setEdit(async () => { throw new Error("request timeout"); });
  await f.lifecycle.clearSessionStatus(session);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.edits[0]!.spec.actions, []);
  assert.equal(f.deps.statusMessageBySession.size, 0);
  await f.lifecycle.setSessionStatus(session, "Working");
  assert.equal(f.sent.length, 2);
});

test("Working omits Thinking summaries on every transport while recovery detail stays literal", async () => {
  const f = fixture();
  await f.lifecycle.setSessionStatus(session, "Thinking", {
    detail: "**Planning separate acceptance scenario**", detailMode: "replace"
  });
  const spec = f.sent[0]!;
  assert.equal(spec.body.length, 1);
  const slack = renderSlackMessageSpec(session.telegramChatId, spec, null)[0];
  assert.equal(slack?.type, "markdown");
  assert.ok(slack?.type === "markdown" && !slack.text.includes("Planning"));
  const telegram = renderTelegramMessageSpec(spec);
  assert.ok(!telegram.markdown.includes("Planning"));
  assert.ok(!telegram.html.includes("Planning"));
  assert.equal(presentWebMessage(spec).body.length, 1);
  await f.lifecycle.setSessionStatus(session, "Recovering", { detail: "Issue · `connection lost`", detailMode: "replace" });
  assert.deepEqual(f.edits[0]!.spec.body[1], { type: "text", text: "Issue · `connection lost`" });
});

test("the Slack transport keeps one Working through an update timeout and completion", async t => {
  let now = 100_000, fail = false;
  t.mock.method(Date, "now", () => now);
  const posts: Array<Record<string, unknown>> = [], updates: Array<Record<string, unknown>> = [];
  const client = {
    conversations: { history: async () => ({ ok: true, messages: [{ ts: "1" }] }) },
    chat: {
      postMessage: async (payload: Record<string, unknown>) => {
        posts.push(payload);
        return { channel: "C", ts: "2", message: { thread_ts: "1" } };
      },
      update: async (payload: Record<string, unknown>) => {
        updates.push(payload);
        if (fail) throw new Error("The operation was aborted due to timeout");
        return { ok: true };
      }
    }
  } as unknown as WebClient;
  const transport = new SlackMessageTransport(client), f = fixture();
  f.deps.sendMessageSpec = async (chatId, spec, options) => {
    const sent = await transport.sendMessageSpec(chatId, spec, options);
    return sent ? { message_id: String(sent.message_id) } : null;
  };
  f.deps.editMessageSpec = (chatId, id, spec) => transport.editMessageSpec(chatId, id, spec);
  await f.lifecycle.setSessionStatus(session, "Thinking");
  fail = true;
  now += 10_000;
  await f.lifecycle.setSessionStatus(session, "Running command");
  fail = false;
  now += 6_000;
  await f.lifecycle.setSessionStatus(session, "Running command");
  now += 6_000;
  await f.lifecycle.clearSessionStatus(session);
  assert.equal(posts.length, 1);
  assert.equal(updates.length, 3);
  assert.ok(updates.every(payload => payload.ts === "2"));
  assert.match(String(updates.at(-1)?.text), /Working · Done · 22s$/);
});


test("synchronized unchanged Working edits and cleanup do not produce warning logs", async t => {
  const warnings: unknown[] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => { warnings.push(args); });
  const f = fixture();
  await f.lifecycle.setSessionStatus(session, "Working");
  f.setEdit(async () => { throw { error_code: 400, description: "Bad Request: message is not modified" }; });
  await f.lifecycle.setSessionStatus(session, "Thinking");
  await f.lifecycle.clearSessionStatus(session);
  await f.lifecycle.setSessionStatus(session, "Working");
  await f.lifecycle.clearAllSessionStatusMessages();
  assert.deepEqual(warnings, []);
  assert.equal(f.deps.statusMessageBySession.size, 0);
});
