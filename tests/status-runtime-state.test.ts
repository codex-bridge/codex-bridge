import assert from "node:assert/strict";
import test from "node:test";
import { StatusRuntimeState } from "../src/bridge/status/runtime-state.js";
import { formatMcpStartupFailureDetails } from "../src/bridge/status/formatters.js";
import { extractMcpStartupStatusEvent } from "../src/codex/notification-events.js";

test("status runtime state owns labels and edit throttles", () => {
  const state = new StatusRuntimeState();
  state.statusLabelBySession.set("session", "Working");
  state.statusLastEditAtBySession.set("session", 100);
  assert.equal(state.getLabel("session"), "Working");
  state.resetEditThrottle("session");
  assert.equal(state.statusLastEditAtBySession.has("session"), false);
});

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
    name: "notion",
    status: "error",
    error: "OAuth login cancelled"
  });
});
