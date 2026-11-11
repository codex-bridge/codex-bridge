import assert from "node:assert/strict";
import test from "node:test";

import {
  getAppServerMethodCapability
} from "../src/codex/protocol-registry.js";
import { extractThreadStatus } from "../src/codex/thread-api.js";

test("Codex 0.163.0 additions have schema and runtime evidence without claiming integration", () => {
  for (const method of ["thread/items/read", "thread/readState/update"]) {
    const capability = getAppServerMethodCapability(method)!;
    assert.ok(capability, method);
    assert.equal(capability.kind, "request");
    assert.equal(capability.group, "thread");
    assert.equal(capability.status, "available");
    assert.equal(capability.evidence.generatedType, true);
    assert.equal(capability.evidence.runtime, "listed");
    assert.deepEqual(capability.evidence.productionReferences, []);
    assert.equal(capability.evidence.liveVerification, null);
  }
  const changed = getAppServerMethodCapability("thread/readState/changed")!;
  assert.equal(changed.kind, "notification");
  assert.equal(changed.group, "events");
  assert.equal(changed.evidence.generatedType, true);
  assert.equal(changed.evidence.runtime, "notChecked");
  assert.deepEqual(changed.evidence.productionReferences, []);
  assert.equal(changed.evidence.liveVerification, null);
});

test("thread status ignores additive durable read state without changing runtime activity", () => {
  const response = { thread: { id: "thread-1", cwd: "/project", status: { type: "idle" } } };
  const expected = extractThreadStatus(response, "fallback");
  for (const readState of [null, { firstUnread: null, revision: "r1" }, {
    firstUnread: { type: "turn", turnId: "turn-1" }, revision: "r2"
  }]) {
    assert.deepEqual(extractThreadStatus({ ...response, readState }, "fallback"), expected);
  }
});
