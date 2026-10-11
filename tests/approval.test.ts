import assert from "node:assert/strict";
import test from "node:test";

import {
  extractRequestedFieldNames,
  mcpRequestRequiresUserInput
} from "../src/codex/extractors/approval.js";

test("does not require MCP JSON input when no fields are requested", () => {
  const params = {
    threadId: "thread",
    message: "Read, search, and update authorized Notion pages and databases.",
    requestedSchema: {
      type: "object",
      properties: {}
    }
  };

  assert.deepEqual(extractRequestedFieldNames(params), []);
  assert.equal(mcpRequestRequiresUserInput(params), false);
});

test("requires MCP JSON input when schema fields are requested", () => {
  const params = {
    threadId: "thread",
    requestedSchema: {
      type: "object",
      properties: {
        memory_name: { type: "string" }
      }
    }
  };

  assert.deepEqual(extractRequestedFieldNames(params), ["memory_name"]);
  assert.equal(mcpRequestRequiresUserInput(params), true);
});
