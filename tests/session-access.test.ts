import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { SessionAccessError, SessionAccessService } from "../src/bridge/sessions/access.js";
import type { SessionLeaseState } from "../src/shared/types.js";
import { BridgeStore } from "../src/store/index.js";

async function fixture(t: TestContext) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({
    telegramChatId: "123", codexThreadId: "thread", pathKey: "/work"
  });
  return { store, session, access: new SessionAccessService(store) };
}

test("session access never claims an unbound session or creates a binding", async (t) => {
  const { store, session, access } = await fixture(t);
  const lease = store.getSessionLease(session.id);
  const bindings = store.listSessionBindings(session.id);
  await assert.rejects(access.requireOwned("thread", "web:local", undefined, () => {}),
    new SessionAccessError("not_owner"));
  assert.deepEqual(store.getSessionLease(session.id), lease);
  assert.deepEqual(store.listSessionBindings(session.id), bindings);
  assert.equal(await store.getActiveSession("web:local"), null);
  assert.deepEqual(await store.listChatIds(), ["123"]);
});

test("only the current owner can read, including when an application is pending", async (t) => {
  const { store, session, access } = await fixture(t);
  store.claimSession(session.id, "123");
  store.requestSessionHandoff(session.id, "web:local", false);
  const lease = store.getSessionLease(session.id);
  await assert.rejects(access.requireOwned("thread", "web:local", undefined, () => {}),
    new SessionAccessError("not_owner"));
  const owner = await access.requireOwned("thread", "123", lease!.version, () => {});
  owner.assertCurrent();
  assert.equal(owner.session.id, session.id);
  assert.equal(owner.leaseVersion, lease!.version);
  assert.deepEqual(store.getSessionLease(session.id), lease);
});

test("access rejects stale snapshots and guards a transfer away and back", async (t) => {
  const { store, session, access } = await fixture(t);
  const lease = store.claimSession(session.id, "web:local").lease;
  await assert.rejects(access.requireOwned("thread", "web:local", lease.version - 1, () => {}),
    new SessionAccessError("stale"));
  const snapshot = await access.requireOwned("thread", "web:local", undefined, () => {});
  store.requestSessionHandoff(session.id, "123", true);
  store.requestSessionHandoff(session.id, "web:local", true);
  assert.throws(() => snapshot.assertCurrent(), new SessionAccessError("stale"));
});

test("missing, archived and unavailable lease states cannot expose conversation", async (t) => {
  const { store, session, access } = await fixture(t);
  await assert.rejects(access.requireOwned("missing", "web:local", undefined, () => {}),
    new SessionAccessError("unavailable"));
  const lease = store.claimSession(session.id, "web:local").lease;
  for (const state of ["releasing", "external_unknown", "archived", "deleted"] satisfies SessionLeaseState[]) {
    const guarded = new SessionAccessService({
      getSessionByThreadId: (id) => store.getSessionByThreadId(id),
      getSessionBinding: (id, source) => store.getSessionBinding(id, source),
      getSessionLease: () => ({ ...lease, state })
    });
    await assert.rejects(guarded.requireOwned("thread", "web:local", undefined, () => {}),
      new SessionAccessError("unavailable"));
  }
  await store.markSessionCodexArchived(session.id);
  await assert.rejects(access.requireOwned("thread", "web:local", undefined, () => {}),
    new SessionAccessError("unavailable"));
});

test("window credentials are rechecked after resolving a session and on final delivery", async (t) => {
  const { store, session } = await fixture(t);
  store.claimSession(session.id, "web:local");
  let revoked = false;
  const guard = () => { if (revoked) throw new Error("revoked"); };
  const slow = new SessionAccessService({
    getSessionByThreadId: async (id) => { revoked = true; return store.getSessionByThreadId(id); },
    getSessionBinding: (id, source) => store.getSessionBinding(id, source),
    getSessionLease: (id) => store.getSessionLease(id)
  });
  await assert.rejects(slow.requireOwned("thread", "web:local", undefined, guard), /revoked/);
  revoked = false;
  const snapshot = await new SessionAccessService(store).requireOwned("thread", "web:local", undefined, guard);
  revoked = true;
  assert.throws(() => snapshot.assertCurrent(), /revoked/);
});
