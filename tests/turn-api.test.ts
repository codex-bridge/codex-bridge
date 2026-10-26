import assert from "node:assert/strict";
import test from "node:test";

import { CodexTurnApi, type TurnApiDependencies } from "../src/codex/turn-api.js";
import { CodexThreadApi } from "../src/codex/thread-api.js";
import type { CodexConfigSnapshot } from "../src/codex/config-snapshot.js";

const snapshot: CodexConfigSnapshot = {
  cwd: "/project",
  model: "gpt-5.6",
  modelProvider: "openai",
  reasoningEffort: "high",
  reasoningSummary: null,
  approvalPolicy: "auto-review",
  approvalsReviewer: null,
  sandboxPolicy: null,
  serviceTier: null,
  personality: null,
  origins: {},
  layerVersions: []
};

function turnFixture(overrides: Partial<TurnApiDependencies> = {}) {
  const calls: string[] = [];
  const api = new CodexTurnApi({
    connect: async () => {}, getObservedThreadSettings: () => undefined,
    readCodexConfigSnapshot: async () => snapshot,
    readLoadedThreadsStatus: async () => null,
    resumeThread: async () => { calls.push("resume"); },
    request: async (method) => { calls.push(method); return { turn: { id: "turn" } }; },
    requestKnownMethod: async () => ({}), onTurnStartBeginning: () => {}, onTurnStarted: () => {},
    onTurnStartFinished: () => {}, updateObservedThreadSettingsAfterStart: () => {}, ...overrides
  });
  return { api, calls };
}

test("a loaded empty thread starts its first turn without trying to resume a nonexistent rollout", async () => {
  const f = turnFixture({ readLoadedThreadsStatus: async (id) => {
    assert.equal(id, "new-thread");
    return { total: 1, activeLoaded: true };
  }, resumeThread: async () => { assert.fail("an empty loaded thread has no rollout to resume"); } });
  assert.deepEqual(await f.api.sendTurn("new-thread", "hello", "/project"), { turnId: "turn" });
  assert.deepEqual(f.calls, ["turn/start"]);
});

test("send preparation checks fresh loaded state rather than remembered settings", async () => {
  let loaded: boolean | null = true;
  const f = turnFixture({ getObservedThreadSettings: () => ({ model: "remembered" } as never),
    readLoadedThreadsStatus: async () => loaded === null ? null : { total: Number(loaded), activeLoaded: loaded } });
  for (const state of [true, false, null]) {
    loaded = state;
    f.calls.length = 0;
    await f.api.sendTurn("thread", "hello", "/project");
    assert.deepEqual(f.calls, state === true ? ["turn/start"] : ["resume", "turn/start"]);
  }
});

test("revocation during the loaded-state read prevents both resume and dispatch", async () => {
  for (const activeLoaded of [true, false]) {
    let revoked = false;
    const f = turnFixture({ readLoadedThreadsStatus: async () => {
      revoked = true;
      return { total: Number(activeLoaded), activeLoaded };
    } });
    await assert.rejects(f.api.sendTurn("thread", "hello", "/project", {
      assertCurrent: () => { if (revoked) throw new Error("revoked"); }
    }), /revoked/);
    assert.deepEqual(f.calls, []);
  }
});

test("failed preparation or dispatch is never retried or replaced by a new thread", async () => {
  for (const activeLoaded of [true, false]) {
    const calls: string[] = [];
    const f = turnFixture({ readLoadedThreadsStatus: async () => ({ total: Number(activeLoaded), activeLoaded }),
      resumeThread: async () => { calls.push("resume"); throw new Error("missing thread"); },
      request: async (method) => { calls.push(method); throw new Error("dispatch outcome unknown"); } });
    await assert.rejects(f.api.sendTurn("thread", "hello", "/project"),
      activeLoaded ? /dispatch outcome unknown/ : /missing thread/);
    assert.deepEqual(calls, [activeLoaded ? "turn/start" : "resume"]);
  }
});

test("guarded sends recheck after configuration, resume connection and resume response", async () => {
  for (const revokeAt of ["config", "resume-connect", "resume-response", "steer-connect"] as const) {
    const calls: string[] = [];
    let revoked = false;
    const guard = (): void => { if (revoked) throw new Error("revoked"); };
    const thread = new CodexThreadApi({ connect: async () => { if (revokeAt === "resume-connect") revoked = true; },
      getObservedThreadSettings: () => undefined, isUnknownMethodError: () => false, rememberThreadSettings: () => {},
      requestKnownMethod: async () => ({}), request: async (method) => {
        calls.push(method); if (revokeAt === "resume-response") revoked = true; return {};
      } });
    const api = new CodexTurnApi({
      connect: async () => { if (revokeAt === "steer-connect") revoked = true; },
      readCodexConfigSnapshot: async () => { if (revokeAt === "config") revoked = true; return snapshot; },
      readLoadedThreadsStatus: async () => null,
      resumeThread: (id, cwd, check) => thread.resumeThread(id, cwd, check), getObservedThreadSettings: () => undefined,
      request: async (method) => { calls.push(method); return {}; },
      requestKnownMethod: async (method) => { calls.push(method); return {}; },
      onTurnStartBeginning: () => {}, onTurnStarted: () => {}, onTurnStartFinished: () => {},
      updateObservedThreadSettingsAfterStart: () => {}
    });
    await assert.rejects(revokeAt === "steer-connect" ? api.steerTurn("thread", "turn", "hello", undefined, guard)
      : api.sendTurn("thread", "hello", "/project", { assertCurrent: guard }), /revoked/);
    assert.deepEqual(calls, revokeAt === "resume-response" ? ["thread/resume"] : []);
  }
});

test("thread unsubscribe accepts every documented terminal status and rejects invalid responses", async () => {
  for (const status of ["notLoaded", "notSubscribed", "unsubscribed"] as const) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const thread = new CodexThreadApi({
      connect: async () => {},
      getObservedThreadSettings: () => undefined,
      isUnknownMethodError: () => false,
      rememberThreadSettings: () => {},
      request: async () => ({}),
      requestKnownMethod: async (method, params) => {
        calls.push({ method, params });
        return { status };
      }
    });

    assert.equal(await thread.unsubscribeThread("thread"), status);
    assert.deepEqual(calls, [{ method: "thread/unsubscribe", params: { threadId: "thread" } }]);
  }

  const invalid = new CodexThreadApi({
    connect: async () => {},
    getObservedThreadSettings: () => undefined,
    isUnknownMethodError: () => false,
    rememberThreadSettings: () => {},
    request: async () => ({}),
    requestKnownMethod: async () => ({ status: "unknown" })
  });
  await assert.rejects(invalid.unsubscribeThread("thread"), /invalid status/);
});

test("a dispatched start still records its result after a window takeover; it is not retried", async () => {
  let revoked = false;
  const calls: string[] = [];
  const api = new CodexTurnApi({ connect: async () => {}, getObservedThreadSettings: () => undefined,
    readCodexConfigSnapshot: async () => snapshot, resumeThread: async () => {},
    readLoadedThreadsStatus: async () => null,
    request: async (method) => { calls.push(method); revoked = true; return { turn: { id: "accepted-turn" } }; },
    requestKnownMethod: async () => ({}), onTurnStartBeginning: () => {},
    onTurnStarted: (id) => { calls.push(id); }, onTurnStartFinished: () => {}, updateObservedThreadSettingsAfterStart: () => {} });
  assert.deepEqual(await api.sendTurn("thread", "hello", "/project", { assertCurrent: () => { if (revoked) throw new Error("revoked"); } }), { turnId: "accepted-turn" });
  assert.deepEqual(calls, ["turn/start", "accepted-turn"]);
});

test("turn start delegates runtime state transitions without owning the state", async () => {
  const calls: string[] = [];
  const observed = { serviceTier: "previous", serviceTierKnown: true };
  const api = new CodexTurnApi({
    connect: async () => { calls.push("connect"); },
    getObservedThreadSettings: () => observed as never,
    readCodexConfigSnapshot: async () => snapshot,
    readLoadedThreadsStatus: async () => null,
    resumeThread: async () => { calls.push("resume"); },
    request: async (method, params) => {
      calls.push(method);
      assert.deepEqual(params, {
        threadId: "thread",
        input: [{ type: "text", text: "hello" }],
        cwd: "/project",
        model: "gpt-5.6",
        effort: "high",
        approvalPolicy: "auto-review"
      });
      return { turn: { id: "turn", serviceTier: "priority" } };
    },
    requestKnownMethod: async () => ({}),
    onTurnStartBeginning: () => { calls.push("begin"); },
    onTurnStarted: (turnId) => { calls.push(`started:${turnId}`); },
    onTurnStartFinished: () => { calls.push("finished"); },
    updateObservedThreadSettingsAfterStart: (_threadId, receivedObserved, result) => {
      calls.push("settings");
      assert.equal(receivedObserved, observed);
      assert.deepEqual(result, { turn: { id: "turn", serviceTier: "priority" } });
    }
  });

  assert.deepEqual(await api.sendTurn("thread", "hello", "/project"), { turnId: "turn" });
  assert.deepEqual(calls, [
    "connect",
    "resume",
    "begin",
    "turn/start",
    "started:turn",
    "finished",
    "settings"
  ]);
});

test("turn start passes its timeout through resume and dispatch", async () => {
  const calls: Array<{ step: string; timeoutMs: number | undefined }> = [];
  const api = new CodexTurnApi({
    connect: async () => {},
    getObservedThreadSettings: () => undefined,
    readCodexConfigSnapshot: async () => snapshot,
    readLoadedThreadsStatus: async () => null,
    resumeThread: async (_threadId, _cwd, _assertCurrent, timeoutMs) => {
      calls.push({ step: "resume", timeoutMs });
    },
    request: async (method, _params, options) => {
      calls.push({ step: method, timeoutMs: options?.timeoutMs });
      return { turn: { id: "turn" } };
    },
    requestKnownMethod: async () => ({}),
    onTurnStartBeginning: () => {},
    onTurnStarted: () => {},
    onTurnStartFinished: () => {},
    updateObservedThreadSettingsAfterStart: () => {}
  });

  await api.sendTurn("thread", "hello", "/project", { timeoutMs: 30_000 });
  assert.deepEqual(calls, [
    { step: "resume", timeoutMs: 30_000 },
    { step: "turn/start", timeoutMs: 30_000 }
  ]);
});

test("turn interrupt preserves optional turn id request shape", async () => {
  const requests: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
  const api = new CodexTurnApi({
    connect: async () => {},
    getObservedThreadSettings: () => undefined,
    readCodexConfigSnapshot: async () => snapshot,
    readLoadedThreadsStatus: async () => null,
    resumeThread: async () => {},
    request: async (method, params, options) => {
      requests.push({ method, params, timeoutMs: options?.timeoutMs });
      return {};
    },
    requestKnownMethod: async () => ({}),
    onTurnStartBeginning: () => {},
    onTurnStarted: () => {},
    onTurnStartFinished: () => {},
    updateObservedThreadSettingsAfterStart: () => {}
  });

  await api.interruptThread("thread");
  await api.interruptThread("thread", "turn");
  assert.deepEqual(requests, [
    { method: "turn/interrupt", params: { threadId: "thread" }, timeoutMs: 5_000 },
    { method: "turn/interrupt", params: { threadId: "thread", turnId: "turn" }, timeoutMs: 5_000 }
  ]);
});

test("turn steer uses expectedTurnId and returns the server turn id", async () => {
  let request: unknown;
  let timeoutMs: number | undefined;
  const api = new CodexTurnApi({
    connect: async () => {},
    getObservedThreadSettings: () => undefined,
    readCodexConfigSnapshot: async () => snapshot,
    readLoadedThreadsStatus: async () => null,
    resumeThread: async () => {},
    request: async () => ({}),
    requestKnownMethod: async (_method, params, options) => {
      request = params;
      timeoutMs = options?.timeoutMs;
      return { turn: { id: "replacement" } };
    },
    onTurnStartBeginning: () => {},
    onTurnStarted: () => {},
    onTurnStartFinished: () => {},
    updateObservedThreadSettingsAfterStart: () => {}
  });

  assert.deepEqual(await api.steerTurn("thread", "active", "continue", undefined, undefined, 30_000),
    { turnId: "replacement" });
  assert.equal(timeoutMs, 30_000);
  assert.deepEqual(request, {
    threadId: "thread",
    expectedTurnId: "active",
    input: [{ type: "text", text: "continue" }]
  });

  assert.deepEqual(await api.steerTurn("thread", "active", "inspect", [
    { type: "text", text: "inspect" },
    { type: "localImage", path: "/tmp/image.png" }
  ]), { turnId: "replacement" });
  assert.deepEqual(request, {
    threadId: "thread",
    expectedTurnId: "active",
    input: [
      { type: "text", text: "inspect" },
      { type: "localImage", path: "/tmp/image.png" }
    ]
  });
});
