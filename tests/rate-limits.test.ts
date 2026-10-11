import assert from "node:assert/strict";
import test from "node:test";

import { extractRateLimitsStatus } from "../src/codex/client.js";

test("extracts weekly-only Codex rate limits with reset credit count", () => {
  const status = extractRateLimitsStatus({
    rateLimits: {
      limitId: "codex",
      primary: {
        usedPercent: 1,
        windowDurationMins: 10080,
        resetsAt: 1784498442
      },
      secondary: null
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        primary: {
          usedPercent: 0,
          windowDurationMins: 10080,
          resetsAt: 1784515470
        },
        secondary: null
      }
    },
    rateLimitResetCredits: {
      availableCount: 4
    }
  });

  assert.equal(status?.primary?.windowDurationMins, 10080);
  assert.equal(status?.secondary, null);
  assert.equal(status?.resetCreditsAvailable, 4);
  assert.equal(status?.byLimitId.codex_bengalfox?.primary?.windowDurationMins, 10080);
});

test("keeps explicit rate limit window labels when provided", () => {
  const status = extractRateLimitsStatus({
    rateLimits: {
      limitId: "codex",
      primary: {
        label: "burst",
        usedPercent: 25,
        windowDurationMins: 300
      },
      secondary: {
        windowName: "weekly",
        usedPercent: 50,
        windowDurationMins: 10080
      }
    }
  });

  assert.equal(status?.primary?.label, "burst");
  assert.equal(status?.primary?.windowDurationMins, 300);
  assert.equal(status?.secondary?.label, "weekly");
});

test("extracts remaining percentage and ratio based rate limit fields", () => {
  const status = extractRateLimitsStatus({
    rateLimits: {
      limitId: "codex",
      primary: {
        remainingPercent: 9.6,
        windowDurationMins: 10080
      },
      secondary: {
        usedRatio: 0.25,
        leftRatio: 0.75,
        windowDurationMins: 300
      }
    }
  });

  assert.equal(status?.primary?.leftPercent, 9.6);
  assert.equal(status?.primary?.usedPercent, null);
  assert.equal(status?.secondary?.usedPercent, 25);
  assert.equal(status?.secondary?.leftPercent, 75);
});
