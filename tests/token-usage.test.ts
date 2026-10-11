import assert from "node:assert/strict";
import test from "node:test";
import { TokenUsageTracker } from "../src/bridge/status/token-usage.js";

test("token usage tracker stores formats and clears usage", () => {
  const tracker = new TokenUsageTracker();
  tracker.remember({ threadId: "thread", usedTokens: 12_500, maxTokens: 20_000, leftPercent: 37 });
  assert.equal(tracker.get("thread")?.usedTokens, 12_500);
  assert.equal(tracker.formatCompactUsage("thread"), " (12.5K used)");
  tracker.clear();
  assert.equal(tracker.get("thread"), null);
});
