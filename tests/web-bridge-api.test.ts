import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { SessionCatalogService } from "../src/bridge/sessions/catalog.js";
import type { ListedCodexThread } from "../src/codex/thread-list-api.js";
import { BridgeStore } from "../src/store/index.js";
import { LocalWebBridgeApi, WebSendError } from "../src/web/bridge-api.js";
import { IncomingTurnService } from "../src/bridge/input/turn.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { SessionBindingService, type SessionBindingEvent } from "../src/bridge/sessions/binding.js";
import { SessionAccessError, SessionAccessService } from "../src/bridge/sessions/access.js";
import { SessionReader, type SessionReaderDependencies } from "../src/bridge/sessions/reader.js";
import { BridgeService } from "../src/bridge/service.js";
import { WEB_MUTATION_RPC_TIMEOUT_MS } from "../src/web/protocol-limits.js";
import { testConfig } from "./bridge-test-config.js";
import { DirectoryRegistrationError, WebDirectoryRegistry } from "../src/bridge/sessions/directory-registry.js";
import { SessionActionGuardService } from "../src/bridge/sessions/action-guards.js";
import { WebAttachmentStorage } from "../src/web/attachments.js";
import type { CodexTurnInputPart } from "../src/codex/client.js";

async function sendFixture(t: TestContext, attachmentRoot?: string) {
  const { store, session } = await historyFixture(t);
  const active = new Map<string, string>();
  const calls: string[] = [];
  const inputParts: Array<CodexTurnInputPart[] | undefined> = [];
  const timeouts: Array<number | undefined> = [];
  let mutate: () => Promise<void> = async () => {};
  let pending = false;
  const turnRouteQueue = new KeyedQueue();
  const sender = new IncomingTurnService({ store, turnRouteQueue, inFlightTurnIdByThread: active,
    codexClient: {
      sendTurn: async (_thread: string, text: string, _cwd: string,
        options: { assertCurrent?: () => void; timeoutMs?: number; inputParts?: CodexTurnInputPart[] }) => {
        await mutate(); options.assertCurrent?.(); calls.push(`start:${text}`); timeouts.push(options.timeoutMs);
        inputParts.push(options.inputParts);
        return { turnId: "turn" };
      },
      steerTurn: async (_thread: string, _turn: string, text: string, parts: CodexTurnInputPart[] | undefined, guard?: () => void,
        timeoutMs?: number) => {
        await mutate(); guard?.(); calls.push(`steer:${text}`); timeouts.push(timeoutMs); inputParts.push(parts); return { turnId: "turn" };
      }
    } as never,
    statusRuntimeState: { resetEditThrottle: () => {}, getLabel: () => null }, lastUserInputBySession: new Map(),
    sessionOwnershipService: {} as never, rememberNotificationSession: () => {}, getSessionDirectory: () => "/work",
    isStaleActiveTurnError: () => false, isMissingRuntimeThreadError: () => false, isActiveWriterConflictError: () => false,
    findProviderMismatch: async () => null, sessionRefreshCallback: () => "unused",
    createIncomingPromptSpec: (kind, text) => createMessage({ kind, body: [{ type: "text", text }] }),
    createSessionActionSpec: (_session, kind, text) => createMessage({ kind, body: [{ type: "text", text }] }),
    sendLongSpec: async () => {}, setSessionStatus: async () => {} });
  const api = new LocalWebBridgeApi(new SessionCatalogService({ store, getSessionDirectory: () => "/work",
    readEffectiveProvider: async () => null, codexClient: { listThreadsForCwd: async () => [], listArchivedThreadsForCwd: async () => [] } }),
  undefined, { access: new SessionAccessService(store), reader: { readSessionTranscript: async () => { throw new Error("not a send"); } },
    sender, isRuntimeConnected: () => true, store: {
      hasTelegramMessage: (sessionId, messageId) => store.hasTelegramMessage(sessionId, messageId),
      listOpenDecisions: async () => pending ? [{} as never] : await store.listOpenDecisions(session.id)
    } }, undefined, undefined, undefined, attachmentRoot ? new WebAttachmentStorage(attachmentRoot) : undefined);
  return { store, session, api, active, calls, inputParts, timeouts, turnRouteQueue,
    setMutate: (callback: () => Promise<void>) => { mutate = callback; },
    setPending: () => { pending = true; } };
}

test("a Web send awaiting the thread queue rechecks its window and pending decisions before upstream work", async (t) => {
  for (const mode of ["window", "pending"] as const) {
    const fixture = await sendFixture(t);
    let finish!: () => void;
    let started!: () => void;
    let revoked = false;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const blocker = fixture.turnRouteQueue.run("history-thread", async () => {
      started(); await new Promise<void>((resolve) => { finish = resolve; });
    });
    await ready;
    const send = fixture.api.sendText({ threadId: "history-thread", requestId: mode, text: "hello" }, () => {
      if (revoked) throw new Error("revoked");
    });
    const rejection = assert.rejects(send);
    if (mode === "window") revoked = true;
    else fixture.setPending();
    finish();
    await blocker;
    await rejection;
    assert.deepEqual(fixture.calls, []);
  }
});

test("Web explicit text sends reuse start/steer and idempotence without active selection or implicit claim", async (t) => {
  const { api, store, session, active, calls, timeouts } = await sendFixture(t);
  const input = { threadId: "history-thread", requestId: "one", text: "/help is conversation text" };
  assert.deepEqual(await api.sendText(input, () => {}), { accepted: true, requestId: "one" });
  await api.sendText(input, () => {});
  await api.sendText({ ...input, requestId: "two", text: "interjection" }, () => {});
  assert.deepEqual(calls, ["start:/help is conversation text", "steer:interjection"]);
  assert.deepEqual(timeouts, [WEB_MUTATION_RPC_TIMEOUT_MS, WEB_MUTATION_RPC_TIMEOUT_MS]);
  assert.equal(active.get("history-thread"), "turn");
  assert.equal(store.getActiveTurnRoute("history-thread")?.sourceId, "web:local");
  assert.equal((await store.listRecentMessages(session.id, 10)).length, 2);
  assert.equal(await store.getActiveSession("web:local"), null);
});

test("Web image sends persist bounded files and route localImage input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-web-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await sendFixture(t, root);
  const receipt = await fixture.api.sendText({ threadId: "history-thread", requestId: "attachments", text: "",
    attachments: [{ name: "screen shot.png", mimeType: "image/png", sizeBytes: 8,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }] }, () => {});
  assert.deepEqual(receipt, { accepted: true, requestId: "attachments" });
  assert.match(fixture.calls[0]!, /Please inspect the attached file: screen_shot.png/);
  const parts = fixture.inputParts[0]!;
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[1]?.type, "localImage");
  if (parts[1]?.type !== "localImage") throw new Error("unexpected attachment parts");
  assert.deepEqual([...await readFile(parts[1].path)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const metadata = JSON.parse(await readFile(`${parts[1].path}.json`, "utf8")) as { status: string };
  assert.equal(metadata.status, "sent-to-codex");
});

test("ordinary Web sends are blocked by actual awaiting MCP input as well as pending approval", async (t) => {
  const { api, store, session, calls } = await sendFixture(t);
  const decision = await store.createOrReplacePendingDecision({ sessionId: session.id, telegramChatId: "web:local",
    approvalId: "mcp-request", kind: "mcpServer/elicitation/request", title: "Input", summary: "fields: value", requiresUserInput: true });
  await store.resolveDecision(decision.id, "awaitingInput");
  assert.equal((await store.listPendingDecisions(session.id)).length, 0);
  await assert.rejects(api.sendText({ threadId: "history-thread", requestId: "input-waiting", text: "hello" }, () => {}), new WebSendError("waiting"));
  assert.deepEqual(calls, []);
});

test("Web refuses ordinary sends with pending approval/input or missing session occupation", async (t) => {
  const fixture = await sendFixture(t);
  fixture.setPending();
  await assert.rejects(fixture.api.sendText({ threadId: "history-thread", requestId: "one", text: "hello" }, () => {}), new WebSendError("waiting"));
  assert.deepEqual(fixture.calls, []);
  fixture.store.requestSessionHandoff(fixture.session.id, "123", true);
  await assert.rejects(fixture.api.sendText({ threadId: "history-thread", requestId: "one", text: "hello" }, () => {}), new SessionAccessError("not_owner"));
});

test("Web send guards stop upstream mutation after asynchronous window revocation or handoff", async (t) => {
  for (const mode of ["window", "session", "pending"] as const) {
    const fixture = await sendFixture(t);
    let revoked = false;
    fixture.setMutate(async () => {
      if (mode === "window") revoked = true;
      else if (mode === "session") fixture.store.requestSessionHandoff(fixture.session.id, "123", true);
    });
    if (mode === "pending") fixture.setPending();
    await assert.rejects(fixture.api.sendText({ threadId: "history-thread", requestId: mode, text: "hello" }, () => {
      if (revoked) throw new Error("revoked");
    }));
    assert.deepEqual(fixture.calls, []);
    assert.equal((await fixture.store.listRecentMessages(fixture.session.id, 10)).length, 0);
  }
});

async function historyFixture(t: TestContext, overrides: Partial<SessionReaderDependencies> = {}) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({
    telegramChatId: "123", codexThreadId: "history-thread", pathKey: "/private/rollout.jsonl", currentCwd: "/work"
  });
  store.claimSession(session.id, "web:local");
  const reader = new SessionReader({
    store, codexClient: {} as SessionReaderDependencies["codexClient"],
    isRuntimeConnected: () => false, canReadThreadStatus: () => false,
    getSessionDirectory: () => "/work", readDisplayPathFromRollout: async () => null,
    pickDirectory: () => null, readRecentMessagesFromRollout: async () => [],
    isActiveWriterConflictError: () => false, ...overrides
  });
  const api = new LocalWebBridgeApi(new SessionCatalogService({
    store, getSessionDirectory: () => "/work", readEffectiveProvider: async () => null,
    codexClient: { listThreadsForCwd: async () => [], listArchivedThreadsForCwd: async () => [] }
  }), undefined, { access: new SessionAccessService(store), reader });
  return { store, session, api };
}

test("Web history uses the disconnected database reader and returns only the latest five conversation messages", async (t) => {
  const { store, session, api } = await historyFixture(t);
  for (let i = 0; i < 7; i++) {
    await store.addMessage({ sessionId: session.id, role: i % 2 ? "assistant" : "user", text: `message-${i}`, createdAt: i });
  }
  const before = await store.getSessionById(session.id);
  const lease = store.getSessionLease(session.id);
  const result = await api.readHistory("history-thread", lease!.version, () => {});
  result.assertCurrent();
  assert.deepEqual(result.history, { threadId: "history-thread", sessionId: session.id, leaseVersion: lease!.version,
    messages: [
      { role: "user", text: "message-2" }, { role: "assistant", text: "message-3" },
      { role: "user", text: "message-4" }, { role: "assistant", text: "message-5" }, { role: "user", text: "message-6" }
    ] });
  assert.equal(JSON.stringify(result.history).includes("private/rollout"), false);
  assert.deepEqual(await store.getSessionById(session.id), before);
  assert.deepEqual(store.getSessionLease(session.id), lease);
  assert.equal(await store.getActiveSession("web:local"), null);
});

test("Web history reuses upstream read without resume and excludes system messages and extra fields", async (t) => {
  let reads = 0;
  const { store, session, api } = await historyFixture(t, { isRuntimeConnected: () => true,
    codexClient: { listRecentThreadMessages: async (id: string, limit: number) => {
      assert.equal(id, "history-thread"); assert.equal(limit, 5); reads++;
      return [ { role: "system", text: "private-system" },
        ...Array.from({ length: 7 }, (_, i) => ({ role: "assistant", text: `answer-${i}`, privateField: "private-extra" })) ];
    }, resumeThread: async () => { assert.fail("history must not resume"); }
    } as unknown as SessionReaderDependencies["codexClient"] });
  const before = await store.getSessionById(session.id);
  const result = await api.readHistory("history-thread", undefined, () => {});
  assert.deepEqual(result.history.messages, Array.from({ length: 5 }, (_, i) => ({ role: "assistant", text: `answer-${i + 2}` })));
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(result.history).includes("private-"), false);
  assert.deepEqual(await store.getSessionById(session.id), before);
});

test("Web history reuses rollout then database fallback without creating synthetic messages", async (t) => {
  let rolloutReads = 0;
  const { store, session, api } = await historyFixture(t, { isRuntimeConnected: () => true,
    codexClient: { listRecentThreadMessages: async () => { throw new Error("upstream offline"); } } as unknown as SessionReaderDependencies["codexClient"],
    readRecentMessagesFromRollout: async (path) => {
      assert.equal(path, "/private/rollout.jsonl"); rolloutReads++;
      return rolloutReads === 1 ? [{ role: "user", text: "rollout conversation" }] : [];
    } });
  assert.deepEqual((await api.readHistory("history-thread", undefined, () => {})).history.messages,
    [{ role: "user", text: "rollout conversation" }]);
  await store.addMessage({ sessionId: session.id, role: "assistant", text: "database conversation" });
  assert.deepEqual((await api.readHistory("history-thread", undefined, () => {})).history.messages,
    [{ role: "assistant", text: "database conversation" }]);
});

test("Web history checks ownership before invoking the reader and permits no spectator or arbitrary source", async (t) => {
  const { store, session, api } = await historyFixture(t, {
    isRuntimeConnected: () => { assert.fail("unowned history must not be read"); }
  });
  store.requestSessionHandoff(session.id, "123", true);
  store.requestSessionHandoff(session.id, "web:local", false);
  const lease = store.getSessionLease(session.id);
  await assert.rejects(api.readHistory("history-thread", undefined, () => {}), new SessionAccessError("not_owner"));
  assert.deepEqual(store.getSessionLease(session.id), lease);
  assert.equal(await store.getActiveSession("web:local"), null);
});

test("Web history refuses delivery after window revocation, handoff, or thread reassociation during reading", async (t) => {
  for (const change of ["window", "handoff", "thread"] as const) {
    let revoked = false;
    const { store, session, api } = await historyFixture(t, { isRuntimeConnected: () => true,
      codexClient: { listRecentThreadMessages: async () => {
        await mutate(); return [{ role: "assistant", text: "private-conversation" }];
      } } as unknown as SessionReaderDependencies["codexClient"] });
    const mutate = async () => {
      if (change === "window") revoked = true;
      else if (change === "handoff") store.requestSessionHandoff(session.id, "123", true);
      else await store.updateSessionThreadId(session.id, "different-thread");
    };
    await assert.rejects(api.readHistory("history-thread", undefined, () => {
      if (revoked) throw new Error("revoked");
    }), change === "window" ? /revoked/ : new SessionAccessError(change === "handoff" ? "stale" : "unavailable"));
  }
});

test("Web history final delivery guard still rejects a handoff after API completion", async (t) => {
  const { store, session, api } = await historyFixture(t);
  const result = await api.readHistory("history-thread", undefined, () => {});
  assert.deepEqual(result.history.messages, []);
  store.requestSessionHandoff(session.id, "123", true);
  assert.throws(() => result.assertCurrent(), new SessionAccessError("stale"));
});

test("BridgeService wires Web history to the existing reader without selecting or resuming", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "thread", pathKey: "/work" });
  store.claimSession(session.id, "web:local");
  await store.addMessage({ sessionId: session.id, role: "user", text: "hello" });
  const service = new BridgeService({ ...testConfig(":memory:"), web: { host: "127.0.0.1", port: 8787 } }, store, {} as never);
  const result = await service.createWebApi().readHistory("thread", undefined, () => {});
  result.assertCurrent();
  assert.deepEqual(result.history.messages, [{ role: "user", text: "hello" }]);
  assert.equal(await service.getActiveSession("web:local"), null);
});

test("Web explicit binding registers upstream metadata without changing selection, resuming or accepting arbitrary identity", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const events: SessionBindingEvent[] = [];
    const service = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: (session) => session.currentCwd!, notify: async () => {} });
    const api = new LocalWebBridgeApi(new SessionCatalogService({ store, getSessionDirectory: (session) => session.currentCwd!,
      readEffectiveProvider: async () => "custom",
      codexClient: { listThreadsForCwd: async () => [thread("new"), thread("wrong", { modelProvider: "openai" })], listArchivedThreadsForCwd: async () => [] }
    }), { store, service });
    const unsubscribe = api.subscribeBinding((event) => { events.push(event); });
    let guardCalls = 0;
    const result = await api.requestBinding("new", undefined, () => { guardCalls++; });
    assert.equal(result.outcome?.owned, true);
    assert.equal(result.outcome?.binding.sourceId, "web:local");
    assert.equal(result.outcome?.binding.platform, "web");
    assert.ok(guardCalls >= 2);
    assert.equal(await store.getActiveSession("web:local"), null);
    assert.equal(events[0]?.kind, "acquired");
    assert.equal((await api.requestBinding("wrong", undefined, () => {})).outcome, null);
    assert.equal(await store.getSessionByThreadId("wrong"), null);
    assert.equal((await api.cancelBinding("new", undefined, () => {})).reason, "not_pending");
    unsubscribe();
  } finally { store.close(); }
});

test("window guard rechecks after upstream awaits and prevents every binding write after revocation", async () => {
  const store = new BridgeStore(":memory:");
  try {
    let revoked = false;
    const service = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work", notify: async () => {} });
    const api = new LocalWebBridgeApi(new SessionCatalogService({ store, getSessionDirectory: () => "/work",
      readEffectiveProvider: async () => null,
      codexClient: { listThreadsForCwd: async () => { revoked = true; return [thread("new")]; }, listArchivedThreadsForCwd: async () => [] }
    }), { store, service });
    await assert.rejects(api.requestBinding("new", undefined, () => { if (revoked) throw new Error("revoked"); }), /revoked/);
    assert.equal(await store.getSessionByThreadId("new"), null);
    assert.deepEqual(await store.listChatIds(), []);
  } finally { store.close(); }
});

test("Web subscriptions expose only source-targeted binding metadata and never other-end events", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "known", pathKey: "/work" });
    store.claimSession(session.id, "123");
    store.setSessionOwnerTurn(session.id, "123", "turn");
    const service = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work", notify: async () => {} });
    const api = new LocalWebBridgeApi(new SessionCatalogService({ store, getSessionDirectory: () => "/work", readEffectiveProvider: async () => null,
      codexClient: { listThreadsForCwd: async () => [thread("known")], listArchivedThreadsForCwd: async () => [] } }), { store, service });
    const events: SessionBindingEvent[] = [];
    const unsubscribe = api.subscribeBinding((event) => { events.push(event); });
    await api.requestBinding("known", undefined, () => {});
    assert.deepEqual(events, []); // Requested notification belongs to the current TG owner.
    await service.request("slack:T:C:1", session.id);
    assert.deepEqual(events.map((event) => event.kind), ["replaced"]);
    assert.equal(events[0]?.otherSourceId, "slack:T:C:1");
    assert.equal(JSON.stringify(events).includes("private"), false);
    unsubscribe();
    await service.request("web:local", session.id);
    await service.cancel("web:local", session.id);
    assert.equal(events.length, 1);
  } finally { store.close(); }
});

function thread(threadId: string, overrides: Partial<ListedCodexThread> = {}): ListedCodexThread {
  return { threadId, name: threadId, currentCwd: "/work", pathKey: null,
    modelProvider: "custom", modelProviderKnown: true, updatedAt: 10, createdAt: 1,
    archivedAt: null, preview: "private conversation", rolloutPath: "/private/rollout.jsonl", ...overrides };
}

test("Web catalog joins metadata without creating bindings, claiming or reading conversation content", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const known = await store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "known", pathKey: "/work" });
    store.claimSession(known.id, "123");
    store.requestSessionHandoff(known.id, "slack:T:C:1", false);
    const lease = store.getSessionLease(known.id);
    const api = new LocalWebBridgeApi(new SessionCatalogService({
      store, getSessionDirectory: (session) => session.currentCwd ?? session.pathKey,
      readEffectiveProvider: async () => "custom",
      codexClient: {
        listThreadsForCwd: async () => [thread("known"), thread("new"), thread("wrong", { modelProvider: "openai" }), thread("unknown", { modelProviderKnown: false })],
        listArchivedThreadsForCwd: async () => [thread("new", { archivedAt: 99 })]
      },
      readLoadedThreadIds: async () => new Set(["known"])
    }));
    const catalog = await api.listCatalog();
    assert.deepEqual(catalog.directories, ["/work"]);
    assert.deepEqual(catalog.sessions.map((entry) => entry.threadId), ["known", "new", "unknown"]);
    assert.equal(catalog.sessions[1]!.archived, true);
    assert.equal(catalog.sessions[1]!.sessionId, null);
    assert.equal(catalog.sessions[0]!.ownership?.ownerSourceId, "123");
    assert.equal(catalog.sessions[0]!.ownership?.pendingSourceId, "slack:T:C:1");
    assert.deepEqual(catalog.sessions.map((entry) => entry.connection), ["active", "inactive", "inactive"]);
    assert.equal(JSON.stringify(catalog).includes("private"), false);
    assert.equal(JSON.stringify(catalog).includes("preview"), false);
    assert.deepEqual(store.getSessionLease(known.id), lease);
    assert.equal(store.getSessionBinding(known.id, "web:local"), null);
    assert.equal(await store.getSessionByThreadId("new"), null);
    assert.deepEqual(await store.listChatIds(), ["123"]);
  } finally { store.close(); }
});

test("catalog empty and upstream failure do not fabricate sessions or connection status", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const catalog = new SessionCatalogService({ store, getSessionDirectory: (session) => session.pathKey,
      readEffectiveProvider: async () => null,
      codexClient: { listThreadsForCwd: async () => [], listArchivedThreadsForCwd: async () => [] } });
    assert.deepEqual(await catalog.list(), { directories: [], sessions: [] });
    const broken = new SessionCatalogService({ store, getSessionDirectory: (session) => session.pathKey,
      readEffectiveProvider: async () => null,
      codexClient: { listThreadsForCwd: async () => { throw new Error("offline"); }, listArchivedThreadsForCwd: async () => [] } });
    await assert.rejects(broken.list(), /offline/);
  } finally { store.close(); }
});

test("catalog directories exclude archive-only locations from the active navigation", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const catalog = new SessionCatalogService({
      store, getSessionDirectory: (session) => session.pathKey, readEffectiveProvider: async () => null,
      codexClient: {
        listThreadsForCwd: async () => [thread("active", { currentCwd: "/active" })],
        listArchivedThreadsForCwd: async () => [thread("archived", { currentCwd: "/archive", archivedAt: 99 })]
      }
    });
    const result = await catalog.list();
    assert.deepEqual(result.directories, ["/active"]);
    assert.deepEqual(result.sessions.map((entry) => [entry.threadId, entry.archived]), [
      ["active", false], ["archived", true]
    ]);
  } finally { store.close(); }
});

test("catalog leaves connection unknown when loaded-thread status is unavailable", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const catalog = new SessionCatalogService({ store, getSessionDirectory: (session) => session.pathKey,
      readEffectiveProvider: async () => null,
      readLoadedThreadIds: async () => null,
      codexClient: { listThreadsForCwd: async () => [thread("known")], listArchivedThreadsForCwd: async () => [] } });
    assert.equal((await catalog.list()).sessions[0]?.connection, "unknown");
  } finally { store.close(); }
});

test("catalog exposes Bridge-computed release capability and disables it for open work", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "web:local", codexThreadId: "release-ready", pathKey: "/work"
    });
    store.claimSession(session.id, "web:local");
    let dispatching = false;
    const guards = new SessionActionGuardService({ store, inFlightTurnIdByThread: new Map(), hasPendingDispatch: () => dispatching,
      buildCallback: () => "unused" });
    const catalog = new SessionCatalogService({ store, getSessionDirectory: () => "/work",
      readEffectiveProvider: async () => null,
      canReleaseToCodex: (sessionId) => guards.isAvailable("web:local", sessionId),
      codexClient: { listThreadsForCwd: async () => [thread("release-ready")], listArchivedThreadsForCwd: async () => [] } });
    assert.equal((await catalog.list()).sessions[0]?.capabilities.releaseToCodex, true);
    dispatching = true;
    assert.equal((await catalog.list()).sessions[0]?.capabilities.releaseToCodex, false);
    dispatching = false;
    await store.createOrReplacePendingDecision({ sessionId: session.id, telegramChatId: "web:local", approvalId: "approval",
      kind: "test", title: "approval", summary: "approval", requiresUserInput: false });
    assert.equal((await catalog.list()).sessions[0]?.capabilities.releaseToCodex, false);
  } finally { store.close(); }
});

test("Web directory registration accepts any accessible existing directory without creating a session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-web-directory-"));
  const directory = join(root, "outside-project");
  const file = join(root, "not-a-directory");
  await mkdir(directory);
  await writeFile(file, "file");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const catalog = new SessionCatalogService({ store, getSessionDirectory: (session) => session.pathKey,
    readEffectiveProvider: async () => null,
    codexClient: { listThreadsForCwd: async () => [], listArchivedThreadsForCwd: async () => [] } });
  const api = new LocalWebBridgeApi(catalog, undefined, undefined, undefined, new WebDirectoryRegistry(store));

  assert.deepEqual(await api.registerDirectory(`  ${directory}  `, () => {}), { directory, existing: false });
  assert.deepEqual(await api.registerDirectory(directory, () => {}), { directory, existing: true });
  assert.deepEqual(await api.listCatalog(), { directories: [directory], sessions: [] });
  assert.deepEqual(await store.listSessionsForPolling(), []);
  await assert.rejects(api.registerDirectory(join(root, "missing"), () => {}),
    new DirectoryRegistrationError("not_found", "Directory does not exist."));
  await assert.rejects(api.registerDirectory(file, () => {}),
    new DirectoryRegistrationError("not_directory", "Path is not a directory."));
});

test("Web session mutations refuse result delivery after window revocation or ownership transfer", async (t) => {
  for (const change of ["window", "session"] as const) {
    const { store, session } = await historyFixture(t);
    const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(),
      getSessionDirectory: () => "/work", notify: async () => {} });
    let revoked = false;
    const catalog = new SessionCatalogService({ store, getSessionDirectory: () => "/work",
      readEffectiveProvider: async () => null,
      codexClient: { listThreadsForCwd: async () => [], listArchivedThreadsForCwd: async () => [] } });
    const api = new LocalWebBridgeApi(catalog, undefined, undefined, undefined, undefined, {
      store, access: new SessionAccessService(store), binding,
      interaction: { renameSession: async () => {
        if (change === "window") revoked = true;
        else store.requestSessionHandoff(session.id, "123", true);
        return createMessage({ kind: "system", body: [{ type: "text", text: "renamed" }] });
      } }
    } as never);

    await assert.rejects(api.manageSession({ threadId: session.codexThreadId,
      leaseVersion: store.getSessionLease(session.id)!.version, action: "rename", name: "new" }, () => {
      if (revoked) throw new Error("revoked");
    }), change === "window" ? /revoked/ : new SessionAccessError("stale"));
  }
});

test("Web release returns a guarded receipt after intentionally dropping session ownership", async (t) => {
  const { store, session } = await historyFixture(t);
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(),
    getSessionDirectory: () => "/work", notify: async () => {} });
  let windowCurrent = true;
  let revokeDuringRelease = false;
  const catalog = new SessionCatalogService({ store, getSessionDirectory: () => "/work",
    readEffectiveProvider: async () => null,
    codexClient: { listThreadsForCwd: async () => [], listArchivedThreadsForCwd: async () => [] } });
  const api = new LocalWebBridgeApi(catalog, undefined, undefined, undefined, undefined, {
    store, access: new SessionAccessService(store), binding,
    mutation: { releaseBridgeSessionLock: async (_sourceId: string, sessionId: string, version?: number) => {
      const result = store.releaseBridgeSessionLock(sessionId, "web:local", version);
      if (revokeDuringRelease) windowCurrent = false;
      return createMessage({ kind: result.released ? "system" : "error", body: [{ type: "text", text: result.reason }] });
    } }
  } as never);

  const result = await api.manageSession({ threadId: session.codexThreadId,
    leaseVersion: store.getSessionLease(session.id)!.version, action: "release" }, () => {
    if (!windowCurrent) throw new Error("revoked");
  });
  assert.equal(result.ok, true);
  assert.equal(store.getSessionLease(session.id)?.state, "unbound");

  store.claimSession(session.id, "web:local");
  windowCurrent = true;
  revokeDuringRelease = true;
  await assert.rejects(api.manageSession({ threadId: session.codexThreadId,
    leaseVersion: store.getSessionLease(session.id)!.version, action: "release" }, () => {
    if (!windowCurrent) throw new Error("revoked");
  }), /revoked/);
  assert.equal(store.getSessionLease(session.id)?.state, "unbound");
});
