import assert from "node:assert/strict";
import test from "node:test";

import { CodexThreadMetadataCache } from "../src/codex/thread-metadata-cache.js";
import type { ListedCodexThread } from "../src/codex/thread-list-api.js";

function thread(threadId: string): ListedCodexThread {
  return {
    threadId,
    updatedAt: 20,
    createdAt: 10,
    name: "thread name",
    preview: null,
    pathKey: "/tmp/rollout.jsonl",
    currentCwd: "/tmp",
    archivedAt: null
  };
}

test("thread metadata cache expires instead of becoming persistent state", () => {
  let now = 1_000;
  const cache = new CodexThreadMetadataCache(60_000, () => now);

  cache.replace([thread("thread-1")]);
  assert.equal(cache.get("thread-1")?.name, "thread name");

  now += 60_000;
  assert.equal(cache.get("thread-1"), null);
});

test("thread metadata refresh replaces stale entries", () => {
  const cache = new CodexThreadMetadataCache(60_000, () => 1_000);
  cache.replace([thread("thread-1")]);
  cache.replace([thread("thread-2")]);

  assert.equal(cache.get("thread-1"), null);
  assert.equal(cache.get("thread-2")?.currentCwd, "/tmp");
});

test("thread name updates preserve the rest of cached metadata", () => {
  const cache = new CodexThreadMetadataCache(60_000, () => 1_000);
  cache.replace([thread("thread-1")]);

  cache.setName("thread-1", "renamed");

  assert.equal(cache.get("thread-1")?.name, "renamed");
  assert.equal(cache.get("thread-1")?.currentCwd, "/tmp");
});
