import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";

import { SessionDecisionOperationQueue } from "../src/bridge/decisions/session-operation-queue.js";

test("session decision operations serialize per session and remain concurrent across sessions", async () => {
  const queue = new SessionDecisionOperationQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = queue.run("session-a", async () => {
    events.push("a:first:start");
    await firstGate;
    events.push("a:first:end");
  });
  const second = queue.run("session-a", async () => { events.push("a:second"); });
  const other = queue.run("session-b", async () => { events.push("b:first"); });

  await tick();
  assert.deepEqual(events, ["a:first:start", "b:first"]);
  releaseFirst?.();
  await Promise.all([first, second, other]);
  assert.deepEqual(events, ["a:first:start", "b:first", "a:first:end", "a:second"]);
});

test("failed session decision operations do not block the next operation", async () => {
  const queue = new SessionDecisionOperationQueue();
  await assert.rejects(queue.run("session", async () => { throw new Error("failed"); }), /failed/);

  let completed = false;
  await queue.run("session", async () => { completed = true; });
  assert.equal(completed, true);
});
