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

test("idle waiting includes later operations and can be cancelled without releasing the queue", async () => {
  const queue = new KeyedQueue(), controller = new AbortController();
  let release!: () => void;
  const first = queue.run("a", () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(setImmediate);
  const cancelled = queue.waitForIdle("a", controller.signal);
  controller.abort(); assert.equal(await cancelled, false);
  assert.equal(await queue.waitForIdle("b"), true);
  let idle = false;
  const waiting = queue.waitForIdle("a").then(() => { idle = true; });
  let releaseSecond!: () => void;
  const second = queue.run("a", () => new Promise<void>(resolve => { releaseSecond = resolve; }));
  release(); await first; await new Promise(setImmediate); assert.equal(idle, false);
  releaseSecond(); await second; await waiting; assert.equal(idle, true);
});
