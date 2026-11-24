import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { fixtureProgressService } from "./fixtures/progress-service.js";
import { telegramRefreshPolicy } from "../src/telegram/delivery-budget.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";

const event = (id: string | undefined, label = "Run", completed = true, failed = false) => ({ threadId: "thread", itemId: id,
  label, completed, failed, text: failed ? "timeout" : "observed", toolName: label === "Called" ? "tools.inspect" : "command",
  action: null, target: null, input: null, changes: null });

async function fixture(t: test.TestContext, failSend = false) {
  const store = new BridgeStore(":memory:");
  const session = await store.upsertDiscoveredSession({ telegramChatId: "telegram:-1:10", codexThreadId: "thread", pathKey: "/project" });
  const writes: Array<{ id: string; text: string; edit: boolean }> = [];
  const service = fixtureProgressService(store, (id, spec, edit) => {
    writes.push({ id, text: renderLegacyMessage(spec), edit });
    if (failSend && !edit) throw new Error("unknown send outcome");
  }, () => false, { getRefreshPolicy: () => telegramRefreshPolicy });
  t.after(async () => { await service.stop(); store.close(); });
  return { store, session, service, writes };
}

test("summary-only aggregates silently and sends each phase once in chronological order", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 20; index++) {
    await f.service.sendProgressMessage(f.session, event(String(index), "Run", false), "turn");
    await f.service.sendProgressMessage(f.session, event(String(index)), "turn");
  }
  assert.equal(f.writes.length, 0);
  const phase = f.store.getActiveProgressPhaseMessage("thread", "turn")!;
  assert.equal(phase.platformMessageId, null); assert.equal(phase.deliveryState, "unsent");
  await f.service.sendProgressMessage(f.session, event("called", "Called"), "turn");
  assert.equal(f.writes.length, 1); assert.match(f.writes[0]!.text, /Run ×20 · Succeeded ×20/);
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  assert.equal(f.writes.length, 2); assert.match(f.writes[1]!.text, /Called/);
  assert.ok(f.writes.every(write => !write.edit));
  assert.equal(f.store.getProgressPhaseMessage(phase.id)!.deliveryState, "synced");
});

test("failed steps form their own final boundary and new actions retain history", async t => {
  const f = await fixture(t);
  await f.service.sendProgressMessage(f.session, event("one"), "turn");
  await f.service.sendProgressMessage(f.session, event("two", "Run", true, true), "turn");
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0]!.text, /Run ×2 · Succeeded ×1 · Failed ×1\nReason: timeout/);
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
