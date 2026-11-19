import assert from "node:assert/strict";
import test from "node:test";
import { APP_SERVER_PROTOCOL_EVIDENCE } from "../src/codex/protocol-evidence.js";
import { APP_SERVER_MESSAGE_COVERAGE, assertMessageCoverage, getMessageCoverage } from "../src/codex/protocol-coverage.js";

test("all generated client-bound methods and items have an explicit disposition", () => {
  assert.doesNotThrow(() => assertMessageCoverage(APP_SERVER_PROTOCOL_EVIDENCE));
  assert.equal(getMessageCoverage("notification", "mcpServer/startupStatus/updated")?.disposition, "handled");
  assert.equal(getMessageCoverage("notification", "item/agentMessage/delta")?.disposition, "ignored");
  assert.equal(getMessageCoverage("notification", "warning")?.disposition, "handled");
  assert.equal(getMessageCoverage("serverRequest", "item/tool/requestUserInput")?.disposition, "handled");
  assert.equal(getMessageCoverage("item", "agentMessage")?.disposition, "partial");
  assert.equal(getMessageCoverage("item", "sleep")?.disposition, "handled");
  assert.equal(getMessageCoverage("item", "new-upstream-item"), undefined);
});

test("new upstream messages require review instead of silently inheriting an ignore policy", () => {
  for (const kind of ["notification", "serverRequest", "item"] as const) {
    const evidence = structuredClone(APP_SERVER_PROTOCOL_EVIDENCE);
    if (kind === "item") evidence.schemaItemTypes.push("new-upstream-item");
    else evidence.schemaMethods[kind].push("new/upstream-method");
    assert.throws(() => assertMessageCoverage(evidence), /unclassified \[new/);
  }
});

test("coverage rejects obsolete, duplicated and undocumented entries", () => {
  const evidence = structuredClone(APP_SERVER_PROTOCOL_EVIDENCE);
  evidence.schemaItemTypes = evidence.schemaItemTypes.filter((type) => type !== "sleep");
  assert.throws(() => assertMessageCoverage(evidence), /obsolete \[sleep\]/);
  const duplicate = structuredClone(APP_SERVER_MESSAGE_COVERAGE);
  duplicate.item = [...duplicate.item, { disposition: "ignored", reason: "duplicate", names: ["sleep"] }];
  assert.throws(() => assertMessageCoverage(APP_SERVER_PROTOCOL_EVIDENCE, duplicate), /Duplicate item/);
  const undocumented = structuredClone(APP_SERVER_MESSAGE_COVERAGE);
  undocumented.item = [...undocumented.item, { disposition: "ignored", reason: "", names: [] }];
  assert.throws(() => assertMessageCoverage(APP_SERVER_PROTOCOL_EVIDENCE, undocumented), /Missing item coverage reason/);
});
