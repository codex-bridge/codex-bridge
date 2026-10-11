import { asRecord, firstString } from "./protocol-utils.js";
import type {
  AppServerRateLimitBucket,
  AppServerRateLimitsStatus,
  AppServerRateLimitWindow
} from "./client.js";

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeEpochMs(value: unknown): number | null {
  const numeric = firstNumber(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeRatioPercent(value: number | null): number | null {
  if (value === null) return null;
  return value >= 0 && value <= 1 ? value * 100 : value;
}

function extractRateLimitWindow(
  value: unknown,
  fallbackLabel: string | null = null
): AppServerRateLimitWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    label: firstString(
      record.label,
      record.name,
      record.windowName,
      record.window_name,
      record.period,
      record.duration,
      record.window,
      record.type
    ) ?? fallbackLabel,
    windowDurationMins: firstNumber(record.windowDurationMins, record.window_duration_mins, record.windowMinutes),
    usedPercent: firstNumber(
      record.usedPercent,
      record.used_percent,
      record.usedPercentage,
      record.used_percentage
    ) ?? normalizeRatioPercent(firstNumber(record.usedRatio, record.used_ratio)),
    leftPercent: firstNumber(
      record.leftPercent,
      record.left_percent,
      record.remainingPercent,
      record.remaining_percent,
      record.remainingPercentage,
      record.remaining_percentage
    ) ?? normalizeRatioPercent(firstNumber(record.leftRatio, record.left_ratio, record.remainingRatio, record.remaining_ratio)),
    resetsAt: normalizeEpochMs(record.resetsAt) ?? normalizeEpochMs(record.reset_at) ?? normalizeEpochMs(record.resetAt)
  };
}

function extractRateLimitBucket(
  value: unknown,
  fallbackLimitId: string,
  fallbackPlanType?: unknown
): AppServerRateLimitBucket | null {
  const record = asRecord(value);
  if (!record) return null;
  const primary = extractRateLimitWindow(
    record.primary,
    firstString(record.primaryLabel, record.primary_label, record.primaryName, record.primary_name)
  );
  const secondary = extractRateLimitWindow(
    record.secondary,
    firstString(record.secondaryLabel, record.secondary_label, record.secondaryName, record.secondary_name)
  );
  if (!primary && !secondary) return null;
  return {
    limitId: firstString(record.limitId, record.limit_id) ?? fallbackLimitId,
    limitName: firstString(record.limitName, record.limit_name, record.name) ?? null,
    planType: firstString(record.planType, record.plan_type, fallbackPlanType) ?? null,
    primary,
    secondary
  };
}

function extractRateLimitBucketsById(value: unknown): Record<string, AppServerRateLimitBucket> {
  const record = asRecord(value);
  if (!record) return {};
  const buckets: Record<string, AppServerRateLimitBucket> = {};
  for (const [fallbackLimitId, rawBucket] of Object.entries(record)) {
    const bucket = extractRateLimitBucket(rawBucket, fallbackLimitId);
    if (bucket) buckets[bucket.limitId] = bucket;
  }
  return buckets;
}

export function extractRateLimitsStatus(value: unknown): AppServerRateLimitsStatus | null {
  const result = asRecord(value);
  const snakeRateLimit = asRecord(result?.rate_limit);
  if (snakeRateLimit) {
    const bucket: AppServerRateLimitBucket = {
      limitId: "codex",
      limitName: null,
      planType: firstString(result?.planType, result?.plan_type) ?? null,
      primary: extractRateLimitWindow(snakeRateLimit.primary_window),
      secondary: extractRateLimitWindow(snakeRateLimit.secondary_window, "weekly")
    };
    return {
      ...bucket,
      byLimitId: bucket.primary || bucket.secondary ? { [bucket.limitId]: bucket } : {},
      resetCreditsAvailable: null
    };
  }

  const byLimitId = extractRateLimitBucketsById(result?.rateLimitsByLimitId);
  const rateLimits = asRecord(result?.rateLimits) ??
    (result && (result.primary !== undefined || result.secondary !== undefined) ? result : null);
  if (!rateLimits && Object.keys(byLimitId).length === 0) return null;

  const defaultBucket = extractRateLimitBucket(rateLimits, "codex", result?.planType) ?? Object.values(byLimitId)[0] ?? null;
  if (!defaultBucket) return null;
  if (!byLimitId[defaultBucket.limitId]) byLimitId[defaultBucket.limitId] = defaultBucket;
  return {
    ...defaultBucket,
    byLimitId,
    resetCreditsAvailable: firstNumber(asRecord(result?.rateLimitResetCredits)?.availableCount)
  };
}

export function extractRateLimitsStatusFromErrorMessage(message: string): AppServerRateLimitsStatus | null {
  const marker = "body=";
  const start = message.indexOf(marker);
  if (start < 0) return null;
  try {
    return extractRateLimitsStatus(JSON.parse(message.slice(start + marker.length).trim()));
  } catch {
    return null;
  }
}
