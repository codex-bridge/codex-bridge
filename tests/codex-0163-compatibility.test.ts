import assert from "node:assert/strict";
import test from "node:test";

import { APP_SERVER_PROTOCOL_EVIDENCE } from "../src/codex/protocol-evidence.js";
import {
  APP_SERVER_METHODS,
  APP_SERVER_PROTOCOL_PROBE,
  getAppServerMethodCapability
} from "../src/codex/protocol-registry.js";
import { extractThreadStatus } from "../src/codex/thread-api.js";

test("Codex 0.163.0 additions have schema and runtime evidence without claiming integration", () => {
  assert.equal(APP_SERVER_PROTOCOL_PROBE.codexCliVersion, "0.163.0");
  assert.equal(APP_SERVER_PROTOCOL_EVIDENCE.version, "0.163.0");
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

test("Codex 0.163.0 protocol inventory is complete and live evidence is version-scoped", () => {
  const evidence = APP_SERVER_PROTOCOL_EVIDENCE;
  assert.equal(evidence.includesExperimental, true);
  assert.equal(evidence.schemaMethods.request.length, 175);
  assert.equal(evidence.schemaMethods.serverRequest.length, 11);
  assert.equal(evidence.schemaMethods.notification.length, 87);
  assert.deepEqual(evidence.runtimeRequests, evidence.schemaMethods.request);
  for (const [kind, methods] of Object.entries(evidence.schemaMethods)) {
    for (const method of methods) {
      assert.ok(APP_SERVER_METHODS.some((entry) => entry.method === method && entry.kind === kind), method);
    }
  }
  for (const verification of Object.values(evidence.liveVerification)) {
    assert.equal(verification.version, "0.163.0");
  }
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
