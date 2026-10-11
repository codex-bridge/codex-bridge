import assert from "node:assert/strict";
import test from "node:test";

import { SessionMenuSnapshotCache } from "../src/bridge/sessions/menu-snapshots.js";

test("session menu snapshots expire without exposing stale menus", () => {
  let now = 1_000;
  const cache = new SessionMenuSnapshotCache({ ttlMs: 100, now: () => now });
  cache.set("chat", { discoveredCount: 1, hiddenCount: 0, groups: [] });

  assert.equal(cache.getFresh("chat")?.expiresAt, 1_100);
  now = 1_099;
  assert.equal(cache.getFresh("chat")?.discoveredCount, 1);
  now = 1_100;
  assert.equal(cache.getFresh("chat"), null);
});

test("session menu snapshots clear every chat together", () => {
  const cache = new SessionMenuSnapshotCache();
  cache.set("chat-a", { discoveredCount: 1, hiddenCount: 0, groups: [] });
  cache.set("chat-b", { discoveredCount: 2, hiddenCount: 0, groups: [] });

  cache.clear();

  assert.equal(cache.getFresh("chat-a"), null);
  assert.equal(cache.getFresh("chat-b"), null);
});
