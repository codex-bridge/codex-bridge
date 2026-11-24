import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { fixtureProgressService } from "./fixtures/progress-service.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";

const event = (index: number, label = "Run", failed = false) => ({ threadId: "thread", itemId: `${label}-${index}`, label,
  toolName: label === "Run" ? `command-${index}` : `tool-${index}`, action: null, target: null, input: null, changes: null,
  failed, text: failed ? "timeout" : `content-${index}`, completed: true });

async function fixture(t: test.TestContext, limited = true) {
  const store = new BridgeStore(":memory:");
  const session = await store.upsertDiscoveredSession({ telegramChatId: "telegram:-1:10", codexThreadId: "thread", pathKey: "/project" });
  const writes: Array<{ id: string; spec: MessageSpec; edit: boolean }> = [];
  const service = fixtureProgressService(store, (id, spec, edit) => writes.push({ id, spec, edit }), () => false,
    { getRefreshPolicy: () => limited ? { typingEnabled: false, progressIntervalMs: 5_000, workingIntervalMs: 20_000 } : undefined });
  t.after(async () => { await service.stop(); store.close(); });
  return { store, session, service, writes };
}

test("a burst coalesces intermediate edits while preserving event aggregates and the final summary", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 100; index++) await f.service.sendProgressMessage(f.session, event(index), "turn");
  assert.equal(f.writes.length, 1, "first creation is never skipped");
  const active = f.store.getActiveProgressPhaseMessage("thread", "turn")!;
  assert.equal(active.aggregate.eventCount, 100);
  assert.equal(active.aggregate.run.updates, 0, "undisplayed previews do not inflate Run");
  await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
  await new Promise(setImmediate);
  assert.equal(f.writes.length, 2);
  assert.match(renderLegacyMessage(f.writes[1]!.spec), /Run ×1 · Succeeded ×1/);
  assert.equal(f.store.getProgressPhaseMessage(active.id)!.deliveryState, "synced");
});

test("a trailing refresh shows the latest content and preserves its first message ID", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const f = await fixture(t);
  await f.service.sendProgressMessage(f.session, event(1), "turn");
  await f.service.sendProgressMessage(f.session, event(2), "turn");
  await f.service.sendProgressMessage(f.session, event(3), "turn");
  t.mock.timers.tick(5_000); await new Promise(setImmediate);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0]!.id, f.writes[1]!.id);
  assert.match(renderLegacyMessage(f.writes[1]!.spec), /command-3/);
  assert.equal(f.store.getActiveProgressPhaseMessage("thread", "turn")!.aggregate.run.updates, 1);
});

test("type switches and failures retain chronological blocks and never revive an old live preview", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const f = await fixture(t);
  await f.service.sendProgressMessage(f.session, event(1), "turn");
  await f.service.sendProgressMessage(f.session, event(2), "turn");
  const run = f.store.getActiveProgressPhaseMessage("thread", "turn")!;
  await f.service.sendProgressMessage(f.session, event(1, "Called"), "turn");
  await f.service.sendProgressMessage(f.session, event(2, "Called", true), "turn");
  await f.service.sendProgressMessage(f.session, event(3, "Called"), "turn");
  await new Promise(setImmediate);
  const creates = f.writes.filter(write => !write.edit);
  assert.deepEqual(creates.map(write => write.spec.title.split(" · ")[0]), ["Run", "Called", "Called"]);
  const failed = f.writes.filter(write => write.edit).map(write => renderLegacyMessage(write.spec)).find(text => text.includes("Error: timeout"));
  assert.ok(failed);
  t.mock.timers.tick(5_000); await new Promise(setImmediate);
  const runEdits = f.writes.filter(write => write.edit && write.id === creates[0]!.id);
  assert.equal(runEdits.length, 1, "only the finalized summary edits the older Run block");
  assert.match(renderLegacyMessage(runEdits[0]!.spec), /Run ×1/);
  assert.equal(f.store.getProgressPhaseMessage(run.id)!.aggregate.eventCount, 2);
});

test("the same synthetic burst workload uses less than one third of the original progress writes", async t => {
  const baseline = await fixture(t, false), limited = await fixture(t);
  for (const f of [baseline, limited]) {
    let item = 0;
    for (const label of ["Run", "Called", "Run"]) {
      for (let index = 0; index < 30; index++) await f.service.sendProgressMessage(f.session, event(item++, label), "turn");
    }
    await f.service.clearProgressMessageForThread("thread", { turnId: "turn" });
    await new Promise(setImmediate);
  }
  assert.equal(baseline.writes.filter(write => !write.edit).length, 3);
  assert.equal(limited.writes.filter(write => !write.edit).length, 3);
  assert.equal(limited.writes.length, 6, "each phase has its first block and a final summary");
  assert.ok(limited.writes.length <= baseline.writes.length / 3);
  t.diagnostic(`Synthetic burst: ${baseline.writes.length} -> ${limited.writes.length} progress writes; this is not a production reduction measurement.`);
});
