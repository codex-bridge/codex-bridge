import { createHash } from "node:crypto";
import type { AppServerErrorEvent, AppServerTurnLifecycleEvent } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";

export type NotificationRecoveryDependencies = {
  errorSeenByThread: Map<string, boolean>;
  getActiveTurnId: (threadId: string) => string | null;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  cancelGoShortcut: (threadId: string) => void;
  clearTypingState: (sessionId: string) => void;
  setSessionStatus: (
    session: SessionRecord,
    label: string,
    update?: { detail: string | null; detailMode: "replace" | "append" | null }
  ) => Promise<void>;
  formatRecoveryIssue: (event: AppServerErrorEvent) => string;
  autoCompactOnIncompatibleHistory: boolean;
  isIncompatibleHistoryError: (message: string) => boolean;
  handleIncompatibleHistoryError: (session: SessionRecord, message: string) => Promise<void>;
  sendSystemErrorMessage: (session: SessionRecord, stage: "stream" | "error", message: string) => Promise<boolean>;
  handleRecoveryTaskComplete: (session: SessionRecord) => Promise<boolean>;
  notifyCompactCompleted: (session: SessionRecord) => Promise<void>;
  clearSessionStatus: (session: SessionRecord) => Promise<void>;
};

type TurnErrorContext = { threadId: string; turnId: string; closed: boolean; delivered: Set<string> };
const MAX_ERROR_CONTEXTS = 256;
const MAX_ERROR_NOTICES_PER_TURN = 32;

export class NotificationRecoveryService {
  // Bounded, in-memory turn contexts survive closure for late duplicate notices.
  private readonly turnErrors = new Map<string, TurnErrorContext>();
  private readonly latestTurnErrorsByThread = new Map<string, TurnErrorContext>();

  constructor(private readonly deps: NotificationRecoveryDependencies) {}

  async observeTurnLifecycle(event: AppServerTurnLifecycleEvent): Promise<void> {
    if (event.kind === "started") {
      this.rememberTurn(event.threadId, event.turnId);
      return;
    }
    if (this.isStaleTurn(event.threadId, event.turnId)) return;
    const context = this.rememberTurn(event.threadId, event.turnId);
    context.closed = true;
    if (event.error && (event.terminalState === "failed" || event.terminalState === "interrupted")) {
      this.deps.errorSeenByThread.set(event.threadId, true);
      await this.handleError({
        threadId: event.threadId, turnId: event.turnId, stage: "error", message: event.error
      });
    }
  }

  async handleCompacted(threadId: string): Promise<void> {
    logger.info("bridge.notification.thread_compacted", { threadId });
    const session = await this.deps.resolveNotificationSession(threadId);
    if (!session) return;
    if (!await this.deps.handleRecoveryTaskComplete(session)) {
      await this.deps.notifyCompactCompleted(session);
      await this.deps.clearSessionStatus(session);
    }
  }

  async handleError(errorEvent: AppServerErrorEvent): Promise<void> {
    if (errorEvent.turnId && this.isStaleTurn(errorEvent.threadId, errorEvent.turnId)) return;
    const turnId = errorEvent.turnId ?? this.deps.getActiveTurnId(errorEvent.threadId);
    const context = turnId
      ? this.rememberTurn(errorEvent.threadId, turnId)
      : this.latestTurnErrorsByThread.get(errorEvent.threadId);
    const fingerprint = createHash("sha256").update(errorEvent.message.trim()).digest("hex");
    if (context?.delivered.has(fingerprint)) return;
    if (context?.closed && errorEvent.retrying) return;
    logger.warn("bridge.notification.error", {
      threadId: errorEvent.threadId,
      stage: errorEvent.stage,
      message: errorEvent.message
    });
    const session = await this.deps.resolveNotificationSession(errorEvent.threadId);
    if (!session) return;

    if (context?.closed) {
      if (errorEvent.stage === "error") {
        await this.deliverError(session, errorEvent, context, fingerprint);
      }
      return;
    }

    this.deps.cancelGoShortcut(errorEvent.threadId);
    if (!errorEvent.retrying) {
      this.deps.errorSeenByThread.set(errorEvent.threadId, true);
    }
    this.deps.clearTypingState(session.id);
    await this.deps.setSessionStatus(session, "Recovering", {
      detail: this.deps.formatRecoveryIssue(errorEvent),
      detailMode: "replace"
    });
    if (errorEvent.retrying) return;
    if (
      errorEvent.stage === "error" &&
      this.deps.autoCompactOnIncompatibleHistory &&
      this.deps.isIncompatibleHistoryError(errorEvent.message)
    ) {
      await this.deps.handleIncompatibleHistoryError(session, errorEvent.message);
    } else if (errorEvent.stage === "error") {
      await this.deliverError(session, errorEvent, context, fingerprint);
    }
  }

  private isStaleTurn(threadId: string, turnId: string): boolean {
    // Different IDs alone do not establish order when a started notification is missing.
    const current = this.deps.getActiveTurnId(threadId);
    return Boolean(current && current !== turnId);
  }

  private rememberTurn(threadId: string, turnId: string): TurnErrorContext {
    const key = `${threadId}\u0000${turnId}`;
    const previous = this.turnErrors.get(key);
    const context = previous ?? { threadId, turnId, closed: false, delivered: new Set<string>() };
    if (!previous) this.latestTurnErrorsByThread.set(threadId, context);
    this.turnErrors.delete(key);
    this.turnErrors.set(key, context);
    if (this.turnErrors.size > MAX_ERROR_CONTEXTS) {
      const oldestKey = this.turnErrors.keys().next().value!;
      const oldest = this.turnErrors.get(oldestKey)!;
      this.turnErrors.delete(oldestKey);
      if (this.latestTurnErrorsByThread.get(oldest.threadId) === oldest) {
        this.latestTurnErrorsByThread.delete(oldest.threadId);
      }
    }
    return context;
  }

  private async deliverError(
    session: SessionRecord,
    event: AppServerErrorEvent,
    context: TurnErrorContext | undefined,
    fingerprint: string
  ): Promise<void> {
    const delivered = await this.deps.sendSystemErrorMessage(session, event.stage, event.message);
    if (!delivered || !context) return;
    context.delivered.add(fingerprint);
    if (context.delivered.size > MAX_ERROR_NOTICES_PER_TURN) {
      context.delivered.delete(context.delivered.values().next().value!);
    }
  }
}
