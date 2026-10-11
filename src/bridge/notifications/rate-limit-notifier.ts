import type {
  AppServerRateLimitBucket,
  AppServerRateLimitWindow,
  AppServerRateLimitsStatus
} from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import type { SessionProviderStateService } from "../sessions/provider-state.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import {
  getRateLimitLeftPercent,
  getRateLimitThreshold,
  getRateLimitWindowKey,
  isRateLimitResetDetected,
  summarizeRateLimitWindow,
  type RateLimitThresholdState
} from "./rate-limit-policy.js";

type RateLimitStore = Pick<{
  getSessionById: (sessionId: string) => Promise<SessionRecord | null>;
}, "getSessionById">;

export type RateLimitNotifierDependencies = {
  store: RateLimitStore;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  sessionProviderState: Pick<SessionProviderStateService, "resolveModelForRateLimit">;
  pickModelRateLimitBucket: (status: AppServerRateLimitsStatus, model: string) => AppServerRateLimitBucket | null;
  isSameRateLimitBucket: (left: AppServerRateLimitBucket, right: AppServerRateLimitsStatus) => boolean;
  formatRateLimitWindowLabel: (status: AppServerRateLimitsStatus | AppServerRateLimitBucket, kind: "primary" | "secondary") => string;
  formatRateLimitWindow: (window: AppServerRateLimitWindow) => string;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec, options?: { disable_notification?: boolean }) => Promise<unknown>;
};

export class RateLimitNotifier {
  private readonly thresholdState = new Map<string, RateLimitThresholdState>();
  private readonly sentNotifications = new Set<string>();
  private readonly recentSessionByThread = new Map<string, { sessionId: string; updatedAt: number }>();

  constructor(private readonly deps: RateLimitNotifierDependencies) {}

  rememberSession(threadId: string, sessionId: string): void {
    this.recentSessionByThread.set(threadId, { sessionId, updatedAt: Date.now() });
  }

  clearSessionRoutes(): void {
    this.recentSessionByThread.clear();
  }

  async handleRateLimitsUpdate(rateLimits: AppServerRateLimitsStatus, inFlightThreadIds: Iterable<string>): Promise<void> {
    const targetSessions = await this.resolveNotificationSessions(inFlightThreadIds);
    if (targetSessions.length === 0) return;

    const modelBucketTargets = new Map<string, { bucket: AppServerRateLimitBucket; label: string; sessions: SessionRecord[] }>();
    const accountTargets: SessionRecord[] = [];
    for (const session of targetSessions) {
      const model = await this.deps.sessionProviderState.resolveModelForRateLimit(session);
      const bucket = model ? this.deps.pickModelRateLimitBucket(rateLimits, model) : null;
      if (!bucket || this.deps.isSameRateLimitBucket(bucket, rateLimits)) {
        accountTargets.push(session);
        continue;
      }
      const existing = modelBucketTargets.get(bucket.limitId);
      if (existing) existing.sessions.push(session);
      else modelBucketTargets.set(bucket.limitId, {
        bucket,
        label: bucket.limitName ?? model ?? bucket.limitId,
        sessions: [session]
      });
    }

    for (const { bucket, label, sessions } of modelBucketTargets.values()) {
      await this.maybeNotifyThreshold(
        `model:${bucket.limitId}:primary`,
        `${label} ${this.deps.formatRateLimitWindowLabel(bucket, "primary")}`,
        bucket.primary,
        sessions
      );
      await this.maybeNotifyThreshold(
        `model:${bucket.limitId}:secondary`,
        `${label} ${this.deps.formatRateLimitWindowLabel(bucket, "secondary")}`,
        bucket.secondary,
        sessions
      );
    }

    if (accountTargets.length > 0) {
      await this.maybeNotifyThreshold(
        "default:primary",
        this.deps.formatRateLimitWindowLabel(rateLimits, "primary"),
        rateLimits.primary,
        accountTargets,
        "Codex account · rate limit"
      );
      await this.maybeNotifyThreshold(
        "default:secondary",
        this.deps.formatRateLimitWindowLabel(rateLimits, "secondary"),
        rateLimits.secondary,
        accountTargets,
        "Codex account · rate limit"
      );
    }
  }

  private async resolveNotificationSessions(inFlightThreadIds: Iterable<string>): Promise<SessionRecord[]> {
    const now = Date.now();
    const sessionIds = new Set<string>();
    for (const threadId of inFlightThreadIds) {
      const session = await this.deps.resolveNotificationSession(threadId);
      if (session) {
        sessionIds.add(session.id);
        this.rememberSession(threadId, session.id);
      }
    }
    for (const [threadId, recent] of this.recentSessionByThread) {
      if (now - recent.updatedAt > 60_000) {
        this.recentSessionByThread.delete(threadId);
        continue;
      }
      sessionIds.add(recent.sessionId);
    }
    const sessions = await Promise.all([...sessionIds].map((sessionId) => this.deps.store.getSessionById(sessionId)));
    return sessions.filter((session): session is SessionRecord => Boolean(session));
  }

  private async maybeNotifyThreshold(
    key: string,
    label: string,
    window: AppServerRateLimitWindow | null,
    targetSessions: SessionRecord[],
    title?: string
  ): Promise<void> {
    if (!window) return;
    const leftPercent = getRateLimitLeftPercent(window);
    if (leftPercent === null) return;
    const threshold = getRateLimitThreshold(leftPercent);
    const resetsAt = getRateLimitWindowKey(window);
    const previousState = this.thresholdState.get(key);
    const resetWindowChanged = Boolean(previousState && previousState.resetsAt !== resetsAt);
    const resetDetected = isRateLimitResetDetected(previousState ?? null, leftPercent);
    const previous = previousState && previousState.resetsAt === resetsAt ? previousState.threshold : undefined;
    if (resetDetected) await this.notifyReset(label, window, targetSessions, title);
    if (threshold === null) {
      this.thresholdState.set(key, { threshold: null, resetsAt, leftPercent });
      return;
    }
    this.thresholdState.set(key, { threshold, resetsAt, leftPercent });
    if (threshold === 0) {
      if (previous === threshold || (resetWindowChanged && !resetDetected)) return;
      await this.notifyWarning(label, window, threshold, targetSessions, title);
      return;
    }
    if (previous === undefined || (previous !== threshold && (previous === null || threshold <= previous))) {
      await this.notifyWarning(label, window, threshold, targetSessions, title);
    }
  }

  private async notifyWarning(label: string, window: AppServerRateLimitWindow, threshold: number, sessions: SessionRecord[], title?: string): Promise<void> {
    const prefix = threshold === 0 ? `${label} limit exhausted.` : `${label} limit warning: ${threshold}% left.`;
    await this.notifySessions("warning", label, window, sessions, title, [prefix, this.deps.formatRateLimitWindow(window)]);
  }

  private async notifyReset(label: string, window: AppServerRateLimitWindow, sessions: SessionRecord[], title?: string): Promise<void> {
    await this.notifySessions("reset", label, window, sessions, title, [`${label} limit reset`, this.deps.formatRateLimitWindow(window)]);
  }

  private async notifySessions(
    kind: "warning" | "reset",
    label: string,
    window: AppServerRateLimitWindow,
    sessions: SessionRecord[],
    title: string | undefined,
    lines: string[]
  ): Promise<void> {
    const notifiedChatIds = new Set<string>();
    for (const session of sessions) {
      const chatId = session.telegramChatId;
      if (notifiedChatIds.has(chatId)) continue;
      notifiedChatIds.add(chatId);
      const threshold = kind === "warning" ? getRateLimitThreshold(getRateLimitLeftPercent(window) ?? 0) : null;
      const key = [chatId, kind, label, threshold ?? "reset", getRateLimitWindowKey(window) ?? "unknown-reset"].join(":");
      if (this.sentNotifications.has(key)) continue;
      this.sentNotifications.add(key);
      const messageTitle = title ?? `${label} · rate limit`;
      const messageSpec = createMessage({
        kind: "system",
        titleLabel: messageTitle,
        body: lines.map((line) => ({ type: "text" as const, text: line }))
      });
      logger.info("bridge.rate_limit.notification", {
        kind,
        chatId,
        title: messageTitle,
        label,
        threshold,
        window: summarizeRateLimitWindow(window)
      });
      await this.deps.sendLongSpec(chatId, messageSpec);
    }
  }
}
