import assert from "node:assert/strict";
import test from "node:test";

import { ThreadRuntimeState } from "../src/codex/thread-runtime-state.js";
import type { AppServerThreadStatus } from "../src/codex/client.js";

function settings(model = "model"): AppServerThreadStatus {
  return {
    threadId: "thread",
    cwd: "/project",
    threadName: null,
    model,
    modelProvider: "openai",
    serviceTier: null,
    approvalPolicy: null,
    sandboxMode: null,
    reasoningEffort: null,
    activity: "idle",
    activityType: null,
    contextLeftPercent: null,
    contextUsedTokens: null,
    contextMaxTokens: null
  };
}

test("runtime state remains busy through a start request and active turn lifecycle", () => {
  const state = new ThreadRuntimeState();
  assert.equal(state.isIdle(), true);

  state.beginTurnStart();
  assert.equal(state.isIdle(), false);
  state.trackTurnLifecycle("started", "turn");
  state.finishTurnStart();
  assert.equal(state.isIdle(), false);
  state.trackTurnLifecycle("completed", "turn");
  assert.equal(state.isIdle(), true);
});

test("unexpected disconnect keeps active turn state while clearing observed settings", () => {
  const state = new ThreadRuntimeState();
  state.rememberSettings("thread", settings());
  state.trackTurnLifecycle("started", "turn");

  state.handleConnectionLost(false);
  assert.equal(state.getObservedSettings("thread"), undefined);
  assert.equal(state.isIdle(), false);

  state.handleConnectionLost(true);
  assert.equal(state.isIdle(), true);
});

test("runtime state bounds observed settings and only updates the current object", () => {
  const state = new ThreadRuntimeState();
  const current = settings("current");
  state.rememberSettings("thread", current);
  state.updateObservedServiceTier("thread", current, "priority");
  assert.equal(current.serviceTier, "priority");
  assert.equal(current.serviceTierKnown, true);

  for (let index = 0; index < 256; index += 1) {
    state.rememberSettings(`thread-${index}`, settings(String(index)));
  }
  assert.equal(state.getObservedSettings("thread"), undefined);
  assert.equal(state.getObservedSettings("thread-255")?.model, "255");
});
