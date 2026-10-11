import type {
  AppServerStatusUpdate,
  AppServerTurnLifecycleEvent
} from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import type { QueuedSubmissionService } from "../input/queued-submission.js";

export type NotificationTurnDependencies = {
  store: BridgeStore;
  promoteSessionHandoff: (session: SessionRecord) => Promise<void>;
  inFlightTurnIdByThread: Map<string, string>;
  assistantOutputByThread: Map<string, boolean>;
  errorSeenByThread: Map<string, boolean>;
  lastAssistantTelegramByThread: Map<string, { chatId: string; messageId: string; text: string }>;
  queuedSubmissionService: Pick<QueuedSubmissionService, "reconcileStartedSubmission">;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  applyStatusUpdate: (session: SessionRecord, update: AppServerStatusUpdate) => Promise<void>;
  handleRecoveryTaskComplete: (session: SessionRecord) => Promise<boolean>;
  clearProgressMessageForThread: (threadId: string, options?: { terminal?: "completed" | "failed" | "interrupted"; turnId?: string }) => Promise<void>;
  scheduleGoShortcut: (session: SessionRecord) => void;
  cancelGoShortcut: (threadId: string) => void;
  rememberRateLimitSession: (threadId: string, sessionId: string) => void;
  deliverVersionUpdateAfterRootTurn: (session: SessionRecord | null) => Promise<boolean>;
};

export class NotificationTurnService {
  constructor(private readonly deps: NotificationTurnDependencies) {}

  async handleStatusUpdate(
    statusUpdate: AppServerStatusUpdate,
    terminalTurnId?: string,
    terminalState?: AppServerTurnLifecycleEvent["terminalState"]
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

    await this.deps.applyStatusUpdate(session, statusUpdate);
    if (statusUpdate.kind !== "clear") return;

    const recoveryContinues = await this.deps.handleRecoveryTaskComplete(session);
    const hadAssistantOutput = this.deps.assistantOutputByThread.get(statusUpdate.threadId) === true;
    const hadError = this.deps.errorSeenByThread.get(statusUpdate.threadId) === true;
    this.deps.assistantOutputByThread.delete(statusUpdate.threadId);
    this.deps.errorSeenByThread.delete(statusUpdate.threadId);
    if (!recoveryContinues) {
      await this.deps.clearProgressMessageForThread(statusUpdate.threadId, {
        terminal: terminalState ?? (hadError ? "failed" : "completed"),
        ...(terminalTurnId ? { turnId: terminalTurnId } : {})
      });
      if (hadAssistantOutput || hadError) {
        this.deps.scheduleGoShortcut(session);
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
      this.deps.store.clearSessionOwnerTurn(session.id, turnLifecycle.turnId);
      await this.deps.promoteSessionHandoff(session);
    }
    const activeRoute = this.deps.store.getActiveTurnRoute(turnLifecycle.threadId);
    if (!activeRoute || activeRoute.turnId === turnLifecycle.turnId) {
      await this.deps.clearProgressMessageForThread(turnLifecycle.threadId, {
        terminal: turnLifecycle.terminalState ?? "interrupted",
        turnId: turnLifecycle.turnId
      });
      await this.deps.deliverVersionUpdateAfterRootTurn(session);
    }
  }
}
