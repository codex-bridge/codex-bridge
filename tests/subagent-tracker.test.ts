import assert from "node:assert/strict";
import test from "node:test";
import { SubagentTracker } from "../src/bridge/notifications/subagent-tracker.js";
const start = (threadId: string, id: string) => ({ method: "turn/started", params: { threadId, turn: { id } } });
const bind = (turnId = "p1", kind = "started") => ({ method: "item/completed", params: {
  threadId: "parent", turnId, item: { type: "subAgentActivity", id: `bind-${turnId}-${kind}`, kind,
    agentThreadId: "child", agentPath: "/root/check" } } });
const message = { method: "item/completed", params: { threadId: "child", turnId: "c1",
  item: { type: "agentMessage", id: "m1", text: "result" } } };
test("early child events inherit the originating parent turn, not later active session", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "session-A");
  tracker.observe(start("child", "c1"));
  tracker.observe(message);
  const out = tracker.observe(bind(), "session-B");
  assert.equal(out.deliveries.length, 2);
  assert.ok(out.deliveries.every((d) => d.route.sessionId === "session-A"));
  assert.equal(tracker.observe(message).deliveries.length, 0);
});
test("closing a completed agent does not overwrite its completed turn", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind());
  tracker.observe(start("child", "c1"));
  const result = tracker.observe({ method: "turn/completed", params: { threadId: "child", turn: { id: "c1", status: "completed" } } });
  tracker.observe(bind("p1", "interrupted"));
  assert.equal(tracker.summary(result.deliveries[0]!.route), "Observed subagent turns: 1 completed.");
});
test("reused child routes new execution to the new parent turn", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind()); tracker.observe(start("child", "c1"));
  tracker.observe(start("parent", "p2"), "B"); tracker.observe(bind("p2"));
  const result = tracker.observe(start("child", "c2"));
  assert.equal(result.deliveries[0]!.route.sessionId, "B");
  assert.equal(tracker.observe(message).deliveries[0]!.route.sessionId, "A");
});
test("reset drops ownership and old events cannot be sent to new chats", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind());
  tracker.reset();
  assert.equal(tracker.route("child"), undefined);
  assert.deepEqual(tracker.observe(message).deliveries, []);
});
test("expired early events produce a gap notice after reliable association", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A", 0);
  tracker.observe(message, undefined, 0);
  tracker.observe(bind(), undefined, 20_000);
  const result = tracker.observe(start("child", "c1"), undefined, 20_001);
  assert.equal(result.deliveries[0]!.event.method, "bridge/subagent/gap");
});

test("missing start still forwards completed output with an explicit gap", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind());
  const result = tracker.observe(message);
  assert.equal(result.deliveries[0]!.event.method, "bridge/subagent/gap");
  assert.equal(result.deliveries[1]!.event, message);
});

test("summary is a snapshot and cannot jump ahead of queued output", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind());
  const result = tracker.observe(start("child", "c1"));
  tracker.observe({ method: "turn/completed", params: { threadId: "child", turn: { id: "c1", status: "completed" } } });
  assert.equal(result.deliveries[0]!.summary, "Observed subagent turns: 1 running.");
});

test("thread-scoped errors without a turn id are not dropped", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind());
  const result = tracker.observe({ method: "error", params: { threadId: "child", error: { message: "offline" } } });
  assert.equal(result.deliveries[0]!.event.method, "error");
});

test("reused child waits for a fresh delegation before routing a new turn", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind()); tracker.observe(start("child", "c1"));
  assert.deepEqual(tracker.observe(start("child", "c2")).deliveries, []);
  assert.equal(tracker.route("child", "c2"), undefined);
  tracker.observe(start("parent", "p2"), "B");
  const result = tracker.observe(bind("p2"));
  assert.equal(result.deliveries[0]!.route.sessionId, "B");
});

test("child communication with its parent is not nested delegation", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A"); tracker.observe(bind()); tracker.observe(start("child", "c1"));
  const result = tracker.observe({ method: "item/completed", params: { threadId: "child", turnId: "c1",
    item: { id: "message-parent", type: "subAgentActivity", kind: "interacted", agentThreadId: "parent", agentPath: "/root" } } });
  assert.deepEqual(result.deliveries, []);
  assert.equal(tracker.route("parent"), undefined);
});

test("early cache overflow is bounded and leaves an explicit coverage marker", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A", 0);
  for (let i = 0; i < 200; i++) tracker.observe({ ...message,
    params: { ...message.params, item: { ...message.params.item, id: `m${i}`, text: "x".repeat(3000) } }
  }, undefined, 0);
  const result = tracker.observe(bind(), undefined, 1);
  assert.ok(result.deliveries.length < 128);
  assert.equal(result.deliveries[0]!.event.method, "bridge/subagent/gap");
  assert.match(result.deliveries.at(-1)!.summary!, /Coverage is incomplete/);
});

function bindChild(index: number) {
  const event = bind();
  return { ...event, params: { ...event.params,
    item: { ...event.params.item, id: `bind-${index}`, agentThreadId: `child-${index}` } } };
}

test("completed child slots are reclaimed across more than 128 agents", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A");
  for (let i = 0; i < 300; i++) {
    tracker.observe(bindChild(i));
    const started = tracker.observe(start(`child-${i}`, `turn-${i}`));
    assert.equal(started.deliveries.at(-1)!.event.method, "turn/started");
    tracker.observe({ method: "turn/completed", params: { threadId: `child-${i}`, turn: { id: `turn-${i}`, status: "completed" } } });
  }
  assert.ok(tracker.route("child-299"));
  assert.match(tracker.summary(tracker.route("child-299")!), /Coverage is incomplete/);
});

test("active capacity overflow warns once and does not evict running agents", () => {
  const tracker = new SubagentTracker();
  tracker.observe(start("parent", "p1"), "A");
  for (let i = 0; i < 128; i++) {
    tracker.observe(bindChild(i)); tracker.observe(start(`child-${i}`, `turn-${i}`));
  }
  const result = tracker.observe(bindChild(128));
  assert.equal(result.deliveries[0]!.event.method, "bridge/subagent/gap");
  assert.ok(tracker.route("child-0"));
  assert.equal(tracker.route("child-128"), undefined);
  assert.deepEqual(tracker.observe(bindChild(129)).deliveries, []);
});
