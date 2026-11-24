import type { AppServerNotification } from "../../codex/client.js";
import { extractNotificationThreadId } from "../../codex/extractors/events.js";
import {
  extractCompletedAgentMessage,
  extractErrorEvent,
  extractMcpStartupStatusEvent,
  extractModelRuntimeEvent,
  extractProgressEvent,
  extractRateLimitsEvent,
  extractResolvedRequestId,
  extractStatusUpdate,
  extractThreadCompactedEvent,
  extractTokenUsageEvent,
  extractTurnLifecycleEvent
} from "../../codex/notification-events.js";
import { extractWarningEvent } from "../../codex/notification-events.js";
import type { NotificationNoticeService } from "./notices.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { NotificationAuxiliaryService } from "./auxiliary.js";
import { NotificationMessageService } from "./messages.js";
import { NotificationRecoveryService } from "./recovery.js";
import { NotificationTurnService } from "./turns.js";
import type { ProgressNotificationEvent } from "../progress/service.js";
import { canDeliverSession } from "./delivery-target.js";
import { ReasoningSummaryTracker } from "../../codex/reasoning-summary.js";

export type NotificationDispatcherDependencies = {
  notices: NotificationNoticeService;
  store: BridgeStore;
  sessionMenuSnapshots: { clear: () => void };
  notificationTurnService: NotificationTurnService;
  notificationRecoveryService: NotificationRecoveryService;
  notificationMessageService: NotificationMessageService;
  notificationAuxiliaryService: NotificationAuxiliaryService;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  sendProgressMessage: (session: SessionRecord, event: ProgressNotificationEvent, turnId: string) => Promise<void>;
  recordBridgeConnectionFailure: (session: SessionRecord, threadId: string, turnId: string) => Promise<boolean>;
  onRuntimeStopped?: (session: SessionRecord, turnId: string) => void;
};

export class NotificationDispatcher {
  private readonly reasoningSummaries = new ReasoningSummaryTracker();

  constructor(private readonly deps: NotificationDispatcherDependencies) {}

  async handle(notification: AppServerNotification): Promise<void> {
    if (notification.method === "bridge/connection/lost") {
      this.reasoningSummaries.reset();
      if ((notification.params as { expected?: boolean } | undefined)?.expected !== false) return;
      for (const route of this.deps.store.listActiveTurnRoutes()) {
        const session = await this.deps.store.getSessionById(route.sessionId);
        if (session && route.sourceId === session.telegramChatId && await canDeliverSession(this.deps.store, session)) {
          this.deps.onRuntimeStopped?.(session, route.turnId);
          await this.deps.recordBridgeConnectionFailure(session, route.codexThreadId, route.turnId);
        }
      }
      return;
    }
    if (
      notification.method === "thread/archived" ||
      notification.method === "thread/unarchived" ||
      notification.method === "thread/deleted"
    ) {
      const params = notification.params as { threadId?: string } | undefined;
      if (params?.threadId) {
        const session = await this.deps.store.getSessionByThreadId(params.threadId);
        if (session) {
          if (
            (notification.method === "thread/archived" || notification.method === "thread/deleted") &&
            session.codexArchivedAt === null
          ) {
            await this.deps.store.markSessionCodexArchived(session.id);
          } else if (notification.method === "thread/unarchived" && session.codexArchivedAt !== null) {
            const restored = await this.deps.store.markSessionCodexUnarchived(session.id);
            this.deps.store.ensureSessionBinding(restored.id, restored.telegramChatId);
          }
          this.deps.sessionMenuSnapshots.clear();
          logger.info("bridge.notification.thread_archive_state", {
            method: notification.method,
            sessionId: session.id,
            threadId: params.threadId
          });
        }
      }
      return;
    }

    const turnLifecycle = extractTurnLifecycleEvent(notification);
    if (turnLifecycle) {
      if (turnLifecycle.kind === "completed") this.reasoningSummaries.reset(turnLifecycle.threadId, turnLifecycle.turnId);
      // Show the reason before clearing status; terminal notices must not start recovery.
      await this.deps.notificationRecoveryService.observeTurnLifecycle(turnLifecycle).catch((error) => {
        logger.warn("bridge.turn.error_delivery_failed", {
          threadId: turnLifecycle.threadId,
          turnId: turnLifecycle.turnId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    if (turnLifecycle?.kind === "completed") {
      await this.deps.notificationTurnService.handleTurnLifecycle(turnLifecycle);
    }
    const statusUpdate = extractStatusUpdate(notification);
    if (statusUpdate) {
      await this.deps.notificationTurnService.handleStatusUpdate(
        statusUpdate,
        turnLifecycle?.kind === "completed" ? turnLifecycle.turnId : undefined,
        turnLifecycle?.kind === "completed" ? turnLifecycle.terminalState : undefined,
        turnLifecycle?.error
      );
    }

    if (turnLifecycle?.kind === "started") {
      await this.deps.notificationTurnService.handleTurnLifecycle(turnLifecycle);
    }

    if (notification.method === "thread/queue/changed") {
      const params = notification.params as { threadId?: string } | undefined;
      if (params?.threadId) {
        await this.deps.notificationAuxiliaryService.handleQueueChanged(params.threadId);
      }
    }

    const rateLimitsEvent = extractRateLimitsEvent(notification);
    if (rateLimitsEvent) {
      await this.deps.notificationAuxiliaryService.handleRateLimits(rateLimitsEvent);
    }

    const mcpStartupStatus = extractMcpStartupStatusEvent(notification);
    if (mcpStartupStatus) {
      await this.deps.notices.handleMcpStartup(mcpStartupStatus);
    }

    const warning = extractWarningEvent(notification);
    if (warning) await this.deps.notices.handleWarning(warning);

    const modelRuntimeEvent = extractModelRuntimeEvent(notification);
    if (modelRuntimeEvent) {
      this.deps.notificationAuxiliaryService.rememberModelRuntimeEvent(modelRuntimeEvent);
    }

    const tokenUsageEvent = extractTokenUsageEvent(notification);
    if (tokenUsageEvent) {
      this.deps.notificationAuxiliaryService.rememberTokenUsage(tokenUsageEvent);
    }

    const compactedEvent = extractThreadCompactedEvent(notification);
    if (compactedEvent) {
      await this.deps.notificationRecoveryService.handleCompacted(compactedEvent.threadId);
      return;
    }

    const errorEvent = extractErrorEvent(notification);
    if (errorEvent) {
      await this.deps.notificationRecoveryService.handleError(errorEvent);
      return;
    }

    const threadId = extractNotificationThreadId(notification);
    const progressEvent = extractProgressEvent(notification) ?? this.reasoningSummaries.observe(notification,
      threadId ? this.deps.store.getActiveTurnRoute(threadId)?.turnId : undefined);
    if (progressEvent) {
      const session = await this.deps.resolveNotificationSession(progressEvent.threadId);
      const route = this.deps.store.getActiveTurnRoute(progressEvent.threadId);
      if (
        session &&
        await canDeliverSession(this.deps.store, session) &&
        route?.sessionId === session.id &&
        route.sourceId === session.telegramChatId &&
        (!progressEvent.turnId || progressEvent.turnId === route.turnId)
      ) {
        await this.deps.sendProgressMessage(session, progressEvent, route.turnId).catch((error) => {
          logger.warn("bridge.progress.delivery_failed", {
            sessionId: session.id,
            threadId: progressEvent.threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      return;
    }

    const agentMessage = extractCompletedAgentMessage(notification);
    if (agentMessage) {
      await this.deps.notificationMessageService.handleCompletedAgentMessage(agentMessage);
      return;
    }

    const resolvedRequestId = extractResolvedRequestId(notification);
    if (resolvedRequestId) {
      logger.info("bridge.notification.request_resolved", {
        requestId: resolvedRequestId
      });
      await this.deps.notificationAuxiliaryService.handleResolvedRequest(resolvedRequestId);
    }
  }

  getQueueKey(notification: AppServerNotification): string {
    return (
      extractStatusUpdate(notification)?.threadId ??
      extractTurnLifecycleEvent(notification)?.threadId ??
      extractThreadCompactedEvent(notification)?.threadId ??
      extractErrorEvent(notification)?.threadId ??
      extractProgressEvent(notification)?.threadId ??
      extractCompletedAgentMessage(notification)?.threadId ??
      extractNotificationThreadId(notification) ??
      "global"
    );
  }
}
