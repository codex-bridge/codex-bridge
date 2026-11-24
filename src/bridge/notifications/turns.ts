import type {
  AppServerStatusUpdate,
  AppServerTurnLifecycleEvent
} from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import type { QueuedSubmissionService } from "../input/queued-submission.js";

export type NotificationTurnDependencies = {
  preserveTurnLease?: (sessionId: string, change: () => boolean) => boolean;
  store: BridgeStore;
  promoteSessionHandoff: (session: SessionRecord) => Promise<void>;
  inFlightTurnIdByThread: Map<string, string>;
  assistantOutputByThread: Map<string, boolean>;
  errorSeenByThread: Map<string, boolean>;
  lastAssistantTelegramByThread: Map<string, { chatId: string; messageId: string; text: string }>;
  queuedSubmissionService: Pick<QueuedSubmissionService, "reconcileStartedSubmission">;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  applyStatusUpdate: (session: SessionRecord, update: AppServerStatusUpdate, canRefresh?: () => boolean) => Promise<void>;
  handleRecoveryTaskComplete: (session: SessionRecord) => Promise<boolean>;
  clearProgressMessageForThread: (threadId: string, options?: { terminal?: "completed" | "failed" | "interrupted"; turnId?: string }) => Promise<void>;
  scheduleGoShortcut: (session: SessionRecord) => Promise<void> | void;
  cancelGoShortcut: (threadId: string) => void;
  rememberRateLimitSession: (threadId: string, sessionId: string) => void;
  onTurnSettled?: (session: SessionRecord, event: AppServerTurnLifecycleEvent) => void;
};

export class NotificationTurnService {
  constructor(private readonly deps: NotificationTurnDependencies) {}

  async handleStatusUpdate(
    statusUpdate: AppServerStatusUpdate,
    terminalTurnId?: string,
    terminalState?: AppServerTurnLifecycleEvent["terminalState"],
    terminalError?: string,
    canRefresh?: () => boolean
  ): Promise<void> {
    if (!this.deps.inFlightTurnIdByThread.has(statusUpdate.threadId)) {
      await this.deps.queuedSubmissionService.reconcileStartedSubmission(statusUpdate.threadId);
    }
    if (statusUpdate.kind === "clear" && terminalTurnId) {
      const activeRoute = this.deps.store.getActiveTurnRoute(statusUpdate.threadId);
      if (activeRoute && activeRoute.turnId !== terminalTurnId) {
        logger.info("bridge.turn.stale_terminal_status_ignored", {
          threadId: statusUpdate.threadId,
          terminalTurnId,
          activeTurnId: activeRoute.turnId
        });
        return;
      }
    }
    const session = await this.deps.resolveNotificationSession(statusUpdate.threadId);
    if (!session) return;

    await this.deps.applyStatusUpdate(session, statusUpdate, canRefresh);
    if (statusUpdate.kind !== "clear") return;

    const recoveryContinues = await this.deps.handleRecoveryTaskComplete(session);
    const hadAssistantOutput = this.deps.assistantOutputByThread.get(statusUpdate.threadId) === true;
    const hadError = this.deps.errorSeenByThread.get(statusUpdate.threadId) === true;
    this.deps.assistantOutputByThread.delete(statusUpdate.threadId);
    this.deps.errorSeenByThread.delete(statusUpdate.threadId);
    if (!recoveryContinues) {
      // Capture the actual ending turn before Actions can accept a new user turn.
      const progressTurnId = terminalTurnId ?? this.deps.store.getActiveTurnRoute(statusUpdate.threadId)?.turnId
        ?? this.deps.inFlightTurnIdByThread.get(statusUpdate.threadId);
      try {
        // Actions get the send slot before the final summary edit. Their own
        // cancellation/decision/ownership checks still run at the write boundary.
        if (hadAssistantOutput || hadError) await this.deps.scheduleGoShortcut(session);
      } finally {
        await this.deps.clearProgressMessageForThread(statusUpdate.threadId, {
          terminal: terminalState ?? (hadError ? "failed" : "completed"),
          ...(progressTurnId ? { turnId: progressTurnId } : {})
        });
        if (terminalTurnId) this.deps.onTurnSettled?.(session, { threadId: statusUpdate.threadId,
          turnId: terminalTurnId, kind: "completed", terminalState, ...(terminalError ? { error: terminalError } : {}) });
      }
    } else {
      this.deps.cancelGoShortcut(statusUpdate.threadId);
      this.deps.lastAssistantTelegramByThread.delete(statusUpdate.threadId);
    }
  }

  async handleTurnLifecycle(turnLifecycle: AppServerTurnLifecycleEvent): Promise<void> {
    if (turnLifecycle.kind === "started" && !this.deps.inFlightTurnIdByThread.has(turnLifecycle.threadId)) {
      await this.deps.queuedSubmissionService.reconcileStartedSubmission(turnLifecycle.threadId);
    }
    const session = await this.deps.resolveNotificationSession(turnLifecycle.threadId);
    if (session) {
      this.deps.rememberRateLimitSession(turnLifecycle.threadId, session.id);
    }
    if (turnLifecycle.kind === "started") {
      const previousRoute = this.deps.store.getActiveTurnRoute(turnLifecycle.threadId);
      if (previousRoute && previousRoute.turnId !== turnLifecycle.turnId) {
        await this.deps.clearProgressMessageForThread(turnLifecycle.threadId, {
          terminal: "interrupted",
          turnId: previousRoute.turnId
        });
      }
      this.deps.cancelGoShortcut(turnLifecycle.threadId);
      this.deps.inFlightTurnIdByThread.set(turnLifecycle.threadId, turnLifecycle.turnId);
      this.deps.assistantOutputByThread.set(turnLifecycle.threadId, false);
      this.deps.errorSeenByThread.set(turnLifecycle.threadId, false);
      this.deps.lastAssistantTelegramByThread.delete(turnLifecycle.threadId);
      if (session) {
        const ownerLease = this.deps.store.getSessionLease(session.id);
        const ownerBinding = ownerLease?.ownerBindingId
          ? this.deps.store.getSessionBindingById(ownerLease.ownerBindingId)
          : null;
        this.deps.store.recordTurnRoute({
          turnId: turnLifecycle.turnId,
          sessionId: session.id,
          codexThreadId: turnLifecycle.threadId,
          bindingId: ownerBinding?.id ?? null,
          sourceId: ownerBinding?.sourceId ?? session.telegramChatId
        });
      }
      return;
    }

    if (this.deps.inFlightTurnIdByThread.get(turnLifecycle.threadId) === turnLifecycle.turnId) {
      this.deps.inFlightTurnIdByThread.delete(turnLifecycle.threadId);
    }
    this.deps.store.completeTurnRoute(turnLifecycle.turnId, turnLifecycle.terminalState ?? "interrupted");
    if (session) {
      const clear = () => this.deps.store.clearSessionOwnerTurn(session.id, turnLifecycle.turnId);
      if (this.deps.preserveTurnLease) this.deps.preserveTurnLease(session.id, clear);
      else clear();
      await this.deps.promoteSessionHandoff(session);
    }
    // Completed notifications also carry a clear status update. That path owns
    // visible cleanup, after Actions; lifecycle bookkeeping performs no summary edit.
  }
}
