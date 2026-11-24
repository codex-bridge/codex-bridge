import assert from "node:assert/strict";
import test from "node:test";
import { compareCodexVersions, parseCodexVersion, readCodexVersion, readLatestCodexVersion } from "../src/codex/version-reader.js";
import { VersionUpdateNotifier, type CodexVersionUpdate } from "../src/bridge/notifications/version-update.js";
import { GoShortcutService } from "../src/bridge/interactions/go-shortcut.js";
import type { SessionRecord } from "../src/shared/types.js";

const session = { id: "session-1", telegramChatId: "chat-1", codexThreadId: "thread-1", pathKey: "/project" } as SessionRecord;
const allowed = async () => true;

function fixture() {
  const state = { installed: "0.170.0", latest: "0.171.0", reads: 0, latestReads: 0, clears: 0, schedules: [] as number[],
    callback: null as (() => void) | null, error: null as Error | null, beforeRead: async () => {} };
  const delivered: Array<{ sourceId: string; update: CodexVersionUpdate }> = [];
  const notifier = new VersionUpdateNotifier({
    readInstalledVersion: async () => { state.reads++; await state.beforeRead(); return state.installed; },
    readLatestVersion: async () => { state.latestReads++; if (state.error) throw state.error; return state.latest; },
    deliver: async (_session, sourceId, update, canSend) => {
      if (!await canSend()) return false;
      delivered.push({ sourceId, update }); return true;
    },
    scheduleInterval: (callback, ms) => {
      state.callback = callback; state.schedules.push(ms); return { unref: () => {} } as ReturnType<typeof setInterval>;
    },
    clearScheduledInterval: () => { state.clears++; }
  });
  return { state, delivered, notifier };
}

test("Codex version reader accepts only stable numeric versions", async () => {
  assert.equal(parseCodexVersion("codex-cli 0.170.0\n"), "0.170.0");
  assert.equal(parseCodexVersion("codex-cli 0.171.0-beta.1"), null);
  assert.equal(parseCodexVersion("unexpected"), null);
  assert.equal(compareCodexVersions("0.171.0", "0.170.9"), 1);
  assert.equal(compareCodexVersions("0.170.0", "0.170.0"), 0);
  assert.equal(compareCodexVersions("0.169.9", "0.170.0"), -1);
  const calls: unknown[] = [];
  assert.equal(await readCodexVersion("codex", async (command, args) => {
    calls.push([command, args]); return { stdout: "codex-cli 0.170.0", stderr: "" };
  }), "0.170.0");
  assert.deepEqual(calls, [["codex", ["--version"]]]);
});

test("release reader checks the official package's stable tag with a bounded request", async () => {
  assert.equal(await readLatestCodexVersion(async (url, options) => {
    assert.equal(url, "https://registry.npmjs.org/@openai%2Fcodex/latest");
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ version: "0.171.0" }));
  }), "0.171.0");
  for (const version of ["0.172.0-beta.1", "v0.171.0", "not a version", null]) {
    await assert.rejects(readLatestCodexVersion(async () => new Response(JSON.stringify({ version }))), /invalid stable version/);
  }
  await assert.rejects(readLatestCodexVersion(async () => new Response("", { status: 503 })), /HTTP 503/);
  await assert.rejects(readLatestCodexVersion(async () => new Response("invalid JSON")));
  await assert.rejects(readLatestCodexVersion(async () => { throw new Error("network unavailable"); }), /network unavailable/);
});

test("startup checks immediately then every 24 hours, without stopping after a reminder", async () => {
  const f = fixture();
  await Promise.all([f.notifier.start(), f.notifier.start()]);
  assert.deepEqual(f.state.schedules, [86_400_000]);
  assert.equal(f.state.reads, 1);
  assert.deepEqual(f.delivered, []);
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), true);
  assert.equal(f.state.clears, 0);
  f.state.latest = "0.172.0";
  f.state.callback!(); await f.notifier.checkNow();
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-2", allowed), true);
  assert.deepEqual(f.delivered.map((value) => value.update.latest), ["0.171.0", "0.172.0"]);
  assert.equal(f.state.clears, 0);
  f.notifier.stop(); assert.equal(f.state.clears, 1);
});

test("only a release newer than the installed CLI is pending, including at startup", async () => {
  const f = fixture();
  for (const version of ["0.170.0", "0.169.0"]) {
    f.state.latest = version; await f.notifier.checkNow();
    assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), false);
  }
  f.state.latest = "0.171.0"; await f.notifier.checkNow();
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), true);
  assert.deepEqual(f.delivered[0]?.update, { baseline: "0.170.0", latest: "0.171.0" });
});

test("pending releases collapse; same and older releases are not repeated across sessions", async () => {
  const f = fixture();
  await f.notifier.checkNow();
  f.state.latest = "0.172.0"; await f.notifier.checkNow();
  const results = await Promise.all([f.notifier.deliverBeforeActions(session, "chat-1", allowed),
    f.notifier.deliverBeforeActions(session, "chat-2", allowed)]);
  assert.deepEqual(results.sort(), [false, true]);
  for (const version of ["0.172.0", "0.171.0"]) {
    f.state.latest = version; await f.notifier.checkNow();
    assert.equal(await f.notifier.deliverBeforeActions(session, "chat-2", allowed), false);
  }
  assert.deepEqual(f.delivered, [{ sourceId: "chat-1", update: { baseline: "0.170.0", latest: "0.172.0" } }]);
});

test("installing an available release before the next check clears a stale pending reminder", async () => {
  const f = fixture(); await f.notifier.checkNow();
  f.state.installed = "0.171.0"; await f.notifier.checkNow();
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), false);
});

test("a skipped unauthorized send remains available for another Actions", async () => {
  const f = fixture(); await f.notifier.checkNow();
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", async () => false), false);
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-2", allowed), true);
  assert.equal(f.delivered[0]?.sourceId, "chat-2");
});

test("an uncertain delivery is not replayed, while a new process may remind again", async () => {
  let attempts = 0;
  const notifier = new VersionUpdateNotifier({ readInstalledVersion: async () => "0.170.0", readLatestVersion: async () => "0.171.0",
    deliver: async (_session, _source, _update, canSend) => {
      if (!await canSend()) return false;
      attempts++; throw new Error("unknown delivery outcome");
    } });
  await notifier.checkNow();
  assert.equal(await notifier.deliverBeforeActions(session, "chat-1", allowed), false);
  await notifier.checkNow();
  assert.equal(await notifier.deliverBeforeActions(session, "chat-2", allowed), false);
  assert.equal(attempts, 1);
  const restarted = fixture(); await restarted.notifier.checkNow();
  assert.equal(await restarted.notifier.deliverBeforeActions(session, "chat-2", allowed), true);
});

test("failed checks retry on the next daily tick and checks never overlap", async () => {
  const f = fixture(); f.state.error = new Error("network unavailable"); await f.notifier.start();
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), false);
  f.state.error = null;
  let release!: () => void;
  f.state.beforeRead = () => new Promise<void>((resolve) => { release = resolve; });
  const first = f.notifier.checkNow(), second = f.notifier.checkNow();
  assert.equal(first, second); assert.equal(f.state.reads, 2);
  release(); await first;
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), true);
  f.notifier.stop();
});

test("a failed registry lookup cannot retain a reminder for a release already installed", async () => {
  const f = fixture(); await f.notifier.checkNow();
  f.state.installed = "0.171.0"; f.state.error = new Error("registry unavailable");
  await f.notifier.checkNow();
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), false);
});

test("stopping during a check discards its result and cannot arm a late timer", async () => {
  const f = fixture(); let release!: () => void;
  f.state.beforeRead = () => new Promise<void>((resolve) => { release = resolve; });
  const started = f.notifier.start(); f.notifier.stop(); release(); await started;
  assert.equal(f.state.clears, 1);
  assert.equal(await f.notifier.deliverBeforeActions(session, "chat-1", allowed), false);
});

test("a skipped queued delivery does not consume the release", async () => {
  const attempts: string[] = [];
  let permitted = true;
  const notifier = new VersionUpdateNotifier({ readInstalledVersion: async () => "0.170.0", readLatestVersion: async () => "0.171.0",
    deliver: async (_session, source, _update, canSend) => {
      if (source === "old") permitted = false;
      if (!await canSend()) return false;
      attempts.push(source); return true;
    } });
  await notifier.checkNow();
  await notifier.deliverBeforeActions(session, "old", async () => permitted);
  permitted = true;
  await notifier.deliverBeforeActions(session, "current", async () => permitted);
  assert.deepEqual(attempts, ["current"]);
});

for (const path of ["completion", "history"] as const) {
  test(`version reminder precedes ${path} Actions without waiting for a new check`, async () => {
    const f = fixture(); await f.notifier.checkNow();
    const sent: string[] = [];
    const actions = new GoShortcutService({
      store: { getSessionLease: () => null, getSessionBindingById: () => null, getActiveSession: async () => session, listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
      pendingByThread: new Map(), lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/project",
      beforeActions: async (value, source, canSend) => {
        if (await f.notifier.deliverBeforeActions(value, source, canSend)) sent.push("update");
      },
      messageOperations: { sendMessageSpec: async (_source, message) => { sent.push(message.kind); return { message_id: "actions" }; } }
    });
    if (path === "history") await actions.sendAfterTranscript(session, "chat-1"); else await actions.flush(session);
    assert.deepEqual(sent, ["update", "actions"]);
    assert.equal(f.state.reads, 1); assert.equal(f.state.latestReads, 1);
  });
}

for (const blocker of ["approval", "input", "selection", "authorization"] as const) {
  test(`${blocker} suppresses both the reminder and Actions without consuming the pending release`, async () => {
    const f = fixture(); await f.notifier.checkNow();
    let blocked = true;
    const sent: string[] = [];
    const actions = new GoShortcutService({
      store: {
        getSessionLease: () => null, getSessionBindingById: () => null,
        getActiveSession: async () => blocked && blocker === "selection" ? null : session,
        listPendingDecisions: async () => blocked && blocker === "approval" ? [{}] as never[] : [],
        getAwaitingInputDecisionForSession: async () => blocked && blocker === "input" ? {} as never : null
      },
      pendingByThread: new Map(), lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/project",
      beforeActions: async (value, source, canSend) => {
        if (await f.notifier.deliverBeforeActions(value, source, canSend)) sent.push("update");
      },
      messageOperations: { sendMessageSpec: async (_source, message) => { sent.push(message.kind); return { message_id: "actions" }; } }
    });
    const permitted = async () => !(blocked && blocker === "authorization");
    await actions.sendAfterTranscript(session, "chat-1", permitted);
    assert.deepEqual(sent, []);
    blocked = false;
    await actions.sendAfterTranscript(session, "chat-1", permitted);
    assert.deepEqual(sent, ["update", "actions"]);
  });
}

test("an in-flight background check does not hold Actions", async () => {
  const f = fixture(); let release!: () => void;
  f.state.beforeRead = () => new Promise<void>((resolve) => { release = resolve; });
  const checking = f.notifier.start();
  const sent: string[] = [];
  const actions = new GoShortcutService({
    store: { getSessionLease: () => null, getSessionBindingById: () => null, getActiveSession: async () => session,
      listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
    pendingByThread: new Map(), lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/project",
    beforeActions: (value, source, canSend) => f.notifier.deliverBeforeActions(value, source, canSend),
    messageOperations: { sendMessageSpec: async (_source, message) => { sent.push(message.kind); return { message_id: "actions" }; } }
  });
  try {
    await actions.flush(session);
    assert.deepEqual(sent, ["actions"]);
  } finally { release(); await checking; f.notifier.stop(); }
});

test("Web Actions retain ownership semantics independently of chat selection", async () => {
  const f = fixture(); await f.notifier.checkNow();
  const sent: string[] = [];
  const actions = new GoShortcutService({
    store: {
      getActiveSession: async () => null,
      getSessionLease: () => ({ state: "active", ownerBindingId: "web-binding" }) as never,
      getSessionBindingById: () => ({ sourceId: "web:local" }) as never,
      listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null
    },
    pendingByThread: new Map(), lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/project",
    beforeActions: async (value, source, canSend) => {
      if (await f.notifier.deliverBeforeActions(value, source, canSend)) sent.push(`update:${source}`);
    },
    messageOperations: { sendMessageSpec: async (source, message) => { sent.push(`${message.kind}:${source}`); return { message_id: "actions" }; } }
  });
  await actions.flush({ ...session, telegramChatId: "web:local" });
  assert.deepEqual(sent, ["update:web:local", "actions:web:local"]);
});

test("a failed reminder does not suppress Actions", async () => {
  const notifier = new VersionUpdateNotifier({ readInstalledVersion: async () => "0.170.0", readLatestVersion: async () => "0.171.0",
    deliver: async (_session, _source, _update, canSend) => {
      if (!await canSend()) return false;
      throw new Error("delivery timeout");
    } });
  await notifier.checkNow();
  const sent: string[] = [];
  const actions = new GoShortcutService({
    store: { getSessionLease: () => null, getSessionBindingById: () => null, getActiveSession: async () => session,
      listPendingDecisions: async () => [], getAwaitingInputDecisionForSession: async () => null },
    pendingByThread: new Map(), lastAssistantMessageByThread: new Map(), getSessionDirectory: () => "/project",
    beforeActions: (value, source, canSend) => notifier.deliverBeforeActions(value, source, canSend),
    messageOperations: { sendMessageSpec: async (_source, message) => { sent.push(message.kind); return { message_id: "actions" }; } }
  });
  await actions.flush(session);
  assert.deepEqual(sent, ["actions"]);
});
