import { randomUUID } from "node:crypto";

import {
  buildApprovalSummary,
  buildApprovalTitle,
  extractRequestedFieldNames,
  mcpRequestRequiresUserInput
} from "./extractors/approval.js";
import { asRecord, firstString } from "./protocol-utils.js";
import type { ThreadHistoryEntry } from "./thread-history.js";
import {
  getAppServerMethodCapability,
  isKnownAppServerMethod,
  listAppServerMethodCapabilities,
  type AppServerKnownMethod,
  type AppServerMethodCapability,
  type AppServerMethodGroup,
  type AppServerMethodKind,
  type AppServerMethodStatus
} from "./protocol-registry.js";
import {
  extractCodexConfigSnapshot,
  type CodexConfigSnapshot
} from "./config-snapshot.js";
import {
  extractTurnLifecycleEvent
} from "./notification-events.js";
import {
  extractRuntimeInfo as parseRuntimeInfo
} from "./catalog-extractors.js";
import { CodexCatalogApi } from "./catalog-api.js";
import { CodexThreadListApi, type ListedCodexThread, type ThreadListOptions } from "./thread-list-api.js";
import {
  AppServerConnection,
  type AppServerServerRequest,
  type JsonRpcId
} from "./app-server-connection.js";
import { getCodexAuthFilePath } from "./auth-identity.js";
import { AuthReconnectCoordinator, readCodexEnvironment } from "./auth-reconnect.js";
import { ProviderReconnectCoordinator } from "./provider-reconnect.js";
import {
  CodexGoalApi,
  type AppServerThreadGoal,
  type ThreadGoalPatch
} from "./goal-api.js";
import { CodexQueueApi, type CodexQueuedSubmission } from "./queue-api.js";
import {
  CodexThreadApi,
  extractThreadStatus,
  type ThreadUnsubscribeStatus
} from "./thread-api.js";
import { CodexTurnApi, type SendTurnOptions } from "./turn-api.js";
import { ThreadRuntimeState } from "./thread-runtime-state.js";
import type { AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { DecisionAction } from "../shared/types.js";

function extractRequestedPermissions(content?: Record<string, unknown> | null): Record<string, unknown> {
  const permissions = asRecord(content?.permissions);
  if (!permissions) return {};
  const network = asRecord(permissions.network);
  const fileSystem = asRecord(permissions.fileSystem);
  return {
    ...(network ? { network } : {}),
    ...(fileSystem ? { fileSystem } : {})
  };
}

export interface AppServerApprovalRequest {
  requestId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  method:
    | "mcpServer/elicitation/request"
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval";
  title: string;
  summary: string | null;
  requestedFields: string[];
  requiresUserInput: boolean;
  elicitationMode: string | null;
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerStatusUpdate {
  threadId: string;
  kind: "running" | "clear";
  activity?: "contextCompaction";
  label: string | null;
  detail: string | null;
  detailMode: "replace" | "append" | null;
}

export interface AppServerTurnLifecycleEvent {
  threadId: string;
  turnId: string;
  kind: "started" | "completed";
  terminalState?: "completed" | "failed" | "interrupted";
  error?: string;
}

export type {
  AppServerThreadGoal,
  AppServerThreadGoalStatus,
  ThreadGoalPatch
} from "./goal-api.js";

export interface AppServerErrorEvent {
  threadId: string;
  turnId?: string;
  stage: "stream" | "error";
  message: string;
  retrying?: boolean;
}

export type { CodexQueuedSubmission } from "./queue-api.js";
export type AppServerHistoryMessage = {
  role: "user" | "assistant";
  text: string;
  turnId: string;
  itemId: string;
};

export interface AppServerThreadStatus {
  threadId: string;
  cwd: string | null;
  threadName: string | null;
  model: string | null;
  modelProvider: string | null;
  serviceTier: string | null;
  serviceTierKnown?: boolean;
  approvalPolicy: string | null;
  sandboxMode: string | null;
  reasoningEffort: string | null;
  activity: "running" | "idle" | "unknown";
  activityType: string | null;
  contextLeftPercent: number | null;
  contextUsedTokens: number | null;
  contextMaxTokens: number | null;
}

export interface AppServerAccountStatus {
  email: string | null;
  plan: string | null;
}

export interface AppServerRateLimitWindow {
  label: string | null;
  windowDurationMins: number | null;
  usedPercent: number | null;
  leftPercent: number | null;
  resetsAt: number | null;
}

export interface AppServerRateLimitBucket {
  limitId: string;
  limitName: string | null;
  planType: string | null;
  primary: AppServerRateLimitWindow | null;
  secondary: AppServerRateLimitWindow | null;
}

export interface AppServerRateLimitsStatus extends AppServerRateLimitBucket {
  byLimitId: Record<string, AppServerRateLimitBucket>;
  resetCreditsAvailable: number | null;
}

export interface AppServerAccountUsageStatus {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

export interface AppServerWorkspaceMessagesStatus {
  featureEnabled: boolean | null;
  activeCount: number;
  latest: {
    type: string | null;
    body: string;
    createdAt: number | null;
  } | null;
}

export type CodexTurnInputPart =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "mention"; name: string; path: string };

export interface AppServerModelInfo {
  id: string;
  displayName: string | null;
  description: string | null;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
  inputModalities: string[];
  serviceTiers: { id: string; name: string; description: string | null }[];
  defaultServiceTier: string | null;
  modelSpecialty: string | null;
  multiAgentVersion: string | null;
  availabilityMessage: string | null;
  upgradeInfo: { model: string | null; retirementAt: number | null } | null;
  supportsPersonality: boolean | null;
  isDefault: boolean;
}

export interface AppServerModelCatalog {
  defaultModel: string | null;
  availableCount: number;
  visibleModels: string[];
  models: AppServerModelInfo[];
}

export interface AppServerSkillsCatalog {
  total: number;
  enabled: number;
  groups: Array<{
    cwd: string | null;
    total: number;
    enabled: number;
  }>;
}

export interface AppServerMcpServerStatus {
  total: number;
  running: number;
  failed: number;
  unknown: number;
  error: string | null;
  servers: Array<{
    name: string;
    status: string | null;
    toolCount: number | null;
  }>;
}

export interface AppServerMcpStartupStatusEvent {
  name: string;
  status: string | null;
  error: string | null;
}

export interface AppServerLoadedThreadsStatus {
  total: number;
  activeLoaded: boolean;
}

export interface AppServerLoadedThreadsSnapshot {
  total: number;
  threadIds: string[];
}

export interface AppServerTokenUsageEvent {
  threadId: string;
  usedTokens: number | null;
  maxTokens: number | null;
  leftPercent: number | null;
}

export interface AppServerProgressEvent {
  threadId: string;
  turnId?: string;
  itemId?: string;
  label: string;
  toolName: string | null;
  action: string | null;
  target: string | null;
  input: string | null;
  changes: AppServerProgressFileChange[] | null;
  failed: boolean;
  text: string;
  completed?: boolean;
}

export interface AppServerProgressFileChange {
  path: string;
  type: string | null;
  added: number;
  removed: number;
  lineStatsAvailable: boolean;
  // Live preview only; phase aggregates must not persist raw code.
  diffPreview?: string;
}

export interface AppServerRuntimeInfo {
  userAgent: string | null;
  version: string | null;
  codexHome: string | null;
  platformFamily: string | null;
  platformOs: string | null;
}









export { extractRateLimitsStatus } from "./rate-limit-extractors.js";



















export class CodexAppServerClient {
  private readonly connection: AppServerConnection;
  private runtimeInfo: AppServerRuntimeInfo | null = null;
  private notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private approvalListeners = new Set<(request: AppServerApprovalRequest) => void>();
  private approvalTokens = new Map<string, { id: JsonRpcId; method: string }>();
  private approvalIds = new Map<JsonRpcId, string>();
  private readonly threadRuntimeState = new ThreadRuntimeState();
  private catalogApi: CodexCatalogApi | null = null;
  private goalApi: CodexGoalApi | null = null;
  private queueApi: CodexQueueApi | null = null;
  private threadApi: CodexThreadApi | null = null;
  private turnApi: CodexTurnApi | null = null;
  private threadListApi: CodexThreadListApi | null = null;
  private readonly authFilePath: string;
  private readonly authReconnect: AuthReconnectCoordinator;
  private readonly providerReconnect: ProviderReconnectCoordinator;

  constructor(private readonly config: AppConfig) {
    this.authFilePath = getCodexAuthFilePath();
    this.connection = new AppServerConnection({
      args: config.codexAppServerArgs,
      command: config.codexAppServerCommand,
      onDisconnected: ({ expected }) => this.handleConnectionLost(expected),
      onInitialized: (result) => this.handleInitialized(result),
      onNotification: (notification) => this.handleNotification(notification),
      onServerRequest: (request) => this.handleServerRequest(request),
      readEnvironment: readCodexEnvironment,
      transport: config.codexTransport
    });
    this.authReconnect = new AuthReconnectCoordinator({
      authFilePath: this.authFilePath,
      isIdle: () => this.threadRuntimeState.isIdle(),
      notifyReconnected: () => this.handleNotification({ method: "bridge/auth/reconnected", params: {} }),
      reconnect: async () => {
        await this.closeAppServer("Codex App Server reconnecting after login identity change.");
        await this.connect();
      },
      transport: config.codexTransport
    });
    this.providerReconnect = new ProviderReconnectCoordinator({
      isIdle: () => this.threadRuntimeState.isIdle(),
      notifyReconnected: () => this.handleNotification({
        method: "bridge/runtime/reconnected",
        params: { reason: "provider" }
      }),
      reconnect: async () => {
        await this.closeAppServer("Codex App Server reconnecting after provider configuration change.");
        await this.connect();
      }
    });
    this.catalogApi = this.createCatalogApi();
    this.threadListApi = this.createThreadListApi();
  }

  private createThreadListApi(): CodexThreadListApi {
    return new CodexThreadListApi({
      connect: () => this.connect(),
      request: (method, params) => this.request(method, params),
      requestKnownMethod: (method, params) => this.requestKnownMethod(method, params)
    });
  }

  private getThreadListApi(): CodexThreadListApi {
    return this.threadListApi ?? (this.threadListApi = this.createThreadListApi());
  }

  private createCatalogApi(): CodexCatalogApi {
    return new CodexCatalogApi({
      connect: () => this.connect(),
      request: (method, params, options) => this.request(method, params, options),
      requestKnownMethod: (method, params, options) =>
        this.requestKnownMethod(method as AppServerKnownMethod, params, options)
    });
  }

  private getCatalogApi(): CodexCatalogApi {
    return this.catalogApi ?? (this.catalogApi = this.createCatalogApi());
  }

  private createGoalApi(): CodexGoalApi {
    return new CodexGoalApi({
      connect: () => this.connect(),
      requestKnownMethod: (method, params, options) => this.requestKnownMethod(method, params, options)
    });
  }

  private getGoalApi(): CodexGoalApi {
    return this.goalApi ?? (this.goalApi = this.createGoalApi());
  }

  private createQueueApi(): CodexQueueApi {
    return new CodexQueueApi({
      connect: () => this.connect(),
      requestKnownMethod: (method, params, options) => this.requestKnownMethod(method, params, options)
    });
  }

  private getQueueApi(): CodexQueueApi {
    return this.queueApi ?? (this.queueApi = this.createQueueApi());
  }

  private createThreadApi(): CodexThreadApi {
    return new CodexThreadApi({
      connect: () => this.connect(),
      getObservedThreadSettings: (threadId) => this.threadRuntimeState.getObservedSettings(threadId),
      isUnknownMethodError: (error, method) => this.isUnknownMethodError(error, method),
      rememberThreadSettings: (threadId, result) => this.rememberThreadSettings(threadId, result),
      request: (method, params, options) => this.request(method, params, options),
      requestKnownMethod: (method, params, options) => this.requestKnownMethod(
        method as AppServerKnownMethod,
        params,
        options
      )
    });
  }

  private getThreadApi(): CodexThreadApi {
    return this.threadApi ?? (this.threadApi = this.createThreadApi());
  }

  private createTurnApi(): CodexTurnApi {
    return new CodexTurnApi({
      connect: () => this.connect(),
      getObservedThreadSettings: (threadId) => this.threadRuntimeState.getObservedSettings(threadId),
      onTurnStartBeginning: () => this.handleTurnStartBeginning(),
      onTurnStarted: (turnId) => this.threadRuntimeState.trackTurnLifecycle("started", turnId),
      onTurnStartFinished: () => this.handleTurnStartFinished(),
      readCodexConfigSnapshot: (cwd) => this.readCodexConfigSnapshot(cwd),
      request: (method, params, options) => this.request(method, params, options),
      requestKnownMethod: (method, params, options) => this.requestKnownMethod(method, params, options),
      resumeThread: (threadId, cwd, assertCurrent) => this.resumeThread(threadId, cwd, assertCurrent),
      updateObservedThreadSettingsAfterStart: (threadId, observed, result) =>
        this.updateObservedThreadSettingsAfterStart(threadId, observed, result)
    });
  }

  private getTurnApi(): CodexTurnApi {
    return this.turnApi ?? (this.turnApi = this.createTurnApi());
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onApprovalRequest(listener: (request: AppServerApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  listKnownMethods(filter?: {
    kind?: AppServerMethodKind;
    group?: AppServerMethodGroup;
    status?: AppServerMethodStatus;
  }): AppServerMethodCapability[] {
    return listAppServerMethodCapabilities(filter);
  }

  getKnownMethodCapability(method: string): AppServerMethodCapability | null {
    return getAppServerMethodCapability(method);
  }

  getRuntimeInfo(): AppServerRuntimeInfo | null {
    return this.runtimeInfo;
  }

  async requestKnownMethod(
    method: AppServerKnownMethod,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    if (!isKnownAppServerMethod(method)) {
      throw new Error(`${method} is not registered as an app-server method.`);
    }
    const capability = getAppServerMethodCapability(method);
    if (capability?.kind !== "request") {
      throw new Error(`${method} is not a client request method.`);
    }
    return this.request(method, params, options);
  }

  async connect(): Promise<void> {
    if (this.connection.isConnected()) {
      return;
    }

    this.authReconnect.start();
    await this.connection.connect();
  }

  async close(): Promise<void> {
    this.authReconnect.stop();
    await this.closeAppServer("Codex App Server was closed.");
  }

  private async closeAppServer(reason: string): Promise<void> {
    if (!this.connection.isConnected()) {
      return;
    }
    await this.connection.close(reason);
  }

  async resumeThread(threadId: string, cwd?: string, assertCurrent?: () => void, timeoutMs?: number): Promise<{
    displayPath: string | null;
    messages: Array<{
      role: "user" | "assistant" | "system";
      text: string;
    }>;
  }> {
    return this.getThreadApi().resumeThread(threadId, cwd, assertCurrent, timeoutMs);
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeStatus> {
    return this.getThreadApi().unsubscribeThread(threadId);
  }

  async listRecentThreadMessages(
    threadId: string,
    maxMessages = 5
  ): Promise<AppServerHistoryMessage[]> {
    return this.getThreadApi().listRecentThreadMessages(threadId, maxMessages);
  }

  async listRecentThreadHistory(
    threadId: string,
    maxTurns = 2
  ): Promise<ThreadHistoryEntry[]> {
    return this.getThreadApi().listRecentThreadHistory(threadId, maxTurns);
  }

  async startThread(cwd: string): Promise<{ threadId: string }> {
    await this.connect();
    let snapshot = await this.readCodexConfigSnapshot(cwd);
    const params = {
      cwd,
      serviceName: this.config.codexServiceName
    } satisfies Record<string, unknown>;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      logger.info("codex.thread.start", {
        cwd,
        model: snapshot.model,
        modelProvider: snapshot.modelProvider,
        configLayers: snapshot.layerVersions.length,
        attempt: attempt + 1
      });
      const result = asRecord(
        await this.request("thread/start", params)
      );
      const thread = asRecord(result?.thread);
      const threadId = firstString(
        thread?.id,
        result?.conversationId,
        asRecord(result?.conversation)?.id,
        result?.id
      );
      if (!threadId) {
        throw new Error("thread start did not return a thread id.");
      }
      const threadStatus = extractThreadStatus(result, threadId);
      const threadProvider = threadStatus.modelProvider ?? this.getObservedThreadProvider(threadId);
      if (snapshot.modelProvider && threadProvider && snapshot.modelProvider !== threadProvider) {
        if (attempt === 0) {
          logger.warn("codex.thread.provider_mismatch", {
            cwd,
            configProvider: snapshot.modelProvider,
            threadProvider,
            action: "reconnect_and_retry"
          });
          this.providerReconnect.markPending();
          await this.providerReconnect.reconnectWhenIdle();
          snapshot = await this.readCodexConfigSnapshot(cwd);
          continue;
        }
        throw new Error(
          `Codex provider mismatch after thread start: config=${snapshot.modelProvider}, thread=${threadProvider}.`
        );
      }
      this.rememberThreadSettings(threadId, result);
      return { threadId };
    }

    throw new Error("Codex thread start retry was exhausted.");
  }

  async interruptThread(threadId: string, turnId?: string | null): Promise<void> {
    return this.getTurnApi().interruptThread(threadId, turnId);
  }

  async readThreadStatus(threadId: string, cwd?: string, options?: { readOnly?: boolean; timeoutMs?: number }): Promise<AppServerThreadStatus> {
    return this.getThreadApi().readThreadStatus(threadId, cwd, options);
  }

  getObservedThreadModel(threadId: string): string | null {
    return this.threadRuntimeState.getObservedModel(threadId);
  }

  getObservedThreadProvider(threadId: string): string | null {
    return this.threadRuntimeState.getObservedProvider(threadId);
  }

  private rememberThreadSettings(threadId: string, result: unknown): void {
    const status = extractThreadStatus(result, threadId);
    if (!status.model && !status.modelProvider && !status.reasoningEffort && !status.serviceTier) return;
    this.threadRuntimeState.rememberSettings(threadId, status);
  }

  private handleTurnStartBeginning(): void {
    this.threadRuntimeState.beginTurnStart();
  }

  private handleTurnStartFinished(): void {
    this.threadRuntimeState.finishTurnStart();
    this.authReconnect.handleTurnCompleted();
  }

  private updateObservedThreadSettingsAfterStart(
    threadId: string,
    observed: AppServerThreadStatus | undefined,
    result: unknown
  ): void {
    const tier = asRecord(asRecord(result)?.turn)?.serviceTier;
    this.threadRuntimeState.updateObservedServiceTier(threadId, observed, tier);
  }

  async readCodexConfigSnapshot(cwd: string): Promise<CodexConfigSnapshot> {
    await this.connect();
    logger.info("codex.config.snapshot", { cwd });
    const result = await this.requestKnownMethod(
      "config/read",
      { cwd, includeLayers: true },
      { timeoutMs: 3_000 }
    );
    const snapshot = extractCodexConfigSnapshot(result, cwd);
    if (this.providerReconnect.observe(cwd, snapshot.modelProvider)) {
      if (this.threadRuntimeState.isIdle()) {
        await this.providerReconnect.reconnectWhenIdle();
        const refreshed = await this.requestKnownMethod(
          "config/read",
          { cwd, includeLayers: true },
          { timeoutMs: 3_000 }
        );
        const refreshedSnapshot = extractCodexConfigSnapshot(refreshed, cwd);
        this.providerReconnect.observe(cwd, refreshedSnapshot.modelProvider);
        return refreshedSnapshot;
      }
    }
    return snapshot;
  }

  async readAccountStatus(): Promise<AppServerAccountStatus | null> {
    return this.getCatalogApi().readAccountStatus();
  }

  async readRateLimitsStatus(): Promise<AppServerRateLimitsStatus | null> {
    return this.getCatalogApi().readRateLimitsStatus();
  }

  async readAccountUsageStatus(): Promise<AppServerAccountUsageStatus | null> {
    return this.getCatalogApi().readAccountUsageStatus();
  }

  async readWorkspaceMessagesStatus(): Promise<AppServerWorkspaceMessagesStatus | null> {
    return this.getCatalogApi().readWorkspaceMessagesStatus();
  }

  async readModelCatalog(): Promise<AppServerModelCatalog | null> {
    return this.getCatalogApi().readModelCatalog();
  }

  async startCompactThread(threadId: string): Promise<void> {
    return this.getCatalogApi().startCompactThread(threadId);
  }

  async readSkillsCatalog(): Promise<AppServerSkillsCatalog | null> {
    return this.getCatalogApi().readSkillsCatalog();
  }

  async readMcpServerStatus(): Promise<AppServerMcpServerStatus | null> {
    return this.getCatalogApi().readMcpServerStatus();
  }

  async readLoadedThreadsStatus(threadId: string): Promise<AppServerLoadedThreadsStatus | null> {
    return this.getCatalogApi().readLoadedThreadsStatus(threadId);
  }

  async readLoadedThreads(): Promise<AppServerLoadedThreadsSnapshot | null> {
    return this.getCatalogApi().readLoadedThreads();
  }

  async sendTurn(
    threadId: string,
    text: string,
    cwd: string,
    options?: SendTurnOptions
  ): Promise<{ turnId: string | null }> {
    return this.getTurnApi().sendTurn(threadId, text, cwd, options);
  }

  async addQueuedSubmission(threadId: string, input: CodexTurnInputPart[], clientUserMessageId: string): Promise<CodexQueuedSubmission> {
    return this.getQueueApi().addQueuedSubmission(threadId, input, clientUserMessageId);
  }

  async listQueuedSubmissions(threadId: string): Promise<CodexQueuedSubmission[]> {
    return this.getQueueApi().listQueuedSubmissions(threadId);
  }

  async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string): Promise<boolean> {
    return this.getQueueApi().deleteQueuedSubmission(threadId, queuedSubmissionId);
  }

  async readThreadGoal(threadId: string): Promise<AppServerThreadGoal | null> {
    return this.getGoalApi().readThreadGoal(threadId);
  }

  async updateThreadGoal(
    threadId: string,
    patch: ThreadGoalPatch
  ): Promise<AppServerThreadGoal> {
    return this.getGoalApi().updateThreadGoal(threadId, patch);
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    return this.getGoalApi().clearThreadGoal(threadId);
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    text: string,
    inputParts?: CodexTurnInputPart[],
    assertCurrent?: () => void,
    timeoutMs?: number
  ): Promise<{ turnId: string | null }> {
    return this.getTurnApi().steerTurn(threadId, turnId, text, inputParts, assertCurrent, timeoutMs);
  }

  async listThreadsForCwd(cwd?: string, options?: Omit<ThreadListOptions, "archived">): Promise<
    ListedCodexThread[]
  > {
    return this.getThreadListApi().listThreadsForCwd(cwd, options);
  }

  async listArchivedThreadsForCwd(cwd?: string, options?: Omit<ThreadListOptions, "archived">): Promise<
    ListedCodexThread[]
  > {
    return this.getThreadListApi().listArchivedThreadsForCwd(cwd, options);
  }

  async archiveThread(threadId: string): Promise<void> {
    return this.getThreadListApi().archiveThread(threadId);
  }

  async unarchiveThread(threadId: string): Promise<void> {
    return this.getThreadListApi().unarchiveThread(threadId);
  }

  async deleteThread(threadId: string): Promise<void> {
    return this.getThreadListApi().deleteThread(threadId);
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    return this.getThreadListApi().setThreadName(threadId, name);
  }

  isApprovalPending(requestId: string): boolean {
    return this.connection.isInitialized() && this.approvalTokens.has(requestId);
  }

  async resolveApproval(
    requestId: string,
    action: DecisionAction,
    method: AppServerApprovalRequest["method"] | string | null,
    content?: Record<string, unknown> | null
  ): Promise<void> {
    const approval = this.approvalTokens.get(requestId);
    if (!approval || approval.method !== method || !this.connection.isInitialized()) {
      throw new Error("This approval is no longer active on the original connection.");
    }
    const result =
      method === "mcpServer/elicitation/request"
        ? action === "cancel"
          ? { action: "cancel", content: null, _meta: null }
          : action === "decline"
            ? { action: "decline", content: null, _meta: null }
            : { action: "accept", content: content ?? null, _meta: null }
        : method === "item/commandExecution/requestApproval" ||
            method === "item/fileChange/requestApproval"
          ? {
              decision:
                action === "accept"
                  ? "accept"
                  : action === "acceptForSession"
                    ? "acceptForSession"
                    : action === "acceptWithExecpolicyAmendment"
                      ? {
                          acceptWithExecpolicyAmendment: {
                            execpolicy_amendment:
                              Array.isArray(content?.execpolicyAmendment) &&
                              content.execpolicyAmendment.every((item) => typeof item === "string")
                                ? content.execpolicyAmendment
                                : []
                          }
                        }
                    : action === "cancel"
                      ? "cancel"
                      : "decline"
            }
          : method === "item/permissions/requestApproval"
            ? {
                permissions:
                  action === "accept" || action === "acceptForSession"
                    ? extractRequestedPermissions(content)
                    : {},
                scope: action === "acceptForSession" ? "session" : "turn"
              }
            : action;
    logger.info("codex.approval.resolve", { requestId, action, method, result });
    this.approvalTokens.delete(requestId);
    await this.connection.sendResponse(approval.id, result);
  }

  private handleInitialized(result: unknown): void {
    this.runtimeInfo = parseRuntimeInfo(result);
    logger.info("codex.initialize.runtime", {
      version: this.runtimeInfo.version,
      userAgent: this.runtimeInfo.userAgent,
      codexHome: this.runtimeInfo.codexHome,
      platformFamily: this.runtimeInfo.platformFamily,
      platformOs: this.runtimeInfo.platformOs
    });
  }

  private handleConnectionLost(expected: boolean): void {
    this.approvalTokens.clear();
    this.approvalIds.clear();
    this.threadRuntimeState.handleConnectionLost(expected);
    this.handleNotification({ method: "bridge/connection/lost", params: { expected } });
  }

  private isUnknownMethodError(error: unknown, method: string): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("unknown variant") &&
      (message.includes(`\`${method}\``) || message.includes(`'${method}'`) || message.includes(method))
    );
  }

  private async request(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    return this.connection.request(method, params, options);
  }

  private handleNotification(notification: AppServerNotification): void {
    if (notification.method === "thread/settings/updated") {
      const params = asRecord(notification.params);
      const settings = asRecord(params?.threadSettings);
      const threadId = firstString(params?.threadId);
      if (threadId && settings) this.rememberThreadSettings(threadId, {
        ...settings, reasoningEffort: settings.effort, sandbox: settings.sandboxPolicy
      });
    }
    if (notification.method === "model/rerouted") {
      const params = asRecord(notification.params);
      const threadId = firstString(params?.threadId);
      const model = firstString(params?.toModel);
      if (threadId && model) this.threadRuntimeState.updateObservedModel(threadId, model);
    }
    if (notification.method === "serverRequest/resolved") {
      const p = asRecord(notification.params);
      const rawId = p?.requestId as JsonRpcId;
      const token = this.approvalIds.get(rawId);
      if (token) {
        this.approvalTokens.delete(token);
        this.approvalIds.delete(rawId);
        notification = { ...notification, params: { ...p, requestId: token } };
      }
    }
    const lifecycle = extractTurnLifecycleEvent(notification);
    if (lifecycle) {
      this.threadRuntimeState.trackTurnLifecycle(lifecycle.kind, lifecycle.turnId);
    }
    logger.info("codex.notification", { method: notification.method });
    for (const listener of this.notificationListeners) {
      listener(notification);
    }
    if (lifecycle?.kind === "completed") {
      this.authReconnect.handleTurnCompleted();
      this.providerReconnect.handleTurnCompleted();
    }
  }

  private handleServerRequest(request: AppServerServerRequest): void {
    if (
      request.method === "mcpServer/elicitation/request" ||
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval"
    ) {
      const params = asRecord(request.params) ?? {};
      const threadId = firstString(
        params.threadId,
        params.conversationId,
        params.sessionId
      );
      if (!threadId) {
        logger.warn("codex.approval.request_missing_thread", {
          id: request.id,
          method: request.method,
          params
        });
        return;
      }

      const approval: AppServerApprovalRequest = {
        requestId: randomUUID(),
        threadId,
        turnId: firstString(params.turnId) ?? null,
        itemId: firstString(params.itemId) ?? null,
        method: request.method as AppServerApprovalRequest["method"],
        title: buildApprovalTitle(request.method, params),
        summary: buildApprovalSummary(request.method, params),
        requestedFields:
          request.method === "mcpServer/elicitation/request"
            ? extractRequestedFieldNames(params)
            : [],
        requiresUserInput:
          request.method === "mcpServer/elicitation/request"
            ? mcpRequestRequiresUserInput(params)
            : false,
        elicitationMode:
          request.method === "mcpServer/elicitation/request"
            ? firstString(params.mode) ?? null
            : null
      };

      const previous = this.approvalIds.get(request.id);
      if (previous) return;
      this.approvalTokens.set(approval.requestId, { id: request.id, method: request.method });
      this.approvalIds.set(request.id, approval.requestId);
      logger.info("codex.approval.request", {
        requestId: approval.requestId,
        threadId: approval.threadId,
        method: approval.method,
        title: approval.title,
        summary: approval.summary,
        paramsKeys: Object.keys(params).filter((key) =>
          !["challenge", "signature", "proof"].includes(key.toLowerCase())
        )
      });
      if (request.method === "item/fileChange/requestApproval") {
        logger.info("codex.approval.file_change.params", {
          requestId: approval.requestId,
          threadId: approval.threadId,
          params
        });
      }

      for (const listener of this.approvalListeners) {
        listener(approval);
      }
      return;
    }

    logger.warn("codex.server_request.unhandled", {
      id: request.id,
      method: request.method
    });
    void this.connection.sendResponse(request.id, "cancel");
  }

}
