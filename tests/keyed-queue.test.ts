import assert from "node:assert/strict";
import test from "node:test";

import { KeyedQueue } from "../src/shared/keyed-queue.js";

test("serializes operations with the same key", async () => {
  const queue = new KeyedQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run("thread", async () => {
    events.push("first:start");
    await firstBlocked;
    events.push("first:end");
  });
  const second = queue.run("thread", async () => {
    events.push("second:start");
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("does not block operations with different keys", async () => {
  const queue = new KeyedQueue();
  const values = await Promise.all([
    queue.run("a", async () => "a"),
    queue.run("b", async () => "b")
  ]);
  assert.deepEqual(values, ["a", "b"]);
});
