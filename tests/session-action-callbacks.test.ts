import assert from "node:assert/strict";
import test from "node:test";

import { createSessionActionCallback } from "../src/bridge/sessions/action-callbacks.js";

test("session action callbacks preserve protocol prefixes and optional lease versions", () => {
  assert.equal(createSessionActionCallback("handoff", "session-1"), "session-handoff:session-1");
  assert.equal(createSessionActionCallback("releaseBridge", "session-1", 4), "session-release-bridge:session-1:4");
  assert.equal(createSessionActionCallback("releaseCodex", "session-1", 5), "session-release-codex:session-1:5");
  assert.equal(createSessionActionCallback("archive", "session-1", 6), "session-archive:session-1:6");
  assert.equal(createSessionActionCallback("delete", "session-1", 7), "session-delete:session-1:7");
  assert.equal(createSessionActionCallback("deleteConfirm", "session-1", 8), "session-delete-confirm:session-1:8");
  assert.equal(createSessionActionCallback("refresh", "session-1", 9), "session-refresh:session-1:9");
});
