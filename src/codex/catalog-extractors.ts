import { asRecord, firstString } from "./protocol-utils.js";
import type {
  AppServerAccountStatus,
  AppServerAccountUsageStatus,
  AppServerLoadedThreadsSnapshot,
  AppServerLoadedThreadsStatus,
  AppServerMcpServerStatus,
  AppServerModelCatalog,
  AppServerModelInfo,
  AppServerRuntimeInfo,
  AppServerSkillsCatalog,
  AppServerWorkspaceMessagesStatus
} from "./client.js";

export function extractAccountStatus(value: unknown): AppServerAccountStatus {
  const result = asRecord(value);
  const account = asRecord(result?.account);
  const user = asRecord(result?.user) ?? asRecord(account?.user);
  return {
    email: firstString(result?.email, account?.email, user?.email, result?.login, account?.login, user?.login) ?? null,
    plan: firstString(
      result?.plan, result?.planType, result?.subscriptionPlan,
      account?.plan, account?.planType, account?.subscriptionPlan,
      user?.plan, user?.planType, user?.subscriptionPlan
    ) ?? null
  };
}

export function extractAccountUsageStatus(value: unknown): AppServerAccountUsageStatus | null {
  const result = asRecord(value);
  const summary = asRecord(result?.summary) ?? result;
  if (!summary) return null;
  const usage = {
    lifetimeTokens: firstNumeric(summary.lifetimeTokens, summary.lifetime_tokens),
    peakDailyTokens: firstNumeric(summary.peakDailyTokens, summary.peak_daily_tokens),
    longestRunningTurnSec: firstNumeric(summary.longestRunningTurnSec, summary.longest_running_turn_sec),
    currentStreakDays: firstNumeric(summary.currentStreakDays, summary.current_streak_days),
    longestStreakDays: firstNumeric(summary.longestStreakDays, summary.longest_streak_days)
  };
  return Object.values(usage).some((item) => item !== null) ? usage : null;
}

export function extractWorkspaceMessagesStatus(value: unknown): AppServerWorkspaceMessagesStatus | null {
  const result = asRecord(value);
  const messages = (Array.isArray(result?.messages) && result.messages) ||
    (Array.isArray(result?.data) && result.data) || null;
  if (!messages) return null;
  const activeMessages = messages
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item && !item.archivedAt));
  const latestRecord = activeMessages[0] ?? null;
  const latestBody = firstString(latestRecord?.messageBody, latestRecord?.body, latestRecord?.text);
  return {
    featureEnabled: typeof result?.featureEnabled === "boolean" ? result.featureEnabled : null,
    activeCount: activeMessages.length,
    latest: latestRecord && latestBody
      ? {
          type: firstString(latestRecord.messageType, latestRecord.type) ?? null,
          body: latestBody,
          createdAt: normalizeEpochMs(latestRecord.createdAt)
        }
      : null
  };
}

function firstNumeric(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function normalizeEpochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeEpochMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = firstNumeric(value);
  if (numeric === null) return null;
  if (numeric >= 1_000_000_000_000) return numeric;
  if (numeric >= 1_000_000_000) return numeric * 1_000;
  return null;
}

export function extractModelCatalog(value: unknown): AppServerModelCatalog | null {
  const result = asRecord(value);
  const data = Array.isArray(result?.data) ? result.data : null;
  if (!data) return null;

  const visibleModels: string[] = [];
  const models: AppServerModelInfo[] = [];
  let defaultModel: string | null = null;
  for (const item of data) {
    const model = asRecord(item);
    if (!model || model.hidden === true) continue;
    const name = firstString(model.model, model.id, model.displayName);
    if (!name || visibleModels.includes(name)) continue;
    visibleModels.push(name);
    const upgrade = asRecord(model.upgradeInfo);
    models.push({
      id: name,
      displayName: firstString(model.displayName) ?? null,
      description: firstString(model.description) ?? null,
      defaultReasoningEffort: firstString(model.defaultReasoningEffort) ?? null,
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map((effort) => firstString(asRecord(effort)?.reasoningEffort)).filter((effort): effort is string => Boolean(effort))
        : [],
      inputModalities: Array.isArray(model.inputModalities)
        ? model.inputModalities.filter((modality): modality is string => typeof modality === "string")
        : [],
      serviceTiers: Array.isArray(model.serviceTiers)
        ? model.serviceTiers.flatMap((tier) => {
            const record = asRecord(tier);
            const id = firstString(record?.id, record?.name, tier);
            return id ? [{ id, name: firstString(record?.name) ?? id, description: firstString(record?.description) ?? null }] : [];
          })
        : [],
      defaultServiceTier: firstString(model.defaultServiceTier) ?? null,
      modelSpecialty: firstString(model.modelSpecialty) ?? null,
      multiAgentVersion: firstString(model.multiAgentVersion) ?? null,
      availabilityMessage: firstString(asRecord(model.availabilityNux)?.message) ?? null,
      upgradeInfo: upgrade ? {
        model: firstString(upgrade.model) ?? null,
        retirementAt: typeof upgrade.retirementAt === "number" && Number.isFinite(upgrade.retirementAt) ? upgrade.retirementAt : null
      } : null,
      supportsPersonality: typeof model.supportsPersonality === "boolean" ? model.supportsPersonality : null,
      isDefault: model.isDefault === true
    });
    if (model.isDefault === true) defaultModel = name;
  }
  return { defaultModel, availableCount: visibleModels.length, visibleModels, models };
}

export function extractSkillsCatalog(value: unknown): AppServerSkillsCatalog | null {
  const result = asRecord(value);
  const data = Array.isArray(result?.data) ? result.data : null;
  if (!data) return null;
  const groups = data.map((item) => {
    const group = asRecord(item);
    const skills = Array.isArray(group?.skills) ? group.skills : [];
    return {
      cwd: firstString(group?.cwd) ?? null,
      total: skills.length,
      enabled: skills.filter((skill) => asRecord(skill)?.enabled !== false).length
    };
  });
  return {
    total: groups.reduce((sum, group) => sum + group.total, 0),
    enabled: groups.reduce((sum, group) => sum + group.enabled, 0),
    groups
  };
}

export function extractMcpServerStatus(value: unknown): AppServerMcpServerStatus | null {
  const result = asRecord(value);
  const rawServers = (Array.isArray(result?.data) && result.data) ||
    (Array.isArray(result?.servers) && result.servers) ||
    (Array.isArray(result?.items) && result.items) || null;
  if (!rawServers) return null;
  const servers = rawServers.map((item, index) => {
    const server = asRecord(item);
    const name = firstString(server?.name, server?.id, server?.serverName, server?.command) ?? `server ${index + 1}`;
    const status = firstString(server?.status, server?.state, server?.phase) ?? null;
    const tools = asRecord(server?.tools);
    const toolCount = tools ? Object.keys(tools).length : Array.isArray(server?.tools) ? server.tools.length : null;
    return { name, status, toolCount };
  });
  const running = servers.filter((server) => isRunningMcpStatus(server.status)).length;
  const failed = servers.filter((server) => isFailedMcpStatus(server.status)).length;
  return { total: servers.length, running, failed, unknown: Math.max(0, servers.length - running - failed), error: null, servers };
}

function isRunningMcpStatus(status: string | null): boolean {
  return Boolean(status && /^(running|ready|connected|started|ok)$/i.test(status));
}

function isFailedMcpStatus(status: string | null): boolean {
  return Boolean(status && /(fail|error|stopped|disconnected|unavailable|disabled)/i.test(status));
}

export function extractLoadedThreads(value: unknown): AppServerLoadedThreadsSnapshot | null {
  const result = asRecord(value);
  const rawThreads = (Array.isArray(result?.data) && result.data) ||
    (Array.isArray(result?.threads) && result.threads) ||
    (Array.isArray(result?.items) && result.items) || null;
  if (!rawThreads) return null;
  const threadIds = rawThreads.flatMap((item) => {
    const thread = asRecord(item);
    const threadId = firstString(item, thread?.id, thread?.threadId);
    return threadId ? [threadId] : [];
  });
  return { total: rawThreads.length, threadIds: [...new Set(threadIds)] };
}

export function extractLoadedThreadsStatus(value: unknown, activeThreadId: string): AppServerLoadedThreadsStatus | null {
  const loaded = extractLoadedThreads(value);
  if (!loaded) return null;
  return {
    total: loaded.total,
    activeLoaded: loaded.threadIds.includes(activeThreadId)
  };
}

export function extractRuntimeInfo(value: unknown): AppServerRuntimeInfo {
  const record = asRecord(value);
  const userAgent = firstString(record?.userAgent, record?.user_agent) ?? null;
  return {
    userAgent,
    version: firstString(record?.version, record?.cliVersion, record?.cli_version) ?? extractVersionFromUserAgent(userAgent),
    codexHome: firstString(record?.codexHome, record?.codex_home) ?? null,
    platformFamily: firstString(record?.platformFamily, record?.platform_family) ?? null,
    platformOs: firstString(record?.platformOs, record?.platform_os) ?? null
  };
}

function extractVersionFromUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  return userAgent.match(/(?:codex|openai)[\s_-]*(?:cli|app)?[\s/:v-]*(\d+\.\d+\.\d+)/i)?.[1] ?? null;
}
