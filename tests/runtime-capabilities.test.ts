import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex/client.js";
import { AppServerRpcError } from "../src/codex/app-server-connection.js";
import { formatConfigRequirements, formatProviderCapabilities } from "../src/bridge/status/capability-formatters.js";

function clientWithResponses(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async (method: string, params: unknown, options: { timeoutMs: number }) => {
      calls.push(method);
      assert.deepEqual(params, {});
      assert.equal(options.timeoutMs, 3_000);
      if (responses[method] instanceof Error) throw responses[method];
      return responses[method];
    }
  });
  return { client, calls };
}

test("read-only capability responses preserve false, null and empty allowlists and omit sensitive policy fields", async () => {
  const responses = {
    "server/diagnostics": { process: { id: 123, residentMemoryBytes: 0, physicalFootprintBytes: null }, gauges: [{ name: "threads", value: 0 }] },
    "modelProvider/capabilities/read": { imageGeneration: false, webSearch: true },
    "configRequirements/read": { requirements: {
      modelProvider: "managed", modelProviders: { managed: { api_key: "PRIVATE_SENTINEL" } },
      additionalDeveloperInstructions: "PRIVATE_SENTINEL",
      allowedApprovalPolicies: [{ granular: { sandbox_approval: false } }],
      allowedSandboxModes: [], allowedWebSearchModes: null,
      featureRequirements: { web_search: false, future_flag: true }
    } }
  };
  const { client, calls } = clientWithResponses(responses);
  const result = await client.readRuntimeCapabilities();
  assert.equal(calls.length, 3);
  assert.deepEqual(result.provider, { state: "available", value: { imageGeneration: false, webSearch: true } });
  assert.equal(result.diagnostics.value?.residentMemoryBytes, 0);
  assert.deepEqual(result.requirements.value?.allowedSandboxModes, []);
  assert.equal(result.requirements.value?.allowedWebSearchModes, null);
  assert.deepEqual(result.requirements.value?.allowedApprovalPolicies, ["granular (sandbox_approval: false)"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|api_key|additionalDeveloperInstructions/);
  const basic = formatConfigRequirements(result.requirements, false).join("\n");
  assert.match(basic, /Allowed sandbox modes\*\* none allowed/);
  assert.match(basic, /web_search: disabled/);
  assert.doesNotMatch(basic, /future_flag/);
  responses["modelProvider/capabilities/read"].imageGeneration = true;
  assert.equal((await client.readRuntimeCapabilities()).provider.value?.imageGeneration, true);
  assert.equal(calls.length, 6, "reads must not reuse stale provider capabilities");
});

test("one unsupported or malformed capability read does not discard successful peers or imply false", async () => {
  const { client } = clientWithResponses({
    "server/diagnostics": {},
    "configRequirements/read": { requirements: null },
    "modelProvider/capabilities/read": new AppServerRpcError("modelProvider/capabilities/read", { code: -32601, message: "Not implemented" })
  });
  const result = await client.readRuntimeCapabilities();
  assert.equal(result.diagnostics.state, "unavailable");
  assert.equal(result.provider.state, "unsupported");
  assert.equal(result.requirements.value?.configured, false);
  assert.match(formatConfigRequirements(result.requirements, false)[0]!, /none reported/);
  assert.doesNotMatch(formatProviderCapabilities(result.provider).join("\n"), /not supported/);
});

test("connection and RPC failures produce unavailable states without guessing provider support", async () => {
  const responses = {
    "server/diagnostics": new Error("Timeout"),
    "configRequirements/read": {},
    "modelProvider/capabilities/read": new AppServerRpcError("modelProvider/capabilities/read", { code: -32000, message: "Unavailable" })
  };
  const { client, calls } = clientWithResponses(responses);
  const result = await client.readRuntimeCapabilities();
  assert.deepEqual(Object.values(result).map((entry) => entry.state), ["unavailable", "unavailable", "unavailable"]);
  client.connect = async () => { throw new Error("Disconnected"); };
  assert.deepEqual(await client.readRuntimeCapabilities(), result);
  assert.equal(calls.length, 3, "a failed connection must not issue requests");
});

test("omitted or malformed fields remain unknown and are never converted into denies", async () => {
  const { client } = clientWithResponses({
    "server/diagnostics": { process: { id: 1 }, gauges: [] },
    "configRequirements/read": { requirements: { allowedWebSearchModes: [123] } },
    "modelProvider/capabilities/read": { webSearch: false }
  });
  const result = await client.readRuntimeCapabilities();
  assert.equal(result.provider.value?.imageGeneration, null);
  assert.equal(result.requirements.value?.allowedWebSearchModes, null);
  assert.match(formatProviderCapabilities(result.provider).join("\n"), /Image generation: unknown · Web search: not supported/);
  assert.doesNotMatch(formatConfigRequirements(result.requirements, true).join("\n"), /none allowed/);
});
