import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";

import { WebServer } from "../src/web/server.js";
import type { WebBridgeApi } from "../src/web/bridge-api.js";
import type { SessionBindingEvent } from "../src/bridge/sessions/binding.js";
import { SessionAccessError } from "../src/bridge/sessions/access.js";
import { WebSendError } from "../src/web/bridge-api.js";
import type { WebMessageDelivery } from "../src/web/transport.js";
import { WebDecisionError } from "../src/web/decisions.js";
import type { WebAttentionDelivery } from "../src/web/attention.js";
import { DirectoryRegistrationError } from "../src/bridge/sessions/directory-registry.js";
import { WEB_ATTACHMENT_MAX_FILE_BYTES, WEB_ATTACHMENT_MAX_TOTAL_BYTES } from "../src/web/protocol-limits.js";

test("decision endpoints require grants, strict native actions and JSON objects, not callbacks or custom source", async (t) => {
  const calls: unknown[] = [];
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    readDecisions: async (threadId, leaseVersion, check) => { check(); return {
      snapshot: { threadId, sessionId: "session", leaseVersion: leaseVersion ?? 1, decisions: [] }, assertCurrent: check }; },
    actDecision: async (input, check) => { check(); calls.push(input); return { accepted: true, decisionId: input.decisionId, state: "approved" }; } });
  const body = { threadId: "thread", decisionId: "decision", action: "accept" };
  assert.equal((await post(base, "/api/web/session/decision", body)).status, 403);
  assert.equal((await post(base, "/api/web/session/decisions", { threadId: "thread" })).status, 403);
  const grant = await acquire(base, "window");
  for (const invalid of [{ ...body, action: "arbitrary" }, { ...body, action: "acceptWithExecpolicyAmendment" },
    { ...body, content: {} }, { ...body, action: "submit" }, { ...body, action: "submit", content: [] },
    { ...body, action: "submit", content: null }, { ...body, sourceId: "123" }, { ...body, callbackData: "decision:a" },
    { ...body, leaseVersion: -1 }, { ...body, decisionId: "" }]) {
    assert.equal((await post(base, "/api/web/session/decision", invalid, grant)).status, 400);
  }
  assert.equal((await post(base, "/api/web/session/decisions", { threadId: "thread", sourceId: "123" }, grant)).status, 400);
  assert.deepEqual(await (await post(base, "/api/web/session/decisions", { threadId: "thread" }, grant)).json(),
    { threadId: "thread", sessionId: "session", leaseVersion: 1, decisions: [] });
  const receipt = await post(base, "/api/web/session/decision", body, grant);
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { accepted: true, decisionId: "decision", state: "approved" });
  const form = { ...body, action: "submit", content: { value: "response" } };
  assert.equal((await post(base, "/api/web/session/decision", form, grant)).status, 200);
  assert.deepEqual(calls, [{ ...body, leaseVersion: undefined }, { ...form, leaseVersion: undefined }]);
});

test("decision content is guarded at HTTP delivery, while an accepted action keeps its minimal receipt after takeover", async (t) => {
  let release!: () => void;
  let entered!: () => void;
  let mode = "read";
  let barrier = Promise.resolve();
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    readDecisions: async (threadId, _version, check) => {
      entered(); await barrier;
      return { snapshot: { threadId, sessionId: "private-session", leaseVersion: 1, decisions: [] }, assertCurrent: check };
    }, actDecision: async (input, check) => {
      check(); entered(); await barrier;
      return { accepted: mode === "accepted", decisionId: input.decisionId, state: "approved", message: "private-refusal", assertCurrent: check };
    } });
  for (mode of ["read", "refused", "accepted"]) {
    const grant = await acquire(base, `window-${mode}`, mode !== "read");
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    barrier = new Promise<void>((resolve) => { release = resolve; });
    const pending = post(base, mode === "read" ? "/api/web/session/decisions" : "/api/web/session/decision",
      mode === "read" ? { threadId: "thread" } : { threadId: "thread", decisionId: "d", action: "accept" }, grant);
    await ready;
    await acquire(base, `replacement-${mode}`, true);
    release();
    const response = await pending;
    assert.equal(response.status, mode === "accepted" ? 200 : 403);
    const text = await response.text();
    assert.equal(text.includes("private-"), false);
    if (mode === "accepted") assert.deepEqual(JSON.parse(text), { accepted: true, decisionId: "d", state: "approved" });
  }
});

test("decision typed failures retain their contract, while unknown errors expose their message", async (t) => {
  for (const reason of ["inactive", "invalid_action", "disconnected", "unavailable", "unknown", "refused"] as const) {
    const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }), actDecision: async (input, check) => {
      if (reason === "unknown") throw new Error("private-rpc-and-path");
      if (reason === "refused") return { accepted: false, decisionId: input.decisionId, state: "awaitingInput", message: "Missing fields: value", assertCurrent: check };
      throw new WebDecisionError(reason);
    } });
    const grant = await acquire(base, "window");
    const response = await post(base, "/api/web/session/decision", { threadId: "thread", decisionId: "d", action: "accept" }, grant);
    assert.equal(response.status, { inactive: 409, invalid_action: 400, disconnected: 503, unavailable: 404, unknown: 500, refused: 422 }[reason]);
    const text = await response.text();
    if (reason === "unknown") assert.deepEqual(JSON.parse(text), { error: "private-rpc-and-path" });
    if (reason === "refused") assert.deepEqual(JSON.parse(text), { accepted: false, decisionId: "d", state: "awaitingInput", message: "Missing fields: value" });
  }
});

test("unknown mutation errors without a usable message keep the outcome warning fallback", async (t) => {
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    actDecision: async () => { throw new Error(" \n "); } });
  const grant = await acquire(base, "window");
  const response = await post(base, "/api/web/session/decision", { threadId: "thread", decisionId: "d", action: "accept" }, grant);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Internal Web server error. Operation outcome may be unknown; do not retry automatically."
  });
});

test("missing decision API returns unavailable, without altering the current window", async (t) => {
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }) });
  const grant = await acquire(base, "window");
  assert.equal((await post(base, "/api/web/session/decisions", { threadId: "thread" }, grant)).status, 503);
  assert.equal((await post(base, "/api/web/session/decision", { threadId: "thread", decisionId: "d", action: "accept" }, grant)).status, 503);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(grant) })).status, 200);
});

test("text send requires a grant and strict text-only input, and acknowledges acceptance separately from completion", async (t) => {
  let sends = 0;
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    sendText: async (input, check) => { check(); sends++; return { accepted: true, requestId: input.requestId }; } });
  const body = { threadId: "thread", requestId: "one", text: "hello" };
  assert.equal((await post(base, "/api/web/session/send", body)).status, 403);
  const grant = await acquire(base, "window");
  for (const invalid of [{ ...body, text: " " }, { ...body, text: "x".repeat(6001) }, { ...body, queue: true },
    { ...body, sourceId: "123" }, { ...body, attachments: [] }, { ...body, requestId: "" }, { ...body, leaseVersion: -1 }]) {
    assert.equal((await post(base, "/api/web/session/send", invalid, grant)).status, 400);
  }
  assert.equal(sends, 0);
  const response = await post(base, "/api/web/session/send", body, grant);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, requestId: "one" });
  assert.equal(sends, 1);
});

test("send and queue accept bounded images without trusting browser paths", async (t) => {
  const calls: Array<{ path: string; input: Parameters<NonNullable<WebBridgeApi["sendText"]>>[0] }> = [];
  const bridge: WebBridgeApi = {
    listCatalog: async () => ({ directories: [], sessions: [] }),
    sendText: async (input, check) => { check(); calls.push({ path: "send", input }); return { accepted: true, requestId: input.requestId }; },
    queueText: async (input, check) => { check(); calls.push({ path: "queue", input }); return { accepted: true, requestId: input.requestId }; }
  };
  const { base } = await fixture(t, bridge);
  const grant = await acquire(base, "window");
  for (const [path, requestId] of [["/api/web/session/send", "files"], ["/api/web/session/queue/send", "queued-files"]] as const) {
    const form = new FormData();
    form.set("threadId", "thread"); form.set("leaseVersion", "3"); form.set("requestId", requestId); form.set("text", "");
    form.append("attachment", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      { type: "image/png" }), "../screen shot.png");
    form.append("attachment", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
      { type: "image/jpeg" }), "photo.jpg");
    const response = await fetch(`${base}${path}`, { method: "POST", headers: headers(grant), body: form,
      signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 202);
  }
  assert.deepEqual(calls.map((call) => call.path), ["send", "queue"]);
  for (const { input } of calls) {
    assert.equal(input.text, ""); assert.equal(input.leaseVersion, 3); assert.equal(input.attachments?.length, 2);
    assert.equal(input.attachments?.[0]?.name, "../screen shot.png");
    assert.deepEqual([...(input.attachments?.[0]?.bytes ?? [])], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  const unsupported = new FormData();
  unsupported.set("threadId", "thread"); unsupported.set("requestId", "unsupported"); unsupported.set("text", "");
  unsupported.append("attachment", new Blob(["notes"], { type: "text/markdown" }), "notes.md");
  assert.equal((await fetch(`${base}/api/web/session/send`, { method: "POST", headers: headers(grant), body: unsupported })).status, 400);

  const tooMany = new FormData();
  tooMany.set("threadId", "thread"); tooMany.set("requestId", "too-many"); tooMany.set("text", "");
  for (let index = 0; index < 6; index++) tooMany.append("attachment", new Blob(["x"]), `file-${index}.txt`);
  assert.equal((await fetch(`${base}/api/web/session/send`, { method: "POST", headers: headers(grant), body: tooMany })).status, 400);

  const tooLargeTogether = new FormData();
  tooLargeTogether.set("threadId", "thread"); tooLargeTogether.set("requestId", "too-large-together");
  tooLargeTogether.set("text", "");
  for (const [index, size] of [WEB_ATTACHMENT_MAX_FILE_BYTES, WEB_ATTACHMENT_MAX_FILE_BYTES,
    WEB_ATTACHMENT_MAX_TOTAL_BYTES - 2 * WEB_ATTACHMENT_MAX_FILE_BYTES + 1].entries()) {
    const bytes = new Uint8Array(size); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    tooLargeTogether.append("attachment", new Blob([bytes], { type: "image/png" }), `large-${index}.png`);
  }
  assert.equal((await fetch(`${base}/api/web/session/send`, { method: "POST", headers: headers(grant),
    body: tooLargeTogether, signal: AbortSignal.timeout(10_000) })).status, 400);
  assert.equal(calls.length, 2);
});

test("send refuses revoked windows before mutation but preserves the minimal accepted receipt after mutation", async (t) => {
  let started!: () => void;
  let finish!: () => void;
  let afterDispatch = false;
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }), sendText: async (input, check) => {
    check(); started(); await new Promise<void>((resolve) => { finish = resolve; });
    if (!afterDispatch) check();
    return { accepted: true, requestId: input.requestId };
  } });
  for (const dispatched of [false, true]) {
    afterDispatch = dispatched;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const old = await acquire(base, `old-${dispatched}`, true);
    const request = post(base, "/api/web/session/send", { threadId: "thread", requestId: "one", text: "hello" }, old);
    await ready;
    await acquire(base, `new-${dispatched}`, true);
    finish();
    const response = await request;
    assert.equal(response.status, dispatched ? 202 : 403);
  }
});

test("waiting decisions and disconnected runtime return explicit send errors", async (t) => {
  let reason: "waiting" | "disconnected" = "waiting";
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }), sendText: async () => { throw new WebSendError(reason); } });
  const grant = await acquire(base, "window");
  for (const value of ["waiting", "disconnected"] as const) {
    reason = value;
    const response = await post(base, "/api/web/session/send", { threadId: "thread", requestId: "one", text: "hello" }, grant);
    assert.equal(response.status, value === "waiting" ? 409 : 503);
    assert.equal((await response.json() as { reason: string }).reason, value);
  }
});

test("send refusal rechecks session occupation before returning its content", async (t) => {
  let current = true;
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }), sendText: async (input) => {
    current = false;
    return { accepted: false, requestId: input.requestId,
      prompt: { kind: "error", title: "Private session title", body: [{ type: "text", text: "Private refusal content" }], actions: [] },
      assertCurrent: () => { if (!current) throw new SessionAccessError("stale"); } };
  } });
  const grant = await acquire(base, "window");
  const response = await post(base, "/api/web/session/send", { threadId: "thread", requestId: "one", text: "hello" }, grant);
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes("Private"), false);
});

test("SSE checks both current window and session occupation at each message write", async (t) => {
  const listeners = new Set<(event: WebMessageDelivery) => void>();
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }), subscribeMessages: (listener) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } });
  const grant = await acquire(base, "window");
  const opened = await stream(base, grant);
  const remaining = opened.remaining();
  const event: WebMessageDelivery["event"] = { operation: "send", messageId: "message", sessionId: "session", threadId: "thread", leaseVersion: 1,
    message: { kind: "codex", title: "Codex", body: [{ type: "text", text: "visible" }], actions: [] } };
  for (const listener of listeners) {
    listener({ event: { ...event, messageId: "hidden" }, isCurrent: () => false });
    listener({ event, isCurrent: () => true });
  }
  await post(base, "/api/web/window/release", {}, grant);
  const received = await remaining;
  assert.match(received, /event: message/);
  assert.match(received, /visible/);
  assert.equal(received.includes("hidden"), false);
  assert.equal(listeners.size, 0);
});

test("attention SSE is live-only, ownership-guarded and removed when another window takes over", async (t) => {
  const listeners = new Set<(delivery: WebAttentionDelivery) => void>();
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    subscribeAttention: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  const grant = await acquire(base, "notifications");
  const opened = await stream(base, grant);
  const remaining = opened.remaining();
  const event: WebAttentionDelivery["event"] = { id: "visible", kind: "turn-ended", sessionId: "session", threadId: "thread",
    directory: "/project", name: "Project", leaseVersion: 1 };
  for (const listener of listeners) {
    listener({ event: { ...event, id: "hidden" }, isCurrent: () => false });
    listener({ event, isCurrent: () => true });
  }
  const replacement = await acquire(base, "replacement", true);
  const received = await remaining;
  assert.match(received, /event: attention/);
  assert.match(received, /visible/);
  assert.doesNotMatch(received, /hidden/);
  assert.equal(listeners.size, 0);
  const next = await stream(base, replacement);
  const later = next.remaining();
  await post(base, "/api/web/window/release", {}, replacement);
  assert.doesNotMatch(await later, /event: attention/);
});

test("history requires window credentials, validates its target and returns a guarded content-only payload", async (t) => {
  let reads = 0;
  let finalChecks = 0;
  const history = { threadId: "thread", sessionId: "session", leaseVersion: 3,
    messages: [{ role: "user" as const, text: "hello" }, { role: "assistant" as const, text: "world" }] };
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    readHistory: async (threadId, version, assertCurrent) => {
      assertCurrent(); reads++;
      assert.equal(threadId, "thread"); assert.equal(version, 3);
      return { history, assertCurrent: () => { assertCurrent(); finalChecks++; } };
    } });
  assert.equal((await post(base, "/api/web/session/history", { threadId: "thread" })).status, 403);
  const grant = await acquire(base, "window");
  assert.equal((await post(base, "/api/web/session/history", { threadId: "thread" }, { ...grant, token: "wrong" })).status, 403);
  for (const body of [{}, { threadId: " " }, { threadId: 123 }, { threadId: "x".repeat(257) },
    { threadId: "thread", leaseVersion: -1 }, { threadId: "thread", leaseVersion: "3" },
    { threadId: "thread", leaseVersion: 1.5 }, { threadId: "thread", leaseVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await post(base, "/api/web/session/history", body, grant)).status, 400);
  }
  assert.equal(reads, 0);
  const response = await post(base, "/api/web/session/history", { threadId: "thread", leaseVersion: 3, sourceId: "123" }, grant);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), history);
  assert.equal(reads, 1);
  assert.equal(finalChecks, 1);
});

test("history never sends content after takeover while the reader is awaiting upstream", async (t) => {
  let finish!: () => void;
  let start!: () => void;
  const reading = new Promise<void>((resolve) => { start = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    readHistory: async (_thread, _version, assertCurrent) => {
      start(); await pending;
      return { history: { threadId: "thread", sessionId: "session", leaseVersion: 1,
        messages: [{ role: "assistant", text: "private-conversation" }] }, assertCurrent };
    } });
  const old = await acquire(base, "old");
  const response = post(base, "/api/web/session/history", { threadId: "thread" }, old);
  await reading;
  await acquire(base, "new", true);
  finish();
  const denied = await response;
  assert.equal(denied.status, 403);
  assert.equal((await denied.text()).includes("private-conversation"), false);
});

test("history rechecks session ownership immediately before HTTP delivery and preserves failure contracts", async (t) => {
  for (const reason of ["not_owner", "unavailable", "stale", "internal"] as const) {
    const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
      readHistory: async () => {
        if (reason === "internal") throw new Error("private-upstream-error");
        return { history: { threadId: "thread", sessionId: "session", leaseVersion: 1,
          messages: [{ role: "assistant", text: "private-conversation" }] },
        assertCurrent: () => { throw new SessionAccessError(reason); } };
      } });
    const grant = await acquire(base, "window");
    const denied = await post(base, "/api/web/session/history", { threadId: "thread" }, grant);
    assert.equal(denied.status, { not_owner: 403, unavailable: 404, stale: 409, internal: 500 }[reason]);
    const body = await denied.text();
    if (reason === "internal") assert.deepEqual(JSON.parse(body), { error: "private-upstream-error" });
    else {
      assert.equal(body.includes("private-conversation"), false);
      assert.equal(JSON.parse(body).reason, reason);
    }
  }
});

test("history API unavailable reports 503, without changing the window grant", async (t) => {
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }) });
  const grant = await acquire(base, "window");
  assert.equal((await post(base, "/api/web/session/history", { threadId: "thread" }, grant)).status, 503);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(grant) })).status, 200);
});

type Grant = { windowId: string; token: string; replacedWindowId: string | null };

async function fixture(t: TestContext, bridge?: WebBridgeApi): Promise<{ server: WebServer; base: string }> {
  const server = new WebServer({ host: "127.0.0.1", port: 0 }, bridge);
  const address = await server.start();
  t.after(() => server.stop());
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("catalog requires a window grant and rejects delivery after takeover during a slow read", async (t) => {
  let finish!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { base } = await fixture(t, { listCatalog: async () => {
    started(); await pending; return { directories: ["/private/work"], sessions: [] };
  } });
  assert.equal((await fetch(`${base}/api/web/catalog`)).status, 403);
  const old = await acquire(base, "first");
  const response = fetch(`${base}/api/web/catalog`, { headers: headers(old) });
  await reading;
  await acquire(base, "second", true);
  finish();
  const rejected = await response;
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.text()).includes("private/work"), false);
});

test("directory registration is strict, lease-guarded and maps path errors", async (t) => {
  let finish!: () => void;
  let start!: () => void;
  let writes = 0;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    registerDirectory: async (path, assertCurrent) => {
      if (path === "/missing") throw new DirectoryRegistrationError("not_found", "Directory does not exist.");
      start(); await pending; assertCurrent(); writes++;
      return { directory: path, existing: false };
    } });
  assert.equal((await post(base, "/api/web/directories", { path: "/work" })).status, 403);
  const old = await acquire(base, "old");
  for (const body of [{}, { path: "" }, { path: "/work", extra: true }, { path: "x".repeat(4097) }]) {
    assert.equal((await post(base, "/api/web/directories", body, old)).status, 400);
  }
  const missing = await post(base, "/api/web/directories", { path: "/missing" }, old);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Directory does not exist.", reason: "not_found" });
  const response = post(base, "/api/web/directories", { path: "/work" }, old);
  await started;
  await acquire(base, "new", true);
  finish();
  assert.equal((await response).status, 403);
  assert.equal(writes, 0);
});

test("binding operations require credentials, validate input and recheck after slow upstream work", async (t) => {
  let finish!: () => void;
  let start!: () => void;
  let writes = 0;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    requestBinding: async (_thread, _version, assertCurrent) => {
      start(); await pending; assertCurrent(); writes++; return { session: null, outcome: null };
    }, cancelBinding: async (_thread, _version, assertCurrent) => {
      assertCurrent(); return { cancelled: false, lease: null, reason: "not_pending" };
    } });
  assert.equal((await post(base, "/api/web/session/request", { threadId: "thread" })).status, 403);
  const old = await acquire(base, "old");
  for (const body of [{}, { threadId: "" }, { threadId: "thread", leaseVersion: -1 }, { threadId: "thread", leaseVersion: "1" }]) {
    assert.equal((await post(base, "/api/web/session/request", body, old)).status, 400);
  }
  const response = post(base, "/api/web/session/request", { threadId: "thread" }, old);
  await started;
  const current = await acquire(base, "new", true);
  finish();
  assert.equal((await response).status, 403);
  assert.equal(writes, 0);
  assert.equal((await post(base, "/api/web/session/cancel", { threadId: "thread" }, old)).status, 403);
  assert.deepEqual(await (await post(base, "/api/web/session/cancel", { threadId: "thread" }, current)).json(),
    { cancelled: false, reason: "not_pending", leaseVersion: null });
});

test("session release is a strict typed management action", async (t) => {
  const calls: unknown[] = [];
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }),
    manageSession: async (input, check) => { check(); calls.push(input);
      return { ok: true, message: { kind: "system", title: "Session", body: [], actions: [] } }; } });
  const grant = await acquire(base, "window");
  assert.equal((await post(base, "/api/web/session/manage",
    { threadId: "thread", action: "release", leaseVersion: 3 }, grant)).status, 200);
  for (const invalid of [
    { threadId: "thread", action: "release", leaseVersion: -1 },
    { threadId: "thread", action: "release", name: "not-allowed" },
    { threadId: "thread", action: "release", sourceId: "123" }
  ]) assert.equal((await post(base, "/api/web/session/manage", invalid, grant)).status, 400);
  assert.deepEqual(calls, [{ threadId: "thread", action: "release", leaseVersion: 3 }]);
});

test("SSE binding metadata belongs only to the current grant and removes subscriptions on disconnect", async (t) => {
  const listeners = new Set<(event: SessionBindingEvent) => void>();
  const { base } = await fixture(t, { listCatalog: async () => ({ directories: [], sessions: [] }), subscribeBinding: (listener) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } });
  const old = await acquire(base, "old");
  const one = await stream(base, old);
  const ending = one.remaining();
  const current = await acquire(base, "new", true);
  assert.match(await ending, /taken_over/);
  const two = await stream(base, current);
  const remaining = two.remaining();
  const event: SessionBindingEvent = { kind: "acquired", sourceId: "web:local", otherSourceId: "123", sessionId: "session",
    threadId: "thread", directory: "/work", leaseVersion: 1 };
  for (const listener of listeners) listener(event);
  await post(base, "/api/web/window/release", {}, current);
  const received = await remaining;
  assert.match(received, /event: session-binding/);
  assert.equal(received.includes(current.token), false);
  assert.equal(listeners.size, 0);
});

function headers(grant: Grant): Record<string, string> {
  return { "X-Bridge-Window-Id": grant.windowId, Authorization: `Bearer ${grant.token}` };
}

function post(base: string, path: string, body: unknown, grant?: Grant): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(grant ? headers(grant) : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5_000)
  });
}

async function acquire(base: string, windowId: string, takeover = false): Promise<Grant> {
  const response = await post(base, "/api/web/window/acquire", { windowId, takeover });
  assert.equal(response.status, 200);
  return await response.json() as Grant;
}

async function stream(base: string, grant: Grant): Promise<{
  first: string; remaining: () => Promise<string>; cancel: () => Promise<void>
}> {
  const response = await fetch(`${base}/api/web/events`, {
    headers: headers(grant), signal: AbortSignal.timeout(5_000)
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let first = "";
  while (!first.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    first += decoder.decode(chunk.value, { stream: true });
  }
  return {
    first,
    remaining: async () => {
      let text = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return text + decoder.decode();
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel()
  };
}

test("Web skeleton grants, checks and releases one window without exposing credentials", async (t) => {
  const { base } = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/api/web/health`)).json(), { status: "ok" });
  assert.deepEqual(await (await fetch(`${base}/api/web/connection`)).json(), { holderWindowId: null });
  const grant = await acquire(base, "first");
  assert.ok(grant.token);
  assert.equal(grant.replacedWindowId, null);
  const metadata = await fetch(`${base}/api/web/connection`);
  assert.equal(metadata.headers.get("cache-control"), "no-store");
  assert.deepEqual(await metadata.json(), { holderWindowId: "first" });
  assert.deepEqual(await (await fetch(`${base}/api/web/window`, { headers: headers(grant) })).json(), { windowId: "first" });
  for (const windowId of ["first", "second"]) {
    const denied = await post(base, "/api/web/window/acquire", { windowId });
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), { acquired: false, holderWindowId: "first" });
  }
  assert.equal((await post(base, "/api/web/window/release", {}, { ...grant, token: "wrong" })).status, 403);
  assert.equal((await post(base, "/api/web/window/release", {}, grant)).status, 200);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(grant) })).status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/web/connection`)).json(), { holderWindowId: null });
});

test("explicit takeover closes every old SSE stream and revokes all old actions", { timeout: 5_000 }, async (t) => {
  const { base } = await fixture(t);
  const old = await acquire(base, "first");
  const one = await stream(base, old);
  const two = await stream(base, old);
  assert.match(one.first, /event: connected\ndata: {"windowId":"first"}/);
  assert.equal(one.first.includes(old.token), false);
  const current = await acquire(base, "second", true);
  assert.equal(current.replacedWindowId, "first");
  for (const text of await Promise.all([one.remaining(), two.remaining()])) {
    assert.match(text, /event: connection-lost\ndata: {"reason":"taken_over"}/);
  }
  assert.equal((await fetch(`${base}/api/web/events`, { headers: headers(old) })).status, 403);
  assert.equal((await post(base, "/api/web/window/release", {}, old)).status, 403);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(current) })).status, 200);
});

test("refresh restoration rotates once, closes old streams and rejects copied credentials", { timeout: 5_000 }, async (t) => {
  const { base } = await fixture(t);
  assert.equal((await post(base, "/api/web/window/restore", {})).status, 403);
  const original = await acquire(base, "tab");
  const oldStream = await stream(base, original);
  const ending = oldStream.remaining();
  const responses = await Promise.all([post(base, "/api/web/window/restore", {}, original), post(base, "/api/web/window/restore", {}, original)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
  const current = await responses.find((response) => response.status === 200)!.json() as Grant;
  assert.equal(current.windowId, original.windowId);
  assert.notEqual(current.token, original.token);
  assert.match(await ending, /"reason":"restored"/);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(original) })).status, 403);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(current) })).status, 200);
  const next = await acquire(base, "other", true);
  assert.equal((await post(base, "/api/web/window/restore", {}, current)).status, 403);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(next) })).status, 200);
  await post(base, "/api/web/window/release", {}, next);
  assert.equal((await post(base, "/api/web/window/restore", {}, next)).status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/web/connection`)).json(), { holderWindowId: null });
});

test("disconnect preserves the grant; release closes SSE and reconnect never reacquires", { timeout: 5_000 }, async (t) => {
  const { base } = await fixture(t);
  const grant = await acquire(base, "window");
  const first = await stream(base, grant);
  await first.cancel();
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(grant) })).status, 200);
  const second = await stream(base, grant);
  assert.equal((await post(base, "/api/web/window/release", {}, grant)).status, 200);
  assert.match(await second.remaining(), /"reason":"released"/);
  assert.equal((await fetch(`${base}/api/web/events`, { headers: headers(grant) })).status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/web/connection`)).json(), { holderWindowId: null });
});

test("shutdown closes live streams and restart does not preserve connection credentials", { timeout: 5_000 }, async (t) => {
  const { base, server } = await fixture(t);
  const grant = await acquire(base, "window");
  const events = await stream(base, grant);
  const ending = events.remaining();
  await server.stop();
  assert.match(await ending, /"reason":"server_stopped"/);
  const address = await server.start();
  const restartedBase = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${restartedBase}/api/web/window`, { headers: headers(grant) })).status, 403);
  assert.deepEqual(await (await fetch(`${restartedBase}/api/web/connection`)).json(), { holderWindowId: null });
});

test("same window takeover rotates credentials and malformed acquisition cannot steal a connection", async (t) => {
  const { base } = await fixture(t);
  const old = await acquire(base, "same");
  for (const body of [{ windowId: " " }, { windowId: "a".repeat(129) }, { windowId: "same", takeover: "true" }, null, []]) {
    assert.equal((await post(base, "/api/web/window/acquire", body)).status, 400);
  }
  const current = await acquire(base, "same", true);
  assert.notEqual(current.token, old.token);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(old) })).status, 403);
});

test("browser-origin and Host guards reject cross-origin changes and DNS rebinding", async (t) => {
  const { base } = await fixture(t);
  const grant = await acquire(base, "safe");
  for (const extra of [{ Origin: "https://attacker.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
    const response = await fetch(`${base}/api/web/window/acquire`, {
      method: "POST", headers: { "Content-Type": "application/json", ...extra },
      body: JSON.stringify({ windowId: "attacker", takeover: true })
    });
    assert.equal(response.status, 403, JSON.stringify(extra));
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  // Fetch may ignore a supplied Host header; send the exact authority via node:http.
  for (const host of ["attacker.example", "localhost:1", `attacker@${base.slice(7)}`]) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/api/web/health`, { headers: { Host: host } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(status, 403, host);
  }
  const sameOrigin = await fetch(`${base}/api/web/window`, { headers: { ...headers(grant), Origin: base } });
  assert.equal(sameOrigin.status, 200);
  assert.equal((await fetch(`${base}/api/web/window/release`, { method: "OPTIONS", headers: { Origin: base } })).status, 404);
});

test("rejects wrong media, invalid JSON, large and unknown requests without granting a lease", async (t) => {
  const { base } = await fixture(t);
  for (const [body, contentType, status] of [
    ['{"windowId":"bad"}', "text/plain", 415],
    ["{", "application/json", 400],
    [JSON.stringify({ windowId: "bad", extra: "x".repeat(9_000) }), "application/json", 413]
  ] as const) {
    assert.equal((await fetch(`${base}/api/web/window/acquire`, {
      method: "POST", headers: { "Content-Type": contentType }, body
    })).status, status);
  }
  assert.equal((await fetch(`${base}/api/web/sessions`)).status, 404);
  assert.equal((await fetch(`${base}/api/web/window?token=not-a-credential&windowId=bad`)).status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/web/connection`)).json(), { holderWindowId: null });
});

test("a stale release whose body finishes after takeover cannot release the new holder", { timeout: 5_000 }, async (t) => {
  const { base } = await fixture(t);
  const old = await acquire(base, "first");
  const pending = httpRequest(`${base}/api/web/window/release`, {
    method: "POST", headers: { ...headers(old), "Content-Type": "application/json" }
  });
  const released = new Promise<number>((resolve, reject) => {
    pending.once("error", reject);
    pending.once("response", (response) => { response.resume(); resolve(response.statusCode!); });
  });
  pending.write("{");
  const current = await acquire(base, "second", true);
  pending.end("}");
  assert.equal(await released, 403);
  assert.equal((await fetch(`${base}/api/web/window`, { headers: headers(current) })).status, 200);
});

test("aborted request bodies neither crash the listener nor acquire a grant", { timeout: 5_000 }, async (t) => {
  const { base } = await fixture(t);
  const pending = httpRequest(`${base}/api/web/window/acquire`, {
    method: "POST", headers: { "Content-Type": "application/json" }
  });
  pending.on("error", () => {});
  await new Promise<void>((resolve) => pending.write('{"windowId":"aborted"', () => resolve()));
  // Keep the partial POST open during a second request, then disconnect it.
  assert.equal((await fetch(`${base}/api/web/health`)).status, 200);
  const closed = new Promise<void>((resolve) => pending.once("close", resolve));
  pending.destroy();
  await closed;
  assert.deepEqual(await (await fetch(`${base}/api/web/connection`)).json(), { holderWindowId: null });
});
