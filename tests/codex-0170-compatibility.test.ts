import assert from "node:assert/strict";
import test from "node:test";

import { APP_SERVER_PROTOCOL_EVIDENCE } from "../src/codex/protocol-evidence.js";
import {
  APP_SERVER_METHODS,
  APP_SERVER_PROTOCOL_PROBE,
  getAppServerMethodCapability
} from "../src/codex/protocol-registry.js";

test("Codex 0.170.0 inventory covers the generated protocol and independent runtime discovery", () => {
  const evidence = APP_SERVER_PROTOCOL_EVIDENCE;
  assert.equal(APP_SERVER_PROTOCOL_PROBE.codexCliVersion, "0.170.0");
  assert.equal(evidence.version, "0.170.0");
  assert.equal(evidence.includesExperimental, true);
  assert.equal(evidence.schemaMethods.request.length, 187);
  assert.equal(evidence.schemaMethods.serverRequest.length, 11);
  assert.equal(evidence.schemaMethods.notification.length, 88);
  assert.equal(evidence.schemaItemTypes.length, 19);
  assert.deepEqual(evidence.runtimeRequests, evidence.schemaMethods.request);
  for (const [kind, methods] of Object.entries(evidence.schemaMethods)) {
    for (const method of methods) {
      assert.ok(APP_SERVER_METHODS.some((entry) => entry.method === method && entry.kind === kind), method);
    }
  }
  // Only these reads have response validation; enumeration is not functional certification.
  assert.deepEqual(Object.keys(evidence.liveVerification).sort(), [
    "configRequirements/read", "modelProvider/capabilities/read", "server/diagnostics"
  ]);
  for (const verification of Object.values(evidence.liveVerification)) {
    assert.equal(verification.version, "0.170.0");
    assert.equal(verification.scenario, "read-only capabilities");
  }
});

test("new provider, account-security and plan-handoff methods do not claim production integration", () => {
  for (const [method, group, status] of [
    ["modelProvider/list", "models", "available"],
    ["modelProvider/config/write", "config", "restricted"],
    ["account/securitySetup/read", "account", "available"],
    ["thread/prepareApprovedPlan", "thread", "restricted"]
  ] as const) {
    const capability = getAppServerMethodCapability(method)!;
    assert.equal(capability.kind, "request");
    assert.equal(capability.group, group);
    assert.equal(capability.status, status);
    assert.equal(capability.evidence.generatedType, true);
    assert.equal(capability.evidence.runtime, "listed");
    assert.deepEqual(capability.evidence.productionReferences, []);
    assert.equal(capability.evidence.liveVerification, null);
  }
});

test("new account, sampling, memory and guardian requests are classified without claiming integration", () => {
  for (const [method, group] of [
    ["account/gcp/setup", "account"],
    ["accountSession/list", "account"],
    ["accountSession/switch", "account"],
    ["thread/sample", "thread"],
    ["thread/sample/cancel", "thread"],
    ["thread/memory/read", "memory"],
    ["thread/guardianReview", "approval"],
    ["feedback/save", "feedback"]
  ] as const) {
    const capability = getAppServerMethodCapability(method)!;
    assert.ok(capability, method);
    assert.equal(capability.kind, "request");
    assert.equal(capability.group, group);
    assert.equal(capability.status, method === "feedback/save" ? "available" : "restricted");
    assert.equal(capability.evidence.generatedType, true);
    assert.equal(capability.evidence.runtime, "listed");
    assert.deepEqual(capability.evidence.productionReferences, []);
    assert.equal(capability.evidence.liveVerification, null);
  }
});

test("section membership is registered as an unconsumed event without runtime verification", () => {
  const capability = getAppServerMethodCapability("thread/section/changed")!;
  assert.equal(capability.kind, "notification");
  assert.equal(capability.group, "events");
  assert.equal(capability.evidence.generatedType, true);
  assert.equal(capability.evidence.runtime, "notChecked");
  assert.deepEqual(capability.evidence.productionReferences, []);
  assert.equal(capability.evidence.liveVerification, null);
});
