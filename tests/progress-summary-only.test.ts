import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { fixtureProgressService } from "./fixtures/progress-service.js";
import { telegramRefreshPolicy } from "../src/telegram/delivery-budget.js";
import type { MessageRefreshPolicy } from "../src/bridge/transport.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";

const event = (id: string | undefined, label = "Run", completed = true, failed = false) => ({ threadId: "thread", itemId: id,
  label, completed, failed, text: failed ? "timeout" : "observed", toolName: label === "Called" ? "tools.inspect" : "command",
  action: null, target: null, input: null, changes: null });
const hiddenRunPolicy: MessageRefreshPolicy = { ...telegramRefreshPolicy, hiddenPhaseKinds: ["run"] };

async function fixture(t: test.TestContext, failSend = false, policy: MessageRefreshPolicy = {
  typingEnabled: false, workingIntervalMs: 20_000, progressMode: "summary"
}, waitForBackgroundRefresh?: () => Promise<boolean>) {
  const store = new BridgeStore(":memory:");
  const session = await store.upsertDiscoveredSession({ telegramChatId: "telegram:-1:10", codexThreadId: "thread", pathKey: "/project" });
  const writes: Array<{ id: string; text: string; edit: boolean }> = [];
  const service = fixtureProgressService(store, (id, spec, edit) => {
    writes.push({ id, text: renderLegacyMessage(spec), edit });
    if (failSend && !edit) throw new Error("unknown send outcome");
  }, () => false, { getRefreshPolicy: () => policy, waitForBackgroundRefresh });
  t.after(async () => { await service.stop(); store.close(); });
  return { store, session, service, writes };
}

test("summary-only aggregates silently and sends each phase once in chronological order", async t => {
  const f = await fixture(t, false, telegramRefreshPolicy);
  for (let index = 0; index < 20; index++) {
    await f.service.sendProgressMessage(f.session, event(String(index), "Run", false), "turn");
    await f.service.sendProgressMessage(f.session, event(String(index)), "turn");
  }
  assert.equal(f.writes.length, 0);
  const phase = f.store.getActiveProgressPhaseMessage("thread", "turn")!;
  assert.equal(phase.platformMessageId, null); assert.equal(phase.deliveryState, "unsent");
  await f.service.sendProgressMessage(f.session, event("called", "Called"), "turn");
  assert.equal(f.writes.length, 1); assert.match(f.writes[0]!.text, /Run ×20 · Succeeded ×20/);
  assert.equal(f.writes[0]!.text, "Run · /project\nRun ×20 · Succeeded ×20");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.equal(f.writes.length, 2); assert.match(f.writes[1]!.text, /Called/);
  assert.ok(f.writes.every(write => !write.edit));
  assert.equal(f.store.getProgressPhaseMessage(phase.id)!.deliveryState, "synced");
});

test("failed steps form their own final boundary and new actions retain history", async t => {
  const f = await fixture(t, false, telegramRefreshPolicy);
  await f.service.sendProgressMessage(f.session, event("one"), "turn");
  await f.service.sendProgressMessage(f.session, event("two", "Run", true, true), "turn");
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]!.text, "Run · /project\nRun ×2 · Succeeded ×1 · Failed ×1");
  await f.service.sendProgressMessage(f.session, event("three"), "turn");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.equal(f.writes.length, 2); assert.match(f.writes[1]!.text, /Run ×1 · Succeeded ×1/);
});

test("missing upstream execution identity does not produce an invented count", async t => {
  const f = await fixture(t);
  await f.service.sendProgressMessage(f.session, event(undefined), "turn");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.match(f.writes[0]!.text, /Execution count unavailable/);
  assert.doesNotMatch(f.writes[0]!.text, /Run ×|Succeeded ×/);
});

test("a first-send unknown outcome cannot be resent by a late result or final-delivery retry", async t => {
  const f = await fixture(t, true);
  await f.service.sendProgressMessage(f.session, event("one", "Run", false), "turn");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  const phase = f.store.getLatestProgressPhaseMessage("thread", "turn")!;
  assert.equal(phase.deliveryState, "send_unknown");
  await f.service.sendProgressMessage(f.session, event("one"), "turn");
  await f.service.retryPendingFinalDeliveries(); await new Promise(setImmediate);
  assert.equal(f.writes.length, 1);
  assert.equal(f.store.getProgressPhaseMessage(phase.id)!.deliveryState, "send_unknown");
});

test("new chronological messages follow the final summary of the phase they close", async t => {
  const f = await fixture(t);
  const claim = f.store.claimSession(f.session.id, f.session.telegramChatId);
  f.store.recordTurnRoute({ turnId: "turn", sessionId: f.session.id, codexThreadId: "thread", bindingId: claim.binding.id, sourceId: f.session.telegramChatId });
  await f.service.sendProgressMessage(f.session, event("one"), "turn");
  await f.service.appendWorkflowMessage(f.session, async () => { f.writes.push({ id: "reply", text: "Assistant reply", edit: false }); });
  assert.match(f.writes[0]!.text, /Run ×1/); assert.equal(f.writes[1]!.text, "Assistant reply");
});

test("explicitly hidden Run summaries retain counts, failures and phase boundaries", async t => {
  const f = await fixture(t, false, hiddenRunPolicy);
  await f.service.sendProgressMessage(f.session, event("one"), "turn");
  await f.service.sendProgressMessage(f.session, event("two", "Run", true, true), "turn");
  const failed = f.store.getLatestProgressPhaseMessage("thread", "turn")!;
  assert.equal(failed.deliveryState, "suppressed");
  assert.equal(failed.state, "step_failed");
  assert.deepEqual(failed.aggregate.run, { updates: 0, succeeded: 1, failed: 1 });
  await f.service.sendProgressMessage(f.session, event("three", "Run", false), "turn");
  await f.service.sendProgressMessage(f.session, event("called", "Called"), "turn");
  const called = f.store.getActiveProgressPhaseMessage("thread", "turn")!;
  await f.service.sendProgressMessage(f.session, event("three"), "turn");
  await f.service.sendProgressMessage(f.session, event("edit", "Edited"), "turn");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn", terminal: "failed" });
  await f.service.retryPendingFinalDeliveries(); await new Promise(setImmediate);
  assert.equal(f.writes.length, 2);
  assert.match(f.writes[0]!.text, /^Called/);
  assert.match(f.writes[1]!.text, /^Edited/);
  assert.ok(f.writes.every(write => !write.edit && !/^Run/.test(write.text)));
  assert.equal(called.phaseSeq, 3, "hidden runs retain chronological phase boundaries");
  assert.equal(f.store.getProgressPhaseMessage(failed.id)!.deliveryState, "suppressed");
  assert.equal(f.store.listPendingProgressPhaseFinalDelivery().length, 0);
});

test("late failures cannot revive or consume background admission for a suppressed Run", async t => {
  let admissions = 0;
  const f = await fixture(t, false, hiddenRunPolicy, async () => { admissions++; return true; });
  await f.service.sendProgressMessage(f.session, event("run", "Run", false), "turn");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  const run = f.store.getLatestProgressPhaseMessage("thread", "turn")!;
  assert.equal(run.deliveryState, "suppressed");
  await f.service.sendProgressMessage(f.session, event("run", "Run", true, true), "turn");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn", terminal: "failed" });
  await f.service.retryPendingFinalDeliveries(); await new Promise(setImmediate);
  const updated = f.store.getProgressPhaseMessage(run.id)!;
  assert.equal(updated.deliveryState, "suppressed");
  assert.equal(updated.state, "failed");
  assert.equal(updated.aggregate.run.failed, 1);
  assert.equal(admissions, 0);
  assert.deepEqual(f.writes, []);
});

test("restart recovery suppresses older pending Run sends instead of publishing them", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, false, hiddenRunPolicy);
  await f.service.sendProgressMessage(f.session, event("run"), "turn");
  const run = f.store.getActiveProgressPhaseMessage("thread", "turn")!;
  await f.service.stop();
  f.store.finalizeProgressPhaseMessage({ id: run.id, state: "phase_complete", deliveryState: "pending_finalization" });
  f.service.start(); t.mock.timers.tick(0); await new Promise(setImmediate);
  await f.service.retryPendingFinalDeliveries();
  assert.equal(f.store.getProgressPhaseMessage(run.id)!.deliveryState, "suppressed");
  assert.deepEqual(f.writes, []);
  assert.equal(f.store.listPendingProgressPhaseFinalDelivery().length, 0);
});

test("previously suppressed Run history stays hidden when Telegram resumes statistics", async t => {
  let policy: MessageRefreshPolicy = hiddenRunPolicy;
  const f = await fixture(t, false, policy);
  await f.service.sendProgressMessage(f.session, event("old"), "turn");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  const old = f.store.getLatestProgressPhaseMessage("thread", "turn")!;
  assert.equal(old.deliveryState, "suppressed");
  policy = telegramRefreshPolicy;
  const resumed = fixtureProgressService(f.store, (_id, spec, edit) => {
    f.writes.push({ id: "resumed", text: renderLegacyMessage(spec), edit });
  }, () => false, { getRefreshPolicy: () => policy });
  t.after(() => resumed.stop());
  await resumed.sendProgressMessage(f.session, event("old", "Run", true, true), "turn");
  await resumed.retryPendingFinalDeliveries();
  assert.equal(f.store.getProgressPhaseMessage(old.id)!.deliveryState, "suppressed");
  assert.deepEqual(f.writes, []);
  await resumed.sendProgressMessage(f.session, event("new"), "next-turn");
  await resumed.clearProgressMessageForThread("thread", { turnId: "next-turn" });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]!.text, "Run · /project\nRun ×1 · Succeeded ×1");
});
