import type {
  AppServerMcpStartupStatusEvent,
  AppServerRateLimitsStatus,
  AppServerTokenUsageEvent
} from "../../codex/client.js";
import type { AppServerModelRuntimeEvent } from "../../codex/notification-events.js";
import { createMessage } from "../messages/factory.js";
import { helpAction } from "../messages/actions.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import type { RateLimitNotifier } from "./rate-limit-notifier.js";
import type { TokenUsageTracker } from "../status/token-usage.js";
import type { StatusRuntimeState } from "../status/runtime-state.js";

export type NotificationAuxiliaryDependencies = {
  store: BridgeStore;
  statusRuntimeState: Pick<StatusRuntimeState, "statusMessageBySession" | "resetEditThrottle" | "getLabel">;
  mcpStartupStatusByName: Map<string, { status: string | null; error: string | null; updatedAt: number }>;
  modelRuntimeEventByThread: Map<string, Omit<AppServerModelRuntimeEvent, "threadId"> & { updatedAt: number }>;
  tokenUsageTracker: Pick<TokenUsageTracker, "remember">;
  recentResolvedMcpBySession: Map<string, number>;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  rateLimitNotifier: Pick<RateLimitNotifier, "handleRateLimitsUpdate">;
  getInFlightThreadIds: () => Iterable<string>;
  setSessionStatus: (session: SessionRecord, label: string) => Promise<void>;
  getSessionDirectory: (session: SessionRecord) => string;
  sendLongSpec: (chatId: string, messageSpec: ReturnType<typeof createMessage>) => Promise<void>;
};

export class NotificationAuxiliaryService {
  constructor(private readonly deps: NotificationAuxiliaryDependencies) {}

  async handleQueueChanged(threadId: string): Promise<void> {
    const session = await this.deps.resolveNotificationSession(threadId);
    if (!session || !this.deps.statusRuntimeState.statusMessageBySession.has(session.id)) return;
    this.deps.statusRuntimeState.resetEditThrottle(session.id);
    await this.deps.setSessionStatus(session, this.deps.statusRuntimeState.getLabel(session.id) ?? "Working");
  }

  async handleRateLimits(rateLimits: AppServerRateLimitsStatus): Promise<void> {
    await this.deps.rateLimitNotifier.handleRateLimitsUpdate(rateLimits, this.deps.getInFlightThreadIds());
  }

  rememberMcpStartupStatus(status: AppServerMcpStartupStatusEvent): void {
    this.deps.mcpStartupStatusByName.set(status.name, {
      status: status.status,
      error: status.error,
      updatedAt: Date.now()
    });
  }

  rememberModelRuntimeEvent(event: AppServerModelRuntimeEvent): void {
    this.deps.modelRuntimeEventByThread.set(event.threadId, {
      kind: event.kind,
      fromModel: event.fromModel,
      toModel: event.toModel,
      reason: event.reason,
      verifications: event.verifications,
      updatedAt: Date.now()
    });
  }

  rememberTokenUsage(usage: AppServerTokenUsageEvent): void {
    this.deps.tokenUsageTracker.remember(usage);
  }

  async handleResolvedRequest(requestId: string): Promise<void> {
    const decision = await this.deps.store.getDecisionByApprovalId(requestId);
    if (decision?.kind === "mcpServer/elicitation/request") {
      const session = await this.deps.store.getSessionById(decision.sessionId);
      if (session) {
        this.deps.recentResolvedMcpBySession.set(session.id, Date.now());
        const messageSpec = createMessage({
          kind: "system",
          session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
          body: [{ type: "text", text: "MCP request accepted by the server." }],
          actions: [helpAction()]
        });
        await this.deps.sendLongSpec(decision.telegramChatId, messageSpec);
      }
    }
    if (decision?.state === "pending" || decision?.state === "awaitingInput") {
      await this.deps.store.resolveDecision(decision.id, "stale");
    }
  }
}
