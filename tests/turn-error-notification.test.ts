import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import { extractErrorEvent, extractTurnLifecycleEvent } from "../src/codex/notification-events.js";
import { BridgeStore } from "../src/store/index.js";
import { testConfig } from "./bridge-test-config.js";

type Notification = { method: string; params: Record<string, unknown> };

async function harness(t: test.TestContext, options: { failNoticeOnce?: boolean; autoCompact?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-turn-error-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const sends: string[] = [];
  const edits: string[] = [];
  const codexCalls: string[] = [];
  const service = new BridgeService({
    ...testConfig(join(directory, "bridge.sqlite")),
    codexAutoCompactOnIncompatibleHistory: options.autoCompact ?? false
  }, store, {
    listQueuedSubmissions: async () => [],
    sendTurn: async () => { codexCalls.push("sendTurn"); return "recovery-turn"; },
    startCompactThread: async () => { codexCalls.push("compact"); }
  } as unknown as CodexAppServerClient);
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chat, text) => {
      if (options.failNoticeOnce && /^Codex error/.test(text)) {
        options.failNoticeOnce = false;
        throw new Error("temporary delivery failure");
      }
      sends.push(text);
      return { message_id: String(sends.length) };
    },
    editMessageText: async (_chat, _id, text) => { edits.push(text); return true; },
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  });
  const session = await store.upsertDiscoveredSession({
    telegramChatId: "chat",
    codexThreadId: "thread",
    pathKey: "/workspace/project",
    currentCwd: "/workspace/project"
  });
  await store.setActiveSession("chat", session.id);
  const internal = service as unknown as {
    handleAppServerNotification(notification: Notification): Promise<void>;
    goShortcutService: { cancel(threadId: string): void };
  };
  t.after(async () => {
    internal.goShortcutService.cancel("thread");
    await service.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const send = (notification: Notification) => internal.handleAppServerNotification(notification);
  const start = (id = "turn") => send({
    method: "turn/started", params: { threadId: "thread", turn: { id, status: "inProgress" } }
  });
  const finish = (message?: string, id = "turn", status = "interrupted") => send({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id, status, error: message ? { message } : null } }
  });
  const error = (message: string, turnId = "turn", willRetry = false) => send({
    method: "error", params: { threadId: "thread", turnId, error: { message }, willRetry }
  });
  return { store, sends, edits, codexCalls, send, start, finish, error };
}

test("terminal reasons extract only human-readable error messages and retain turn identity", () => {
  const event = extractTurnLifecycleEvent({
    method: "turn/completed",
    params: { threadId: "thread", turn: {
      id: "turn", status: "interrupted", error: { message: "Approval denied", codexErrorInfo: "tooManyDenials" }
    } }
  });
  assert.deepEqual(event, {
    threadId: "thread", turnId: "turn", kind: "completed", terminalState: "interrupted", error: "Approval denied"
  });
  for (const error of [null, {}, { message: "  " }, { codexErrorInfo: "tooManyDenials" }]) {
    const result = extractTurnLifecycleEvent({
      method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted", error } }
    });
    assert.equal(result?.error, undefined);
  }
  assert.equal(extractErrorEvent({
    method: "error", params: { threadId: "thread", turnId: "turn", error: { message: "Denied" }, willRetry: false }
  })?.turnId, "turn");
});

test("interrupted terminal reason is visible without converting Run into failed or changing reported counts", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.send({ method: "item/started", params: {
    threadId: "thread", turnId: "turn",
    item: { id: "command", type: "commandExecution", command: "yarn check", status: "inProgress" }
  } });
  const phase = h.store.getActiveProgressPhaseMessage("thread", "turn");
  assert.ok(phase);
  await h.error("Too many approval denials");
  await h.finish("Too many approval denials");
  const closed = h.store.getProgressPhaseMessage(phase.id);
  assert.equal(closed?.state, "interrupted");
  assert.deepEqual(closed?.aggregate.run, phase.aggregate.run);
  assert.equal(h.sends.filter((text) => text.includes("Too many approval denials")).length, 1);
  assert.doesNotMatch(h.edits.at(-1) ?? "", /Recovering/);
  assert.equal(h.store.getActiveTurnRoute("thread"), null);
});

test("terminal without a reason creates no error message", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.finish();
  assert.equal(h.sends.filter((text) => /^Codex error/.test(text)).length, 0);
});

test("independent and terminal errors are deduplicated in either order, including duplicate terminals", async (t) => {
  const h = await harness(t);
  await h.start("first");
  await h.error("Denied", "first");
  await h.error("Denied", "first");
  await h.finish("Denied", "first");
  await h.finish("Denied", "first");
  assert.equal(h.sends.filter((text) => text.includes("Denied")).length, 1);

  await h.start("second");
  await h.finish("Denied", "second");
  const beforeLateError = [...h.edits];
  await h.error("Denied", "second");
  assert.deepEqual(h.edits, beforeLateError);
  assert.equal(h.sends.filter((text) => text.includes("Denied")).length, 2);
});

test("different reasons are retained and retry-only errors do not consume the final notice", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.error("Connection failed", "turn", true);
  await h.finish("Connection failed");
  await h.error("Additional reason");
  assert.equal(h.sends.filter((text) => text.includes("Connection failed")).length, 1);
  assert.equal(h.sends.filter((text) => text.includes("Additional reason")).length, 1);
  assert.doesNotMatch(h.edits.at(-1) ?? "", /Recovering/);
});

test("late errors from an older turn cannot change or notify the current turn", async (t) => {
  const h = await harness(t);
  await h.start("old");
  await h.start("new");
  const before = { sends: [...h.sends], edits: [...h.edits] };
  await h.finish("Old terminal reason", "old");
  await h.error("Old independent reason", "old");
  assert.deepEqual(h.sends, before.sends);
  assert.deepEqual(h.edits, before.edits);
  assert.equal(h.store.getActiveTurnRoute("thread")?.turnId, "new");
});

test("terminal reason without an observed start is delivered", async (t) => {
  const h = await harness(t);
  await h.finish("Missing start notification");
  await h.finish("Next turn also missing start", "next-turn");
  assert.equal(h.sends.filter((text) => text.includes("Missing start notification")).length, 1);
  assert.equal(h.sends.filter((text) => text.includes("Next turn also missing start")).length, 1);
});

test("late duplicate errors stay deduplicated after a newer turn has also finished", async (t) => {
  const h = await harness(t);
  await h.start("old");
  await h.finish("Denied", "old");
  await h.start("new");
  await h.finish("New reason", "new");
  const before = { sends: [...h.sends], edits: [...h.edits] };
  await h.error("Denied", "old");
  await h.finish("Denied", "old");
  assert.deepEqual(h.sends, before.sends);
  assert.deepEqual(h.edits, before.edits);
});

test("terminal reasons cannot start automatic recovery even when history recovery is enabled", async (t) => {
  const h = await harness(t, { autoCompact: true });
  await h.start();
  await h.finish("incompatible history", "turn", "failed");
  assert.equal(h.sends.filter((text) => text.includes("incompatible history")).length, 1);
  assert.deepEqual(h.codexCalls, []);
  assert.equal(h.store.getActiveTurnRoute("thread"), null);
});

test("a failed notice does not block terminal cleanup and a duplicate can retry delivery", async (t) => {
  const h = await harness(t, { failNoticeOnce: true });
  await h.start();
  await h.finish("Denied");
  assert.equal(h.store.getActiveTurnRoute("thread"), null);
  assert.equal(h.sends.filter((text) => text.includes("Denied")).length, 0);
  await h.finish("Denied");
  assert.equal(h.sends.filter((text) => text.includes("Denied")).length, 1);
});

test("legacy errors without turn IDs deduplicate against the current turn's terminal reason", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.send({ method: "error", params: { threadId: "thread", error: { message: "Denied" } } });
  await h.finish("Denied");
  await h.send({ method: "error", params: { threadId: "thread", error: { message: "Denied" } } });
  assert.equal(h.sends.filter((text) => text.includes("Denied")).length, 1);
});

test("a completed turn is not reclassified as an error by inconsistent error metadata", async (t) => {
  const h = await harness(t);
  await h.start();
  await h.finish("Not a terminal failure", "turn", "completed");
  assert.equal(h.sends.filter((text) => text.includes("Not a terminal failure")).length, 0);
});
