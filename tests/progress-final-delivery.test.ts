import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BridgeStore } from "../src/store/index.js";
import { PhaseDeliveryAdapter } from "../src/bridge/progress/delivery.js";
import { FinalProgressDelivery } from "../src/bridge/progress/final-delivery.js";
import { ProgressService } from "../src/bridge/progress/service.js";
import { emptyPhaseAggregate } from "../src/bridge/progress/lifecycle.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const store = new BridgeStore(":memory:");
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "thread", pathKey: "/project" });
  const edits: Array<{ chat: string; id: string; text: string }> = [];
  let edit: (id: string, spec: MessageSpec) => Promise<boolean> = async () => true;
  const delivery = new PhaseDeliveryAdapter({
    editMessageSpec: async (chat, id, spec) => { edits.push({ chat, id, text: renderLegacyMessage(spec) }); return edit(id, spec); },
    sendTemporaryMessageSpec: async () => assert.fail("final delivery must never send a new message")
  });
  const queue = new KeyedQueue();
  const makeWorker = () => new FinalProgressDelivery({
    getRecord: (id) => store.getProgressPhaseMessage(id),
    listPending: () => store.listPendingProgressPhaseFinalDelivery(),
    mark: (input) => store.markProgressPhaseMessageDeliveryState(input),
    enqueue: (key, operation) => queue.run(key, operation)
  }, delivery);
  const worker = makeWorker();
  const services: ProgressService[] = [];
  t.after(async () => {
    await worker.stop();
    for (const service of services) await service.stop();
    store.close();
  });
  const record = store.createProgressPhaseMessage({ sessionId: session.id, codexThreadId: "thread", turnId: "turn",
    phaseKind: "called", sourceId: "chat", platformMessageId: "original", directory: "/project", text: "",
    aggregate: { ...emptyPhaseAggregate(), eventCount: 1, operations: [{ name: "tool.first", count: 1 }] } });
  store.finalizeProgressPhaseMessage({ id: record.id, state: "phase_complete", deliveryState: "pending_finalization" });
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await setImmediate(); };
  const sends: string[] = [];
  const makeService = () => {
    const service = new ProgressService({
      getSessionDirectory: () => "/project",
      getInFlightTurnId: () => "live-turn",
      shouldSkipCalledProgress: () => false,
      getProgressPhaseMessage: (id) => store.getProgressPhaseMessage(id),
      getActiveProgressPhaseMessage: (...args) => store.getActiveProgressPhaseMessage(...args),
      getLatestProgressPhaseMessage: (...args) => store.getLatestProgressPhaseMessage(...args),
      getProgressPhaseMessageForFileEdit: (...args) => store.getProgressPhaseMessageForFileEdit(...args),
      updateFinalProgressPhaseAggregate: (...args) => store.updateFinalProgressPhaseAggregate(...args),
      listActiveProgressPhaseMessages: () => store.listActiveProgressPhaseMessages(),
      listPendingProgressPhaseFinalDelivery: () => store.listPendingProgressPhaseFinalDelivery(),
      createProgressPhaseMessage: (input) => store.createProgressPhaseMessage(input),
      updateActiveProgressPhaseMessage: (...args) => store.updateActiveProgressPhaseMessage(...args),
      recordSuccessfulRunContentUpdate: (id) => store.recordSuccessfulRunContentUpdate(id),
      finalizeProgressPhaseMessage: (input) => store.finalizeProgressPhaseMessage(input),
      updateFinalProgressPhaseMessageState: (input) => store.updateFinalProgressPhaseMessageState(input),
      markProgressPhaseMessageDeliveryState: (input) => store.markProgressPhaseMessageDeliveryState(input),
      editMessageSpec: async (chat, id, spec) => { edits.push({ chat, id, text: renderLegacyMessage(spec) }); return edit(id, spec); },
      sendTemporaryMessageSpec: async (_chat, spec) => {
        const text = renderLegacyMessage(spec);
        sends.push(text);
        return { messageId: `live-${sends.length}`, text };
      }
    });
    services.push(service);
    return service;
  };
  return { store, worker, makeWorker, queue, edits, id: record.id, session, tick,
    makeService, sends,
    setEdit: (fn: typeof edit) => { edit = fn; } };
}

const liveEvent = (label: string, failed = false) => ({
  threadId: "thread", label, failed, toolName: "tool.test", action: null, target: null,
  input: null, changes: null, text: failed ? "timeout" : "observed", completed: true
});

test("live finalization sends no placeholder and allows the next phase during retry backoff", async (t) => {
  const f = await fixture(t);
  f.store.markProgressPhaseMessageDeliveryState({ id: f.id, deliveryState: "synced" });
  const service = f.makeService();
  service.start();
  await service.sendProgressMessage(f.session, liveEvent("Run"));
  f.setEdit(async () => { throw new Error("timeout"); });
  await service.sendProgressMessage(f.session, liveEvent("Called"));
  assert.equal(f.sends.length, 2, "only actual Run and Called cards are sent");
  assert.doesNotMatch(f.sends.join("\n"), /Phase update pending/);
  assert.equal(f.store.getActiveProgressPhaseMessage("thread", "live-turn")?.phaseKind, "called");
  f.setEdit(async () => true);
  await f.tick(5_000);
  assert.deepEqual(f.edits.map((edit) => edit.id), ["live-1", "live-1"]);
  assert.match(f.edits[1]!.text, /Run ×1 · Reported successes ×1 · Reported failures ×0/);
  await service.stop();
});

test("a previously synced step failure is delivered again when the turn later fails", async (t) => {
  const f = await fixture(t);
  const service = f.makeService();
  await service.sendProgressMessage(f.session, liveEvent("Run", true));
  assert.equal(f.store.getLatestProgressPhaseMessage("thread", "live-turn")?.deliveryState, "synced");
  assert.match(f.edits.at(-1)!.text, /Task continued/);
  await service.clearProgressMessageForThread("thread", { turnId: "live-turn", terminal: "failed" });
  assert.equal(f.edits.length, 2);
  assert.equal(f.store.getLatestProgressPhaseMessage("thread", "live-turn")?.state, "failed");
  assert.doesNotMatch(f.edits.at(-1)!.text, /Task continued/);
});

test("service shutdown waits for live finalization as well as background retries", async (t) => {
  const f = await fixture(t);
  const service = f.makeService();
  await service.sendProgressMessage(f.session, liveEvent("Run"));
  let release!: () => void;
  f.setEdit(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
  const finalization = service.clearProgressMessageForThread("thread", { turnId: "live-turn" });
  await setImmediate();
  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  await setImmediate();
  assert.equal(stopped, false);
  release(); await finalization; await stop;
  assert.equal(f.store.getLatestProgressPhaseMessage("thread", "live-turn")?.deliveryState, "synced");
});

test("timeouts retry only the original ID with the latest stored summary, without changing task or Run counts", async (t) => {
  const f = await fixture(t);
  f.setEdit(async () => { throw new Error("request timed out"); });
  f.worker.start(); await f.tick(0);
  assert.equal(f.edits.length, 1);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "pending_finalization");
  const aggregate = { ...emptyPhaseAggregate(), eventCount: 2, operations: [{ name: "tool.latest", count: 2 }] };
  f.store.updateFinalProgressPhaseAggregate(f.id, aggregate);
  f.setEdit(async () => true);
  await f.tick(4_999); assert.equal(f.edits.length, 1);
  await f.tick(1);
  assert.deepEqual(f.edits.map((edit) => [edit.chat, edit.id]), [["chat", "original"], ["chat", "original"]]);
  assert.match(f.edits[1]!.text, /tool.latest ×2/);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "synced");
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.state, "phase_complete");
  assert.deepEqual(f.store.getProgressPhaseMessage(f.id)?.aggregate, aggregate);
  await f.tick(100_000); assert.equal(f.edits.length, 2);
});

test("persistent unknown failures stop after three retries, but a restart recovers pending delivery", async (t) => {
  const f = await fixture(t);
  f.setEdit(async () => { throw new Error("network unavailable"); });
  f.worker.start();
  for (const ms of [0, 5_000, 20_000, 60_000, 100_000]) await f.tick(ms);
  assert.equal(f.edits.length, 4);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "pending_finalization");
  await f.worker.stop();
  f.setEdit(async () => true);
  const restarted = f.makeWorker();
  try {
    restarted.start(); await f.tick(0);
    assert.equal(f.edits.length, 5);
    assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "synced");
  } finally { await restarted.stop(); }
});

test("known missing or forbidden messages stop retrying and never recover an old placeholder falsely", async (t) => {
  for (const rejection of [false, { data: { error: "message_not_found" } }, { error_code: 403 }]) {
    await t.test(String(JSON.stringify(rejection)), async (t) => {
      const f = await fixture(t);
      f.store.markProgressPhaseMessageDeliveryState({ id: f.id, deliveryState: "correction_sent", correctionMessageId: "old-notice" });
      f.setEdit(async () => { if (rejection === false) return false; throw rejection; });
      f.worker.start(); await f.tick(0); await f.tick(100_000);
      assert.deepEqual(f.edits.map((edit) => edit.id), ["original"]);
      assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "unavailable");
      assert.deepEqual(f.store.listPendingProgressPhaseFinalDelivery(), []);
      f.store.updateFinalProgressPhaseAggregate(f.id, emptyPhaseAggregate());
      await f.worker.retryPending();
      assert.equal(f.edits.length, 1, "late data must not revive a permanently unavailable destination");
    });
  }
});

test("legacy correction messages are updated only after the original summary succeeds", async (t) => {
  const f = await fixture(t);
  f.store.markProgressPhaseMessageDeliveryState({ id: f.id, deliveryState: "correction_sent", correctionMessageId: "old-notice" });
  f.setEdit(async () => { throw new Error("timeout"); });
  f.worker.start(); await f.tick(0);
  assert.deepEqual(f.edits.map((edit) => edit.id), ["original"]);
  f.setEdit(async (id) => { if (id === "old-notice") throw new Error("timeout"); return true; });
  await f.tick(5_000);
  assert.deepEqual(f.edits.map((edit) => edit.id), ["original", "original", "old-notice"]);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "synced");
  assert.equal(f.store.listPendingProgressPhaseFinalDelivery().length, 1);
  f.setEdit(async () => true);
  await f.tick(20_000);
  assert.equal(f.edits.at(-1)?.id, "old-notice", "a synced original is not repeatedly edited");
  assert.match(f.edits.at(-1)!.text, /^System · \/project\nProgress summary synced\.$/);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.correctionMessageId, null);
  assert.deepEqual(f.store.listPendingProgressPhaseFinalDelivery(), []);
});

test("startup also resolves legacy placeholders left behind after an earlier successful original edit", async (t) => {
  const f = await fixture(t);
  f.store.markProgressPhaseMessageDeliveryState({ id: f.id, deliveryState: "synced", correctionMessageId: "old-notice" });
  f.worker.start(); await f.tick(0);
  assert.deepEqual(f.edits.map((edit) => edit.id), ["old-notice"]);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.correctionMessageId, null);
});

test("a deleted legacy notice cannot disable later updates to the original summary", async (t) => {
  const f = await fixture(t);
  f.store.markProgressPhaseMessageDeliveryState({ id: f.id, deliveryState: "correction_sent", correctionMessageId: "old-notice" });
  f.setEdit(async (id) => id !== "old-notice");
  f.worker.start(); await f.tick(0);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "synced");
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.correctionMessageId, null);
  f.store.updateFinalProgressPhaseAggregate(f.id, emptyPhaseAggregate());
  await f.worker.retryPending();
  assert.deepEqual(f.edits.map((edit) => edit.id), ["original", "old-notice", "original"]);
});

test("queued retries re-read the record after late updates and concurrent flushes do not duplicate edits", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const blocked = f.queue.run("thread:turn", () => new Promise<void>((resolve) => { release = resolve; }));
  await setImmediate();
  f.worker.start(); await f.tick(0);
  const flush = f.worker.retryPending();
  f.store.updateFinalProgressPhaseAggregate(f.id, { ...emptyPhaseAggregate(), eventCount: 1, operations: [{ name: "late", count: 1 }] });
  release(); await blocked; await flush; await setImmediate();
  assert.equal(f.edits.length, 1);
  assert.match(f.edits[0]!.text, /late ×1/);
});

test("stopping cancels scheduled retries and waits for an in-flight edit before storage closes", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.setEdit(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
  f.worker.start(); await f.tick(0);
  let stopped = false;
  const stop = f.worker.stop().then(() => { stopped = true; });
  await setImmediate(); assert.equal(stopped, false);
  release(); await stop;
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "synced");
  await f.tick(100_000); assert.equal(f.edits.length, 1);
});

test("stopping during backoff cancels future retries", async (t) => {
  const f = await fixture(t);
  f.setEdit(async () => { throw new Error("timeout"); });
  f.worker.start(); await f.tick(0);
  await f.worker.stop();
  await f.tick(100_000);
  assert.equal(f.edits.length, 1);
  assert.equal(f.store.getProgressPhaseMessage(f.id)?.deliveryState, "pending_finalization");
});

test("phase editing distinguishes uncertain transport errors, native rejections and Telegram's unchanged acknowledgement", async () => {
  const spec = createMessage({ scope: "global", kind: "system", body: [] });
  for (const [error, expected] of [
    [new Error("timeout"), "retryable"],
    [{ error_code: 429 }, "retryable"], [{ error_code: 500 }, "retryable"],
    [{ data: { error: "ratelimited" } }, "retryable"],
    [{ data: { error: "internal_error" } }, "retryable"],
    [{ data: { error: "request_timeout" } }, "retryable"],
    [{ data: { error: "unknown_upstream_error" } }, "retryable"],
    [{ data: { error: "cant_update_message" } }, "unavailable"],
    [{ error_code: 400, description: "Bad Request: message to edit not found" }, "unavailable"],
    [{ error_code: 400, description: "Bad Request: message is not modified" }, "synced"]
  ] as const) {
    const delivery = new PhaseDeliveryAdapter({ editMessageSpec: async () => { throw error; },
      sendTemporaryMessageSpec: async () => assert.fail("unexpected send") });
    assert.equal(await delivery.editResult("chat", "id", spec), expected);
  }
});
