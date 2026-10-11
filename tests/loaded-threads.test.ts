import assert from "node:assert/strict";
import test from "node:test";

import { extractLoadedThreads, extractLoadedThreadsStatus } from "../src/codex/catalog-extractors.js";

test("loaded-thread extraction accepts the native string-id response", () => {
  const response = { data: ["thread-a", "thread-a", "thread-b"], nextCursor: null };
  assert.deepEqual(extractLoadedThreads(response), {
    total: 3,
    threadIds: ["thread-a", "thread-b"]
  });
  assert.deepEqual(extractLoadedThreadsStatus(response, "thread-b"), {
    total: 3,
    activeLoaded: true
  });
  assert.equal(extractLoadedThreadsStatus(response, "thread-c")?.activeLoaded, false);
});

test("loaded-thread extraction keeps compatibility with object responses", () => {
  assert.deepEqual(extractLoadedThreads({ threads: [{ id: "thread-a" }, { threadId: "thread-b" }] }), {
    total: 2,
    threadIds: ["thread-a", "thread-b"]
  });
  assert.equal(extractLoadedThreads({ data: "invalid" }), null);
});
