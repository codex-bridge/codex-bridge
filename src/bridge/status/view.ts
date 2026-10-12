import { CodexAppServerClient, type AppServerThreadGoal } from "../../codex/client.js";
import type { CodexConfigSnapshot } from "../../codex/config-snapshot.js";
import { APP_SERVER_PROTOCOL_PROBE, listAppServerMethodCapabilities } from "../../codex/protocol-registry.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { createMessage } from "../messages/factory.js";
import { actionRow, helpAction, sessionAction, statusViewAction } from "../messages/actions.js";
import type { MessageSpec } from "../messages/types.js";
import {
  formatAccountUsageStatus,
  formatCompactNumber,
  formatContextWindow,
  formatElapsed,
  formatLoadedThreadsStatus,
  formatMcpServerStatus,
  formatMcpStartupFailureDetails,
  formatMcpStartupStatusCache,
  formatMcpToolCatalogStatus,
  formatModelCatalog,
  formatModelToolCallStatus,
  formatRateLimitBucketLabel,
  formatRateLimitWindow,
  formatRateLimitWindowLabel,
  formatRuntimeClient,
  formatSkillsCatalog,
  formatStatusHealthSummary,
  formatWorkspaceMessagesStatus,
  pickModelRateLimitBucket,
} from "./formatters.js";
import { formatSessionMarker } from "../../shared/session-tag.js";
import { formatCompactDateTime, pickDirectory } from "../sessions/menu-formatters.js";
import type { TokenUsageTracker } from "./token-usage.js";
import type { ModelRuntimeEvent } from "../runtime-state.js";
import { formatConfigRequirements, formatProviderCapabilities, formatServerDiagnostics } from "./capability-formatters.js";

type SessionProviderDetails = {
  activeProvider: string | null;
  configError: string | null;
  configOrigin: string | null;
  effectiveProvider: string | null;
};

type GoalResult = { goal: AppServerThreadGoal | null; error: string | null };

export type StatusViewDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  tokenUsageTracker: Pick<TokenUsageTracker, "get">;
  inFlightTurnIdByThread: Map<string, string>;
  mcpStartupStatusByName: Map<string, { status: string | null; error: string | null; updatedAt: number }>;
  modelRuntimeEventByThread: Map<string, ModelRuntimeEvent>;
  isRuntimeConnected: () => boolean;
  getSessionDirectory: (session: SessionRecord) => string;
  getSessionProviderDetails: (session: SessionRecord, options?: {
    activeProvider?: string | null;
    configError?: string | null;
    readActive?: boolean;
    snapshot?: CodexConfigSnapshot | null;
  }) => Promise<SessionProviderDetails>;
  readEffectiveConfigSnapshot: (directory: string) => Promise<{ snapshot: CodexConfigSnapshot | null; error: string | null }>;
  readSessionGoal: (session: SessionRecord) => Promise<GoalResult>;
};

export class StatusViewService {
  constructor(private readonly deps: StatusViewDependencies) {}

  async render(telegramChatId: string, full = false): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!session) {
      const text = this.deps.isRuntimeConnected()
        ? "No active session."
        : "Codex runtime is disconnected.\nNo active session.";
      return createMessage({
        kind: "system",
        titleLabel: "Codex status",
        body: [{ type: "text", text }],
        actions: actionRow(sessionAction(), helpAction())
      });
    }

    return this.renderSession(session, full);
  }

  async renderSession(session: SessionRecord, full = false): Promise<MessageSpec> {

    if (!this.deps.isRuntimeConnected()) {
      return this.renderDisconnected(session, full);
    }

    const [threadStatus, accountStatus, rateLimitsStatus, pendingDecisions, goalResult, configState, capabilities] = await Promise.all([
      this.deps.codexClient.readThreadStatus(session.codexThreadId, this.deps.getSessionDirectory(session)),
      this.deps.codexClient.readAccountStatus(),
      this.deps.codexClient.readRateLimitsStatus(),
      this.deps.store.listPendingDecisions(session.id),
      this.deps.readSessionGoal(session),
      this.deps.readEffectiveConfigSnapshot(this.deps.getSessionDirectory(session)),
      this.deps.codexClient.readRuntimeCapabilities()
    ]);

    const [modelCatalog, mcpServerStatus, loadedThreadsStatus, skillsCatalog, accountUsageStatus, workspaceMessagesStatus] = full
      ? await Promise.all([
          this.deps.codexClient.readModelCatalog(),
          this.deps.codexClient.readMcpServerStatus(),
          this.deps.codexClient.readLoadedThreadsStatus(session.codexThreadId),
          this.deps.codexClient.readSkillsCatalog(),
          this.deps.codexClient.readAccountUsageStatus(),
          this.deps.codexClient.readWorkspaceMessagesStatus()
        ])
      : [null, null, null, null, null, null];

    const directory = pickDirectory(
      threadStatus.cwd,
      session.currentCwd,
      session.displayName,
      session.pathKey
    ) ?? session.pathKey;
    const configSnapshot = configState.snapshot;
    const model = threadStatus.model ?? configSnapshot?.model ?? "unknown";
    const permissionParts = [
      `approval ${threadStatus.approvalPolicy ?? "unknown"}`,
      `sandbox ${threadStatus.sandboxMode ?? "unknown"}`
    ];
    const modelRateLimit = pickModelRateLimitBucket(rateLimitsStatus, model);
    const modelRateLimitLabel = modelRateLimit ? formatRateLimitBucketLabel(modelRateLimit, model) : null;
    const sparkModelRateLimit = pickModelRateLimitBucket(rateLimitsStatus, "gpt-5.3-codex-spark");
    const sparkModelRateLimitLabel = sparkModelRateLimit
      ? formatRateLimitBucketLabel(sparkModelRateLimit, "gpt-5.3-codex-spark")
      : null;
    const inFlightTurnId = this.deps.inFlightTurnIdByThread.get(session.codexThreadId) ?? null;
    const threadName = threadStatus.threadName ?? session.displayName ?? null;
    const tokenUsage = threadStatus.contextLeftPercent !== null ||
      threadStatus.contextUsedTokens !== null || threadStatus.contextMaxTokens !== null
      ? {
          leftPercent: threadStatus.contextLeftPercent,
          usedTokens: threadStatus.contextUsedTokens,
          maxTokens: threadStatus.contextMaxTokens
        }
      : this.deps.tokenUsageTracker.get(session.codexThreadId);
    const mcpStartupStatus = formatMcpStartupStatusCache(
      mcpServerStatus,
      new Map([...this.deps.mcpStartupStatusByName].map(([name, startup]) => [name, { status: startup.status, error: startup.error }]))
    );
    const mcpStartupFailureDetails = formatMcpStartupFailureDetails(
      new Map([...this.deps.mcpStartupStatusByName].map(([name, startup]) => [name, { status: startup.status, error: startup.error }]))
    );
    const healthSummary = formatStatusHealthSummary({
      busy: Boolean(inFlightTurnId),
      tokenUsage,
      rateLimitsStatus: modelRateLimit ?? rateLimitsStatus,
      rateLimitLabel: modelRateLimitLabel,
      mcpStartupStatus,
      pendingApprovals: pendingDecisions.length
    });

    const lines = [heading("Codex status"), "", section("Core")];
    lines.push(field("Health", healthSummary));
    const runtimeInfo = this.deps.codexClient.getRuntimeInfo();
    lines.push(field("Directory", formatSessionMarker(directory)));
    lines.push("", section("Config"));
    if (configSnapshot) {
      lines.push(field("Model", configValue(configSnapshot, "model", configSnapshot.model)));
      lines.push(field("Reasoning", configValue(configSnapshot, "model_reasoning_effort", configSnapshot.reasoningEffort ?? "built-in default")));
      lines.push(field("Tier", configValue(configSnapshot, "service_tier", configSnapshot.serviceTier ?? "built-in default")));
      if (full) {
        lines.push(field("Summary", configValue(configSnapshot, "model_reasoning_summary", configSnapshot.reasoningSummary ?? "built-in default")));
        lines.push(field("Approval", unknownConfigValue(configSnapshot.approvalPolicy)));
        lines.push(field("Reviewer", configSnapshot.approvalsReviewer ?? "built-in default"));
        lines.push(field("Sandbox", configSnapshot.sandboxPolicy?.type ?? "built-in default"));
        lines.push(field("Personality", configSnapshot.personality ?? "built-in default"));
      }
    } else {
      lines.push(field("Read", `failed (${configState.error ?? "unknown error"})`));
    }
    lines.push(...formatConfigRequirements(capabilities.requirements, full));
    lines.push("", section("Thread"));
    lines.push(field("Model", threadStatus.model ?? "unknown"));
    lines.push(field("Reasoning", threadStatus.reasoningEffort ?? "unknown"));
    lines.push(field("Tier", threadStatus.serviceTier ?? (threadStatus.serviceTierKnown ? "none (reported)" : "unknown")));
    const modelRuntimeEvent = this.deps.modelRuntimeEventByThread.get(session.codexThreadId);
    if (modelRuntimeEvent) {
      lines.push(field("Model event", formatModelRuntimeEvent(modelRuntimeEvent)));
    }
    lines.push("", section("Goal"));
    lines.push(...this.formatGoalStatusLines(goalResult));
    const providerDetails = await this.deps.getSessionProviderDetails(session, {
      activeProvider: threadStatus.modelProvider,
      configError: configState.error,
      snapshot: configSnapshot
    });
    lines.push("", section("Provider"));
    lines.push(...providerLines(providerDetails));
    lines.push(...formatProviderCapabilities(capabilities.provider));
    if (full) {
      lines.push("", section("Tools"));
      if (mcpServerStatus) lines.push(field("MCP servers", formatMcpServerStatus(mcpServerStatus)));
      if (mcpStartupStatus) lines.push(field("MCP startup", mcpStartupStatus));
      if (mcpStartupFailureDetails) lines.push(field("MCP reconnect", mcpStartupFailureDetails));
      if (mcpServerStatus) lines.push(field("MCP tools", formatMcpToolCatalogStatus(mcpServerStatus)));
      lines.push(field("Model tool calls", formatModelToolCallStatus(runtimeInfo?.version ?? null)));
    }
    lines.push("", section("Runtime"));
    lines.push(...formatServerDiagnostics(capabilities.diagnostics, full));
    if (runtimeInfo) lines.push(field("Version", runtimeInfo.version ?? runtimeInfo.userAgent ?? "unknown"));
    lines.push(field("Permissions", permissionParts.join(" · ")));
    if (accountStatus?.email) lines.push(field("Account", accountStatus.email));
    if (accountStatus?.plan) lines.push(field("Plan", accountStatus.plan));
    if (threadName) lines.push(field("Thread", threadName));
    lines.push(field("Session", threadStatus.threadId));
    if (full && inFlightTurnId) lines.push(field("Active turn", inFlightTurnId));
    if (tokenUsage) lines.push(field("Context window", formatContextWindow(tokenUsage)));

    const limitLines: string[] = [];
    if (rateLimitsStatus?.primary) limitLines.push(field(formatRateLimitWindowLabel(rateLimitsStatus, "primary"), formatRateLimitWindow(rateLimitsStatus.primary)));
    if (rateLimitsStatus?.secondary) limitLines.push(field(formatRateLimitWindowLabel(rateLimitsStatus, "secondary"), formatRateLimitWindow(rateLimitsStatus.secondary)));
    if (modelRateLimit) {
      const label = modelRateLimitLabel ?? modelRateLimit.limitId;
      if (modelRateLimit.primary) limitLines.push(field(`${label} ${formatRateLimitWindowLabel(modelRateLimit, "primary")}`, formatRateLimitWindow(modelRateLimit.primary)));
      if (modelRateLimit.secondary) limitLines.push(field(`${label} ${formatRateLimitWindowLabel(modelRateLimit, "secondary")}`, formatRateLimitWindow(modelRateLimit.secondary)));
    }
    if (sparkModelRateLimit && sparkModelRateLimit.limitId !== modelRateLimit?.limitId) {
      const label = sparkModelRateLimitLabel ?? sparkModelRateLimit.limitId;
      if (sparkModelRateLimit.primary) limitLines.push(field(`${label} ${formatRateLimitWindowLabel(sparkModelRateLimit, "primary")}`, formatRateLimitWindow(sparkModelRateLimit.primary)));
      if (sparkModelRateLimit.secondary) limitLines.push(field(`${label} ${formatRateLimitWindowLabel(sparkModelRateLimit, "secondary")}`, formatRateLimitWindow(sparkModelRateLimit.secondary)));
    }
    if (limitLines.length > 0) lines.push("", section("Limits"), ...limitLines);
    if (full && typeof rateLimitsStatus?.resetCreditsAvailable === "number") lines.push(field("Reset credits", `${rateLimitsStatus.resetCreditsAvailable} available`));
    if (full) {
      lines.push("", section("Runtime detail"));
      const methods = listAppServerMethodCapabilities({ kind: "request" });
      lines.push(field("Protocol", `baseline ${APP_SERVER_PROTOCOL_PROBE.codexCliVersion} · ${methods.length} requests · ${methods.filter((entry) => entry.evidence.productionReferences.length).length} referenced · ${methods.filter((entry) => entry.evidence.liveVerification).length} live verified`));
      if (runtimeInfo?.userAgent && runtimeInfo.userAgent !== runtimeInfo.version) lines.push(field("Client", formatRuntimeClient(runtimeInfo.userAgent)));
      if (runtimeInfo?.codexHome) lines.push(field("Codex home", runtimeInfo.codexHome));
      const platform = [runtimeInfo?.platformFamily, runtimeInfo?.platformOs].filter(Boolean).join(" / ");
      if (platform) lines.push(field("Platform", platform));
    }
    if (modelCatalog) lines.push(field("Models", formatModelCatalog(modelCatalog)));
    if (accountUsageStatus) lines.push(field("Usage", formatAccountUsageStatus(accountUsageStatus)));
    if (workspaceMessagesStatus) lines.push(field("Workspace messages", formatWorkspaceMessagesStatus(workspaceMessagesStatus)));
    if (skillsCatalog) lines.push(field("Skills", formatSkillsCatalog(skillsCatalog)));
    if (loadedThreadsStatus && !loadedThreadsStatus.activeLoaded) lines.push(field("Loaded threads", formatLoadedThreadsStatus(loadedThreadsStatus)));
    if (pendingDecisions.length > 0) lines.push(field("Pending approvals", String(pendingDecisions.length)));

    return this.createResult(session, lines, full);
  }

  private async renderDisconnected(session: SessionRecord, full: boolean): Promise<MessageSpec> {
    const directory = pickDirectory(session.currentCwd, session.displayName, session.pathKey) ?? session.pathKey;
    const lines = [heading("Codex status"), "", section("Core"), field("Runtime", "disconnected")];
    const runtimeInfo = this.deps.codexClient.getRuntimeInfo();
    if (runtimeInfo) {
      lines.push(field("Version", runtimeInfo.version ?? runtimeInfo.userAgent ?? "unknown"));
      if (full) {
        if (runtimeInfo.userAgent && runtimeInfo.userAgent !== runtimeInfo.version) lines.push(field("User agent", runtimeInfo.userAgent));
        if (runtimeInfo.codexHome) lines.push(field("Codex home", runtimeInfo.codexHome));
        const platform = [runtimeInfo.platformFamily, runtimeInfo.platformOs].filter(Boolean).join(" / ");
        if (platform) lines.push(field("Platform", platform));
      }
    }
    lines.push(field("Directory", formatSessionMarker(directory)));
    if (session.displayName) lines.push(field("Thread", session.displayName));
    const providerDetails = await this.deps.getSessionProviderDetails(session);
    lines.push("", section("Provider"), ...providerLines(providerDetails), "", section("Runtime"), field("Session", session.codexThreadId));
    return this.createResult(session, lines, full);
  }

  private formatGoalStatusLines(result: GoalResult): string[] {
    if (result.error) return [field("Status", `unavailable: ${result.error}`)];
    if (!result.goal) return [field("Status", "none")];
    const goal = result.goal;
    const lines = [
      field("Status", goal.status === "usageLimited" ? "usage limited" : goal.status === "budgetLimited" ? "budget limited" : goal.status),
      field("Objective", goal.objective),
      field("Used", `${formatCompactNumber(goal.tokensUsed)} tokens · ${formatElapsed(goal.timeUsedSeconds * 1_000)}`)
    ];
    if (goal.tokenBudget !== null) lines.push(field("Budget", `${formatCompactNumber(goal.tokenBudget)} tokens`));
    lines.push(field("Updated", formatCompactDateTime(goal.updatedAt * (goal.updatedAt < 10_000_000_000 ? 1_000 : 1))));
    return lines;
  }

  private createResult(session: SessionRecord, lines: string[], full: boolean): MessageSpec {
    return createMessage({
      kind: "system",
      titleLabel: "Codex status",
      session: { id: session.codexThreadId, directory: this.deps.getSessionDirectory(session) },
      body: [{ type: "markdown", text: lines.slice(2).join("\n") }],
      actions: actionRow(statusViewAction(full), helpAction())
    });
  }
}

function formatModelRuntimeEvent(event: ModelRuntimeEvent): string {
  if (event.kind === "rerouted") {
    const route = [event.fromModel, event.toModel].filter(Boolean).join(" -> ");
    return event.reason ? `${route || "rerouted"} (${event.reason})` : route || "rerouted";
  }
  return event.verifications.length > 0 ? event.verifications.join(", ") : "completed";
}

const heading = (text: string): string => `**${text}**`;
const section = (text: string): string => `**${text}**`;
const field = (key: string, value: string): string => `**${key}** ${value}`;
const configValue = (snapshot: CodexConfigSnapshot, key: string, value: string): string => {
  const origin = snapshot.origins?.[key]?.type;
  return origin ? `${value} (${origin})` : value;
};
const unknownConfigValue = (value: unknown): string => {
  if (value === null || value === undefined) return "built-in default";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "configured";
  }
};
const providerLines = (details: SessionProviderDetails): string[] => [
  field("Config", details.configError ? `unavailable (${details.configError})` : `${details.effectiveProvider ?? "built-in default"}${details.configOrigin ? ` (${details.configOrigin})` : ""}`),
  field("Thread", details.activeProvider ?? "unknown")
];
