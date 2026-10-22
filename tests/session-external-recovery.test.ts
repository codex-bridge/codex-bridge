import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { ExternalSessionRecoveryService } from "../src/bridge/sessions/external-recovery.js";
import { SessionBindingService } from "../src/bridge/sessions/binding.js";
import { SessionActivationError } from "../src/bridge/sessions/ownership.js";

async function fixture(t: TestContext) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "chat", codexThreadId: "external",
    pathKey: "/work/rollout.jsonl", currentCwd: "/work" });
  const lease = store.markSessionExternalUnknown(session.id);
  const state = { connected: true, busy: false, activity: "idle", activityType: "completed",
    reads: 0, resumes: 0, readError: null as Error | null, resumeError: null as Error | null,
    wait: async () => {}, resumeWait: async () => {} };
  const recovery = new ExternalSessionRecoveryService({ store,
    codexClient: {
      readThreadStatus: async () => {
        state.reads++; await state.wait();
        if (state.readError) throw state.readError;
        return { activity: state.activity, activityType: state.activityType } as never;
      },
      resumeThread: async () => {
        state.resumes++;
        await state.resumeWait();
        if (state.resumeError) throw state.resumeError;
        return { messages: [] } as never;
      }
    }, isRuntimeConnected: () => state.connected, canReadThreadStatus: () => true,
    isBusy: () => state.busy, getSessionDirectory: () => "/work",
    isActiveWriterConflictError: (error) => error instanceof Error && error.message.includes("active writer")
  });
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(),
    getSessionDirectory: () => "/work", notify: async () => {},
    recoverExternalSession: (value) => recovery.recover(value) });
  return { store, session, lease, state, recovery, binding };
}

for (const activityType of ["completed", "notLoaded", "idle"]) {
  test(`external recovery requires a real resume for ${activityType}`, async (t) => {
    const { store, session, state, recovery, lease } = await fixture(t);
    state.activityType = activityType;
    assert.equal(await recovery.recover(session), lease.version + 1);
    assert.equal(state.resumes, 1);
    assert.equal(store.getSessionLease(session.id)?.state, "unbound");
  });
}

test("active writer conflict retains the lease and next action can retry", async (t) => {
  const { store, session, state, recovery, lease } = await fixture(t);
  state.resumeError = new Error("thread already has an active writer");
  assert.equal(await recovery.recover(session), null);
  assert.equal(store.getSessionLease(session.id)?.version, lease.version);
  state.resumeError = null;
  assert.equal(await recovery.recover(session), lease.version + 1);
  assert.equal(state.resumes, 2);
});

for (const phase of ["readError", "resumeError"] as const) {
  test(`external recovery preserves ${phase} instead of inventing occupancy`, async (t) => {
    const { store, session, state, recovery, lease } = await fixture(t);
    state[phase] = new Error("authentication unavailable");
    await assert.rejects(recovery.recover(session), (error: unknown) =>
      error instanceof SessionActivationError && /authentication unavailable/.test(error.message));
    assert.equal(store.getSessionLease(session.id)?.version, lease.version);
  });
}

test("disconnected recovery reports the runtime problem without a resume", async (t) => {
  const { session, state, recovery } = await fixture(t);
  state.connected = false;
  await assert.rejects(recovery.recover(session), /runtime is disconnected/);
  assert.equal(state.resumes, 0);
});

for (const activity of ["running", "unknown"]) {
  test(`external recovery does not resume or clear a ${activity} session`, async (t) => {
    const { store, session, state, recovery, lease } = await fixture(t);
    state.activity = activity;
    assert.equal(await recovery.recover(session), null);
    assert.equal(state.resumes, 0);
    assert.equal(store.getSessionLease(session.id)?.version, lease.version);
  });
}

test("concurrent recovery calls share one read and one resume", async (t) => {
  const { session, state, recovery, lease } = await fixture(t);
  const results = await Promise.all([recovery.recover(session), recovery.recover(session)]);
  assert.deepEqual(results, [lease.version + 1, lease.version + 1]);
  assert.equal(state.reads, 1);
  assert.equal(state.resumes, 1);
});

test("a newer lease fences an older recovery probe", async (t) => {
  const { store, session, state, recovery } = await fixture(t);
  let finish!: () => void;
  state.wait = () => new Promise<void>((resolve) => { finish = resolve; });
  const pending = recovery.recover(session);
  const newer = store.markSessionExternalUnknown(session.id);
  finish();
  assert.equal(await pending, null);
  assert.equal(state.resumes, 0);
  assert.equal(store.getSessionLease(session.id)?.version, newer.version);
});

test("external marker compare-and-swap rejects stale versions", async (t) => {
  const { store, session, lease } = await fixture(t);
  store.markSessionExternalUnknown(session.id);
  assert.equal(store.clearSessionExternalUnknown(session.id, lease.version), false);
  assert.equal(store.getSessionLease(session.id)?.state, "external_unknown");
});

test("a lease changed while resume waits cannot be cleared", async (t) => {
  const { store, session, state, recovery } = await fixture(t);
  let newerVersion = 0;
  state.resumeWait = async () => { newerVersion = store.markSessionExternalUnknown(session.id).version; };
  assert.equal(await recovery.recover(session), null);
  assert.equal(state.resumes, 1);
  assert.equal(store.getSessionLease(session.id)?.version, newerVersion);
  assert.equal(store.getSessionLease(session.id)?.state, "external_unknown");
});

test("busy Bridge work prevents recovery", async (t) => {
  const { session, state, recovery } = await fixture(t);
  state.busy = true;
  assert.equal(await recovery.recover(session), null);
  assert.equal(state.reads, 0);
});

test("explicit Web binding recovers and advances only its observed lease", async (t) => {
  const { store, session, state, binding, lease } = await fixture(t);
  const result = await binding.request("web:local", session.id, lease.version, () => {}, { select: false });
  assert.equal(result.outcome?.owned, true);
  assert.equal(state.resumes, 1);
  assert.equal(store.getSessionBindingById(store.getSessionLease(session.id)!.ownerBindingId!)?.sourceId, "web:local");
});

test("stale binding requests never probe or claim", async (t) => {
  const { session, state, binding, lease } = await fixture(t);
  assert.equal((await binding.request("web:local", session.id, lease.version - 1)).outcome?.reason, "stale");
  assert.equal(state.reads, 0);
});

test("a revoked Web window cannot claim after a recovery probe", async (t) => {
  const { store, session, state, binding, lease } = await fixture(t);
  let current = true;
  state.wait = async () => { current = false; };
  await assert.rejects(binding.request("web:local", session.id, lease.version, () => {
    if (!current) throw new Error("window revoked");
  }), /window revoked/);
  assert.equal(store.getSessionLease(session.id)?.ownerBindingId, null);
});
