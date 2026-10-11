import type { AppServerRateLimitWindow } from "../../codex/client.js";

export type RateLimitThresholdState = {
  threshold: number | null;
  resetsAt: number | null;
  leftPercent: number | null;
};

export function getRateLimitLeftPercent(window: AppServerRateLimitWindow | null): number | null {
  if (!window) {
    return null;
  }
  if (typeof window.leftPercent === "number" && Number.isFinite(window.leftPercent)) {
    return Math.max(0, Math.min(100, Math.round(window.leftPercent)));
  }
  if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
    return Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)));
  }
  return null;
}

export function getRateLimitThreshold(leftPercent: number): number | null {
  const thresholds = [0, 1, 2, 3, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  for (const threshold of thresholds) {
    if (leftPercent <= threshold) {
      return threshold;
    }
  }
  return null;
}

export function getRateLimitWindowKey(window: AppServerRateLimitWindow): number | null {
  if (!window.resetsAt) {
    return null;
  }
  return Math.floor(window.resetsAt / 60_000) * 60_000;
}

export function isRateLimitResetDetected(
  previousState: RateLimitThresholdState | null,
  leftPercent: number
): boolean {
  if (!previousState || previousState.leftPercent === null) {
    return false;
  }
  return previousState.leftPercent < 100 && leftPercent >= 100;
}

export function summarizeRateLimitWindow(
  window: AppServerRateLimitWindow | null
): Record<string, unknown> | null {
  if (!window) {
    return null;
  }
  return {
    label: window.label,
    windowDurationMins: window.windowDurationMins,
    leftPercent: getRateLimitLeftPercent(window),
    resetsAt: window.resetsAt
  };
}
