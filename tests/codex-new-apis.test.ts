import assert from "node:assert/strict";
import test from "node:test";
import { CodexThreadSearchApi } from "../src/codex/thread-search-api.js";
import { CodexProviderApi } from "../src/codex/provider-api.js";
import { CodexRealtimeHistoryApi } from "../src/codex/realtime-history-api.js";
import { extractErrorEvent, extractTurnLifecycleEvent } from "../src/codex/notification-events.js";
import type { AppServerNotification } from "../src/codex/client.js";
import { CodexThreadListApi } from "../src/codex/thread-list-api.js";

test("stream search isolates connection request IDs, preserves provisional order and returns the authoritative page", async () => {
  let listener: (event: AppServerNotification) => void = () => {};
  let detached = false;
  const partials: string[][] = [];
  const row = (id: string) => ({ thread: { id, cwd: "/project", name: id }, snippet: "Match" });
  const api = new CodexThreadSearchApi({ connect: async () => {},
    onNotification: callback => { listener = callback; return () => { detached = true; }; },
    request: async (method, _params, options) => {
      assert.equal(method, "thread/search/stream"); options?.onRequestId?.(7);
      listener({ method: "thread/search/partial", params: { requestId: 8, data: [row("other")] } });
      listener({ method: "thread/search/partial", params: { requestId: 7, data: [row("provisional")] } });
      return { data: [row("final")], nextCursor: "page-two" };
    } });
  const result = await api.search("match", { onPartial: rows => partials.push(rows.map(row => row.threadId)) });
  assert.deepEqual(partials, [["provisional"]]);
  assert.deepEqual(result.data.map(row => row.threadId), ["final"]);
  assert.equal(result.nextCursor, "page-two"); assert.equal(detached, true);
});

test("search cancellation targets its actual request once and releases listeners even when cancel fails", async () => {
  const abort = new AbortController(); let detached = false, cancelCalls = 0;
  const api = new CodexThreadSearchApi({ connect: async () => {}, onNotification: () => () => { detached = true; },
    request: async (method, params, options) => {
      if (method.endsWith("/cancel")) { cancelCalls++; assert.deepEqual(params, { requestId: 0 }); throw new Error("disconnected"); }
      options?.onRequestId?.(0);
      abort.abort();
      return { data: [], nextCursor: null };
    } });
  await assert.rejects(api.search("match", { signal: abort.signal }), /abort/i);
  assert.equal(cancelCalls, 1); assert.equal(detached, true);
  await assert.rejects(api.search(" "), /Search must/);
});

test("nonstreaming search cancellation uses its own endpoint", async () => {
  const abort = new AbortController(), calls: string[] = [];
  const api = new CodexThreadSearchApi({ connect: async () => {}, onNotification: () => () => {},
    request: async (method, params, options) => {
      calls.push(method);
      if (method === "thread/search/cancel") { assert.deepEqual(params, { requestId: "plain" }); return {}; }
      options?.onRequestId?.("plain"); abort.abort(); return { data: [] };
    } });
  await assert.rejects(api.search("match", { stream: false, signal: abort.signal }), /abort/i);
  assert.deepEqual(calls, ["thread/search", "thread/search/cancel"]);
});

test("targeted thread metadata filtering stays unchanged across every page", async () => {
  const calls: Record<string, unknown>[] = [];
  const api = new CodexThreadListApi({ connect: async () => {}, requestKnownMethod: async () => ({}),
    request: async (_method, params) => { calls.push(params as Record<string, unknown>); return {
      data: [{ id: calls.length === 1 ? "a" : "b", cwd: "/project" }], nextCursor: calls.length === 1 ? "next" : null }; } });
  await api.listThreadsForCwd(undefined, { includedThreadIds: ["a", "b"] });
  assert.deepEqual(calls.map(call => call.includedThreadIds), [["a", "b"], ["a", "b"]]);
  assert.deepEqual(calls.map(call => call.cursor), [null, "next"]);
  await assert.rejects(api.listThreadsForCwd(undefined, { includedThreadIds: Array.from({length:101}, (_,i) => String(i)) }), /at most 100/);
});

test("provider settings validate Codex capabilities and recheck authorization at the write boundary", async () => {
  const calls: string[] = []; let allowed = true;
  const api = new CodexProviderApi({ connect: async () => {}, request: async method => {
    calls.push(method);
    if (method === "modelProvider/list") return { defaultProviderId: "first", canChangeDefault: true,
      data: [{ id: "first", name: "First", settings: { private: "not returned" } }, { id: "second", name: "Second" }] };
    return {};
  } });
  const guard = () => { if (!allowed) throw new Error("revoked"); };
  assert.deepEqual((await api.list()).data[0], { id: "first", name: "First" });
  await api.setDefault("second", guard);
  allowed = false;
  await assert.rejects(api.setDefault("first", guard), /revoked/);
  await assert.rejects(api.setDefault("missing", guard), /not present/);
  assert.equal(calls.filter(method => method.endsWith("/set")).length, 1);
});

test("realtime history preserves pending coverage and snapshot pagination without exposing frame payloads", async () => {
  let expected: unknown;
  const api = new CodexRealtimeHistoryApi({ connect: async () => {}, request: async (_method, params) => {
    expected = params;
    return { coverage: "pending", nextCursor: "next", snapshotEnd: 7, projectedThroughItemIndex: 3, data: [
      { position: 1, item: { id: "frame", realtimeSessionId: "voice", type: "frame", channels: { secret: "omit" } } },
      { position: 2, item: { id: "text", realtimeSessionId: "voice", type: "transcriptSegment", role: "user", text: "Hello" } }
    ] };
  } });
  const page = await api.read("thread", { cursor: "cursor", snapshotEnd: 7 });
  assert.deepEqual(expected, { threadId: "thread", cursor: "cursor", snapshotEnd: 7, limit: 50 });
  assert.equal(page.coverage, "pending"); assert.equal(page.nextCursor, "next");
  assert.equal(page.data[1]!.text, "Hello"); assert.doesNotMatch(JSON.stringify(page), /secret|omit/);
});

test("new error classifications retain public explanations on both error paths without exposing private instructions", () => {
  const error = { message: "Quota", codexErrorInfo: "projectSpendLimitExceeded", additionalDetails: "Ask the project owner.",
    misalignment: { detailedExplanation: "Public explanation", steer: "private instruction" }, internal: { secret: "omit" } };
  const event = extractErrorEvent({ method: "error", params: { threadId: "thread", error } });
  const terminal = extractTurnLifecycleEvent({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "failed", error } } });
  assert.deepEqual(event?.details, ["Project spend limit reached", "Ask the project owner.", "Public explanation"]);
  assert.deepEqual(terminal?.errorDetails, event?.details);
  assert.doesNotMatch(JSON.stringify([event, terminal]), /private|secret|omit/);
});
