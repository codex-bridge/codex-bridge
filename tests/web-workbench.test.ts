import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { File } from "node:buffer";
import { QueryClient } from "@tanstack/react-query";
import { ApiError, HttpWorkbenchApi, decodeEvents, type WorkbenchApi } from "../web/src/lib/api.ts";
import { WorkbenchController, canInteract, canViewSelectedTimeline, isSelectedOperation } from "../web/src/lib/workbench.ts";
import { applyMessage, historyBoundaryIndex, restoreHistory } from "../web/src/lib/timeline.ts";
import { decisionAppearance } from "../web/src/lib/decision-appearance.ts";
import { messageAppearance } from "../web/src/lib/message-appearance.ts";
import { bindingAppearance } from "../web/src/lib/binding-appearance.ts";
import { sessionAccessAppearance } from "../web/src/lib/session-access-appearance.ts";
import { createClientId } from "../web/src/lib/id.ts";
import type { TimelineCache } from "../web/src/lib/cache.ts";
import type { ComposerDraftStore } from "../web/src/lib/composer-drafts.ts";
import type { Catalog, Grant, MessageSpec, StreamEvent } from "../web/src/lib/protocol.ts";
import type { SessionLocation, WindowGrantStore } from "../web/src/lib/browser-state.ts";

const message = (title: string, kind: MessageSpec["kind"] = "progress"): MessageSpec => ({ title, kind, body: [{ type: "text", text: title }], actions: [] });

test("message appearance follows protocol semantics instead of title text", () => {
  assert.deepEqual(messageAppearance(message("Run", "codex")), { appearance: "assistant", tone: "default" });
  assert.deepEqual(messageAppearance(message("Codex", "user")), { appearance: "user", tone: "default" });
  assert.deepEqual(messageAppearance(message("Anything", "edited")), { appearance: "activity", tone: "default" });
  assert.deepEqual(messageAppearance(message("Anything", "failed")), { appearance: "activity", tone: "error" });
  assert.deepEqual(messageAppearance(message("Anything", "stream-error")), { appearance: "activity", tone: "error" });
  assert.deepEqual(messageAppearance(message("Anything", "actions")), { appearance: "actions", tone: "default" });
  assert.deepEqual(messageAppearance({ ...message("Anything", "system"), decision: { id: "d", state: "pending",
    requiresUserInput: false, requestedFields: [], availableActions: [], inputAllowed: false } }),
  { appearance: "decision", tone: "default" });
});
test("decision appearance separates actionable, unavailable, uncertain and terminal states", () => {
  const decision = { id: "d", state: "pending" as const, requiresUserInput: false,
    requestedFields: [], availableActions: ["accept" as const], inputAllowed: false };
  assert.deepEqual(decisionAppearance(decision, { current: true, enabled: true, busy: false }), {
    label: "Awaiting approval", tone: "attention", open: true, guidance: "Approval only allows Codex to continue; it does not mean the later operation succeeded.", unavailable: null
  });
  assert.match(decisionAppearance(decision, { current: true, enabled: false, busy: false }).unavailable!, /session access/);
  assert.match(decisionAppearance({ ...decision, unavailableReason: "runtime_disconnected" },
    { current: true, enabled: true, busy: false }).unavailable!, /runtime is disconnected/);
  assert.equal(decisionAppearance(decision, { current: false, enabled: true, busy: false }).label, "Status unknown");
  assert.equal(decisionAppearance({ ...decision, state: "awaitingInput" },
    { current: true, enabled: true, busy: false }).label, "Awaiting input");
  assert.deepEqual(decisionAppearance({ ...decision, state: "approved", availableActions: [] },
    { current: true, enabled: true, busy: false }), {
    label: "Approved", tone: "success", open: false, guidance: "Codex may continue. This does not mean the later operation succeeded.", unavailable: null
  });
  for (const [state, label, tone] of [["approvedForSession", "Approved for session", "success"], ["rejected", "Rejected", "danger"],
    ["cancelled", "Cancelled", "muted"], ["stale", "Request expired", "muted"]] as const) {
    const result = decisionAppearance({ ...decision, state, availableActions: [] }, { current: true, enabled: true, busy: false });
    assert.deepEqual([result.label, result.tone, result.open, result.unavailable], [label, tone, false, null]);
  }
});
test("binding appearance never exposes protocol reasons and keeps visible successes quiet", () => {
  assert.equal(bindingAppearance({ owned: true, reason: "claimed" }, "request"), null);
  assert.equal(bindingAppearance({ cancelled: true, reason: "cancelled" }, "cancel"), null);
  assert.deepEqual(bindingAppearance({ pending: true, reason: "owned_by_other", replacedSourceId: "slack:one" }, "request"), {
    tone: "notice", message: "Waiting to bind when the current stage ends. This replaced the pending request from slack:one."
  });
  const unavailable = bindingAppearance({ reason: "unavailable" }, "request");
  assert.deepEqual(unavailable, { tone: "error", message: "Binding did not take effect because this session cannot be bound right now. Try again later." });
  assert.equal(unavailable?.message.includes("unavailable"), false);
});
test("session access appearance states only the current blocker", () => {
  const entry = { threadId: "a", sessionId: "session-a", name: "a", directory: "/project", archived: false,
    updatedAt: 0, provider: "test", connection: "active" as const,
    ownership: { state: "unbound", ownerSourceId: null, pendingSourceId: null, version: 1 } };
  assert.deepEqual(sessionAccessAppearance({ selected: true, entry, connection: "connected", catalogReady: true,
    interactive: false, decisionPending: false }), {
    emptyTitle: null,
    emptyDescription: "Binding restores the 5 most recent messages. Switching does not stop a running task.",
    draftPlaceholder: "You can start a draft",
    composerRestriction: "Bind this session before sending."
  });
  assert.equal(sessionAccessAppearance({ selected: true, entry, connection: "offline", catalogReady: false,
    interactive: false, decisionPending: false }).composerRestriction, "Connect to the service before binding.");
  assert.deepEqual(sessionAccessAppearance({ selected: true, connection: "offline", catalogReady: false,
    interactive: false, decisionPending: false }), {
    emptyTitle: null,
    emptyDescription: null,
    draftPlaceholder: "Draft",
    composerRestriction: "Connect to the service to confirm this session."
  });
});
test("client identities work with a random source lacking secure-context randomUUID", () => {
  const random: Pick<Crypto, "getRandomValues"> = { getRandomValues: (array) => {
    assert.ok(array instanceof Uint8Array);
    for (let index = 0; index < array.length; index++) array[index] = index;
    return array;
  } };
  assert.equal(createClientId(random), "000102030405060708090a0b0c0d0e0f");
  assert.match(createClientId(), /^[A-Za-z0-9_-]{1,128}$/);
  assert.notEqual(createClientId(), createClientId());
});
function fixture(overrides: Partial<WorkbenchApi> = {}, cache?: TimelineCache,
  browser?: { location?: SessionLocation; grants?: WindowGrantStore; drafts?: ComposerDraftStore }, mutationTimeoutMs?: number) {
  const calls: string[] = [];
  let receive!: (event: StreamEvent) => void;
  let finishStream!: () => void;
  const catalog: Catalog = { directories: ["/project"], sessions: ["a", "b"].map((threadId) => ({
    threadId, sessionId: `session-${threadId}`, name: threadId, directory: "/project", archived: false, updatedAt: 0,
    provider: "test", connection: "unknown", ownership: { state: "active", ownerSourceId: "web:local", pendingSourceId: null, version: 1 }
  })) };
  const api: WorkbenchApi = {
    holder: async () => ({ holderWindowId: null }),
    acquire: async () => { calls.push("acquire"); return { windowId: "test", token: "fake" }; },
    resume: async () => { calls.push("resume"); },
    restore: async (grant) => { calls.push("restore"); return { ...grant, token: "restored" }; },
    catalog: async () => { calls.push("catalog"); return structuredClone(catalog); },
    directory: async (_, path) => { calls.push(`directory-${path}`); return { directory: path, existing: false }; },
    history: async (_, threadId) => { calls.push(`history-${threadId}`); return { threadId, sessionId: `session-${threadId}`, leaseVersion: 1,
      messages: [{ role: "assistant", text: `history ${threadId}` }] }; },
    decisions: async (_, threadId) => ({ threadId, sessionId: `session-${threadId}`, leaseVersion: 1, decisions: [] }),
    binding: async () => { calls.push("binding"); return { owned: true, reason: "claimed" }; },
    send: async (_, __, ___, requestId) => { calls.push("send"); return { accepted: true, requestId }; },
    decision: async (_, __, decisionId) => ({ accepted: true, decisionId, state: "approved" }),
    createSession: async (_, directory) => ({ threadId: `new-${directory}`, sessionId: "session-new", leaseVersion: 1 }),
    manageSession: async () => ({ ok: true, message: message("managed", "system") }),
    sessionTool: async (_, __, tool) => ({ ok: true, message: message(tool, "system") }),
    queue: async (_, threadId) => ({ threadId, sessionId: `session-${threadId}`, leaseVersion: 1, running: false, entries: [] }),
    queueSend: async (_, __, ___, requestId) => ({ accepted: true, requestId }),
    queueCancel: async () => ({ ok: true, message: message("cancelled", "queue") }),
    events: async (_, signal, callback) => { receive = callback; callback({ name: "connected", data: {} });
      await new Promise<void>((resolve) => { finishStream = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); }); },
    ...overrides
  };
  const controller = new WorkbenchController(api, new QueryClient(), "test", cache, browser, mutationTimeoutMs);
  return { controller, api, calls, catalog, event: (event: StreamEvent) => receive(event), disconnect: () => finishStream() };
}
async function settle() { await nextTick(); await nextTick(); }
async function open(f: ReturnType<typeof fixture>, threadId = "a") { await f.controller.connect(); await settle(); f.controller.select(threadId); await settle(); }

test("adding a directory refreshes navigation without changing the selected session", async (t) => {
  const f = fixture({ directory: async (_, path) => {
    f.catalog.directories.push(path);
    return { directory: path, existing: false };
  } });
  t.after(() => f.controller.dispose());
  await open(f, "b");
  f.calls.length = 0;
  assert.deepEqual(await f.controller.addDirectory("/empty"), { directory: "/empty", existing: false });
  assert.equal(f.controller.getSnapshot().selected, "b");
  assert.deepEqual(f.controller.getSnapshot().catalog?.directories, ["/project", "/empty"]);
  assert.deepEqual(f.calls, ["catalog"]);
});

function browserState(selected: string | null, grant: Grant | null) {
  let listener = () => {};
  const writes: Array<string | null> = [];
  const location: SessionLocation = { read: () => selected, write: (value) => { selected = value; writes.push(value); },
    subscribe: (callback) => { listener = callback; return () => { listener = () => {}; }; } };
  const grants: WindowGrantStore = { take: () => { const old = grant; grant = null; return old; },
    save: (value) => { grant = value; }, clear: () => { grant = null; } };
  return { location, grants, writes, stored: () => grant, navigate: (value: string | null) => { selected = value; listener(); } };
}

test("same-tab refresh restores a rotated grant and URL target, without acquiring or binding", async (t) => {
  const browser = browserState("b", { windowId: "original", token: "old" });
  let restorations = 0;
  const f = fixture({ restore: async (grant) => {
    restorations++;
    assert.equal(browser.stored(), null);
    assert.deepEqual(grant, { windowId: "original", token: "old" });
    return { ...grant, token: "new" };
  } }, undefined, browser);
  t.after(() => f.controller.dispose());
  assert.equal(f.controller.getSnapshot().selected, "b");
  await Promise.all([f.controller.start(), f.controller.start(), f.controller.connect()]); await settle();
  assert.equal(restorations, 1);
  assert.equal(canInteract(f.controller.getSnapshot()), true);
  assert.deepEqual(browser.stored(), { windowId: "original", token: "new" });
  assert.deepEqual(f.calls, ["catalog", "history-b"]);
  assert.deepEqual(browser.writes, []);
  browser.navigate("a"); await settle();
  assert.equal(f.controller.getSnapshot().selected, "a");
  assert.deepEqual(browser.writes, []);
  f.controller.select("b"); await settle();
  assert.deepEqual(browser.writes, ["b"]);
  browser.navigate(null); await settle();
  assert.equal(canInteract(f.controller.getSnapshot()), false);
  f.event({ name: "connection-lost", data: { reason: "taken_over" } });
  assert.equal(browser.stored(), null);
});

test("expired or uncertain refresh recovery preserves selection and requires explicit connection", async (t) => {
  for (const error of [new ApiError(403, "expired"), new Error("network"), new ApiError(404, "old server")]) {
    const browser = browserState("b", { windowId: "original", token: "old" });
    const f = fixture({ restore: async () => { throw error; } }, undefined, browser);
    t.after(() => f.controller.dispose());
    await f.controller.start(); await settle();
    assert.equal(f.controller.getSnapshot().connection, "revoked");
    assert.equal(f.controller.getSnapshot().selected, "b");
    assert.equal(f.controller.getSnapshot().occupied, false);
    assert.equal(browser.stored(), null);
    assert.deepEqual(f.calls, []);
    await f.controller.connect(); await settle();
    assert.deepEqual(f.calls, ["acquire", "catalog", "history-b"]);
  }
});

test("URL targets remain selected when missing, archived or owned elsewhere; no content or claims", async (t) => {
  for (const mode of ["missing", "archived", "foreign", "no-credential"]) {
    const browser = browserState(mode === "missing" ? "absent" : "a", mode === "no-credential" ? null : { windowId: "old", token: "old" });
    const f = fixture({}, undefined, browser); t.after(() => f.controller.dispose());
    if (mode === "archived") f.catalog.sessions[0]!.archived = true;
    if (mode === "foreign") f.catalog.sessions[0]!.ownership!.ownerSourceId = "slack:other";
    await f.controller.start(); await settle();
    assert.equal(f.controller.getSnapshot().selected, mode === "missing" ? "absent" : "a");
    assert.equal(canInteract(f.controller.getSnapshot()), false);
    assert.equal(f.calls.some((call) => /history|binding|acquire|send/.test(call)), false);
    assert.deepEqual(browser.writes, []);
  }
});

test("disposal preserves refresh credentials but detaches browser navigation", async () => {
  const browser = browserState("a", null);
  const f = fixture({}, undefined, browser); await f.controller.connect(); await settle();
  f.controller.dispose();
  assert.deepEqual(browser.stored(), { windowId: "test", token: "fake" });
  browser.navigate("b");
  assert.equal(f.controller.getSnapshot().selected, "a");
});

test("selection without session ownership never reads content or mutates", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.catalog.sessions[0]!.ownership!.ownerSourceId = "slack:other";
  await open(f); f.controller.setDraft("hi"); await f.controller.send();
  assert.equal(f.calls.includes("history-a"), false);
  assert.equal(f.calls.includes("send"), false);
  assert.equal(canInteract(f.controller.getSnapshot()), false);
  assert.equal(f.calls.includes("binding"), false);
});
test("cache cannot reveal content before fresh owned history and decision reads succeed", async (t) => {
  for (const failure of ["not-owned", "history", "decisions"] as const) {
    let loaded = 0;
    const cache: TimelineCache = { load: () => { loaded++; return [{ id: "private", origin: "cache", message: message("cached", "codex") }]; }, save: () => {} };
    const f = fixture({
      ...(failure === "history" ? { history: async () => { throw new ApiError(403, "not owned", "not_owner"); } } : {}),
      ...(failure === "decisions" ? { decisions: async () => { throw new Error("unavailable"); } } : {})
    }, cache);
    t.after(() => f.controller.dispose());
    if (failure === "not-owned") f.catalog.sessions[0]!.ownership!.ownerSourceId = "slack:other";
    await open(f);
    assert.equal(loaded, 0, failure);
    assert.equal(f.controller.getSnapshot().timelines.a, undefined, failure);
    assert.equal(canInteract(f.controller.getSnapshot()), false, failure);
  }
});
test("takeover preserves static content and draft, disables operations and ignores stale reads", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await open(f); f.controller.setDraft("unsent");
  f.event({ name: "connection-lost", data: { reason: "taken_over" } });
  const count = f.calls.length;
  await f.controller.send(); await f.controller.bind("request"); await f.controller.refresh();
  assert.equal(f.calls.length, count);
  assert.equal(f.controller.getSnapshot().drafts.a, "unsent");
  assert.equal(f.controller.getSnapshot().timelines.a!.length, 1);
  assert.equal(f.controller.getSnapshot().connection, "revoked");
  assert.equal(canViewSelectedTimeline(f.controller.getSnapshot()), true);
  assert.equal(canInteract(f.controller.getSnapshot()), false);
});

test("session transfer hides stale timeline even when catalog refresh fails", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await open(f);
  f.api.catalog = async () => { throw new Error("unavailable"); };
  f.event({ name: "session-binding", data: { kind: "transferred", sourceId: "web:local",
    otherSourceId: "slack:team:channel:thread", sessionId: "session-a", threadId: "a",
    directory: "/project", leaseVersion: 2 } });
  await settle();
  const state = f.controller.getSnapshot();
  assert.equal(state.timelines.a!.length, 1);
  assert.equal(state.catalog?.sessions[0]?.ownership?.ownerSourceId, "slack:team:channel:thread");
  assert.equal(state.catalogFresh, false);
  assert.equal(state.ready, false);
  assert.equal(state.viewableSessionId, null);
  assert.equal(canViewSelectedTimeline(state), false);
  assert.equal(canInteract(state), false);
  assert.match(state.catalogError!, /Status is temporarily unavailable/);
  f.event({ name: "connection-lost", data: { reason: "network" } });
  assert.equal(canViewSelectedTimeline(f.controller.getSnapshot()), false);
});

test("binding receipt cannot appear under a session selected while it is pending", async (t) => {
  let finish!: (receipt: Awaited<ReturnType<WorkbenchApi["binding"]>>) => void;
  let target = "";
  const f = fixture({ binding: async (_, threadId) => {
    target = threadId;
    return new Promise((resolve) => { finish = resolve; });
  } });
  t.after(() => f.controller.dispose());
  f.catalog.sessions[0]!.ownership!.ownerSourceId = "slack:other";
  await open(f);
  const binding = f.controller.bind("request");
  f.controller.select("b"); await settle();
  finish({ owned: true, reason: "claimed" });
  await binding;
  assert.equal(target, "a");
  assert.equal(f.controller.getSnapshot().selected, "b");
  assert.equal(f.controller.getSnapshot().feedback, null);
});

test("refused send stays on its origin after selecting another session", async (t) => {
  let finish!: (receipt: Awaited<ReturnType<WorkbenchApi["send"]>>) => void;
  let target = "";
  const f = fixture({ send: async (_, threadId, __, requestId) => {
    target = threadId;
    return new Promise((resolve) => { finish = (receipt) => resolve({ ...receipt, requestId }); });
  } });
  t.after(() => f.controller.dispose()); await open(f);
  f.controller.setDraft("hello");
  const send = f.controller.send();
  assert.equal(isSelectedOperation(f.controller.getSnapshot(), "send"), true);
  f.controller.select("b"); await settle();
  assert.equal(f.controller.getSnapshot().operation?.threadId, "a");
  assert.equal(isSelectedOperation(f.controller.getSnapshot(), "send"), false);
  finish({ accepted: false, requestId: "ignored" });
  await send;
  const state = f.controller.getSnapshot();
  assert.equal(target, "a");
  assert.equal(state.selected, "b");
  assert.equal(state.feedback, null);
  assert.equal(state.timelines.a![1]?.deliveryStatus, "refused");
  assert.equal(state.drafts.a, "hello");
});
test("switching during a slow read ignores its response and never binds or interrupts", async (t) => {
  let resolve!: (value: Awaited<ReturnType<WorkbenchApi["history"]>>) => void;
  const f = fixture({ history: async (_, threadId) => threadId === "a" ? new Promise((done) => { resolve = done; }) :
    { threadId, sessionId: `session-${threadId}`, leaseVersion: 1, messages: [{ role: "assistant", text: "only b" }] } });
  t.after(() => f.controller.dispose());
  await open(f); f.controller.select("b"); await settle();
  resolve({ threadId: "a", sessionId: "session-a", leaseVersion: 1, messages: [{ role: "assistant", text: "late a" }] }); await settle();
  assert.equal(f.controller.getSnapshot().selected, "b");
  assert.equal(f.controller.getSnapshot().timelines.a, undefined);
  assert.equal(f.controller.getSnapshot().timelines.b![0]!.message.body[0]!.type, "markdown");
  assert.equal(f.calls.includes("binding"), false);
});
test("network loss disables actions, without automatically acquiring another window", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  f.disconnect(); await settle();
  assert.equal(f.controller.getSnapshot().connection, "offline");
  assert.equal(canInteract(f.controller.getSnapshot()), false);
  assert.equal(f.calls.filter((call) => call === "acquire").length, 1);
});
test("repeated reconnect clicks recover one stream with the original grant", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose());
  let streams = 0, resumes = 0;
  const events = f.api.events;
  f.api.events = (...args) => { streams++; return events(...args); };
  await open(f); f.disconnect(); await settle();
  let resume!: () => void;
  f.api.resume = async () => { resumes++; await new Promise<void>((done) => { resume = done; }); };
  const first = f.controller.connect(), second = f.controller.connect();
  assert.equal(resumes, 1);
  assert.equal(f.controller.getSnapshot().connection, "connecting");
  resume(); await Promise.all([first, second]); await settle();
  assert.equal(streams, 2);
  assert.equal(f.calls.filter((call) => call === "acquire").length, 1);
  assert.equal(f.controller.getSnapshot().connection, "connected");
});
test("unknown send result is not retried; user remains before live assistant with preserved draft", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  let reject!: (error: Error) => void;
  f.api.send = async () => { f.calls.push("send"); return new Promise((_, no) => { reject = no; }); };
  f.controller.setDraft("hello"); const send = f.controller.send();
  f.event({ name: "message", data: { operation: "send", messageId: "reply", threadId: "a", sessionId: "session-a", leaseVersion: 1, message: message("reply", "codex") } });
  reject(new Error("lost response")); await send;
  const state = f.controller.getSnapshot();
  assert.equal(state.timelines.a![1]!.message.kind, "user");
  assert.equal(state.timelines.a![1]!.deliveryStatus, "unknown");
  assert.equal(state.timelines.a![2]!.message.title, "reply");
  assert.equal(state.drafts.a, "hello");
  assert.equal(f.calls.filter((call) => call === "send").length, 1);
});

test("catalog refreshes never clear or replace an unknown-send warning", async (t) => {
  const f = fixture({ send: async () => { throw new Error("lost response"); } });
  t.after(() => f.controller.dispose()); await open(f);
  f.controller.setDraft("hello"); await f.controller.send();
  const warning = f.controller.getSnapshot().feedback;
  assert.equal(warning?.source, "operation");
  assert.equal(warning?.tone, "error");
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().feedback, warning);
  f.api.catalog = async () => { throw new Error("catalog unavailable"); };
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().feedback, warning);
  assert.match(f.controller.getSnapshot().catalogError!, /Status is temporarily unavailable/);
});

test("connection loss replaces stale operation feedback with one connection warning", async (t) => {
  const f = fixture({ send: async () => { throw new Error("lost response"); } });
  t.after(() => f.controller.dispose()); await open(f);
  f.controller.setDraft("hello"); await f.controller.send();
  assert.equal(f.controller.getSnapshot().feedback?.source, "operation");
  f.event({ name: "connection-lost", data: { reason: "taken_over" } });
  const feedback = f.controller.getSnapshot().feedback;
  assert.equal(feedback?.source, "connection");
  assert.equal(feedback?.tone, "warning");
  assert.match(feedback!.message, /Another browser window took over/);
});

test("directory failures stay on the directory surface", async (t) => {
  const f = fixture({ directory: async () => { throw new Error("path unavailable"); } });
  t.after(() => f.controller.dispose()); await open(f);
  assert.equal(await f.controller.addDirectory("/missing"), null);
  assert.deepEqual(f.controller.getSnapshot().feedback, {
    source: "directory", surface: "directory", tone: "error", message: "path unavailable"
  });
});

test("a mutation timeout releases busy, aborts fetch and keeps the send outcome unknown without retry", async (t) => {
  let aborted = false;
  let sends = 0;
  const f = fixture({ send: async (_, __, ___, ____, _____, ______, signal) => {
    sends++;
    signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } }, undefined, undefined, 5);
  t.after(() => f.controller.dispose()); await open(f);
  f.controller.setDraft("hello"); await f.controller.send();
  const state = f.controller.getSnapshot();
  assert.equal(aborted, true);
  assert.equal(state.operation, null);
  assert.equal(state.timelines.a![1]?.deliveryStatus, "unknown");
  assert.equal(state.drafts.a, "hello");
  assert.match(state.feedback!.message, /Timed out.*result is unknown.*will not resend automatically/i);
  assert.equal(sends, 1);
});

test("UTF-8 request size rejects multibyte text before sending but keeps the 6000-character ASCII limit", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  const originalLength = f.controller.getSnapshot().timelines.a!.length;
  f.controller.setDraft("€".repeat(3000)); await f.controller.send();
  assert.equal(f.calls.includes("send"), false);
  assert.equal(f.controller.getSnapshot().timelines.a!.length, originalLength);
  assert.equal(f.controller.getSnapshot().drafts.a, "€".repeat(3000));
  assert.match(f.controller.getSnapshot().feedback!.message, /UTF-8.*was not sent/);
  f.controller.setDraft("a".repeat(6000)); await f.controller.send();
  assert.equal(f.calls.filter((call) => call === "send").length, 1);
  const accepted = f.controller.getSnapshot();
  assert.equal(accepted.drafts.a, "");
  assert.equal(accepted.timelines.a?.at(-1)?.deliveryStatus, "accepted");
  assert.equal(accepted.feedback, null);
});
test("sending clears an earlier operation notice instead of presenting it as send feedback", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  await f.controller.addDirectory("/other");
  assert.match(f.controller.getSnapshot().feedback!.message, /directory/i);
  f.controller.setDraft("hello"); await f.controller.send();
  assert.equal(f.controller.getSnapshot().feedback, null);
});
test("an unavailable binding remains a human error after catalog refresh", async (t) => {
  const f = fixture({ binding: async () => ({ owned: false, pending: false, reason: "unavailable" }) });
  f.catalog.sessions[0]!.ownership = { state: "unbound", ownerSourceId: null, pendingSourceId: null, version: 1 };
  t.after(() => f.controller.dispose()); await open(f);
  await f.controller.bind("request");
  const state = f.controller.getSnapshot();
  assert.equal(state.feedback?.tone, "error");
  assert.equal(state.feedback?.message, "Binding did not take effect because this session cannot be bound right now. Try again later.");
  assert.equal(state.feedback?.message.includes("unavailable"), false);
});
test("attachment-only sends keep files on refusal and clear them only after acceptance", async (t) => {
  let accept = false;
  const received: Array<readonly File[]> = [];
  const f = fixture({ send: async (_, __, ___, requestId, _____, attachments) => {
    received.push(attachments ?? []);
    return { accepted: accept, requestId };
  } });
  t.after(() => f.controller.dispose()); await open(f);
  const image = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" });
  f.controller.addAttachments([image]);
  await f.controller.send();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.[0], image);
  assert.equal(f.controller.getSnapshot().attachments.a?.[0], image);
  assert.equal(f.controller.getSnapshot().timelines.a?.at(-1)?.deliveryStatus, "refused");
  accept = true;
  await f.controller.send();
  assert.equal(received.length, 2);
  assert.deepEqual(f.controller.getSnapshot().attachments.a, []);
  assert.match(String(f.controller.getSnapshot().timelines.a?.at(-1)?.message.body[0]?.text), /Images: screen\.png/);
});
test("composer drafts restore per session and accepted sends clear persisted text and images", async (t) => {
  const imageA = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
  const imageB = new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" });
  const texts = new Map([["a", "draft a"], ["b", "draft b"]]);
  const files = new Map<string, readonly File[]>([["a", [imageA]], ["b", [imageB]]]);
  const drafts: ComposerDraftStore = {
    loadText: (threadId) => texts.get(threadId) ?? "",
    saveText: (threadId, text) => { if (text) texts.set(threadId, text); else texts.delete(threadId); },
    loadAttachments: async (threadId) => [...files.get(threadId) ?? []],
    saveAttachments: async (threadId, next) => { if (next.length) files.set(threadId, [...next]); else files.delete(threadId); }
  };
  const browser = browserState("a", null);
  const f = fixture({}, undefined, { location: browser.location, grants: browser.grants, drafts });
  t.after(() => f.controller.dispose());
  await settle();
  assert.equal(f.controller.getSnapshot().drafts.a, "draft a");
  assert.equal(f.controller.getSnapshot().attachments.a?.[0]?.name, "a.png");
  f.controller.select("b"); await settle();
  assert.equal(f.controller.getSnapshot().drafts.b, "draft b");
  assert.equal(f.controller.getSnapshot().attachments.b?.[0]?.name, "b.png");
  await f.controller.connect(); await settle();
  f.controller.setDraft("updated b");
  await f.controller.send(); await settle();
  assert.equal(texts.has("b"), false);
  assert.equal(files.has("b"), false);
  assert.equal(texts.get("a"), "draft a");
  assert.equal(files.get("a")?.[0]?.name, "a.png");
});
test("Web composer rejects non-image attachments before sending", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  f.controller.addAttachments([new File(["notes"], "notes.md", { type: "text/markdown" })]);
  assert.deepEqual(f.controller.getSnapshot().attachments.a ?? [], []);
  assert.equal(f.controller.getSnapshot().feedback?.message, "Only PNG, JPEG, WebP, and GIF images are supported.");
});
test("catalog query failure is unavailable, not stale authority", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  f.api.catalog = async () => { throw new Error("unavailable"); };
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().catalogFresh, false);
  assert.equal(canInteract(f.controller.getSnapshot()), false);
  assert.match(f.controller.getSnapshot().catalogError!, /Status is temporarily unavailable/);
});
test("live approval updates arriving during a read win over its older snapshot", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  const pending: MessageSpec = { ...message("Approval", "decision"), decision: { id: "d", state: "pending", requiresUserInput: false,
    requestedFields: [], availableActions: ["accept"], inputAllowed: false } };
  let resolve!: (result: Awaited<ReturnType<WorkbenchApi["decisions"]>>) => void;
  f.api.decisions = async () => new Promise((done) => { resolve = done; });
  const refreshing = f.controller.refresh(); await settle();
  f.event({ name: "message", data: { operation: "edit", messageId: "approval", threadId: "a", sessionId: "session-a", leaseVersion: 1,
    message: { ...pending, decision: { ...pending.decision!, state: "approved", availableActions: [] } } } });
  resolve({ threadId: "a", sessionId: "session-a", leaseVersion: 1, decisions: [pending] }); await refreshing;
  assert.equal(f.controller.getSnapshot().timelines.a!.find((item) => item.message.decision)?.message.decision?.state, "approved");
});
test("timeline preserves original titles and card position, keeps repeated dialogue and only restores five", () => {
  let items = applyMessage([], { operation: "send", messageId: "run", threadId: "t", sessionId: "s", leaseVersion: 1, message: message("Run") });
  items = applyMessage(items, { operation: "send", messageId: "fail", threadId: "t", sessionId: "s", leaseVersion: 1, message: message("Failed", "failed") });
  items = applyMessage(items, { operation: "edit", messageId: "run", threadId: "t", sessionId: "s", leaseVersion: 1, message: message("Run updated") });
  assert.deepEqual(items.map((item) => item.message.title), ["Run updated", "Failed"]);
  const restored = restoreHistory([], { threadId: "t", sessionId: "s", leaseVersion: 1, messages: Array.from({ length: 6 }, () => ({ role: "user", text: "go" })) });
  assert.equal(restored.length, 5);
});
test("history boundary follows the final restored or cached item without inspecting message text", () => {
  const items = [
    { id: "history", origin: "history" as const, message: message("Current-looking title", "codex") },
    { id: "cache", origin: "cache" as const, message: message("Another title", "progress") },
    { id: "live", origin: "live" as const, message: message("History-looking title", "codex") }
  ];
  assert.equal(historyBoundaryIndex(items), 1);
  assert.equal(historyBoundaryIndex(items.slice(2)), -1);
});
test("timeline omits bodyless chat-action shells, removes empty edits and retains native decisions", () => {
  const empty: MessageSpec = { title: "Actions", kind: "actions", body: [], actions: [] };
  const event = { threadId: "t", sessionId: "s", leaseVersion: 1 };
  assert.deepEqual(applyMessage([], { ...event, operation: "send", messageId: "actions", message: empty }), []);

  let items = applyMessage([], { ...event, operation: "send", messageId: "run", message: message("Run") });
  items = applyMessage(items, { ...event, operation: "edit", messageId: "run",
    message: { ...empty, body: [{ type: "text", text: "  \n" }] } });
  assert.deepEqual(items, []);

  const decision: MessageSpec = { ...empty, kind: "decision", decision: { id: "decision", state: "pending",
    requiresUserInput: false, requestedFields: [], availableActions: ["accept"], inputAllowed: false } };
  assert.equal(applyMessage([], { ...event, operation: "send", messageId: "decision", message: decision }).length, 1);
});
test("typed message actions remain in order and send their text without replacing the draft", async (t) => {
  let sentText = "";
  const f = fixture({ send: async (_, __, text, requestId) => {
    sentText = text;
    return { accepted: true, requestId };
  } });
  t.after(() => f.controller.dispose());
  await open(f);
  f.controller.setDraft("keep this draft");
  const action = { id: "continue", label: "Continue", execution: { type: "send-text" as const, text: "continue" } };
  f.event({ name: "message", data: { operation: "send", messageId: "actions", threadId: "a", sessionId: "session-a",
    leaseVersion: 1, message: { title: "Actions", kind: "actions", body: [], actions: [action] } } });
  assert.deepEqual(f.controller.getSnapshot().timelines.a!.at(-1)?.message.actions, [action]);
  await f.controller.actMessage(action);
  assert.equal(sentText, "continue");
  assert.equal(f.controller.getSnapshot().drafts.a, "keep this draft");
  assert.equal(f.controller.getSnapshot().timelines.a!.at(-1)?.message.body[0]?.type, "markdown");
});
test("typed session tools use the structured tool endpoint and append the result to the originating timeline", async (t) => {
  const tools: string[] = [];
  const f = fixture({ sessionTool: async (_, threadId, tool) => {
    tools.push(`${threadId}:${tool}`);
    return { ok: true, message: message(`result-${tool}`, "system") };
  } });
  t.after(() => f.controller.dispose()); await open(f);
  await f.controller.actMessage({ id: "status", label: "Status", execution: { type: "session-tool", tool: "status" } });
  assert.deepEqual(tools, ["a:status"]);
  assert.equal(f.controller.getSnapshot().timelines.a!.at(-1)?.message.title, "result-status");
});
test("running sessions can queue a draft, refresh the ordered queue and cancel an accepted item", async (t) => {
  let entries: Array<{ id: string; summary: string; state: "queued"; createdAt: number }> = [];
  const f = fixture({
    queue: async (_, threadId) => ({ threadId, sessionId: `session-${threadId}`, leaseVersion: 1, running: true,
      entries: structuredClone(entries) }),
    queueSend: async (_, __, text, requestId) => { entries.push({ id: "q1", summary: text, state: "queued", createdAt: 1 });
      return { accepted: true, requestId }; },
    queueCancel: async (_, __, queueId) => { entries = entries.filter((entry) => entry.id !== queueId);
      return { ok: true, message: message("cancelled", "queue") }; }
  });
  t.after(() => f.controller.dispose()); await open(f);
  f.controller.setDraft("after this");
  await f.controller.queueDraft();
  assert.equal(f.controller.getSnapshot().drafts.a, "");
  assert.deepEqual(f.controller.getSnapshot().queues.a?.entries.map((entry) => entry.summary), ["after this"]);
  await f.controller.cancelQueued("q1");
  assert.deepEqual(f.controller.getSnapshot().queues.a?.entries, []);
});
test("creating a session refreshes the catalog and selects only the confirmed new thread", async (t) => {
  const f = fixture({ createSession: async (_, directory) => {
    f.catalog.sessions.push({ threadId: "new", sessionId: "session-new", name: "new", directory, archived: false,
      updatedAt: 1, provider: "test", connection: "active",
      ownership: { state: "active", ownerSourceId: "web:local", pendingSourceId: null, version: 1 } });
    return { threadId: "new", sessionId: "session-new", leaseVersion: 1 };
  } });
  t.after(() => f.controller.dispose()); await open(f);
  assert.equal(await f.controller.createSession("/project"), "new");
  await settle();
  assert.equal(f.controller.getSnapshot().selected, "new");
});
test("background reads and binding notifications do not cancel selection of a newly created session", async (t) => {
  for (const mode of ["refresh", "binding"] as const) {
    const f = fixture({ createSession: async (_, directory) => {
      f.catalog.sessions.push({ threadId: "new", sessionId: "session-new", name: "new", directory, archived: false,
        updatedAt: 1, provider: "test", connection: "active",
        ownership: { state: "active", ownerSourceId: "web:local", pendingSourceId: null, version: 1 } });
      if (mode === "binding") {
        f.event({ name: "session-binding", data: { kind: "acquired", sourceId: "web:local", otherSourceId: null,
          threadId: "new", sessionId: "session-new", directory, leaseVersion: 1 } });
      } else await f.controller.refresh(true);
      await settle();
      return { threadId: "new", sessionId: "session-new", leaseVersion: 1 };
    } });
    t.after(() => f.controller.dispose());
    await open(f);
    assert.equal(await f.controller.createSession("/project"), "new");
    await settle();
    assert.equal(f.controller.getSnapshot().selected, "new", mode);
    assert.equal(canInteract(f.controller.getSnapshot()), true, mode);
  }
});
test("releasing a session keeps its selection but hides conversation access and never reacquires it", async (t) => {
  let releases = 0;
  const f = fixture({ manageSession: async (_, threadId, action) => {
    assert.equal(threadId, "a"); assert.equal(action, "release"); releases++;
    const session = f.catalog.sessions.find((entry) => entry.threadId === threadId)!;
    session.ownership = { state: "unbound", ownerSourceId: null, pendingSourceId: null, version: 2 };
    session.capabilities = { releaseToCodex: false };
    return { ok: true, message: message("released", "system") };
  } });
  f.catalog.sessions[0]!.capabilities = { releaseToCodex: true };
  t.after(() => f.controller.dispose()); await open(f);
  assert.equal(canViewSelectedTimeline(f.controller.getSnapshot()), true);
  f.calls.length = 0;
  assert.equal(await f.controller.manageSession(f.controller.getSnapshot().catalog!.sessions[0]!, "release"), true);
  assert.equal(releases, 1);
  assert.equal(f.controller.getSnapshot().selected, "a");
  assert.equal(canViewSelectedTimeline(f.controller.getSnapshot()), false);
  assert.match(f.controller.getSnapshot().feedback!.message, /will not bind it again automatically/);
  assert.equal(f.calls.includes("binding"), false);
});
test("a completed session creation does not replace a newer user selection", async (t) => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const f = fixture({ createSession: async (_, directory) => {
    await pending;
    f.catalog.sessions.push({ threadId: "new", sessionId: "session-new", name: "new", directory, archived: false,
      updatedAt: 1, provider: "test", connection: "active",
      ownership: { state: "active", ownerSourceId: "web:local", pendingSourceId: null, version: 1 } });
    return { threadId: "new", sessionId: "session-new", leaseVersion: 1 };
  } });
  t.after(() => f.controller.dispose()); await open(f, "a");
  const creation = f.controller.createSession("/project");
  f.controller.select("b");
  resolve();
  assert.equal(await creation, "new");
  assert.equal(f.controller.getSnapshot().selected, "b");
  assert.equal(f.controller.getSnapshot().feedback, null);
});
test("SSE parser supports byte-split Unicode, CRLF, heartbeat and multiple events", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: message\r\ndata: {"text":"café"}\r\n\r\nevent: connection-lost\ndata: {"reason":"taken_over"}\n\n');
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = []; for await (const event of decodeEvents(body)) events.push(event);
  assert.deepEqual(events, [{ name: "message", data: { text: "café" } }, { name: "connection-lost", data: { reason: "taken_over" } }]);
});
test("HTTP credentials stay out of URLs and refused receipts remain usable without retries", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = new HttpWorkbenchApi((async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify({ accepted: false, requestId: "one" }), { status: 422 });
  }) as typeof fetch);
  const grant: Grant = { windowId: "window", token: "test-credential" };
  assert.equal((await api.send(grant, "t", "hi", "one", 1)).accepted, false);
  const file = new File(["file"], "notes.md", { type: "text/markdown" });
  assert.equal((await api.send(grant, "t", "", "two", 1, [file])).accepted, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.includes(grant.token), false);
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), `Bearer ${grant.token}`);
  assert.equal(new Headers(calls[1]!.init.headers).has("content-type"), false);
  const form = calls[1]!.init.body as FormData;
  assert.equal(form.get("threadId"), "t");
  assert.equal((form.get("attachment") as File).name, "notes.md");
});
test("lost window credentials are not treated as session errors", async (t) => {
  const f = fixture(); t.after(() => f.controller.dispose()); await open(f);
  f.api.catalog = async () => { throw new ApiError(403, "lost window"); };
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().connection, "revoked");
});

test("decision actions use guarded receipts in original location, do not retry and cannot run after takeover", async (t) => {
  let decisionCalls = 0, openCard = true;
  const card = { ...message("Approval", "decision"), decision: { id: "d", state: "pending" as const, requiresUserInput: false,
    requestedFields: [], availableActions: ["accept" as const], inputAllowed: false } };
  const f = fixture({ decisions: async (_, threadId) => ({ threadId, sessionId: `session-${threadId}`, leaseVersion: 1, decisions: openCard ? [card] : [] }),
    decision: async (_, __, id) => { decisionCalls++; openCard = false; return { accepted: true, decisionId: id, state: "approved" }; } });
  t.after(() => f.controller.dispose()); await open(f);
  const ids = f.controller.getSnapshot().timelines.a!.map((item) => item.id);
  await f.controller.actDecision("d", "acceptWithExecpolicyAmendment"); assert.equal(decisionCalls, 0);
  await f.controller.actDecision("d", "accept"); assert.equal(decisionCalls, 1);
  assert.deepEqual(f.controller.getSnapshot().timelines.a!.map((item) => item.id), ids);
  assert.equal(f.controller.getSnapshot().timelines.a!.find((item) => item.message.decision)?.message.decision?.state, "approved");
  f.event({ name: "connection-lost", data: { reason: "taken_over" } });
  await f.controller.actDecision("d", "accept"); assert.equal(decisionCalls, 1);
});
test("MCP input waits for JSON required own fields and unknown decision outcome never retries", async (t) => {
  let count = 0;
  const card = { ...message("Input", "decision"), decision: { id: "d", state: "awaitingInput" as const, requiresUserInput: true,
    requestedFields: ["value"], availableActions: ["decline" as const], inputAllowed: true } };
  const f = fixture({ decisions: async (_, threadId) => ({ threadId, sessionId: `session-${threadId}`, leaseVersion: 1, decisions: [card] }),
    decision: async (_, __, ___, action, ____, content) => { count++; assert.equal(action, "submit"); assert.deepEqual(content, { value: "x" }); throw new Error("unknown outcome"); } });
  t.after(() => f.controller.dispose()); await open(f);
  await f.controller.actDecision("d", "submit", {}); assert.equal(count, 0);
  await f.controller.actDecision("d", "submit", Object.create({ value: "x" })); assert.equal(count, 0);
  await f.controller.actDecision("d", "submit", { value: "€".repeat(3000) });
  assert.equal(count, 0); assert.match(f.controller.getSnapshot().feedback!.message, /UTF-8.*was not submitted/);
  await f.controller.actDecision("d", "submit", { value: "x" }); await settle();
  assert.equal(count, 1); assert.match(f.controller.getSnapshot().feedback!.message, /will not retry automatically/);
  f.controller.setDraft("blocked"); await f.controller.send(); assert.equal(f.calls.includes("send"), false);
});
test("removed open card disables old controls without guessing its result or blocking new dialogue", async (t) => {
  let present = true;
  const card = { ...message("Approval", "decision"), decision: { id: "d", state: "pending" as const, requiresUserInput: false,
    requestedFields: [], availableActions: ["accept" as const], inputAllowed: false } };
  const f = fixture({ decisions: async (_, threadId) => ({ threadId, sessionId: `session-${threadId}`, leaseVersion: 1, decisions: present ? [card] : [] }) });
  t.after(() => f.controller.dispose()); await open(f); present = false; await f.controller.refresh();
  const item = f.controller.getSnapshot().timelines.a!.find((entry) => entry.message.decision)!;
  assert.equal(item.message.decision!.state, "pending"); assert.equal(item.openDecision, false);
  f.controller.setDraft("new"); await f.controller.send(); assert.equal(f.calls.includes("send"), true);
});

test("refresh preserves interleaved Run and failed traces, original native IDs and repeated dialogue", () => {
  const history = { threadId: "t", sessionId: "s", leaseVersion: 1, messages: [{ role: "user" as const, text: "go" },
    { role: "assistant" as const, text: "answer" }, { role: "user" as const, text: "go" }] };
  const items = restoreHistory([], history);
  items.splice(1, 0, { id: "run", origin: "live", message: message("Run") });
  items.splice(3, 0, { id: "failed", origin: "live", message: message("Failed", "failed") });
  const ids = items.map((item) => item.id);
  assert.deepEqual(restoreHistory(items, history).map((item) => item.id), ids);
  const withNext = restoreHistory(items, { ...history, messages: [...history.messages, { role: "assistant", text: "next" }] });
  assert.deepEqual(withNext.slice(0, -1).map((item) => item.id), ids);
  assert.equal(withNext.at(-1)!.message.body[0]!.type, "markdown");
});
