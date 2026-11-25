import assert from "node:assert/strict";
import test from "node:test";

import type { MessageSpec } from "../src/bridge/messages/types.js";
import { createThreadHistoryEntrySpec } from "../src/bridge/renderers/thread-history.js";
import { CompactService, type CompactServiceDependencies } from "../src/bridge/sessions/compact-service.js";
import type { BridgeMessageOptions } from "../src/bridge/transport.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { BridgeStore } from "../src/store/index.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

async function harness(t: test.TestContext, connected = true, overrides: Partial<CompactServiceDependencies> = {}) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({
    telegramChatId: "chat", codexThreadId: "thread", pathKey: "/workspace/project"
  });
  await store.setActiveSession("chat", session.id);
  const sent: Array<{ spec: MessageSpec; options: Omit<BridgeMessageOptions, "messageSpec"> | undefined }> = [];
  const edits: Array<{ source: string; id: string; spec: MessageSpec; options: Omit<BridgeMessageOptions, "messageSpec"> | undefined }> = [];
  const service = new CompactService({
    appendWorkflowMessage: (_session, operation) => operation(),
    store,
    codexClient: {
      startCompactThread: async () => {},
      resumeThread: async () => ({ displayPath: null, messages: [] }),
      sendTurn: async () => {}
    },
    isRuntimeConnected: () => connected,
    getLastUserInput: () => undefined,
    getSessionDirectory: () => "/workspace/project",
    formatCompactTokenCount: () => "",
    isMissingRuntimeThreadError: () => false,
    resumeThread: async () => ({ displayPath: null, messages: [] }),
    rememberNotificationSession: () => {},
    setSessionStatus: async () => {},
    sendSystemErrorMessage: async () => {},
    sendMessageSpec: async (_chat, spec, options) => { sent.push({ spec, options }); return { message_id: `compact-${sent.length}` }; },
    editMessageSpec: async (source, id, spec, options) => { edits.push({ source, id, spec, options }); return true; },
    ...overrides
  });
  return { service, session, sent, edits };
}

function assertActivity(spec: MessageSpec, expected: string[]) {
  assert.equal(spec.presentation, "activity");
  assert.deepEqual(spec.actions, []);
  const blocks = renderSlackMessageSpec("slack:T:C", spec, null);
  const text = expected.length > 1 ? `${expected[0]} ·\n${expected.slice(1).join("\n")}` : expected[0];
  assert.deepEqual(blocks, [{
    type: "context", elements: [{ type: "plain_text", text, emoji: false }]
  }]);
  const telegram = renderTelegramMessageSpec(spec);
  assert.equal(telegram.markdown, `<footer>${expected.join("<br>")}</footer>`);
  assert.equal(telegram.html, expected.join("\n"));
}

test("manual compact replies use subdued activity without Help", async (t) => {
  const { service } = await harness(t);
  assertActivity(await service.compactActiveSession("chat"), [
    "Compact started · /workspace/project", "Triggered by you"
  ]);
});

test("manual and auto-recovery Compact request immediate Working updates", async t => {
  const statuses: Array<{ label: string; immediate: boolean | undefined }> = [];
  const { service, session } = await harness(t, true, {
    getLastUserInput: () => "Continue",
    setSessionStatus: async (_session, label, update) => { statuses.push({ label, immediate: update?.immediate }); }
  });
  await service.compactSession(session);
  await service.handleIncompatibleHistoryError(session, "Incompatible history");
  assert.deepEqual(statuses, [
    { label: "Compacting", immediate: true }, { label: "Compacting", immediate: true }
  ]);
});

test("compact notifications keep source, recovery details and quiet delivery without Help", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  for (const [source, label] of [["runtime", "Codex"], ["bridge-auto", "Bridge"], ["manual", "you"]] as const) {
    const { service, session, sent, edits } = await harness(t);
    await service.notifyCompactStarted(session, source, { reason: "incompatible history", next: "retrying once" });
    t.mock.timers.tick(102_000);
    await service.notifyCompactCompleted(session, { next: "Retrying last message" });
    assert.equal(sent.length, 1);
    assertActivity(sent[0]!.spec, ["Compact started · /workspace/project", `Triggered by ${label}`,
      "Reason: incompatible history", "Next: retrying once"]);
    assert.equal(edits.length, 1);
    assert.equal(edits[0]!.id, "compact-1");
    assertActivity(edits[0]!.spec, ["Compact completed · /workspace/project", `Triggered by ${label}`,
      "Reason: incompatible history", "Elapsed 1m 42s", "Next: Retrying last message"]);
    assert.ok(sent.every(({ options }) => options?.disable_notification === true));
    assert.ok(edits.every(({ options }) => options?.disable_notification === true));
  }
});

test("completion without a start and historical compaction use the same button-free activity style", async (t) => {
  const { service, session, sent } = await harness(t);
  await service.notifyCompactCompleted(session);
  assertActivity(sent[0]!.spec, ["Compact completed · /workspace/project"]);
  assertActivity(createThreadHistoryEntrySpec({
    directory: "/workspace/project", entry: { kind: "compaction", itemId: "item", turnId: "turn" }
  }), ["Compact completed · /workspace/project"]);
});

test("compact errors retain the ordinary error presentation", async (t) => {
  const { service } = await harness(t, false);
  const spec = await service.compactActiveSession("chat");
  assert.equal(spec.kind, "error");
  assert.equal(spec.presentation, undefined);
  assert.equal(spec.title, "Codex error · /workspace/project");
});

test("manual Compact retains its receipt and duplicate events neither add blocks nor reset elapsed time", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const f = await harness(t);
  const reply = await f.service.compactSession(f.session);
  await f.service.deliverResult("chat", reply, async () => assert.fail("shared Compact send owns the receipt"));
  await f.service.notifyCompactStarted(f.session, "runtime");
  t.mock.timers.tick(5_000);
  await f.service.notifyCompactCompleted(f.session);
  t.mock.timers.tick(50_000);
  await f.service.notifyCompactCompleted(f.session);
  await f.service.deliverResult("chat", reply, async () => assert.fail("no obsolete start"));
  assert.equal(f.sent.length, 1); assert.equal(f.edits.length, 1);
  assertActivity(f.edits[0]!.spec, ["Compact completed · /workspace/project", "Triggered by you", "Elapsed 5s"]);
  await f.service.notifyCompactStarted(f.session, "runtime");
  t.mock.timers.tick(2_000);
  await f.service.notifyCompactCompleted(f.session);
  assert.equal(f.sent.length, 2); assert.equal(f.edits[1]!.id, "compact-2");
  assertActivity(f.edits[1]!.spec, ["Compact completed · /workspace/project", "Triggered by Codex", "Elapsed 2s"]);
});

test("completion during the manual RPC cannot be followed by an obsolete started block", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const client = {
    startCompactThread: async () => {},
    resumeThread: async () => ({ displayPath: null, messages: [] }), sendTurn: async () => {}
  };
  const fast = await harness(t, true, { codexClient: client });
  client.startCompactThread = async () => { t.mock.timers.tick(3_000); await fast.service.notifyCompactCompleted(fast.session); };
  const reply = await fast.service.compactSession(fast.session);
  await fast.service.deliverResult("chat", reply, async () => assert.fail("no obsolete start"));
  assert.equal(fast.sent.length, 1); assert.equal(fast.edits.length, 0);
  assertActivity(fast.sent[0]!.spec, ["Compact completed · /workspace/project", "Triggered by you", "Elapsed 3s"]);
});

test("completion waits for the original start receipt before editing it", async t => {
  let release!: () => void, sending!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { sending = resolve; });
  const f = await harness(t, true, { sendMessageSpec: async () => { sending(); await blocked; return { message_id: "in-flight" }; } });
  const start = f.service.notifyCompactStarted(f.session, "runtime");
  await entered;
  const finish = f.service.notifyCompactCompleted(f.session);
  release(); await Promise.all([start, finish]);
  assert.equal(f.edits.length, 1); assert.equal(f.edits[0]!.id, "in-flight");
});

test("unknown first-send outcomes are not duplicated at completion", async t => {
  let sends = 0;
  const f = await harness(t, true, { sendMessageSpec: async () => { sends++; return null; } });
  await f.service.notifyCompactStarted(f.session, "runtime");
  await f.service.notifyCompactCompleted(f.session);
  assert.equal(sends, 1); assert.equal(f.edits.length, 0);
});

test("only a confirmed missing Compact block is replaced", async t => {
  for (const missing of [false, true]) {
    const f = await harness(t, true, { editMessageSpec: async () => {
      throw missing ? { error_code: 400, description: "message to edit not found" } : new Error("connection lost");
    } });
    await f.service.notifyCompactStarted(f.session, "runtime");
    await f.service.notifyCompactCompleted(f.session);
    assert.equal(f.sent.length, missing ? 2 : 1);
    if (missing) assert.equal(f.sent[1]!.spec.kind, "compact-completed");
  }
});

test("a retryable completion edit retains its original duration and never resends the start", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let attempts = 0;
  let boundaries = 0;
  const f = await harness(t, true, {
    appendWorkflowMessage: async (_session, operation) => { boundaries++; return operation(); },
    editMessageSpec: async (_source, id, spec) => {
    attempts++;
    if (attempts === 1) throw new Error("network unavailable");
    assert.equal(id, "compact-1");
    assertActivity(spec, ["Compact completed · /workspace/project", "Triggered by Codex", "Elapsed 5s"]);
    return true;
  } });
  await f.service.notifyCompactStarted(f.session, "runtime");
  t.mock.timers.tick(5_000);
  await f.service.notifyCompactCompleted(f.session);
  t.mock.timers.tick(30_000);
  await f.service.notifyCompactCompleted(f.session);
  assert.equal(attempts, 2); assert.equal(f.sent.length, 1);
  assert.equal(boundaries, 2, "a delivery retry cannot split a later workflow phase");
});

test("Compact receipts from another source are never edited with the current source", async t => {
  const f = await harness(t);
  await f.service.notifyCompactStarted(f.session, "runtime");
  await f.service.notifyCompactCompleted({ ...f.session, telegramChatId: "other-chat" });
  assert.equal(f.sent.length, 2); assert.equal(f.edits.length, 0);
});
