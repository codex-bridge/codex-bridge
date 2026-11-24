import assert from "node:assert/strict";
import test from "node:test";
import { formatMcpStartupFailureDetails } from "../src/bridge/status/formatters.js";
import { extractMcpStartupStatusEvent } from "../src/codex/notification-events.js";

test("MCP OAuth failures include the exact local login command", () => {
  const details = formatMcpStartupFailureDetails(new Map([
    ["notion", { status: "error", error: "OAuth token expired" }]
  ]));
  assert.equal(details, "notion: OAuth token expired Run: codex mcp login notion");
});

test("MCP OAuth completion updates the same startup status channel", () => {
  assert.deepEqual(extractMcpStartupStatusEvent({
    method: "mcpServer/oauthLogin/completed",
    params: { name: "notion", success: false, error: "OAuth login cancelled" }
  }), {
    threadId: null,
    source: "oauth",
    failureReason: null,
    name: "notion",
    status: "error",
    error: "OAuth login cancelled"
  });
});
