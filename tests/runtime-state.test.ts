import assert from "node:assert/strict";
import test from "node:test";

import {
  isRuntimeConnected,
  isRuntimeTransitioning,
  transitionRuntimeState
} from "../src/bridge/runtime/controller.js";

test("runtime state follows explicit connection lifecycle transitions", () => {
  let state = transitionRuntimeState("disconnected", "connecting");
  assert.equal(isRuntimeTransitioning(state), true);
  state = transitionRuntimeState(state, "connected");
  assert.equal(isRuntimeConnected(state), true);
  state = transitionRuntimeState(state, "disconnecting");
  state = transitionRuntimeState(state, "disconnected");
  assert.equal(isRuntimeConnected(state), false);
});

test("failed runtime can reconnect but cannot skip the connecting state", () => {
  assert.equal(transitionRuntimeState("connected", "failed"), "failed");
  assert.equal(transitionRuntimeState("failed", "connecting"), "connecting");
  assert.throws(
    () => transitionRuntimeState("failed", "connected"),
    /Invalid runtime state transition/
  );
});
