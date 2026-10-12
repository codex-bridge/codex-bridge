import assert from "node:assert/strict";
import test from "node:test";
import { APP_SERVER_METHODS, getAppServerMethodCapability } from "../src/codex/protocol-registry.js";
import { extractGeneratedMethods, extractRuntimeMethods, scanProductionReferences } from "../scripts/probes/protocol-evidence.js";

test("protocol inventory distinguishes generated, runtime, production-reference and live evidence", () => {
  const archive = getAppServerMethodCapability("thread/archive")!;
  assert.equal(archive.status, "used");
  assert.ok(archive.evidence.productionReferences.includes("src/codex/thread-list-api.ts"));
  assert.equal(archive.evidence.runtime, "listed");
  assert.equal(archive.evidence.generatedType, true);
  assert.equal(archive.evidence.liveVerification, null);
  const permissionProfiles = getAppServerMethodCapability("permissionProfile/list")!;
  assert.equal(permissionProfiles.evidence.productionReferences.length, 0);
  assert.equal(permissionProfiles.status, "available");
  assert.equal(getAppServerMethodCapability("server/diagnostics")?.evidence.liveVerification?.scenario, "read-only capabilities");
  assert.equal(getAppServerMethodCapability("thread/prediction/request")?.evidence.generatedType, true);
  assert.equal(getAppServerMethodCapability("thread/status/changed")?.evidence.runtime, "notChecked");
  assert.equal(new Set(APP_SERVER_METHODS.map((entry) => entry.method)).size, APP_SERVER_METHODS.length);
});

test("protocol evidence scan matches executable-source literals without counting comments or registry declarations", async () => {
  const refs = await scanProductionReferences(process.cwd(), new Set(APP_SERVER_METHODS.map((entry) => entry.method)));
  for (const entry of APP_SERVER_METHODS) assert.deepEqual(entry.evidence.productionReferences, refs[entry.method] ?? [], entry.method);
  assert.ok(refs["server/diagnostics"]?.includes("src/codex/runtime-capabilities.ts"));
  assert.ok(!refs["server/diagnostics"]?.includes("src/codex/protocol-registry.ts"));
});

test("generated and runtime discovery collect method discriminants without inventing availability", () => {
  assert.deepEqual(extractGeneratedMethods(`
    // method: "not-a-method"
    export type Requests = { "method": "read/a"; params: {} } | { method: "read/b" };
    const sample = "method: read/c";
  `), ["read/a", "read/b"]);
  assert.deepEqual(extractRuntimeMethods("unknown method, expected one of `read/b`, `read/a`, `read/a`"), ["read/a", "read/b"]);
  assert.deepEqual(extractRuntimeMethods("permission denied"), []);
});
