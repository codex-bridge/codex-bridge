import assert from "node:assert/strict";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { NotificationPreviewBacklog } from "../src/bridge/notifications/preview-backlog.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { AppServerInteractionRequest, AppServerNotification, CodexAppServerClient } from "../src/codex/client.js";
import { logger } from "../src/logging/logger.js";
import type { KeyedQueue } from "../src/shared/keyed-queue.js";
import { BridgeStore } from "../src/store/index.js";
import { testConfig } from "./bridge-test-config.js";

logger.configureOutput({ console: "none", file: false });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function progress(id: string, kind = "run", completed = false, failed = false,
  threadId = "thread", turnId: string | undefined = "turn"): AppServerNotification {
  return { method: completed ? "item/completed" : "item/started", params: { threadId, turnId,
    item: { id, type: kind === "run" ? "commandExecution" : "mcpToolCall",
      ...(kind === "run" ? { command: `echo ${id}` } : { server: "demo", tool: `lookup_${id}` }),
      status: failed ? "failed" : completed ? "completed" : "inProgress",
      ...(failed ? { exitCode: 1, output: "Timed out", error: { message: "Timed out" } } : {}) } } };
}

type Write = { source: string; id: string; spec: MessageSpec; edit: boolean };

async function harness(t: test.TestContext) {
  const store = new BridgeStore(":memory:");
  let notify!: (notification: AppServerNotification) => void;
  let approval!: (request: AppServerInteractionRequest) => void;
  let input!: (request: AppServerInteractionRequest) => void;
  const bridge = new BridgeService(testConfig(":memory:"), store, {
    onNotification: (listener: typeof notify) => { notify = listener; return () => {}; },
    onApprovalRequest: (listener: typeof approval) => { approval = listener; return () => {}; },
    onUserInputRequest: (listener: typeof input) => { input = listener; return () => {}; },
    listQueuedSubmissions: async () => [], isApprovalPending: () => true,
    readUserInputRequest: () => ({ questions: [{ id: "q", header: "Question", question: "Choose", isOther: true, isSecret: false }] })
  } as unknown as CodexAppServerClient);
  const internal = bridge as unknown as {
    attachCodexListeners(): void;
    detachCodexListeners(): void;
    notificationQueue: KeyedQueue;
    notificationSessionIdByThread: Map<string, string>;
    handleAppServerNotification(notification: AppServerNotification): Promise<void>;
  };
  const writes: Write[] = [];
  let onWrite: (write: Write) => Promise<boolean> = async () => true;
  let next = 0;
  bridge.registerMessageTransport({ name: "test", wholeMessageSpecs: true, canHandle: () => true,
    sendMessageSpec: async (source, spec) => {
      const write = { source, spec, id: String(++next), edit: false }; writes.push(write);
      return await onWrite(write) ? { message_id: write.id } : null;
    },
    editMessageSpec: async (source, id, spec) => {
      const write = { source, spec, id, edit: true }; writes.push(write); return onWrite(write);
    },
    sendMessage: async () => assert.fail("structured transport"), editMessageText: async () => assert.fail("structured transport"),
    deleteMessage: async () => true, clearMessageActions: async () => true, sendTyping: async () => {} });
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/workspace/project" });
  await store.setActiveSession("chat", session.id); store.claimSession(session.id, "chat");
  internal.notificationSessionIdByThread.set("thread", session.id);
  await internal.handleAppServerNotification({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", status: "inProgress" } } });
  internal.attachCodexListeners();
  const holds: ReturnType<typeof gate>[] = [];
  const hold = () => { const blocked = gate(); holds.push(blocked); return blocked; };
  t.after(async () => {
    for (const blocked of holds) blocked.release();
    internal.detachCodexListeners(); await internal.notificationQueue.drain(); await bridge.shutdown(); store.close();
  });
  const block = () => {
    const blocked = hold();
    const queued = internal.notificationQueue.run("thread", () => blocked.promise);
    return async () => { blocked.release(); await queued; await internal.notificationQueue.drain(); };
  };
  return { bridge, store, session, internal, writes, block, hold,
    notify: (notification: AppServerNotification) => notify(notification),
    approval: (request: AppServerInteractionRequest, userInput = false) => userInput ? input(request) : approval(request),
    setWrite: (handler: typeof onWrite) => { onWrite = handler; },
    drain: () => internal.notificationQueue.drain(),
    latest: () => store.getLatestProgressPhaseMessage("thread", "turn")!,
    progressWrites: () => writes.filter(w => ["progress", "failed", "edited"].includes(w.spec.kind)) };
}

test("a queued burst creates its first block, shows its latest content and aggregates every event", async t => {
  const f = await harness(t), release = f.block();
  for (let n = 0; n < 50; n++) f.notify(progress(`command-${n}`, "run", true));
  await release();
  const phase = f.latest(), writes = f.progressWrites();
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.edit, false); assert.match(renderLegacyMessage(writes[0]!.spec), /echo command-0/);
  assert.equal(writes[1]!.edit, true); assert.equal(writes[1]!.id, writes[0]!.id);
  assert.match(renderLegacyMessage(writes[1]!.spec), /echo command-49/);
  assert.equal(phase.aggregate.eventCount, 50); assert.equal(phase.aggregate.items?.length, 50);
  assert.equal(phase.aggregate.run.succeeded, 50); assert.equal(phase.aggregate.run.updates, 1);
  f.notify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  await f.drain();
  assert.equal(f.latest().state, "phase_complete");
  assert.match(renderLegacyMessage(f.progressWrites().at(-1)!.spec), /Run ×2 · Succeeded ×2/);
});

test("an in-flight creation finishes before coalesced edits, while another thread remains independent", async t => {
  const f = await harness(t), sending = gate(), blocked = f.hold();
  f.setWrite(async w => {
    if (!w.edit && w.source === "chat" && w.spec.kind === "progress") { sending.release(); await blocked.promise; }
    return true;
  });
  f.notify(progress("first")); await sending.promise;
  for (let n = 0; n < 20; n++) f.notify(progress(`queued-${n}`));
  const other = await f.store.upsertDiscoveredSession({ telegramChatId: "other-chat", codexThreadId: "other", pathKey: "/other" });
  await f.store.setActiveSession("other-chat", other.id); f.store.claimSession(other.id, "other-chat");
  f.internal.notificationSessionIdByThread.set("other", other.id);
  f.notify({ method: "turn/started", params: { threadId: "other", turn: { id: "other-turn", status: "inProgress" } } });
  f.notify(progress("independent", "run", false, false, "other", "other-turn"));
  await f.internal.notificationQueue.run("other", async () => {});
  assert.ok(f.writes.some(w => w.source === "other-chat" && w.spec.kind === "progress"));
  assert.equal(f.progressWrites().filter(w => w.source === "chat").length, 1);
  blocked.release(); await f.drain();
  const writes = f.progressWrites().filter(w => w.source === "chat");
  assert.equal(writes.length, 2); assert.equal(writes[0]!.id, writes[1]!.id);
  assert.match(renderLegacyMessage(writes[1]!.spec), /queued-19/);
  assert.equal(f.latest().aggregate.items?.length, 21);
});

test("coalesced Called previews retain ordered operations and start/completion identity", async t => {
  const f = await harness(t), release = f.block();
  for (let n = 0; n < 15; n++) {
    f.notify(progress(`tool-${n}`, "called")); f.notify(progress(`tool-${n}`, "called", true));
  }
  await release();
  assert.equal(f.progressWrites().length, 2);
  assert.deepEqual(f.latest().aggregate.operations,
    Array.from({ length: 15 }, (_, n) => ({ name: `demo.lookup_tool-${n}`, count: 1 })));
  assert.equal(f.latest().aggregate.eventCount, 30);
});

test("type changes and failures preserve blocks, reasons and later same-type work", async t => {
  const f = await harness(t), release = f.block();
  f.notify(progress("a", "called")); f.notify(progress("b", "called"));
  f.notify(progress("before-failure")); f.notify(progress("failed", "run", true, true));
  f.notify(progress("after-failure")); f.notify(progress("last"));
  await release();
  const phases = f.store.listActiveProgressPhaseMessages();
  assert.equal(phases.length, 1); assert.equal(f.latest().phaseSeq, 3);
  const records = f.progressWrites().filter(w => !w.edit);
  assert.equal(records.length, 3);
  const failedWrite = f.progressWrites().find(w => w.spec.kind === "failed")!;
  assert.ok(failedWrite); assert.match(renderLegacyMessage(failedWrite.spec), /timeout/i);
  assert.ok(f.progressWrites().some(w => /Failed ×1/.test(renderLegacyMessage(w.spec))));
  assert.equal(f.latest().state, "active"); assert.equal(f.latest().aggregate.items?.length, 2);
  assert.match(renderLegacyMessage(f.progressWrites().at(-1)!.spec), /echo last/);
});

for (const boundary of ["assistant", "compact", "warning", "approval", "input"] as const) {
  test(`${boundary} preserves the last preview before it and creates a new block afterwards`, async t => {
    const f = await harness(t), release = f.block();
    f.notify(progress("before-1")); f.notify(progress("before-2"));
    if (boundary === "assistant") f.notify({ method: "item/completed", params: { threadId: "thread", turnId: "turn",
      item: { id: "answer", type: "agentMessage", text: "Still working", phase: "commentary" } } });
    if (boundary === "compact") f.notify({ method: "item/started", params: { threadId: "thread", turnId: "turn",
      item: { id: "compact", type: "contextCompaction" } } });
    if (boundary === "warning") f.notify({ method: "warning", params: { threadId: "thread", message: "Public warning" } });
    if (boundary === "approval" || boundary === "input") f.approval({
      requestId: "request", threadId: "thread", turnId: "turn", itemId: "approval",
      method: boundary === "input" ? "item/tool/requestUserInput" : "item/commandExecution/requestApproval",
      title: "Choose", summary: "Review", requestedFields: [], elicitationMode: null,
      requiresUserInput: boundary === "input", availableDecisions: null
    } as AppServerInteractionRequest, boundary === "input");
    f.notify(progress("after-1")); f.notify(progress("after-2"));
    await release();
    const previews = f.progressWrites();
    assert.equal(previews.filter(w => !w.edit).length, 2);
    assert.equal(f.latest().phaseSeq, 2);
    assert.ok(previews.some(w => /echo before-2/.test(renderLegacyMessage(w.spec))));
    assert.match(renderLegacyMessage(previews.at(-1)!.spec), /echo after-2/);
    const firstId = previews[0]!.id, lastOld = f.writes.findLastIndex(w => w.id === firstId);
    const newBlock = f.writes.findIndex(w => w.spec.kind === "progress" && !w.edit && w.id !== firstId);
    assert.ok(lastOld < newBlock - 1, "the standalone boundary is delivered between the blocks");
  });
}

test("reasoning deltas are consumed once and retain their complete summary", async t => {
  const f = await harness(t), release = f.block();
  for (const delta of ["First ", "second ", "third"]) f.notify({ method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread", turnId: "turn", itemId: "reason", summaryIndex: 0, delta } });
  f.notify({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "reason", type: "reasoning", summary: [] } } });
  await release();
  assert.equal(f.latest().phaseKind, "thinking");
  assert.deepEqual(f.latest().aggregate.activities?.[0]?.lines, ["First second third"]);
  assert.equal(f.latest().aggregate.activities?.[0]?.terminal, true);
  assert.match(renderLegacyMessage(f.progressWrites().at(-1)!.spec), /First second third/);
});

test("failed preview edits never increment Run display counts or replace a known block", async t => {
  const f = await harness(t), release = f.block();
  f.setWrite(async w => !w.edit);
  for (let n = 0; n < 8; n++) f.notify(progress(`command-${n}`));
  await release();
  assert.equal(f.progressWrites().length, 2);
  assert.equal(f.progressWrites().filter(w => !w.edit).length, 1);
  assert.equal(f.latest().aggregate.items?.length, 8); assert.equal(f.latest().aggregate.run.updates, 0);
});

test("a duplicate or late original result cannot swallow the latest meaningful preview", async t => {
  const f = await harness(t);
  f.notify(progress("old", "run", true)); await f.drain();
  const original = f.latest();
  f.notify(progress("boundary", "called")); await f.drain();
  let release = f.block();
  f.notify(progress("new-1")); f.notify(progress("new-2"));
  f.notify(progress("old", "run", true));
  await release();
  assert.match(renderLegacyMessage(f.progressWrites().at(-1)!.spec), /echo new-2/);
  assert.equal(f.latest().phaseSeq, 3); assert.equal(f.latest().aggregate.run.updates, 1);
  assert.equal(f.store.getProgressPhaseMessage(original.id)?.aggregate.eventCount, 1);
  // A duplicate terminal result on the active phase is also a no-op.
  f.notify(progress("terminal", "run", true)); await f.drain();
  release = f.block();
  f.notify(progress("new-3")); f.notify(progress("new-4"));
  f.notify(progress("terminal", "run", true));
  await release();
  assert.match(renderLegacyMessage(f.progressWrites().at(-1)!.spec), /echo new-4/);
  assert.equal(f.latest().aggregate.items?.length, 5);
});

test("Edited coalescing keeps every operation and ordered file line count in the final summary", async t => {
  const f = await harness(t), release = f.block();
  for (let n = 0; n < 12; n++) f.notify({ method: "item/completed", params: { threadId: "thread", turnId: "turn",
    item: { id: `edit-${n}`, type: "fileChange", status: "completed", changes: [
      { path: `/workspace/project/file-${n}.ts`, kind: { type: "add" }, diff: "first\nsecond\n" }
    ] } } });
  await release();
  assert.equal(f.progressWrites().length, 2); assert.equal(f.latest().aggregate.fileEdits?.length, 12);
  assert.deepEqual(f.latest().aggregate.fileEdits?.map(edit => [edit.files[0]!.path, edit.files[0]!.added]),
    Array.from({ length: 12 }, (_, n) => [`/workspace/project/file-${n}.ts`, 2]));
  f.notify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  await f.drain();
  const summary = renderLegacyMessage(f.progressWrites().at(-1)!.spec);
  assert.ok(summary.indexOf("file-0.ts (+2 -0)") < summary.indexOf("file-11.ts (+2 -0)"));
});

test("ordinary unqueued progress still updates immediately", async t => {
  const f = await harness(t);
  for (let n = 0; n < 4; n++) { f.notify(progress(`single-${n}`)); await f.drain(); }
  assert.equal(f.progressWrites().length, 4); assert.equal(f.latest().aggregate.run.updates, 3);
});

test("missing turn identity cannot coalesce, and reset cannot cross listener generations", () => {
  const backlog = new NotificationPreviewBacklog();
  const missing = progress("missing"); (missing.params as { turnId?: string }).turnId = undefined;
  const first = backlog.track("thread", progress("first"));
  const unidentified = backlog.track("thread", missing);
  backlog.track("thread", progress("third"));
  assert.deepEqual(first(), {}); assert.deepEqual(unidentified(), {});
  const beforeReset = backlog.track("thread", progress("old"));
  backlog.reset(); backlog.track("thread", progress("new"));
  assert.deepEqual(beforeReset(), {});
  const otherTurn = backlog.track("thread", progress("other-turn", "run", false, false, "thread", "other"));
  backlog.track("thread", progress("new-turn")); assert.deepEqual(otherTurn(), {});
});

test("global notices and per-thread interaction barriers preserve queued previews", () => {
  const backlog = new NotificationPreviewBacklog();
  const first = backlog.track("thread", progress("first"));
  backlog.boundary("thread"); backlog.track("thread", progress("second")); assert.deepEqual(first(), {});
  const latest = backlog.track("thread", progress("latest"));
  backlog.track("global", { method: "configWarning", params: { summary: "Public warning" } });
  backlog.track("thread", progress("last")); assert.deepEqual(latest(), {});
});
