import { CodexAppServerClient, type AppServerNotification } from "../../codex/client.js";
import { CodexThreadMetadataCache } from "../../codex/thread-metadata-cache.js";
import { logger } from "../../logging/logger.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";
import type { RuntimeState } from "../runtime/controller.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import { extractTurnLifecycleEvent } from "../../codex/notification-events.js";
import { NotificationApprovalService, type EarlyApproval } from "./approval.js";
import { NotificationDispatcher } from "./dispatcher.js";
import { SubagentDeliveryService } from "./subagent-delivery.js";
import { SubagentTracker } from "./subagent-tracker.js";

export type NotificationListenerDependencies = {
  codexClient: CodexAppServerClient;
  threadMetadataCache: CodexThreadMetadataCache;
  sessionMenuSnapshots: { clear: () => void };
  earlyApprovals: Map<string, EarlyApproval>;
  subagents: SubagentTracker;
  subagentDelivery: SubagentDeliveryService;
  notificationSessionRouter: { getRememberedSessionId: (threadId: string) => string | undefined };
  notificationQueue: KeyedQueue;
  notificationDispatcher: NotificationDispatcher;
  notificationApprovalService: NotificationApprovalService;
  handleAppServerNotification: (notification: AppServerNotification) => Promise<void>;
  releaseBridgeLocksAfterAuthChange: () => number;
  store: BridgeStore;
  getRuntimeState: () => RuntimeState;
  setRuntimeState: (next: RuntimeState) => void;
  getSessionDirectory: (session: SessionRecord) => string;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec) => Promise<void>;
};

export class NotificationListener {
  private notificationUnsubscribe: (() => void) | null = null;
  private approvalUnsubscribe: (() => void) | null = null;

  constructor(private readonly deps: NotificationListenerDependencies) {}

  attach(): void {
    if (!this.notificationUnsubscribe) {
      this.notificationUnsubscribe = this.deps.codexClient.onNotification((notification) => {
        const params = notification.params as {
          threadId?: string;
          requestId?: string;
          threadName?: string | null;
        } | undefined;
        if (notification.method === "thread/name/updated" && params?.threadId) {
          this.deps.threadMetadataCache.setName(params.threadId, params.threadName ?? null);
          this.deps.sessionMenuSnapshots.clear();
        }
        if (notification.method === "serverRequest/resolved" && params?.requestId) {
          const pending = this.deps.earlyApprovals.get(params.requestId);
          if (pending) clearTimeout(pending.timer);
          this.deps.earlyApprovals.delete(params.requestId);
        }
        if (notification.method === "bridge/connection/lost") {
          if (this.deps.getRuntimeState() !== "disconnected" && this.deps.getRuntimeState() !== "failed") {
            this.deps.setRuntimeState("failed");
          }
          logger.warn("bridge.runtime.connection_lost");
          for (const pending of this.deps.earlyApprovals.values()) clearTimeout(pending.timer);
          this.deps.earlyApprovals.clear();
          const routes = this.deps.subagents.reset();
          for (const sessionId of new Set(routes.map((route) => route.sessionId))) {
            void this.deps.store.getSessionById(sessionId).then(async (session) => {
              if (session) {
                const text = "Subagent monitoring disconnected. Progress may be missing; previous approvals are no longer valid.";
                await this.deps.sendLongSpec(session.telegramChatId, createMessage({
                  kind: "error",
                  session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
                  body: [{ type: "text", text }]
                }));
              }
            }).catch((error) => logger.warn("bridge.subagent.disconnect_notice_failed", { error: String(error) }));
          }
        }
        if (notification.method === "bridge/runtime/reconnected") {
          if (this.deps.getRuntimeState() === "failed" || this.deps.getRuntimeState() === "disconnected") {
            this.deps.setRuntimeState("connecting");
            this.deps.setRuntimeState("connected");
          }
          return;
        }
        if (notification.method === "bridge/auth/reconnected") {
          if (this.deps.getRuntimeState() === "failed" || this.deps.getRuntimeState() === "disconnected") {
            this.deps.setRuntimeState("connecting");
            this.deps.setRuntimeState("connected");
          }
          const releasedCount = this.deps.releaseBridgeLocksAfterAuthChange();
          logger.info("bridge.session.bridge_locks_released_after_auth_change", { releasedCount });
          return;
        }
        const observed = this.deps.subagents.observe(notification,
          params?.threadId ? this.deps.notificationSessionRouter.getRememberedSessionId(params.threadId) : undefined);
        for (const [id, pending] of this.deps.earlyApprovals) {
          if (!this.deps.subagents.route(pending.request.threadId, pending.request.turnId)) continue;
          clearTimeout(pending.timer);
          this.deps.earlyApprovals.delete(id);
          void this.deps.notificationApprovalService.handleApprovalRequest(pending.request)
            .catch((error) => logger.error("bridge.subagent.approval_failed", { error: String(error) }));
        }
        for (const delivery of observed.deliveries) {
          void this.deps.subagentDelivery.queueSubagentDelivery(delivery)
            .catch((error) => logger.error("bridge.subagent.delivery_failed", { error: String(error) }));
        }
        const turnLifecycle = extractTurnLifecycleEvent(notification);
        if (
          turnLifecycle?.kind === "completed" &&
          this.deps.subagents.hasObservedParent(turnLifecycle.threadId, turnLifecycle.turnId)
        ) {
          const sessionId = this.deps.notificationSessionRouter.getRememberedSessionId(turnLifecycle.threadId);
          if (sessionId) {
            void this.deps.subagentDelivery.finalizeParentTurn({
              sessionId,
              parentThreadId: turnLifecycle.threadId,
              parentTurnId: turnLifecycle.turnId,
              terminal: turnLifecycle.terminalState ?? "interrupted"
            }).catch((error) => logger.error("bridge.subagent.finalize_failed", { error: String(error) }));
          }
        }
        if (observed.handled) return;
        const key = this.deps.notificationDispatcher.getQueueKey(notification);
        void this.deps.notificationQueue
          .run(key, () => this.deps.handleAppServerNotification(notification))
          .catch((error) => {
            logger.error("bridge.notification.unhandled", {
              method: notification.method,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      });
    }

    if (!this.approvalUnsubscribe) {
      this.approvalUnsubscribe = this.deps.codexClient.onApprovalRequest((request) => {
        void this.deps.notificationQueue
          .run(request.threadId, () => this.deps.notificationApprovalService.handleApprovalRequest(request))
          .catch((error) => {
            logger.error("bridge.approval.unhandled", {
              requestId: request.requestId,
              threadId: request.threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      });
    }
  }

  detach(): void {
    this.deps.subagentDelivery.reset();
    this.deps.subagents.reset();
    for (const pending of this.deps.earlyApprovals.values()) clearTimeout(pending.timer);
    this.deps.earlyApprovals.clear();
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    this.approvalUnsubscribe?.();
    this.approvalUnsubscribe = null;
  }
}
