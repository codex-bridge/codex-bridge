import assert from "node:assert/strict";
import test from "node:test";

import { WebWindowLeaseManager } from "../src/web/window-lease.js";

test("one manager grants one window, without exposing its token to other windows", () => {
  const manager = new WebWindowLeaseManager();
  assert.equal(manager.getHolderWindowId(), null);
  const first = manager.acquire("window-a");
  assert.equal(first.acquired, true);
  if (!first.acquired) throw new Error("Expected first grant.");
  assert.equal(first.replacedWindowId, null);
  assert.equal(manager.getHolderWindowId(), "window-a");
  assert.equal(first.lease.signal.aborted, false);
  assert.equal(Object.isFrozen(first.lease), true);
  assert.deepEqual(manager.acquire("window-b"), { acquired: false, holderWindowId: "window-a" });
  // A caller-provided window ID alone does not authenticate a reconnect.
  assert.deepEqual(manager.acquire("window-a"), { acquired: false, holderWindowId: "window-a" });
  assert.equal(manager.resume("window-a", "wrong-token"), null);
  assert.equal(manager.resume("window-b", first.lease.token), null);
  assert.equal(manager.resume("window-a", first.lease.token), first.lease);
});

test("explicit takeover invalidates old credentials and closes their streams immediately", () => {
  const manager = new WebWindowLeaseManager();
  const first = manager.acquire("window-a");
  if (!first.acquired) throw new Error("Expected first grant.");
  let abortCount = 0;
  first.lease.signal.addEventListener("abort", () => {
    abortCount++;
    assert.equal(manager.getHolderWindowId(), "window-b");
    assert.equal(manager.resume("window-a", first.lease.token), null);
  });
  const second = manager.acquire("window-b", { takeover: true });
  if (!second.acquired) throw new Error("Expected takeover grant.");
  assert.equal(second.replacedWindowId, "window-a");
  assert.notEqual(second.lease.token, first.lease.token);
  assert.equal(abortCount, 1);
  assert.equal(first.lease.signal.reason, "taken_over");
  assert.equal(second.lease.signal.aborted, false);
  assert.equal(manager.isHolder("window-a", first.lease.token), false);
  assert.equal(manager.release("window-a", first.lease.token), false);
  assert.deepEqual(manager.acquire("window-a"), { acquired: false, holderWindowId: "window-b" });
  assert.equal(manager.resume("window-b", second.lease.token), second.lease);
});

test("a new grant to the same window still invalidates its old token", () => {
  const manager = new WebWindowLeaseManager();
  const first = manager.acquire("window-a");
  if (!first.acquired) throw new Error("Expected first grant.");
  const second = manager.acquire("window-a", { takeover: true });
  if (!second.acquired) throw new Error("Expected replacement grant.");
  assert.notEqual(second.lease.token, first.lease.token);
  assert.equal(first.lease.signal.aborted, true);
  assert.equal(manager.resume("window-a", first.lease.token), null);
  assert.equal(manager.release("window-a", first.lease.token), false);
  assert.equal(manager.isHolder("window-a", second.lease.token), true);
});

test("release is credential-checked and reconnect cannot re-acquire an empty grant", () => {
  const manager = new WebWindowLeaseManager();
  const first = manager.acquire("window-a");
  if (!first.acquired) throw new Error("Expected first grant.");
  assert.equal(manager.release("window-b", first.lease.token), false);
  assert.equal(manager.release("window-a", "wrong-token"), false);
  assert.equal(first.lease.signal.aborted, false);
  assert.equal(manager.release("window-a", first.lease.token), true);
  assert.equal(first.lease.signal.reason, "released");
  assert.equal(manager.getHolderWindowId(), null);
  assert.equal(manager.release("window-a", first.lease.token), false);
  assert.equal(manager.resume("window-a", first.lease.token), null);
  const next = manager.acquire("window-b");
  assert.equal(next.acquired, true);
});

test("window rights are in-memory and cannot be restored across a service restart", () => {
  const oldManager = new WebWindowLeaseManager();
  const grant = oldManager.acquire("window-a");
  if (!grant.acquired) throw new Error("Expected first grant.");
  const restarted = new WebWindowLeaseManager();
  assert.equal(restarted.getHolderWindowId(), null);
  assert.equal(restarted.resume("window-a", grant.lease.token), null);
  assert.equal(restarted.acquire("window-b").acquired, true);
});

test("invalid window IDs cannot take over a valid grant", () => {
  const manager = new WebWindowLeaseManager();
  const grant = manager.acquire("window-a");
  if (!grant.acquired) throw new Error("Expected first grant.");
  for (const windowId of ["", " ", "\n\t"]) {
    assert.throws(() => manager.acquire(windowId, { takeover: true }), /window ID is required/);
  }
  assert.equal(manager.isHolder("window-a", grant.lease.token), true);
});

test("page restoration consumes credentials, revokes streams and cannot acquire a missing grant", () => {
  const manager = new WebWindowLeaseManager();
  const result = manager.acquire("tab");
  if (!result.acquired) throw new Error("Expected grant.");
  assert.equal(manager.restore("other", result.lease.token), null);
  assert.equal(manager.restore("tab", "wrong"), null);
  const restored = manager.restore("tab", result.lease.token)!;
  assert.equal(restored.windowId, "tab");
  assert.notEqual(restored.token, result.lease.token);
  assert.equal(result.lease.signal.reason, "restored");
  assert.equal(manager.restore("tab", result.lease.token), null);
  assert.equal(manager.resume("tab", result.lease.token), null);
  assert.equal(manager.resume("tab", restored.token), restored);
  manager.release("tab", restored.token);
  assert.equal(manager.restore("tab", restored.token), null);
  assert.equal(manager.getHolderWindowId(), null);
  assert.equal(new WebWindowLeaseManager().restore("tab", restored.token), null);
});
