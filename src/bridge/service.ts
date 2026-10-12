import type { AppConfig } from "../config/index.js";
import { getSessionSelectorChatId, parseSlackChatId } from "./chat-address.js";
import { IncomingPayloadService, type IncomingAttachment } from "./input/payload.js";
import { QueuedSubmissionService } from "./input/queued-submission.js";
import { IncomingPreflightService } from "./input/preflight.js";
import { IncomingTurnService } from "./input/turn.js";
import { GoalCommandService } from "./goals/commands.js";
import { GoalService } from "./goals/service.js";
import { DecisionDeliveryService } from "./decisions/delivery.js";
import { SessionDecisionOperationQueue } from "./decisions/session-operation-queue.js";
import { DecisionCommandService } from "./decisions/commands.js";
import { CompactService, SessionCompactService } from "./sessions/compact-service.js";
import { NotificationSessionRouter } from "./notifications/session-router.js";
import { NotificationSessionContext } from "./notifications/session-context.js";
import { SessionDiscoveryService } from "./sessions/discovery.js";
import { SessionMutationService } from "./sessions/mutation.js";
import { SessionCatalogService } from "./sessions/catalog.js";
import { WebDirectoryRegistry } from "./sessions/directory-registry.js";
import { SessionAccessService } from "./sessions/access.js";
import { LocalWebBridgeApi } from "../web/bridge-api.js";
import { WebMessageTransport } from "../web/transport.js";
import { WebDecisionService } from "../web/decisions.js";
import { WebAttachmentStorage } from "../web/attachments.js";
import { NotificationDeliveryTargets } from "./notifications/delivery-target.js";
import { SessionBindingService, bindingEventText } from "./sessions/binding.js";
import { WEB_SOURCE_ID } from "../shared/source-address.js";
import { SessionReader } from "./sessions/reader.js";
import { SessionViewService } from "./sessions/view.js";
import { SessionActivationService } from "./sessions/activation.js";
import { SessionCreationService } from "./sessions/creation.js";
import {
  DEFAULT_STALE_BRIDGE_LEASE_MS,
  SessionOwnershipService
} from "./sessions/ownership.js";
import { TypingService } from "./progress/typing.js";
import { ProgressService, type ProgressNotificationEvent } from "./progress/service.js";
import { SubagentDeliveryService } from "./notifications/subagent-delivery.js";
import { NotificationTurnService } from "./notifications/turns.js";
import { NotificationRecoveryService } from "./notifications/recovery.js";
import { NotificationMessageService } from "./notifications/messages.js";
import { NotificationAuxiliaryService } from "./notifications/auxiliary.js";
import { NotificationDispatcher } from "./notifications/dispatcher.js";
import { NotificationApprovalService, type EarlyApproval } from "./notifications/approval.js";
import { VersionUpdateNotifier } from "./notifications/version-update.js";
import { NotificationListener } from "./notifications/listener.js";
import { RuntimeController, type RuntimeState } from "./runtime/controller.js";
import { RuntimeCommandService } from "./runtime/commands.js";
import { RuntimeStateCleanupService } from "./runtime/cleanup.js";
import { BridgeRuntimeState } from "./runtime-state.js";
import { StatusViewService } from "./status/view.js";
import { StatusRuntimeState } from "./status/runtime-state.js";
import { TokenUsageTracker } from "./status/token-usage.js";
import { StatusLifecycleService } from "./status/lifecycle.js";
import { SessionActionGuardService } from "./sessions/action-guards.js";
import { SessionStopService } from "./sessions/stop.js";
import { SessionRefreshStatusService } from "./sessions/refresh-status.js";
import { SessionInteractionService } from "./sessions/interaction.js";
import { SessionRecoveryService } from "./sessions/recovery.js";
import { RolloutReader } from "./sessions/rollout-reader.js";
import { SessionPresentationService } from "./sessions/presentation.js";
import { SessionProviderStateService } from "./sessions/provider-state.js";
import { createSessionActionCallback } from "./sessions/action-callbacks.js";
import { BridgeMessageFactory, createMessage } from "./messages/factory.js";
import { renderLegacyMessage } from "./messages/legacy-adapter.js";
import { GoShortcutService } from "./interactions/go-shortcut.js";
import { RuntimePromptFactory } from "./messages/runtime-prompts.js";
import { helpMenuActions } from "./messages/actions.js";
import type { ActionSpec, MessageSpec, SessionContext } from "./messages/types.js";
import { BridgeMessageOperations } from "./messages/operations.js";
import { SessionTranscriptService } from "./sessions/transcript.js";
import {
  SessionMenuService,
} from "./sessions/menu.js";
import { SessionMenuSnapshotCache } from "./sessions/menu-snapshots.js";
import { MessageDeliveryService } from "./messages/sender.js";
import { HistoryDeliveryService } from "./messages/history-delivery.js";
import { readCodexVersion } from "../codex/version-reader.js";
import {
  createBatchDecisionMessageSpec,
  createDecisionMessageSpec,
  getExecpolicyAmendment,
  isBatchableDecision,
} from "./decisions/formatters.js";
import {
  expandHomeDirectory,
  formatDirectoryMenuLabel,
  hashDirectoryKey,
  normalizeDirectoryCandidate,
  pickDirectory,
  sortSessionsByMenuActivity
} from "./sessions/menu-formatters.js";
import {
  formatRateLimitWindow,
  formatRateLimitWindowLabel,
  formatShortError,
  isSameRateLimitBucket,
  pickModelRateLimitBucket
} from "./status/formatters.js";
import { RateLimitNotifier } from "./notifications/rate-limit-notifier.js";
import { SubagentTracker } from "./notifications/subagent-tracker.js";
import { CodexAppServerClient } from "../codex/client.js";
import {
  isActiveWriterConflictError,
  isIncompatibleHistoryError,
  isMissingRuntimeThreadError,
  isStaleActiveTurnError
} from "../codex/error-policy.js";
import { CodexThreadMetadataCache } from "../codex/thread-metadata-cache.js";
import type {
  AppServerStatusUpdate,
  CodexTurnInputPart
} from "../codex/client.js";
import { logger } from "../logging/logger.js";
import { KeyedQueue } from "../shared/keyed-queue.js";
import { BridgeStore } from "../store/index.js";
import {
  formatCodexTelegramHtml,
  formatTelegramHtml,
  type TelegramTextChunk
} from "../telegram/text.js";
import type { BridgeMessageTransport } from "./transport.js";
import type { SessionTranscript } from "./contracts.js";
import type {
  DecisionAction,
  MessageRecord,
  SessionRecord
} from "../shared/types.js";

export type { IncomingAttachment } from "./input/payload.js";

export { SessionActivationError } from "./sessions/ownership.js";

export class BridgeService {
  private readonly pm2AppName = process.env.PM2_APP_NAME?.trim() || "codex-bridge";
  private readonly runtime = new RuntimeController();
  private readonly runtimeCommandService: RuntimeCommandService;
  private readonly statusViewService: StatusViewService;
  private readonly statusLifecycleService: StatusLifecycleService;
  private readonly sessionActionGuardService: SessionActionGuardService;
  private readonly sessionStopService: SessionStopService;
  private readonly sessionCompactService: SessionCompactService;
  private readonly sessionRefreshStatusService: SessionRefreshStatusService;
  private readonly sessionInteractionService: SessionInteractionService;
  // COMPATIBILITY(TEST): keep the old test seam while callers migrate to RuntimeController.
  private get runtimeState(): RuntimeState {
    return this.runtime.state;
  }

  private set runtimeState(next: RuntimeState) {
    this.runtime.replaceForCompatibility(next);
  }
  private readonly threadMetadataCache = new CodexThreadMetadataCache();
  private readonly sessionsPageSize = 8;
  private readonly sessionMenuSnapshots = new SessionMenuSnapshotCache();
  private readonly sessionMenuService: SessionMenuService;
  private readonly telegramMessageMaxLength = 3500;
  private readonly typingIntervalMs = 4_000;
  private readonly typingService: TypingService;
  private readonly bridgeRuntimeState = new BridgeRuntimeState();
  private readonly statusRuntimeState = new StatusRuntimeState();
  private readonly tokenUsageTracker = new TokenUsageTracker();
  private readonly notificationSessionRouter: NotificationSessionRouter;
  private readonly notificationSessionContext: NotificationSessionContext;
  private readonly sessionDiscoveryService: SessionDiscoveryService;
  private readonly sessionMutationService: SessionMutationService;
  private readonly sessionBindingService: SessionBindingService;
  private readonly sessionOwnershipService: SessionOwnershipService;
  private readonly sessionReader: SessionReader;
  private readonly sessionViewService: SessionViewService;
  private readonly sessionActivationService: SessionActivationService;
  private readonly sessionCreationService: SessionCreationService;
  private readonly sessionRecoveryService: SessionRecoveryService;
  private readonly sessionPresentationService: SessionPresentationService;
  private readonly getSessionDirectory: (session: SessionRecord) => string;
  private readonly sessionProviderStateService: SessionProviderStateService;
  private readonly rolloutReader = new RolloutReader();
  // COMPATIBILITY(TEST): preserve the old test seam during router extraction.
  private get notificationSessionIdByThread(): Map<string, string> {
    return this.notificationSessionRouter.compatibilityMap;
  }
  private readonly turnRouteQueue = new KeyedQueue();
  private readonly sessionCardQueue = new KeyedQueue();
  private webMessageTransport: WebMessageTransport | null = null;
  private readonly notificationDeliveryTargets: NotificationDeliveryTargets;
  private readonly notificationQueue = new KeyedQueue();
  private readonly subagents = new SubagentTracker();
  private readonly earlyApprovals = new Map<string, EarlyApproval>();
  private readonly subagentDelivery: SubagentDeliveryService;
  private readonly notificationTurnService: NotificationTurnService;
  private readonly notificationRecoveryService: NotificationRecoveryService;
  private readonly notificationMessageService: NotificationMessageService;
  private readonly notificationAuxiliaryService: NotificationAuxiliaryService;
  private readonly notificationDispatcher: NotificationDispatcher;
  private readonly notificationApprovalService: NotificationApprovalService;
  private readonly notificationListener: NotificationListener;
  private readonly versionUpdateNotifier: VersionUpdateNotifier;
  private readonly incomingPayloadService: IncomingPayloadService;
  private readonly queuedSubmissionService: QueuedSubmissionService;
  private readonly incomingPreflightService: IncomingPreflightService;
  private readonly incomingTurnService: IncomingTurnService;
  private readonly telegramSendQueue = new KeyedQueue();
  private readonly messageSender: MessageDeliveryService;
  private readonly messageOperations: BridgeMessageOperations;
  private readonly goShortcutService: GoShortcutService;
  private readonly runtimePromptFactory: RuntimePromptFactory;
  private readonly goalService: GoalService;
  private readonly goalCommandService: GoalCommandService;
  private readonly decisionDelivery: DecisionDeliveryService;
  private readonly sessionDecisionOperationQueue = new SessionDecisionOperationQueue();
  private readonly decisionCommandService: DecisionCommandService;
  private readonly rateLimitNotifier: RateLimitNotifier;
  private readonly compactService: CompactService;
  private readonly progressService: ProgressService;
  private readonly sessionTranscriptService: SessionTranscriptService;
  private readonly messageFactory: BridgeMessageFactory;
  private readonly historyDeliveryService: HistoryDeliveryService;
  private readonly runtimeStateCleanupService: RuntimeStateCleanupService;

  constructor(
    private readonly config: AppConfig,
    private readonly store: BridgeStore,
    private readonly codexClient: CodexAppServerClient
  ) {
    const state = this.bridgeRuntimeState;
    this.notificationDeliveryTargets = new NotificationDeliveryTargets(store, (threadId) => this.notificationSessionRouter.resolve(threadId));
    this.sessionPresentationService = new SessionPresentationService({
      codexClient,
      threadMetadataCache: this.threadMetadataCache,
      isRuntimeConnected: () => this.isRuntimeConnected()
    });
    this.getSessionDirectory = this.sessionPresentationService.getSessionDirectory.bind(this.sessionPresentationService);
    this.runtimePromptFactory = new RuntimePromptFactory({
      isRuntimeConnected: () => this.isRuntimeConnected(),
      getSessionDirectory: (session) => this.getSessionDirectory(session)
    });
    this.messageFactory = new BridgeMessageFactory((session) => this.sessionPresentationService.getSessionDirectory(session));
    const createSessionActionSpec = this.messageFactory.createSessionActionSpec.bind(this.messageFactory);
    const createCommandResultSpec = this.messageFactory.createCommandResultSpec.bind(this.messageFactory);
    const createSessionCommandResultSpec = this.messageFactory.createSessionCommandResultSpec.bind(this.messageFactory);
    this.notificationSessionRouter = new NotificationSessionRouter(store);
    this.sessionOwnershipService = new SessionOwnershipService({
      store,
      codexClient,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      staleBridgeLeaseMs: DEFAULT_STALE_BRIDGE_LEASE_MS,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      canReadThreadStatus: () => this.canReadThreadStatus(),
      createSessionActionSpec,
      sessionRefreshCallback: (sessionId, leaseVersion) => createSessionActionCallback("refresh", sessionId, leaseVersion),
      sessionHandoffCallback: (sessionId, leaseVersion) => createSessionActionCallback("handoff", sessionId, leaseVersion)
    });
    this.sessionDiscoveryService = new SessionDiscoveryService({
      store,
      codexClient,
      threadMetadataCache: this.threadMetadataCache,
      getDiscoveryChatIds: () => this.getDiscoveryChatIds(),
      pickDirectory,
      resolveSessionActivityAt: (rolloutPath, fallbackTimestamp) =>
        this.rolloutReader.resolveSessionActivityAt(rolloutPath, fallbackTimestamp),
      readDisplayPathFromRollout: (rolloutPath) => this.rolloutReader.readDisplayPath(rolloutPath),
      readThreadStatus: (threadId, cwd, options) => codexClient.readThreadStatus(threadId, cwd, options),
      onSessionsChanged: () => this.sessionMenuSnapshots.clear(),
      onSessionDeleted: (session) => {
        this.typingService.clear(session.id);
        this.goShortcutService.cancel(session.codexThreadId);
        this.notificationSessionRouter.clearThread(session.codexThreadId);
        state.lastUserInputBySession.delete(session.id);
        this.sessionMenuSnapshots.clear();
      }
    });
    this.sessionBindingService = new SessionBindingService({
      store,
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      onStateChanged: (sourceId) => this.updateConversationSession(sourceId),
      notify: async (event) => {
        if (event.sourceId === WEB_SOURCE_ID) return; // Web uses metadata-only SSE events.
        await this.messageOperations.sendLongSpec(event.sourceId, createMessage({
          kind: "system", session: { id: event.threadId, directory: event.directory },
          body: [{ type: "text", text: bindingEventText(event) }]
        }), { disable_notification: true });
      }
    });
    this.sessionMutationService = new SessionMutationService({
      store,
      onStateChanged: (sourceId) => this.updateConversationSession(sourceId),
      codexClient,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      bindingService: this.sessionBindingService,
      createSessionActionSpec,
      sessionRefreshCallback: (sessionId, leaseVersion) => createSessionActionCallback("refresh", sessionId, leaseVersion),
      sessionReleaseBridgeCallback: (sessionId, leaseVersion) => createSessionActionCallback("releaseBridge", sessionId, leaseVersion),
      sessionDeleteConfirmCallback: (sessionId, leaseVersion) => createSessionActionCallback("deleteConfirm", sessionId, leaseVersion),
      getSessionArchiveCallback: (chatId, sessionId) => this.getSessionArchiveCallback(chatId, sessionId),
      getSessionDeleteCallback: (chatId, sessionId) => this.getSessionDeleteCallback(chatId, sessionId),
      getSessionSelectorChatId,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      clearSessionState: (session) => {
        this.typingService.clear(session.id);
        this.goShortcutService.cancel(session.codexThreadId);
        this.notificationSessionRouter.clearThread(session.codexThreadId);
        state.lastUserInputBySession.delete(session.id);
        this.sessionMenuSnapshots.clear();
      }
    });
    this.sessionInteractionService = new SessionInteractionService({
      store,
      codexClient,
      threadMetadataCache: this.threadMetadataCache,
      sessionOwnershipService: this.sessionOwnershipService,
      sessionMenuSnapshots: this.sessionMenuSnapshots,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      parseSlackChatId,
      getSessionArchiveCallback: (chatId, sessionId) => this.getSessionArchiveCallback(chatId, sessionId),
      getSessionDeleteCallback: (chatId, sessionId) => this.getSessionDeleteCallback(chatId, sessionId),
      getSessionReleaseBridgeCallback: (chatId, sessionId) => this.getSessionReleaseBridgeCallback(chatId, sessionId),
      sessionHandoffCallback: (sessionId, leaseVersion) => createSessionActionCallback("handoff", sessionId, leaseVersion),
      createCommandResultSpec,
      createSessionCommandResultSpec
    });
    this.sessionRecoveryService = new SessionRecoveryService({
      store,
      parseSlackChatId
    });
    this.sessionProviderStateService = new SessionProviderStateService({
      codexClient,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      canReadThreadStatus: () => this.canReadThreadStatus(),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      formatShortError
    });
    this.sessionReader = new SessionReader({
      store,
      codexClient,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      canReadThreadStatus: () => this.canReadThreadStatus(),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      readDisplayPathFromRollout: (rolloutPath) => this.rolloutReader.readDisplayPath(rolloutPath),
      pickDirectory,
      readRecentMessagesFromRollout: (rolloutPath) => this.rolloutReader.readRecentMessages(rolloutPath),
      isActiveWriterConflictError
    });
    this.sessionViewService = new SessionViewService({
      store,
      sessionReader: this.sessionReader,
      sessionOwnershipService: this.sessionOwnershipService
    });
    this.sessionActivationService = new SessionActivationService({
      store,
      onSelectionChanged: (sourceId) => this.updateConversationSession(sourceId),
      sessionReader: this.sessionReader,
      sessionOwnershipService: this.sessionOwnershipService,
      clearBatchDecisionMessage: (session) => this.decisionDelivery.clearBatchDecisionMessage(session),
      isActiveWriterConflictError,
      sessionRefreshCallback: (sessionId, leaseVersion) => createSessionActionCallback("refresh", sessionId, leaseVersion),
      createSessionActionSpec
    });
    this.messageSender = new MessageDeliveryService({
      maxLength: this.telegramMessageMaxLength,
      queue: this.telegramSendQueue,
      getEnvelopeTitle: async (chatId) => {
        const activeSession = await this.store.getActiveSession(chatId);
        return activeSession ? `Codex · ${this.sessionPresentationService.getSessionTitle(activeSession)}` : "Codex";
      }
    });
    this.messageOperations = new BridgeMessageOperations({
      sender: this.messageSender,
      formatCodexTelegramHtml: (text) => this.formatCodexTelegramHtml(text),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      rememberLastAssistantMessage: (threadId, message) => {
        state.lastAssistantTelegramByThread.set(threadId, message);
      }
    });
    this.versionUpdateNotifier = new VersionUpdateNotifier({
      readVersion: () => readCodexVersion(this.config.codexAppServerCommand),
      deliver: (session, update) => this.messageOperations.sendLongSpec(
        session.telegramChatId,
        createMessage({
          kind: "version-update",
          session: { id: session.codexThreadId, directory: this.getSessionDirectory(session) },
          body: [{ type: "text", text: `${update.baseline} → ${update.latest}` }]
        })
      ).then(() => undefined)
    });
    this.goShortcutService = new GoShortcutService({
      store,
      messageOperations: this.messageOperations,
      pendingByThread: state.pendingGoShortcutByThread,
      lastAssistantMessageByThread: state.lastAssistantTelegramByThread,
      getSessionDirectory: (session) => this.getSessionDirectory(session)
    });
    this.historyDeliveryService = new HistoryDeliveryService({
      sender: this.messageSender,
      formatCodexTelegramHtml: (text) => this.formatCodexTelegramHtml(text),
      sendTelegramTextChunksAndGetLastMessage: (chatId, chunks, options) =>
        this.messageOperations.sendTelegramTextChunksAndGetLastMessage(chatId, chunks, options)
    });
    this.statusLifecycleService = new StatusLifecycleService({
      store,
      statusMessageBySession: this.statusRuntimeState.statusMessageBySession,
      statusStartedAtBySession: this.statusRuntimeState.statusStartedAtBySession,
      statusLabelBySession: this.statusRuntimeState.statusLabelBySession,
      statusDetailBySession: this.statusRuntimeState.statusDetailBySession,
      statusLastEditAtBySession: this.statusRuntimeState.statusLastEditAtBySession,
      statusOpBySession: this.statusRuntimeState.statusOpBySession,
      sendMessageSpec: (chatId, messageSpec, options) => this.messageOperations.sendMessageSpec(chatId, messageSpec, options),
      editMessageSpec: (chatId, messageId, messageSpec) => this.messageOperations.editMessageSpec(chatId, messageId, messageSpec),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      isCompactStatusUpdate: (update) => this.compactService.isCompactStatusUpdate(update),
      notifyCompactStarted: (session, source) => this.compactService.notifyCompactStarted(session, source),
      clearTypingState: (sessionId) => this.typingService.clear(sessionId),
      sendTypingOnce: (session) => this.typingService.sendOnce(session)
    });
    this.queuedSubmissionService = new QueuedSubmissionService({
      store,
      codexClient,
      sessionOwnershipService: this.sessionOwnershipService,
      statusRuntimeState: this.statusRuntimeState,
      ensureChatAllowed: (chatId) => this.ensureChatAllowed(chatId),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      setSessionStatus: (session, label) => this.statusLifecycleService.setSessionStatus(session, label),
      rememberNotificationSessionId: (threadId, sessionId) =>
        this.notificationSessionRouter.rememberSessionId(threadId, sessionId)
    });
    this.rateLimitNotifier = new RateLimitNotifier({
      store,
      resolveNotificationSession: (threadId) => this.notificationDeliveryTargets.resolve(threadId),
      sessionProviderState: this.sessionProviderStateService,
      pickModelRateLimitBucket,
      isSameRateLimitBucket,
      formatRateLimitWindowLabel,
      formatRateLimitWindow,
      sendLongSpec: (chatId, messageSpec, options) => this.messageOperations.sendLongSpec(chatId, messageSpec, options)
    });
    this.notificationSessionContext = new NotificationSessionContext({
      router: this.notificationSessionRouter,
      rateLimitNotifier: this.rateLimitNotifier
    });
    this.sessionRefreshStatusService = new SessionRefreshStatusService({
      store,
      refreshStatusMessageBySession: state.refreshStatusMessageBySession,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      refreshSessionCallback: (sessionId, leaseVersion) => createSessionActionCallback("refresh", sessionId, leaseVersion),
      editMessageSpec: (chatId, messageId, messageSpec, options) => this.messageOperations.editMessageSpec(chatId, messageId, messageSpec, options),
      sendSpecAndGetLastMessage: (chatId, messageSpec, options) => this.messageOperations.sendSpecAndGetLastMessage(chatId, messageSpec, options),
      requireMessageTransport: (chatId) => this.messageSender.requireTransport(chatId)
    });
    this.goalService = new GoalService({
      store,
      codexClient,
      sessionsPageSize: this.sessionsPageSize,
      getSessionSelectorChatId,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      getSessionTitle: (session) => this.sessionPresentationService.getSessionTitle(session),
      readSessionGoal: (session) => this.sessionPresentationService.readSessionGoal(session),
      formatGoalStatus: (status) => this.sessionPresentationService.formatGoalStatus(status),
      formatGoalStatusLines: (result) => this.sessionPresentationService.formatGoalStatusLines(result),
      formatShortError
    });
    this.goalCommandService = new GoalCommandService({
      store,
      goalService: this.goalService,
      sessionOwnershipService: this.sessionOwnershipService
    });
    this.sessionMenuService = new SessionMenuService({
      store,
      sessionsPageSize: this.sessionsPageSize,
      snapshots: this.sessionMenuSnapshots,
      getSessionSelectorChatId,
      refreshSessionsForChat: (chatId, options) => this.sessionDiscoveryService.refreshSessionsForChat(chatId, options),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      sortSessionsByMenuActivity,
      hashDirectoryKey,
      formatDirectoryMenuLabel,
      formatSectionMenuLabel: (entry, provider) => this.sessionPresentationService.formatSectionMenuLabel(entry, provider),
      getSessionProvider: (threadId) => this.threadMetadataCache.getProvider(threadId),
      readEffectiveProvider: (directory) => this.sessionProviderStateService.readEffectiveProviderForFilter(directory),
      readEffectiveProviderLabel: (directory) => this.sessionProviderStateService.readEffectiveProviderLabel(directory),
      renderCurrentSession: (chatId) => this.sessionInteractionService.renderCurrentSessionMenuSection(chatId)
    });
    this.sessionCreationService = new SessionCreationService({
      store,
      codexClient,
      sessionMenuService: this.sessionMenuService,
      sessionDiscoveryService: this.sessionDiscoveryService,
      sessionOwnershipService: this.sessionOwnershipService,
      sessionActivationService: this.sessionActivationService,
      clearBatchDecisionMessage: (session) => this.decisionDelivery.clearBatchDecisionMessage(session),
      ensureChatAllowed: (chatId) => this.ensureChatAllowed(chatId),
      isRuntimeConnected: () => this.runtime.isConnected(),
      getSessionSelectorChatId,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      expandHomeDirectory,
      normalizeDirectoryCandidate
    });
    this.subagentDelivery = new SubagentDeliveryService({
      store,
      subagents: this.subagents,
      notificationQueue: this.notificationQueue,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      sendSpecAndGetLastMessage: (chatId, messageSpec) => this.messageOperations.sendSpecAndGetLastMessage(chatId, messageSpec),
      editMessageSpec: (chatId, messageId, messageSpec) => this.messageOperations.editMessageSpec(chatId, messageId, messageSpec)
    });
    this.notificationTurnService = new NotificationTurnService({
      store,
      promoteSessionHandoff: (session) => this.sessionBindingService.promote(session),
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      assistantOutputByThread: state.assistantOutputByThread,
      errorSeenByThread: state.errorSeenByThread,
      lastAssistantTelegramByThread: state.lastAssistantTelegramByThread,
      queuedSubmissionService: this.queuedSubmissionService,
      resolveNotificationSession: (threadId) => this.notificationDeliveryTargets.resolve(threadId),
      applyStatusUpdate: (session, update) => this.applyStatusUpdate(session, update),
      handleRecoveryTaskComplete: (session) => this.handleRecoveryTaskComplete(session),
      clearProgressMessageForThread: (threadId, options) => this.clearProgressMessageForThread(threadId, options),
      scheduleGoShortcut: (session) => this.goShortcutService.schedule(session),
      cancelGoShortcut: (threadId) => this.goShortcutService.cancel(threadId),
      rememberRateLimitSession: (threadId, sessionId) => this.rateLimitNotifier.rememberSession(threadId, sessionId),
      deliverVersionUpdateAfterRootTurn: (session) => this.versionUpdateNotifier.deliverAfterRootTurn(session)
    });
    this.notificationRecoveryService = new NotificationRecoveryService({
      errorSeenByThread: state.errorSeenByThread,
      getActiveTurnId: (threadId) => state.inFlightTurnIdByThread.get(threadId)
        ?? store.getActiveTurnRoute(threadId)?.turnId ?? null,
      resolveNotificationSession: (threadId) => this.notificationDeliveryTargets.resolve(threadId),
      cancelGoShortcut: (threadId) => this.goShortcutService.cancel(threadId),
      clearTypingState: (sessionId) => this.typingService.clear(sessionId),
      setSessionStatus: (session, label, update) => this.statusLifecycleService.setSessionStatus(session, label, update),
      formatRecoveryIssue: (event) => this.statusLifecycleService.formatRecoveryIssue(event),
      autoCompactOnIncompatibleHistory: this.config.codexAutoCompactOnIncompatibleHistory,
      isIncompatibleHistoryError,
      handleIncompatibleHistoryError: (session, message) => this.handleIncompatibleHistoryError(session, message),
      sendSystemErrorMessage: (session, stage, message) => this.sendSystemErrorMessage(session, stage, message),
      handleRecoveryTaskComplete: (session) => this.handleRecoveryTaskComplete(session),
      notifyCompactCompleted: (session) => this.compactService.notifyCompactCompleted(session),
      clearSessionStatus: (session) => this.statusLifecycleService.clearSessionStatus(session)
    });
    this.notificationMessageService = new NotificationMessageService({
      store,
      assistantOutputByThread: state.assistantOutputByThread,
      recentResolvedMcpBySession: state.recentResolvedMcpBySession,
      resolveNotificationSession: (threadId) => this.notificationDeliveryTargets.resolve(threadId),
      resetTypingStatus: (sessionId) => this.typingService.resetStatus(sessionId),
      clearRetryingRecovery: (sessionId) => this.compactService.clearRetryingRecovery(sessionId),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      sendLongSpec: (chatId, messageSpec) => this.messageOperations.sendLongSpec(chatId, messageSpec),
      sendTranscriptMessage: (session, message, threadId) => this.messageOperations.sendTranscriptMessage(session, message, threadId),
      clearProgressMessageForThread: (threadId) => this.clearProgressMessageForThread(threadId)
    });
    this.notificationAuxiliaryService = new NotificationAuxiliaryService({
      store,
      statusRuntimeState: this.statusRuntimeState,
      mcpStartupStatusByName: state.mcpStartupStatusByName,
      modelRuntimeEventByThread: state.modelRuntimeEventByThread,
      tokenUsageTracker: this.tokenUsageTracker,
      recentResolvedMcpBySession: state.recentResolvedMcpBySession,
      resolveNotificationSession: (threadId) => this.notificationDeliveryTargets.resolve(threadId),
      rateLimitNotifier: this.rateLimitNotifier,
      getInFlightThreadIds: () => state.inFlightTurnIdByThread.keys(),
      setSessionStatus: (session, label) => this.statusLifecycleService.setSessionStatus(session, label),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      sendLongSpec: (chatId, messageSpec) => this.messageOperations.sendLongSpec(chatId, messageSpec)
    });
    this.notificationDispatcher = new NotificationDispatcher({
      store,
      sessionMenuSnapshots: this.sessionMenuSnapshots,
      notificationTurnService: this.notificationTurnService,
      notificationRecoveryService: this.notificationRecoveryService,
      notificationMessageService: this.notificationMessageService,
      notificationAuxiliaryService: this.notificationAuxiliaryService,
      resolveNotificationSession: (threadId) => this.notificationDeliveryTargets.resolve(threadId),
      sendProgressMessage: (session, event, turnId) => this.sendProgressMessage(session, event, turnId),
      recordBridgeConnectionFailure: (session, threadId, turnId) =>
        this.progressService.recordBridgeConnectionFailure(session, threadId, turnId)
    });
    this.notificationApprovalService = new NotificationApprovalService({
      store,
      codexClient,
      subagents: this.subagents,
      earlyApprovals: this.earlyApprovals,
      resolveNotificationSession: (threadId) => this.notificationDeliveryTargets.resolve(threadId),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      cancelGoShortcut: (threadId) => this.goShortcutService.cancel(threadId),
      setSessionStatus: (session, label) => this.statusLifecycleService.setSessionStatus(session, label),
      sendDecisionMessage: (session, decision) => this.decisionDelivery.sendDecisionMessage(session, decision),
      syncBatchDecisionMessage: (session) => this.decisionDelivery.syncBatchDecisionMessage(session),
      sendLongSpec: (chatId, messageSpec) => this.messageOperations.sendLongSpec(chatId, messageSpec)
    });
    this.notificationListener = new NotificationListener({
      codexClient,
      threadMetadataCache: this.threadMetadataCache,
      sessionMenuSnapshots: this.sessionMenuSnapshots,
      earlyApprovals: this.earlyApprovals,
      subagents: this.subagents,
      subagentDelivery: this.subagentDelivery,
      notificationSessionRouter: this.notificationSessionRouter,
      notificationQueue: this.notificationQueue,
      notificationDispatcher: this.notificationDispatcher,
      notificationApprovalService: this.notificationApprovalService,
      handleAppServerNotification: (notification) => this.notificationDispatcher.handle(notification),
      releaseBridgeLocksAfterAuthChange: () => store.releaseBridgeLocksAfterAuthChange(),
      store,
      getRuntimeState: () => this.runtime.state,
      setRuntimeState: (next) => this.setRuntimeState(next),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      sendLongSpec: (chatId, messageSpec) => this.messageOperations.sendLongSpec(chatId, messageSpec)
    });
    this.incomingPayloadService = new IncomingPayloadService({
      openaiApiKey: this.config.openaiApiKey,
      transcriptionModel: this.config.slackAudioTranscriptionModel,
      createPromptSpec: (kind, text) => this.runtimePromptFactory.createIncoming(kind, text),
      handleIncomingUserText: (input) => this.handleIncomingUserText(input)
    });
    this.incomingPreflightService = new IncomingPreflightService({
      store,
      codexClient,
      sessionOwnershipService: this.sessionOwnershipService,
      ensureChatAllowed: (chatId) => this.ensureChatAllowed(chatId),
      isRuntimeConnected: () => this.isRuntimeConnected(),
      getActiveSession: (chatId) => this.store.getActiveSession(chatId),
      recoverSlackDmActiveSession: (chatId) => this.sessionRecoveryService.recoverSlackDmActiveSession(chatId),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      createIncomingPromptSpec: (kind, text, session) => this.runtimePromptFactory.createIncoming(kind, text, session),
      createMcpInputPromptSpec: (session, decision, errorMessage) => this.runtimePromptFactory.createMcpInput(session, decision, errorMessage),
      sendLongSpec: (chatId, messageSpec) => this.messageOperations.sendLongSpec(chatId, messageSpec),
      syncBatchDecisionMessageForSessionId: (sessionId) => this.decisionDelivery.syncBatchDecisionMessageForSessionId(sessionId),
      renderSessionMenu: (chatId, page, options) => this.renderSessionMenu(chatId, page, options)
    });
    this.incomingTurnService = new IncomingTurnService({
      store,
      codexClient,
      turnRouteQueue: this.turnRouteQueue,
      runDispatch: (session, operation) => this.sessionBindingService.runDispatch(session, operation),
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      statusRuntimeState: this.statusRuntimeState,
      lastUserInputBySession: state.lastUserInputBySession,
      sessionOwnershipService: this.sessionOwnershipService,
      rememberNotificationSession: (session) => {
        this.notificationSessionContext.remember(session);
        this.notificationDeliveryTargets.remember(session);
      },
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      isStaleActiveTurnError,
      isMissingRuntimeThreadError,
      isActiveWriterConflictError,
      findProviderMismatch: (session, snapshot) => this.sessionProviderStateService.findProviderMismatch(session, snapshot),
      sessionRefreshCallback: (sessionId, leaseVersion) => createSessionActionCallback("refresh", sessionId, leaseVersion),
      createIncomingPromptSpec: (kind, text, session) => this.runtimePromptFactory.createIncoming(kind, text, session),
      createSessionActionSpec,
      sendLongSpec: (chatId, messageSpec) => this.messageOperations.sendLongSpec(chatId, messageSpec),
      setSessionStatus: (session, label) => this.statusLifecycleService.setSessionStatus(session, label)
    });
    this.decisionDelivery = new DecisionDeliveryService({
      store,
      requireMessageTransport: (chatId) => this.messageSender.requireTransport(chatId),
      sessionOperationQueue: this.sessionDecisionOperationQueue,
      isBatchableDecision: (decision) => isBatchableDecision(decision),
      createDecisionMessageSpec: (session, decision, actions) => createDecisionMessageSpec(session, decision, actions),
      createBatchDecisionMessageSpec: (count, actions) => createBatchDecisionMessageSpec(count, actions),
      getExecpolicyAmendment: (decision) => getExecpolicyAmendment(decision),
      sendMessageSpec: (chatId, messageSpec, options) => this.messageOperations.sendMessageSpec(chatId, messageSpec, options),
      editMessageSpec: (chatId, messageId, messageSpec, options) => this.messageOperations.editMessageSpec(chatId, messageId, messageSpec, options)
    });
    this.decisionCommandService = new DecisionCommandService({
      store,
      codexClient,
      sessionOwnershipService: this.sessionOwnershipService,
      decisionDelivery: this.decisionDelivery,
      createMcpInputPromptSpec: (session, decision) => this.runtimePromptFactory.createMcpInput(session, decision),
      sendLongSpec: (chatId, messageSpec) => this.messageOperations.sendLongSpec(chatId, messageSpec)
    });
    this.compactService = new CompactService({
      store,
      codexClient,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      getLastUserInput: (sessionId) => state.lastUserInputBySession.get(sessionId),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      formatCompactTokenCount: (threadId) => this.tokenUsageTracker.formatCompactUsage(threadId),
      isMissingRuntimeThreadError,
      rememberNotificationSession: (session) => {
        this.notificationSessionContext.remember(session);
        this.notificationDeliveryTargets.remember(session);
      },
      resumeThread: (threadId, cwd) => this.codexClient.resumeThread(threadId, cwd),
      setSessionStatus: (session, label) => this.statusLifecycleService.setSessionStatus(session, label),
      sendSystemErrorMessage: async (session, stage, message) => { await this.sendSystemErrorMessage(session, stage, message); },
      sendLongSpec: (chatId, messageSpec, options) => this.messageOperations.sendLongSpec(chatId, messageSpec, options)
    });
    this.typingService = new TypingService({
      intervalMs: this.typingIntervalMs,
      requireMessageTransport: (chatId) => this.messageSender.requireTransport(chatId),
    });
    this.progressService = new ProgressService({
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      getInFlightTurnId: (threadId) => state.inFlightTurnIdByThread.get(threadId) ?? null,
      shouldSkipCalledProgress: (session, now) => this.subagentDelivery.shouldSkipCalledProgress(session, now),
      getActiveProgressPhaseMessage: (threadId, turnId) => store.getActiveProgressPhaseMessage(threadId, turnId),
      getLatestProgressPhaseMessage: (threadId, turnId) => store.getLatestProgressPhaseMessage(threadId, turnId),
      getProgressPhaseMessageForFileEdit: (threadId, turnId, itemId) => store.getProgressPhaseMessageForFileEdit(threadId, turnId, itemId),
      updateFinalProgressPhaseAggregate: (id, aggregate) => store.updateFinalProgressPhaseAggregate(id, aggregate),
      listActiveProgressPhaseMessages: () => store.listActiveProgressPhaseMessages(),
      listPendingProgressPhaseFinalDelivery: () => store.listPendingProgressPhaseFinalDelivery(),
      createProgressPhaseMessage: (input) => store.createProgressPhaseMessage(input),
      updateActiveProgressPhaseMessage: (id, input) => store.updateActiveProgressPhaseMessage(id, input),
      recordSuccessfulRunContentUpdate: (id) => store.recordSuccessfulRunContentUpdate(id),
      finalizeProgressPhaseMessage: (input) => store.finalizeProgressPhaseMessage(input),
      updateFinalProgressPhaseMessageState: (input) => store.updateFinalProgressPhaseMessageState(input),
      markProgressPhaseMessageDeliveryState: (input) => store.markProgressPhaseMessageDeliveryState(input),
      editMessageSpec: (chatId, messageId, messageSpec, options) => this.messageOperations.editMessageSpec(chatId, messageId, messageSpec, options),
      sendTemporaryMessageSpec: async (chatId, messageSpec, options) => {
        const sent = await this.messageOperations.sendMessageSpec(chatId, messageSpec, options);
        return sent ? { messageId: sent.message_id, text: renderLegacyMessage(messageSpec) } : null;
      }
    });
    this.sessionTranscriptService = new SessionTranscriptService({
      listRecentMessages: (sessionId, limit) => this.store.listRecentMessages(sessionId, limit),
      listPendingDecisions: (sessionId) => this.store.listPendingDecisions(sessionId),
      getAwaitingInputDecision: (sessionId) => this.store.getAwaitingInputDecisionForSession(sessionId),
      resolveDecision: (decisionId, state) => this.store.resolveDecision(decisionId, state),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      getProviderDetails: async (session) => {
        const details = await this.sessionProviderStateService.getSessionProviderDetails(session, { readActive: true });
        return this.sessionProviderStateService.getProviderDetailsValues(details);
      },
      sendLongSpec: async (chatId, messageSpec, options) => {
        await this.messageOperations.sendLongSpec(chatId, messageSpec, options);
      },
      sendHistoryBlocks: (chatId, blocks, purpose) => this.historyDeliveryService.sendHistoryBlocks(chatId, blocks, purpose),
      sendDecisionMessage: (session, decision) => this.decisionDelivery.sendDecisionMessage(session, decision),
      syncBatchDecisionMessage: (session) => this.decisionDelivery.syncBatchDecisionMessage(session),
      postSessionRefreshStatus: (chatId, session) => this.sessionRefreshStatusService.post(chatId, session),
      sendGoNextHelpActions: (chatId, session) => this.goShortcutService.sendAfterTranscript(session, chatId)
    });
    this.runtimeStateCleanupService = new RuntimeStateCleanupService({
      threadMetadataCache: this.threadMetadataCache,
      inFlightTurnIds: state.inFlightTurnIdByThread,
      notificationSessions: this.notificationSessionRouter,
      assistantOutput: state.assistantOutputByThread,
      seenErrors: state.errorSeenByThread,
      rateLimitSessions: this.rateLimitNotifier,
      tokenUsage: this.tokenUsageTracker,
      mcpStartupStatus: state.mcpStartupStatusByName,
      modelRuntimeEvents: state.modelRuntimeEventByThread,
      lastAssistantMessages: state.lastAssistantTelegramByThread,
      pendingGoShortcuts: state.pendingGoShortcutByThread,
      typing: this.typingService,
      clearProgressMessages: () => this.progressService.clearAllProgressMessages(),
      clearSessionStatusMessages: () => this.statusLifecycleService.clearAllSessionStatusMessages()
    });
    this.runtimeCommandService = new RuntimeCommandService({
      runtime: this.runtime,
      codexClient,
      pm2AppName: this.pm2AppName,
      getActiveSessionContext: (chatId) => this.getActiveSessionContext(chatId),
      attachCodexListeners: () => this.attachCodexListeners(),
      detachCodexListeners: () => this.detachCodexListeners(),
      discoverSessions: () => this.sessionDiscoveryService.discoverSessionsForAllowedChats(),
      clearDisconnectedState: () => this.runtimeStateCleanupService.clear(),
      getSeedChatIds: () => this.getDiscoveryChatIds(),
      ensureSeedChats: (chatIds) => this.store.ensureSeedChats(chatIds),
      listSessionsForPolling: async () => (await this.store.listSessionsForPolling()).length,
      reconcileRecoveredTurnState: () => this.reconcileRecoveredTurnState()
    });
    this.statusViewService = new StatusViewService({
      store,
      codexClient,
      tokenUsageTracker: this.tokenUsageTracker,
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      mcpStartupStatusByName: state.mcpStartupStatusByName,
      modelRuntimeEventByThread: state.modelRuntimeEventByThread,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      getSessionProviderDetails: (session, options) => this.sessionProviderStateService.getSessionProviderDetails(session, options),
      readEffectiveConfigSnapshot: (directory) => this.sessionProviderStateService.readEffectiveConfigSnapshot(directory),
      readSessionGoal: (session) => this.sessionPresentationService.readSessionGoal(session)
    });
    this.sessionActionGuardService = new SessionActionGuardService({
      store,
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      hasPendingDispatch: (threadId) => this.sessionBindingService.hasPendingDispatch(threadId),
      buildCallback: (action, sessionId, leaseVersion) => {
        switch (action) {
          case "archive": return createSessionActionCallback("archive", sessionId, leaseVersion);
          case "delete": return createSessionActionCallback("delete", sessionId, leaseVersion);
          case "releaseBridge": return createSessionActionCallback("releaseBridge", sessionId, leaseVersion);
        }
      }
    });
    this.sessionStopService = new SessionStopService({
      store,
      codexClient,
      inFlightTurnIdByThread: state.inFlightTurnIdByThread,
      sessionOwnershipService: this.sessionOwnershipService,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      createCommandResultSpec,
      createSessionCommandResultSpec,
      clearTypingState: (sessionId) => this.typingService.clear(sessionId),
      setSessionStatus: (session, label) => this.statusLifecycleService.setSessionStatus(session, label)
    });
    this.sessionCompactService = new SessionCompactService({
      store,
      compactService: this.compactService,
      sessionOwnershipService: this.sessionOwnershipService
    });
  }

  registerMessageTransport(transport: BridgeMessageTransport): void {
    this.messageSender.registerTransport(transport);
  }

  private async updateConversationSession(sourceId: string): Promise<void> {
    await this.sessionCardQueue.run(sourceId, async () => {
      try {
        const transport = this.messageSender.requireTransport(sourceId);
        if (!transport.updateConversationSession) return;
        const current = await this.sessionInteractionService.renderCurrentSessionMenuSection(sourceId);
        await transport.updateConversationSession(sourceId, current?.messageSpec ?? createMessage({
          kind: "system", titleLabel: "Codex", body: [{ type: "text", text: "No session selected." }]
        }));
      } catch (error) {
        logger.warn("bridge.session.card_update_failed", { sourceId, error: String(error) });
      }
    });
  }

  async getActiveSession(telegramChatId: string): Promise<SessionRecord | null> {
    return this.store.getActiveSession(telegramChatId);
  }

  async getActiveSessionContext(telegramChatId: string): Promise<SessionContext | undefined> {
    const session = await this.store.getActiveSession(telegramChatId);
    if (!session) return undefined;
    return {
      id: session.codexThreadId,
      directory: this.getSessionDirectory(session)
    };
  }

  async getHelpMenuActions(telegramChatId: string): Promise<ActionSpec[]> {
    const session = await this.store.getActiveSession(telegramChatId);
    const hasActiveTurn = Boolean(
      session && this.bridgeRuntimeState.inFlightTurnIdByThread.has(session.codexThreadId)
    );
    return helpMenuActions({
      hasActiveSession: Boolean(session),
      hasActiveTurn,
      runtimeConnected: this.isRuntimeConnected()
    });
  }

  async getSessionArchiveCallback(telegramChatId: string, sessionId: string): Promise<string | null> {
    return this.sessionActionGuardService.getCallback(telegramChatId, sessionId, "archive");
  }

  async getSessionDeleteCallback(telegramChatId: string, sessionId: string): Promise<string | null> {
    return this.sessionActionGuardService.getCallback(telegramChatId, sessionId, "delete");
  }

  async getSessionReleaseBridgeCallback(telegramChatId: string, sessionId: string): Promise<string | null> {
    return this.sessionActionGuardService.getCallback(telegramChatId, sessionId, "releaseBridge");
  }

  async archiveSession(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    return this.sessionMutationService.archiveSession(telegramChatId, sessionId, expectedLeaseVersion);
  }

  async requestDeleteSession(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    return this.sessionMutationService.requestDeleteSession(telegramChatId, sessionId, expectedLeaseVersion);
  }

  async deleteSession(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    return this.sessionMutationService.deleteSession(telegramChatId, sessionId, expectedLeaseVersion);
  }

  async stopActiveSessionMessage(telegramChatId: string): Promise<MessageSpec> {
    return this.sessionStopService.stop(telegramChatId);
  }

  async compactActiveSessionMessage(telegramChatId: string): Promise<MessageSpec> {
    return this.sessionCompactService.compact(telegramChatId);
  }

  async statusActiveSessionMessage(telegramChatId: string, full = false): Promise<MessageSpec> {
    return this.statusViewService.render(telegramChatId, full);
  }

  async renderActiveGoal(telegramChatId: string): Promise<MessageSpec> {
    return this.goalCommandService.renderActive(telegramChatId);
  }

  async renderSelectedGoal(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    return this.goalCommandService.renderSelected(telegramChatId, sessionId);
  }

  async setActiveGoalObjective(telegramChatId: string, objective: string): Promise<MessageSpec> {
    return this.goalCommandService.setActiveObjective(telegramChatId, objective);
  }

  async updateActiveGoalStatus(telegramChatId: string, status: "active" | "paused" | "complete"): Promise<MessageSpec> {
    return this.goalCommandService.updateActiveStatus(telegramChatId, status);
  }

  async updateGoalStatus(telegramChatId: string, sessionId: string, status: "active" | "paused" | "complete"): Promise<MessageSpec> {
    return this.goalCommandService.updateStatus(telegramChatId, sessionId, status);
  }

  async clearActiveGoal(telegramChatId: string): Promise<MessageSpec> {
    return this.goalCommandService.clearActive(telegramChatId);
  }

  async clearGoal(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    return this.goalCommandService.clear(telegramChatId, sessionId);
  }

  async requestClearActiveGoal(telegramChatId: string): Promise<MessageSpec> {
    return this.goalCommandService.requestClearActive(telegramChatId);
  }

  async requestClearGoal(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    return this.goalCommandService.requestClear(telegramChatId, sessionId);
  }

  async renderGoalsMenu(telegramChatId: string, page = 0): Promise<MessageSpec> {
    return this.goalCommandService.renderMenu(telegramChatId, page);
  }

  formatTelegramHtml(text: string): string {
    return formatTelegramHtml(text);
  }

  async envelopeChatMessage(telegramChatId: string, text: string): Promise<string> {
    return this.messageSender.envelopeText(telegramChatId, text);
  }

  formatCodexTelegramHtml(text: string): TelegramTextChunk[] | null {
    return formatCodexTelegramHtml(text, this.telegramMessageMaxLength);
  }

  async restartServiceMessage(): Promise<MessageSpec> {
    return this.runtimeCommandService.restart();
  }

  isRuntimeConnected(): boolean {
    return this.runtime.isConnected();
  }

  private setRuntimeState(next: RuntimeState): void {
    const previous = this.runtimeState;
    this.runtime.transition(next);
    logger.info("bridge.runtime.state_changed", { previous, next });
  }

  async disconnectBotRuntimeMessage(telegramChatId?: string): Promise<MessageSpec> {
    return this.runtimeCommandService.disconnect(telegramChatId);
  }

  async connectBotRuntimeMessage(telegramChatId?: string): Promise<MessageSpec> {
    return this.runtimeCommandService.connect(telegramChatId);
  }

  async bootstrap(): Promise<void> {
    await this.runtimeCommandService.bootstrap();
    await this.versionUpdateNotifier.start();
  }

  shutdown(): void {
    this.versionUpdateNotifier.stop();
  }

  async ensureChatAllowed(telegramChatId: string): Promise<void> {
    if (telegramChatId === WEB_SOURCE_ID && this.config.web) {
      await this.store.ensureChat(telegramChatId);
      return;
    }
    const slackChat = parseSlackChatId(telegramChatId);
    if (slackChat) {
      if (
        this.config.slackAllowedChannelIds &&
        !slackChat.channelId.startsWith("D") &&
        !this.config.slackAllowedChannelIds.has(slackChat.channelId)
      ) {
        throw new Error(`Slack channel ${slackChat.channelId} is not allowed.`);
      }

      await this.store.ensureChat(telegramChatId);
      return;
    }

    if (
      this.config.telegramAllowedChatIds &&
      !this.config.telegramAllowedChatIds.has(telegramChatId)
    ) {
      throw new Error(`Chat ${telegramChatId} is not allowed.`);
    }

    await this.store.ensureChat(telegramChatId);
  }

  async renderSessionMenu(
    telegramChatId: string,
    page = 0,
    options?: { refresh?: boolean; includeUnknownThreads?: boolean; reuseSnapshot?: boolean }
  ): Promise<MessageSpec> {
    return this.sessionMenuService.renderSessionMenu(telegramChatId, page, options);
  }

  async renderArchivedSessionMenu(
    telegramChatId: string,
    page = 0
  ): Promise<MessageSpec> {
    return this.sessionMenuService.renderArchivedSessionMenu(telegramChatId, page);
  }

  async renderSessionSectionMenu(
    telegramChatId: string,
    directoryHash: string,
    page = 0
  ): Promise<MessageSpec> {
    return this.sessionMenuService.renderSessionSectionMenu(telegramChatId, directoryHash, page);
  }

  async activateSection(telegramChatId: string, sessionId: string): Promise<{
    session: SessionRecord;
    recentMessages: Array<Pick<MessageRecord, "role" | "text">>;
  }> {
    return this.activateSession(telegramChatId, sessionId);
  }

  async renderSelectedSessionSpec(
    session: SessionRecord,
    actions: MessageSpec["actions"] = []
  ): Promise<MessageSpec> {
    const slackChat = parseSlackChatId(session.telegramChatId);
    return this.messageFactory.createSelectedSessionSpec(
      session,
      slackChat?.threadTs ?? "n/a",
      actions
    );
  }

  async renderSelectedSessionMessage(session: SessionRecord): Promise<string> {
    const message = await this.renderSelectedSessionSpec(session);
    return [`**${message.title}**`, ...message.body.map((part) => {
      switch (part.type) {
        case "text":
        case "markdown":
        case "code":
        case "heading":
          return part.text;
        case "field":
          return `${part.label}: ${part.value}`;
      }
    })].join("\n");
  }

  async unarchiveSession(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    return this.sessionMutationService.unarchiveSession(telegramChatId, sessionId);
  }

  async requestSessionHandoff(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    return this.sessionMutationService.requestSessionHandoff(telegramChatId, sessionId, expectedLeaseVersion);
  }

  createWebApi(): LocalWebBridgeApi {
    if (!this.webMessageTransport) {
      this.webMessageTransport = new WebMessageTransport(this.store, {
        isRuntimeConnected: () => this.isRuntimeConnected(),
        isApprovalPending: (approvalId) => this.codexClient.isApprovalPending(approvalId)
      });
      this.registerMessageTransport(this.webMessageTransport);
      this.sessionBindingService.subscribe((event) => this.webMessageTransport?.observeBinding(event));
    }
    const transport = this.webMessageTransport;
    return new LocalWebBridgeApi(new SessionCatalogService({
      store: this.store,
      codexClient: this.codexClient,
      getSessionDirectory: (session) => this.getSessionDirectory(session),
      readEffectiveProvider: (directory) => this.sessionProviderStateService.readEffectiveProviderForFilter(directory),
      readLoadedThreadIds: async () => {
        if (!this.isRuntimeConnected()) return null;
        const loaded = await this.codexClient.readLoadedThreads();
        return loaded ? new Set(loaded.threadIds) : null;
      },
      canReleaseToCodex: (sessionId) => this.sessionActionGuardService.isAvailable(WEB_SOURCE_ID, sessionId)
    }), { store: this.store, service: this.sessionBindingService }, {
      access: new SessionAccessService(this.store), reader: this.sessionReader,
      sender: this.incomingTurnService, transport, store: this.store,
      isRuntimeConnected: () => this.isRuntimeConnected()
    }, new WebDecisionService({
      access: new SessionAccessService(this.store), store: this.store, commands: this.decisionCommandService,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      isApprovalPending: (approvalId) => this.codexClient.isApprovalPending(approvalId),
      runDispatch: (session, operation) => this.sessionBindingService.runDispatch(session, operation)
    }), new WebDirectoryRegistry(this.store), {
      store: this.store,
      access: new SessionAccessService(this.store),
      binding: this.sessionBindingService,
      creation: this.sessionCreationService,
      interaction: this.sessionInteractionService,
      mutation: this.sessionMutationService,
      compact: this.compactService,
      stop: this.sessionStopService,
      status: this.statusViewService,
      queued: this.queuedSubmissionService,
      sender: this.incomingTurnService,
      isRuntimeConnected: () => this.isRuntimeConnected(),
      inFlightTurnIdByThread: this.bridgeRuntimeState.inFlightTurnIdByThread,
      help: async (session) => createMessage({
        kind: "menu",
        titleLabel: "Help",
        session: { id: session.codexThreadId, directory: this.getSessionDirectory(session) },
        actions: helpMenuActions({
          hasActiveSession: true,
          hasActiveTurn: this.bridgeRuntimeState.inFlightTurnIdByThread.has(session.codexThreadId),
          runtimeConnected: this.isRuntimeConnected()
        })
      })
    }, new WebAttachmentStorage());
  }

  async cancelSessionHandoff(sourceId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec> {
    return this.sessionMutationService.cancelSessionHandoff(sourceId, sessionId, expectedLeaseVersion);
  }

  async releaseBridgeSessionLock(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    return this.sessionMutationService.releaseBridgeSessionLock(telegramChatId, sessionId, expectedLeaseVersion);
  }

  async releaseCodexSession(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    return this.sessionMutationService.releaseCodexSession(telegramChatId, sessionId, expectedLeaseVersion);
  }

  async requestCreateSessionForCurrentDirectory(telegramChatId: string): Promise<MessageSpec> {
    return this.sessionCreationService.requestCreateSessionForCurrentDirectory(telegramChatId);
  }

  async requestCreateSessionFromDirectorySelector(
    telegramChatId: string,
    directoryHash: string
  ): Promise<MessageSpec> {
    return this.sessionCreationService.requestCreateSessionFromDirectorySelector(telegramChatId, directoryHash);
  }

  async activateSectionFromSelector(telegramChatId: string, sessionId: string): Promise<{
    session: SessionRecord;
    recentMessages: Array<Pick<MessageRecord, "role" | "text">>;
  }> {
    return this.activateSessionFromSelector(telegramChatId, sessionId);
  }

  async renameActiveSectionMessage(telegramChatId: string, nameInput: string): Promise<MessageSpec> {
    return this.sessionInteractionService.renameActiveSection(telegramChatId, nameInput);
  }

  async activateSession(telegramChatId: string, sessionId: string): Promise<{
    session: SessionRecord;
    recentMessages: Array<Pick<MessageRecord, "role" | "text">>;
  }> {
    return this.sessionActivationService.activateSession(telegramChatId, sessionId);
  }

  async activateSessionFromSelector(telegramChatId: string, sessionId: string): Promise<{
    session: SessionRecord;
    recentMessages: Array<Pick<MessageRecord, "role" | "text">>;
  }> {
    const targetSession = await this.store.getSessionById(sessionId);
    if (!targetSession) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return this.activateSession(telegramChatId, sessionId);
  }

  async refreshSessionView(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<SessionTranscript> {
    return this.sessionViewService.refreshSessionView(telegramChatId, sessionId, expectedLeaseVersion);
  }

  async activateOrCreateSessionForDirectory(
    telegramChatId: string,
    directoryInput: string
  ): Promise<{
    session: SessionRecord;
    recentMessages: Array<Pick<MessageRecord, "role" | "text">>;
    created: boolean;
  }> {
    return this.sessionCreationService.activateOrCreateSessionForDirectory(telegramChatId, directoryInput);
  }

  async postSessionSwitchTranscript(
    telegramChatId: string,
    session: SessionRecord,
    recentMessages?: Array<Pick<MessageRecord, "role" | "text">>,
    options?: { heading?: string; purpose?: "session_switch" | "session_refresh" }
  ): Promise<void> {
    return this.sessionTranscriptService.postSessionSwitchTranscript(
      telegramChatId,
      session,
      recentMessages,
      options
    );
  }

  async postSessionRefreshStatus(
    telegramChatId: string,
    session: SessionRecord
  ): Promise<void> {
    return this.sessionRefreshStatusService.post(telegramChatId, session);
  }

  async removeSessionRefreshStatus(telegramChatId: string, sessionId: string): Promise<void> {
    return this.sessionRefreshStatusService.remove(telegramChatId, sessionId);
  }

  async handleIncomingUserPayload(input: {
    attachments: IncomingAttachment[];
    queue?: boolean;
    telegramChatId: string;
    telegramMessageId: string;
    text: string;
  }): Promise<{ routed: boolean; prompt?: MessageSpec }> {
    return this.incomingPayloadService.handle(input);
  }

  async handleIncomingUserText(input: {
    inputParts?: CodexTurnInputPart[];
    queue?: boolean;
    telegramChatId: string;
    telegramMessageId: string;
    text: string;
  }): Promise<{ routed: boolean; prompt?: MessageSpec }> {
    const preflight = await this.incomingPreflightService.run(input);
    if (preflight.kind === "response") return preflight.response;
    return this.incomingTurnService.route(preflight.session, input);
  }

  async cancelQueuedSubmission(chatId: string, id: string): Promise<MessageSpec> {
    const result = await this.queuedSubmissionService.cancel(chatId, id);
    const queued = await this.store.getQueuedSubmission(id);
    if (queued) {
      const session = await this.store.getSessionById(queued.sessionId);
      if (session) await this.sessionBindingService.promote(session);
    }
    return result;
  }

  async handleDecision(decisionId: string, action: DecisionAction, sourceId?: string): Promise<{
    ok: boolean;
    message: string;
  }> {
    const result = await this.decisionCommandService.handle(decisionId, action, sourceId);
    if (result.ok) {
      const decision = await this.store.getDecision(decisionId);
      const session = decision ? await this.store.getSessionById(decision.sessionId) : null;
      if (session) await this.sessionBindingService.promote(session);
    }
    return result;
  }

  async handleBatchDecision(
    sessionId: string,
    action: Extract<DecisionAction, "accept" | "decline" | "cancel">,
    sourceId?: string,
    expectedLeaseVersion?: number
  ): Promise<{ ok: boolean; message: string }> {
    const result = await this.decisionCommandService.handleBatch(sessionId, action, sourceId, expectedLeaseVersion);
    if (result.ok) {
      const session = await this.store.getSessionById(sessionId);
      if (session) await this.sessionBindingService.promote(session);
    }
    return result;
  }

  private async handleAppServerNotification(notification: {
    method: string;
    params?: unknown;
  }): Promise<void> {
    return this.notificationDispatcher.handle(notification);
  }

  private getDiscoveryChatIds(): string[] {
    return this.config.telegramAllowedChatIds ? [...this.config.telegramAllowedChatIds] : [];
  }

  private attachCodexListeners(): void {
    this.notificationListener.attach();
  }

  private detachCodexListeners(): void {
    this.notificationListener.detach();
  }

  private async sendSystemErrorMessage(
    session: SessionRecord,
    stage: "stream" | "error",
    message: string
  ): Promise<boolean> {
    const messageSpec = this.runtimePromptFactory.createSystemError(session, stage, message);
    return Boolean(await this.messageOperations.sendSpecAndGetLastMessage(session.telegramChatId, messageSpec));
  }

  // COMPATIBILITY(TEST): integration tests inject lifecycle status updates through the Bridge facade.
  private async applyStatusUpdate(
    session: SessionRecord,
    update: AppServerStatusUpdate
  ): Promise<void> {
    return this.statusLifecycleService.applyStatusUpdate(session, update);
  }

  // COMPATIBILITY(TEST): integration tests control progress delivery timing through the Bridge facade.
  private async sendProgressMessage(
    session: SessionRecord,
    event: ProgressNotificationEvent,
    turnId?: string
  ): Promise<void> {
    return this.progressService.sendProgressMessage(session, event, turnId);
  }

  // COMPATIBILITY(TEST): integration tests exercise automatic compact recovery via the Bridge facade.
  private async handleIncompatibleHistoryError(session: SessionRecord, errorMessage: string): Promise<void> {
    return this.compactService.handleIncompatibleHistoryError(session, errorMessage);
  }

  // COMPATIBILITY(TEST): integration tests close in-flight progress through the Bridge facade.
  private async clearProgressMessageForThread(
    threadId: string,
    options?: { terminal?: "completed" | "failed" | "interrupted"; turnId?: string }
  ): Promise<void> {
    const turnId = options?.turnId ??
      this.bridgeRuntimeState.inFlightTurnIdByThread.get(threadId) ??
      this.store.getActiveTurnRoute(threadId)?.turnId;
    if (!turnId) return;
    await this.progressService.clearProgressMessageForThread(threadId, { ...options, turnId });
  }

  private async reconcileRecoveredTurnState(): Promise<void> {
    if (!this.canReadThreadStatus()) return;

    const candidates = new Map<string, {
      route?: ReturnType<BridgeStore["getActiveTurnRoute"]>;
      phase?: ReturnType<BridgeStore["getActiveProgressPhaseMessage"]>;
    }>();
    for (const route of this.store.listActiveTurnRoutes()) {
      candidates.set(route.codexThreadId, { ...candidates.get(route.codexThreadId), route });
    }
    for (const phase of this.store.listActiveProgressPhaseMessages()) {
      candidates.set(phase.codexThreadId, { ...candidates.get(phase.codexThreadId), phase });
    }

    for (const [threadId, candidate] of candidates) {
      const sessionId = candidate.route?.sessionId ?? candidate.phase?.sessionId;
      const session = sessionId ? await this.store.getSessionById(sessionId) : null;
      if (!session) {
        if (candidate.route) this.store.completeTurnRoute(candidate.route.turnId, "interrupted");
        if (candidate.phase) await this.clearProgressMessageForThread(threadId, {
          terminal: "interrupted",
          turnId: candidate.phase.turnId
        });
        logger.warn("bridge.bootstrap.active_turn_orphaned", { threadId, sessionId: sessionId ?? null });
        continue;
      }

      try {
        const status = await this.codexClient.readThreadStatus(
          threadId,
          this.getSessionDirectory(session),
          { readOnly: true, timeoutMs: 5_000 }
        );
        if (status.activity === "running") {
          const turnId = candidate.route?.turnId ?? candidate.phase?.turnId;
          if (turnId && turnId !== "unknown") {
            this.bridgeRuntimeState.inFlightTurnIdByThread.set(threadId, turnId);
          }
          this.notificationSessionRouter.remember(session);
          logger.info("bridge.bootstrap.active_turn_restored", {
            sessionId: session.id,
            threadId,
            turnId: turnId ?? null,
            activityType: status.activityType
          });
          continue;
        }
        const activityType = status.activityType?.toLowerCase().replace(/[-_]/g, "") ?? null;
        if (status.activity === "idle" && activityType === "notloaded") {
          logger.info("bridge.bootstrap.active_turn_reconcile_deferred", {
            sessionId: session.id,
            threadId,
            activityType: status.activityType
          });
          continue;
        }
        if (status.activity === "idle") {
          if (candidate.route) {
            this.store.completeTurnRoute(candidate.route.turnId, "interrupted");
            this.store.clearSessionOwnerTurn(session.id, candidate.route.turnId);
          }
          await this.clearProgressMessageForThread(threadId, {
            terminal: "interrupted",
            turnId: candidate.phase?.turnId ?? candidate.route?.turnId
          });
          logger.info("bridge.bootstrap.active_turn_interrupted", {
            sessionId: session.id,
            threadId,
            activityType: status.activityType
          });
          continue;
        }
        logger.info("bridge.bootstrap.active_turn_reconcile_deferred", {
          sessionId: session.id,
          threadId,
          activityType: status.activityType
        });
      } catch (error) {
        logger.warn("bridge.bootstrap.active_turn_reconcile_failed", {
          sessionId: session.id,
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  // COMPATIBILITY(TEST): integration tests exercise the final automatic compact recovery step here.
  private async handleRecoveryTaskComplete(session: SessionRecord): Promise<boolean> {
    return this.compactService.handleRecoveryTaskComplete(session);
  }

  private canReadThreadStatus(): boolean {
    return typeof (this.codexClient as { readThreadStatus?: unknown }).readThreadStatus === "function";
  }

}
