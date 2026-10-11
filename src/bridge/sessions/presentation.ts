import type {
  AppServerThreadGoal,
  AppServerThreadGoalStatus,
  CodexAppServerClient
} from "../../codex/client.js";
import { CodexThreadMetadataCache } from "../../codex/thread-metadata-cache.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { formatCompactNumber, formatElapsed, formatShortError } from "../status/formatters.js";
import {
  formatCompactDate,
  formatCompactDateTime,
  getSessionDirectory,
  getSessionTitle
} from "./menu-formatters.js";
import type { SectionMenuEntry } from "./menu.js";

export type SessionGoalReadResult = {
  goal: AppServerThreadGoal | null;
  error: string | null;
};

export type SessionPresentationDependencies = {
  codexClient: Pick<CodexAppServerClient, "getObservedThreadProvider" | "readThreadGoal">;
  threadMetadataCache: CodexThreadMetadataCache;
  isRuntimeConnected: () => boolean;
};

export class SessionPresentationService {
  constructor(private readonly deps: SessionPresentationDependencies) {}

  getSessionDirectory(session: SessionRecord): string {
    return getSessionDirectory(this.withLatestCodexMetadata(session));
  }

  getSessionTitle(session: SessionRecord): string {
    return getSessionTitle(this.withLatestCodexMetadata(session));
  }

  async formatSectionMenuLabel(
    entry: SectionMenuEntry,
    effectiveProvider: string
  ): Promise<string> {
    const session = this.withLatestCodexMetadata(entry.session);
    const codexName = this.deps.threadMetadataCache.get(session.codexThreadId)?.name?.trim();
    const name = codexName || getSessionTitle(session);
    const created = formatCompactDate(session.createdAt);
    const updated = formatCompactDateTime(entry.activityAt);
    const actualProvider = this.deps.codexClient.getObservedThreadProvider?.(session.codexThreadId) ?? null;
    const provider = actualProvider ?? (effectiveProvider === "built-in default" ? null : effectiveProvider);
    return `${provider ? `${provider} · ` : ""}${name} · u ${updated} · c ${created}`;
  }

  async readSessionGoal(session: SessionRecord): Promise<SessionGoalReadResult> {
    if (!this.deps.isRuntimeConnected()) return { goal: null, error: "runtime disconnected" };
    try {
      return { goal: await this.deps.codexClient.readThreadGoal(session.codexThreadId), error: null };
    } catch (error) {
      const message = formatShortError(error instanceof Error ? error.message : String(error));
      logger.warn("bridge.goal.read_failed", {
        sessionId: session.id,
        threadId: session.codexThreadId,
        message
      });
      return { goal: null, error: message };
    }
  }

  formatGoalStatus(status: AppServerThreadGoalStatus): string {
    switch (status) {
      case "usageLimited": return "usage limited";
      case "budgetLimited": return "budget limited";
      default: return status;
    }
  }

  formatGoalStatusLines(result: SessionGoalReadResult): string[] {
    if (result.error) return [this.formatStatusField("Status", `unavailable: ${result.error}`)];
    if (!result.goal) return [this.formatStatusField("Status", "none")];
    const goal = result.goal;
    const lines = [
      this.formatStatusField("Status", this.formatGoalStatus(goal.status)),
      this.formatStatusField("Objective", goal.objective),
      this.formatStatusField("Used", `${formatCompactNumber(goal.tokensUsed)} tokens · ${formatElapsed(goal.timeUsedSeconds * 1_000)}`)
    ];
    if (goal.tokenBudget !== null) {
      lines.push(this.formatStatusField("Budget", `${formatCompactNumber(goal.tokenBudget)} tokens`));
    }
    lines.push(this.formatStatusField("Updated", formatCompactDateTime(goal.updatedAt * (goal.updatedAt < 10_000_000_000 ? 1_000 : 1))));
    return lines;
  }

  private withLatestCodexMetadata(session: SessionRecord): SessionRecord {
    const metadata = this.deps.threadMetadataCache.get(session.codexThreadId);
    if (!metadata) return session;
    return {
      ...session,
      pathKey: metadata.pathKey ?? session.pathKey,
      currentCwd: metadata.currentCwd ?? session.currentCwd,
      displayName: metadata.name ?? session.displayName,
      latestActivityAt: metadata.updatedAt ?? session.latestActivityAt,
      createdAt: metadata.createdAt ?? session.createdAt,
      codexArchivedAt: metadata.archivedAt ?? session.codexArchivedAt
    };
  }

  private formatStatusField(key: string, value: string): string {
    return `**${key}** ${value}`;
  }
}
