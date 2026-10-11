import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex/client.js";

function catalogClient(pages: unknown[]) {
  const requests: unknown[] = [];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async (method: string, params: unknown) => {
      assert.equal(method, "model/list");
      requests.push(params);
      assert.ok(requests.length <= pages.length, "unexpected extra request");
      return pages[requests.length - 1];
    }
  });
  return { client, requests };
}

test("model catalog follows pages and preserves server capabilities and defaults", async () => {
  const { client, requests } = catalogClient([
    { data: [{ model: "first" }, { model: "hidden", hidden: true }], nextCursor: "page2" },
    { data: [{ model: "first" }, {
      model: "latest", isDefault: true, defaultReasoningEffort: "ultra",
      supportedReasoningEfforts: [{ reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
      inputModalities: ["text", "image", "audio"],
      serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
      defaultServiceTier: "priority", modelSpecialty: "coding", multiAgentVersion: "v2",
      availabilityNux: { message: "Available now" },
      upgradeInfo: { model: "replacement", retirementAt: 1800000000 }
    }], nextCursor: null }
  ]);
  const catalog = await client.readModelCatalog();
  assert.deepEqual(requests, [{ includeHidden: false }, { includeHidden: false, cursor: "page2" }]);
  assert.equal(catalog?.defaultModel, "latest");
  assert.deepEqual(catalog?.visibleModels, ["first", "latest"]);
  assert.equal(catalog?.availableCount, 2);
  const model = catalog!.models[1]!;
  assert.equal(model.defaultReasoningEffort, "ultra");
  assert.deepEqual(model.supportedReasoningEfforts, ["max", "ultra"]);
  assert.deepEqual(model.inputModalities, ["text", "image", "audio"]);
  assert.deepEqual(model.serviceTiers, [{ id: "priority", name: "Fast", description: "Faster responses" }]);
  assert.equal(model.defaultServiceTier, "priority");
  assert.equal(model.modelSpecialty, "coding");
  assert.equal(model.multiAgentVersion, "v2");
  assert.equal(model.availabilityMessage, "Available now");
  assert.deepEqual(model.upgradeInfo, { model: "replacement", retirementAt: 1800000000 });
  assert.equal(catalog!.models[0]!.defaultServiceTier, null);
});

test("model catalog rejects repeated cursors instead of hanging or returning a partial catalog", async () => {
  const { client } = catalogClient([
    { data: [{ model: "first" }], nextCursor: "loop" },
    { data: [], nextCursor: "loop" }
  ]);
  assert.equal(await client.readModelCatalog(), null);
});

test("model catalog rejects malformed later pages", async () => {
  const { client } = catalogClient([{ data: [], nextCursor: "next" }, {}]);
  assert.equal(await client.readModelCatalog(), null);
});
