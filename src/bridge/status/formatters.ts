import type {
  AppServerMcpServerStatus,
  AppServerModelCatalog,
  AppServerModelInfo,
  AppServerRateLimitBucket,
  AppServerRateLimitsStatus,
  AppServerRateLimitWindow,
  AppServerWorkspaceMessagesStatus
} from "../../codex/client.js";
import { getRateLimitLeftPercent } from "../notifications/rate-limit-policy.js";

export function formatRateLimitWindow(window: AppServerRateLimitWindow): string {
  const resolvedLeftPercent = getRateLimitLeftPercent(window);
  const leftPercent = resolvedLeftPercent !== null ? `${resolvedLeftPercent}% left` : "unknown";
  if (!window.resetsAt) {
    return `${leftPercent} (reset time unavailable)`;
  }

  const resetsAt = new Date(window.resetsAt);
  const hours = `${resetsAt.getHours()}`.padStart(2, "0");
  const minutes = `${resetsAt.getMinutes()}`.padStart(2, "0");
  const day = `${resetsAt.getDate()}`.padStart(2, "0");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = monthNames[resetsAt.getMonth()] ?? "";
  return `${leftPercent} (resets ${hours}:${minutes} on ${day} ${month})`;
}

export function formatStatusHealthSummary(input: {
  busy: boolean;
  tokenUsage: { leftPercent: number | null; usedTokens: number | null; maxTokens: number | null } | null;
  rateLimitsStatus: AppServerRateLimitBucket | null;
  rateLimitLabel?: string | null;
  mcpStartupStatus: string | null;
  pendingApprovals: number;
}): string {
  const parts = [input.busy ? "busy" : "idle"];
  if (input.pendingApprovals > 0) {
    parts.push(`${input.pendingApprovals} pending approval${input.pendingApprovals === 1 ? "" : "s"}`);
  }
  if (input.tokenUsage?.leftPercent !== null && input.tokenUsage?.leftPercent !== undefined) {
    parts.push(`context ${Math.max(0, Math.round(input.tokenUsage.leftPercent))}% left`);
  }
  for (const slot of ["primary", "secondary"] as const) {
    const window = input.rateLimitsStatus?.[slot] ?? null;
    const leftPercent = getRateLimitLeftPercent(window);
    if (leftPercent === null || !input.rateLimitsStatus) {
      continue;
    }
    const label = input.rateLimitLabel
      ? `${input.rateLimitLabel} ${formatRateLimitWindowLabel(input.rateLimitsStatus, slot)}`
      : formatRateLimitWindowLabel(input.rateLimitsStatus, slot);
    parts.push(`${label} ${leftPercent}% left`);
  }
  if (input.mcpStartupStatus) {
    parts.push(`MCP ${input.mcpStartupStatus}`);
  }
  return parts.join(" · ");
}

export function formatRuntimeClient(userAgent: string): string {
  const parts: string[] = [];
  const codexBridge = userAgent.match(/codex_bridge\/[^\s]+/i)?.[0];
  const vscode = userAgent.match(/vscode\/[^\s]+/i)?.[0];
  if (codexBridge) parts.push(codexBridge);
  if (vscode) parts.push(vscode);
  return parts.length > 0 ? parts.join(" · ") : userAgent;
}

export function pickModelRateLimitBucket(
  status: AppServerRateLimitsStatus | null,
  model: string
): AppServerRateLimitBucket | null {
  if (!status) return null;
  const normalizedModel = normalizeRateLimitLabel(model);
  if (!normalizedModel || normalizedModel === "systemdefault") return null;
  const buckets = Object.values(status.byLimitId);
  return (
    buckets.find((bucket) => rateLimitLabelMatchesModel(bucket.limitName, normalizedModel)) ??
    buckets.find((bucket) => rateLimitLabelMatchesModel(bucket.limitId, normalizedModel)) ??
    null
  );
}

function rateLimitLabelMatchesModel(labelValue: string | null | undefined, normalizedModel: string): boolean {
  const label = labelValue ? normalizeRateLimitLabel(labelValue) : "";
  if (!label || label === "codex") return false;
  return label.includes(normalizedModel) || normalizedModel.includes(label);
}

export function formatRateLimitBucketLabel(bucket: AppServerRateLimitBucket, model: string): string {
  return bucket.limitName ?? model ?? bucket.limitId;
}

export function formatRateLimitWindowLabel(
  bucket: AppServerRateLimitBucket,
  slot: "primary" | "secondary"
): string {
  const window = bucket[slot];
  const label = window?.label?.trim();
  if (label) return label;
  const durationLabel = formatRateLimitDurationLabel(window?.windowDurationMins ?? null);
  if (durationLabel) return durationLabel;
  return slot === "secondary" ? "weekly" : "usage window";
}

function formatRateLimitDurationLabel(windowDurationMins: number | null): string | null {
  if (typeof windowDurationMins !== "number" || !Number.isFinite(windowDurationMins)) return null;
  if (windowDurationMins === 10080) return "weekly";
  if (windowDurationMins === 1440) return "daily";
  if (windowDurationMins % 1440 === 0) return `${windowDurationMins / 1440}d`;
  if (windowDurationMins % 60 === 0) return `${windowDurationMins / 60}h`;
  return `${windowDurationMins}m`;
}

export function isSameRateLimitBucket(
  left: AppServerRateLimitBucket | null,
  right: AppServerRateLimitsStatus | null
): boolean {
  return Boolean(left && right && left.limitId === right.limitId);
}

export function normalizeRateLimitLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function formatContextWindow(window: {
  leftPercent: number | null;
  usedTokens: number | null;
  maxTokens: number | null;
}): string {
  const left = typeof window.leftPercent === "number" && Number.isFinite(window.leftPercent)
    ? `${Math.max(0, Math.round(window.leftPercent))}% left`
    : "unknown";
  if (
    typeof window.usedTokens !== "number" || !Number.isFinite(window.usedTokens) ||
    typeof window.maxTokens !== "number" || !Number.isFinite(window.maxTokens)
  ) {
    return left;
  }
  return `${left} (${formatCompactNumber(window.usedTokens)} used / ${formatCompactNumber(window.maxTokens)})`;
}

export function formatModelCatalog(catalog: AppServerModelCatalog): string {
  const defaultPart = catalog.defaultModel ? `default ${catalog.defaultModel}` : "default unknown";
  const preview = catalog.visibleModels.slice(0, 8).join(", ");
  const suffix = catalog.visibleModels.length > 8 ? `, +${catalog.visibleModels.length - 8}` : "";
  return preview
    ? `${defaultPart}; ${catalog.availableCount} available (${preview}${suffix})`
    : `${defaultPart}; ${catalog.availableCount} available`;
}

export function formatModelCatalogLines(catalog: AppServerModelCatalog): string[] {
  if (catalog.models.length === 0) {
    return [`${catalog.availableCount} available; default ${catalog.defaultModel ?? "unknown"}`];
  }
  return catalog.models.map((model) => `- ${formatModelDetails(model)}`);
}

export function formatModelDetails(model: AppServerModelInfo): string {
  const tags: string[] = [];
  if (model.isDefault) tags.push("default");
  const reasoning = formatReasoningEfforts(model.supportedReasoningEfforts);
  if (reasoning) tags.push(`r ${reasoning}`);
  if (model.defaultReasoningEffort) tags.push(`d ${model.defaultReasoningEffort}`);
  if (model.serviceTiers.length > 0) {
    tags.push(`tier ${model.serviceTiers.map((tier) => tier.id === model.defaultServiceTier ? `${tier.name} (default)` : tier.name).join("/")}`);
  } else if (model.defaultServiceTier) {
    tags.push(`tier ${model.defaultServiceTier} (default)`);
  }
  if (model.inputModalities.includes("image")) tags.push("image");
  if (model.inputModalities.includes("audio")) tags.push("audio");
  if (model.modelSpecialty) tags.push(model.modelSpecialty);
  if (model.upgradeInfo?.retirementAt != null) {
    const retirement = new Date(model.upgradeInfo.retirementAt * 1000);
    if (!Number.isNaN(retirement.getTime())) tags.push(`retires ${retirement.toISOString().slice(0, 10)}`);
  }
  if (model.supportsPersonality === false) tags.push("no personality");
  return tags.length > 0 ? `${model.id} (${tags.join("; ")})` : model.id;
}

export function formatReasoningEfforts(efforts: string[]): string | null {
  return efforts.length > 0 ? efforts.join("/") : null;
}

export function formatAccountUsageStatus(status: {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
  longestRunningTurnSec: number | null;
}): string {
  const parts: string[] = [];
  if (status.lifetimeTokens !== null) parts.push(`${formatCompactNumber(status.lifetimeTokens)} lifetime tokens`);
  if (status.peakDailyTokens !== null) parts.push(`${formatCompactNumber(status.peakDailyTokens)} peak daily`);
  if (status.currentStreakDays !== null) parts.push(`${status.currentStreakDays}d streak`);
  if (status.longestRunningTurnSec !== null) parts.push(`longest turn ${formatElapsed(status.longestRunningTurnSec * 1000)}`);
  return parts.length > 0 ? parts.join("; ") : "available";
}

export function formatWorkspaceMessagesStatus(status: AppServerWorkspaceMessagesStatus): string {
  if (status.featureEnabled === false) return "feature disabled";
  if (status.activeCount === 0) return "none";
  const latest = status.latest
    ? `; latest ${truncateText(status.latest.body.replace(/\s+/g, " "), 80)}`
    : "";
  return `${status.activeCount} active${latest}`;
}

export function formatSkillsCatalog(catalog: {
  total: number;
  enabled: number;
  groups: Array<{ cwd: string | null; total: number; enabled: number }>;
}): string {
  const roots = catalog.groups.length;
  return `${catalog.enabled}/${catalog.total} enabled across ${roots} ${roots === 1 ? "root" : "roots"}`;
}

export function formatMcpServerStatus(status: AppServerMcpServerStatus): string {
  if (status.error) return status.error.includes("timed out") ? "status check timeout" : `status check failed (${status.error.includes("unknown variant") ? "unsupported" : "error"})`;
  if (status.total === 0) return "none";
  const parts = [`${status.running}/${status.total} running`];
  if (status.failed > 0) parts.push(`${status.failed} failed`);
  if (status.unknown > 0) parts.push(`${status.unknown} unknown`);
  return parts.join(", ");
}

export function formatMcpToolCatalogStatus(status: AppServerMcpServerStatus): string {
  if (status.error) return "unknown";
  const knownServers = status.servers.filter((server) => typeof server.toolCount === "number");
  if (knownServers.length === 0) return "not reported";
  const total = knownServers.reduce((sum, server) => sum + (server.toolCount ?? 0), 0);
  const preview = knownServers
    .filter((server) => (server.toolCount ?? 0) > 0)
    .sort((left, right) => (right.toolCount ?? 0) - (left.toolCount ?? 0) || left.name.localeCompare(right.name))
    .slice(0, 3)
    .map((server) => `${server.name} ${server.toolCount}`)
    .join(", ");
  return preview ? `${total} listed (${preview})` : `${total} listed`;
}

export function formatModelToolCallStatus(version: string | null): string {
  return `requires probe${version ? ` for ${version}` : ""}`;
}

export function formatMcpStartupStatusCache(
  currentStatus: AppServerMcpServerStatus | null,
  startupStatuses: Map<string, { status: string | null; error: string | null }>
): string | null {
  const statusesByName = new Map<string, { status: string | null; error: string | null }>();
  if (currentStatus && !currentStatus.error) {
    for (const server of currentStatus.servers) statusesByName.set(server.name, { status: server.status, error: null });
  }
  for (const [name, startup] of startupStatuses) statusesByName.set(name, startup);
  if (statusesByName.size === 0) return null;

  let running = 0;
  let failed = 0;
  let unknown = 0;
  const failedNames: string[] = [];
  for (const [name, entry] of statusesByName) {
    const status = entry.status?.toLowerCase() ?? "";
    if (status.includes("running") || status.includes("ready") || status.includes("started")) {
      running += 1;
    } else if (status.includes("fail") || status.includes("error") || status.includes("stopped") || entry.error) {
      failed += 1;
      failedNames.push(name);
    } else {
      unknown += 1;
    }
  }
  const parts = [`${running}/${statusesByName.size} ready`];
  if (failed > 0) {
    const preview = failedNames.slice(0, 3).join(", ");
    parts.push(preview ? `${failed} failed (${preview})` : `${failed} failed`);
  }
  if (unknown > 0) parts.push(`${unknown} unknown`);
  return parts.join(", ");
}

export function formatMcpStartupFailureDetails(
  startupStatuses: Map<string, { status: string | null; error: string | null }>
): string | null {
  const failures = [...startupStatuses]
    .filter(([, entry]) => Boolean(entry.error) || /(fail|error|stopped|disconnected)/i.test(entry.status ?? ""))
    .slice(0, 3)
    .map(([name, entry]) => {
      const error = entry.error?.replace(/\s+/g, " ").trim() || "connection failed";
      const loginHint = /(oauth|token|credential|auth)/i.test(error)
        ? ` Run: codex mcp login ${name}`
        : "";
      return `${name}: ${error}${loginHint}`;
    });
  return failures.length > 0 ? failures.join("\n") : null;
}

export function formatLoadedThreadsStatus(status: { total: number; activeLoaded: boolean }): string {
  return `${status.total} loaded; active ${status.activeLoaded ? "loaded" : "not loaded"}`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes <= 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

export function formatShortError(error: string): string {
  if (error.includes("timed out")) return "timeout";
  if (error.includes("unknown variant")) return "unsupported";
  return "error";
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0
  }).format(value);
}

function truncateText(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
