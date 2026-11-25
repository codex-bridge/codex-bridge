import type { AppServerStatusUpdate, CodexAppServerClient } from "../../codex/client.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { createActivityMessage, createMessage, messageContextForSession } from "../messages/factory.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";
import type { BridgeMessageOptions } from "../transport.js";
import type { SessionOwnershipService } from "./ownership.js";
import type { WorkflowAppend } from "../progress/workflow-sequence.js";
import type { WorkingUpdate } from "../status/working-window.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";
import { formatDuration } from "../../shared/duration.js";
import { classifyMessageEditError } from "../messages/edit-result.js";
import { logger } from "../../logging/logger.js";

export type CompactEventSource = "manual" | "bridge-auto" | "runtime";

type CompactEventState = {
  completedAt: number | null;
  completedNotified: boolean;
  source: CompactEventSource;
  startedAt: number | null;
  startedNotified: boolean;
  reason?: string;
  message: { sourceId: string; messageId: string } | null;
  attemptedSource: string | null;
};

type RecoveryState = {
  originalText: string;
  phase: "compacting" | "retrying";
};

type CompactStore = Pick<BridgeStore, "getActiveSession" | "getSessionById">;
type CompactClient = Pick<CodexAppServerClient, "sendTurn" | "startCompactThread" | "resumeThread">;

export type CompactServiceDependencies = {
  appendWorkflowMessage: WorkflowAppend;
  store: CompactStore;
  codexClient: CompactClient;
  isRuntimeConnected: () => boolean;
  getLastUserInput: (sessionId: string) => string | undefined;
  getSessionDirectory: (session: SessionRecord) => string;
  formatCompactTokenCount: (threadId: string) => string;
  isMissingRuntimeThreadError: (error: unknown) => boolean;
  resumeThread: (threadId: string, cwd?: string) => Promise<{ displayPath: string | null; messages: unknown[] }>;
  rememberNotificationSession: (session: SessionRecord) => void;
  setSessionStatus: (session: SessionRecord, label: string, update?: WorkingUpdate) => Promise<void>;
  sendSystemErrorMessage: (session: SessionRecord, stage: "stream" | "error", message: string) => Promise<void>;
  sendMessageSpec: (chatId: string, messageSpec: MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<{ message_id: string } | null>;
  editMessageSpec: (chatId: string, messageId: string, messageSpec: MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<boolean>;
};

export type SessionCompactDependencies = {
  store: Pick<BridgeStore, "getActiveSession">;
  compactService: CompactService;
  sessionOwnershipService: SessionOwnershipService;
};

export class CompactService {
  private readonly compactEventsByThread = new Map<string, CompactEventState>();
  private readonly sessionRecovery = new Map<string, RecoveryState>();
  private readonly deliveries = new KeyedQueue();
  private readonly manualResults = new WeakMap<MessageSpec, CompactEventState>();

  constructor(private readonly deps: CompactServiceDependencies) {}

  async compactActiveSession(telegramChatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!this.deps.isRuntimeConnected()) return this.errorResult(session, "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    if (!session) return this.errorResult(null, "No active session to compact.");
    return this.compactSession(session);
  }

  async compactSession(session: SessionRecord): Promise<MessageSpec> {
    if (!this.deps.isRuntimeConnected()) return this.errorResult(session, "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    this.deps.rememberNotificationSession(session);
    await this.deps.setSessionStatus(session, "Compacting", { immediate: true });

    const threadId = session.codexThreadId;
    const currentCwd = this.deps.getSessionDirectory(session);
    let resumeWarning: string | null = null;
    try {
      await this.deps.resumeThread(threadId, currentCwd);
    } catch (resumeErr) {
      if (this.deps.isMissingRuntimeThreadError(resumeErr)) {
        const resumeMessage = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        this.compactEventsByThread.delete(threadId);
        await this.deps.setSessionStatus(session, "Compact failed", { immediate: true });
        return this.errorResult(session, `Compact failed.\n${resumeMessage}`);
      }
      resumeWarning = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
    }

    try {
      // Reserve the start before the RPC: its runtime notification can arrive before
      // the RPC reply. The returned manual result owns this start message.
      this.markCompactStarted(session, "manual");
      await this.deps.codexClient.startCompactThread(threadId);
      return this.startedResult(session, "manual");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (resumeWarning || this.deps.isMissingRuntimeThreadError(error)) {
        const fallbackReason = resumeWarning
          ? `\nResume warning: ${resumeWarning}`
          : "";
        this.compactEventsByThread.delete(threadId);
        await this.deps.setSessionStatus(session, "Compact failed", { immediate: true });
        return this.errorResult(session, `Compact failed.\n${message}${fallbackReason}`);
      }
      this.compactEventsByThread.delete(session.codexThreadId);
      await this.deps.setSessionStatus(session, "Compact failed", { immediate: true });
      return this.errorResult(session, `Compact failed.\n${message}`);
    }
  }

  /** Compact owns its send receipt; the caller delivers errors and ownership prompts. */
  async deliverResult(sourceId: string, message: MessageSpec, deliverFallback: () => Promise<void>): Promise<void> {
    if (message.kind !== "compact-started" || !message.session?.id) return deliverFallback();
    const session = await this.deps.store.getSessionById(message.session.id);
    const state = this.manualResults.get(message);
    if (!session || !state || state.completedAt !== null || this.compactEventsByThread.get(session.codexThreadId) !== state) return;
    await this.deliveries.run(session.codexThreadId, async () => {
      if (state.completedAt !== null || state.attemptedSource === sourceId) return;
      await this.deps.appendWorkflowMessage(session, () => this.sendActivity(sourceId, message, state), { sourceId });
    });
  }

  markCompactStarted(session: SessionRecord, source: CompactEventSource): boolean {
    const existing = this.compactEventsByThread.get(session.codexThreadId);
    if (existing?.startedNotified && existing.completedAt === null) return false;
    this.compactEventsByThread.set(session.codexThreadId, {
      completedAt: null,
      completedNotified: false,
      source,
      startedAt: Date.now(),
      startedNotified: true,
      message: null,
      attemptedSource: null
    });
    return true;
  }

  async notifyCompactStarted(session: SessionRecord, source: CompactEventSource, options?: { reason?: string; next?: string }): Promise<void> {
    if (!this.markCompactStarted(session, source)) return;
    const state = this.compactEventsByThread.get(session.codexThreadId)!;
    state.reason = options?.reason;
    await this.deliveries.run(session.codexThreadId, () => this.deps.appendWorkflowMessage(session,
      () => this.sendActivity(session.telegramChatId, this.startedSpec(session, source, options), state)));
  }

  renderCompactStartedMessage(session: SessionRecord, source: CompactEventSource, options?: { reason?: string; next?: string }): string {
    // COMPATIBILITY(MESSAGE_FACTORY): keep the string compact renderer for legacy callers.
    return renderLegacyMessage(this.startedSpec(session, source, options));
  }

  async notifyCompactCompleted(session: SessionRecord, options?: { next?: string }): Promise<void> {
    const state: CompactEventState = this.compactEventsByThread.get(session.codexThreadId) ?? {
      completedAt: null, completedNotified: false, source: "runtime", startedAt: null,
      startedNotified: false, message: null, attemptedSource: null
    };
    if (state.completedNotified) return;
    const firstCompletion = state.completedAt === null;
    state.completedAt ??= Date.now();
    state.completedNotified = true;
    this.compactEventsByThread.set(session.codexThreadId, state);
    const messageSpec = createActivityMessage({
      kind: "compact-completed",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        ...(state.startedNotified ? [{ type: "text" as const, text: this.triggeredBy(state.source) }] : []),
        ...(state.reason ? [{ type: "field" as const, label: "Reason", value: state.reason }] : []),
        ...(state.startedAt !== null ? [{ type: "text" as const, text: `Elapsed ${formatDuration(state.completedAt - state.startedAt)}` }] : []),
        ...(options?.next ? [{ type: "field" as const, label: "Next", value: options.next }] : [])
      ]
    });
    const deliver = async () => {
      const sourceId = session.telegramChatId;
      if (state.message?.sourceId === sourceId) {
        try {
          if (await this.deps.editMessageSpec(sourceId, state.message.messageId, messageSpec, { disable_notification: true })) return;
          logger.warn("bridge.compact.edit_unavailable", { threadId: session.codexThreadId });
          return;
        } catch (error) {
          const result = classifyMessageEditError(error);
          if (result === "synced") return;
          if (result !== "missing") {
            state.completedNotified = result !== "retryable";
            logger.warn("bridge.compact.edit_failed", { threadId: session.codexThreadId, result });
            return;
          }
          state.message = null;
          state.attemptedSource = null;
        }
      }
      await this.sendActivity(sourceId, messageSpec, state);
    };
    await this.deliveries.run(session.codexThreadId, () => firstCompletion
      ? this.deps.appendWorkflowMessage(session, deliver) : deliver());
  }

  private async sendActivity(sourceId: string, message: MessageSpec, state: CompactEventState): Promise<void> {
    if (state.attemptedSource === sourceId) return;
    // A missing receipt can mean an unknown send outcome; never duplicate it.
    state.attemptedSource = sourceId;
    const sent = await this.deps.sendMessageSpec(sourceId, message, { disable_notification: true });
    if (sent) state.message = { sourceId, messageId: sent.message_id };
    else logger.warn("bridge.compact.send_unknown", { sourceId });
  }

  private triggeredBy(source: CompactEventSource): string {
    return `Triggered by ${source === "manual" ? "you" : source === "bridge-auto" ? "Bridge" : "Codex"}`;
  }

  isCompactStatusUpdate(update: AppServerStatusUpdate): boolean {
    return update.activity === "contextCompaction" ||
      /\bcompact(?:ing|ed)?\b/.test(`${update.label ?? ""}\n${update.detail ?? ""}`.toLowerCase());
  }

  async handleIncompatibleHistoryError(session: SessionRecord, errorMessage: string): Promise<void> {
    const existingRecovery = this.sessionRecovery.get(session.id);
    if (existingRecovery?.phase === "retrying") {
      this.sessionRecovery.delete(session.id);
      await this.deps.sendSystemErrorMessage(session, "error", `Auto-compact retry failed.\n${errorMessage}`);
      return;
    }
    if (existingRecovery?.phase === "compacting") return;
    const originalText = this.deps.getLastUserInput(session.id);
    if (!originalText) {
      await this.deps.sendSystemErrorMessage(session, "error", errorMessage);
      return;
    }
    this.sessionRecovery.set(session.id, { originalText, phase: "compacting" });
    await this.deps.setSessionStatus(session, `Compacting${this.deps.formatCompactTokenCount(session.codexThreadId)}`, { immediate: true });
    await this.notifyCompactStarted(session, "bridge-auto", {
      reason: "incompatible history",
      next: "retrying your last message once"
    });
    await this.deps.codexClient.sendTurn(session.codexThreadId, "compact", this.deps.getSessionDirectory(session));
  }

  async handleRecoveryTaskComplete(session: SessionRecord): Promise<boolean> {
    const recovery = this.sessionRecovery.get(session.id);
    if (!recovery || recovery.phase !== "compacting") {
      if (recovery?.phase === "retrying") this.sessionRecovery.delete(session.id);
      return false;
    }
    this.sessionRecovery.set(session.id, { originalText: recovery.originalText, phase: "retrying" });
    await this.deps.setSessionStatus(session, "Retrying", { immediate: true });
    await this.notifyCompactCompleted(session, { next: "Retrying last message" });
    await this.deps.codexClient.sendTurn(session.codexThreadId, recovery.originalText, this.deps.getSessionDirectory(session));
    return true;
  }

  clearRetryingRecovery(sessionId: string): void {
    if (this.sessionRecovery.get(sessionId)?.phase === "retrying") this.sessionRecovery.delete(sessionId);
  }

  private startedResult(session: SessionRecord, source: CompactEventSource, prefix?: string): MessageSpec {
    const message = this.startedSpec(session, source, undefined, prefix);
    const state = this.compactEventsByThread.get(session.codexThreadId);
    if (state) this.manualResults.set(message, state);
    return message;
  }

  private startedSpec(
    session: SessionRecord,
    source: CompactEventSource,
    options?: { reason?: string; next?: string },
    prefix?: string
  ): MessageSpec {
    return createActivityMessage({
      kind: "compact-started",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        ...(prefix ? [{ type: "text" as const, text: prefix }] : []),
        { type: "text", text: this.triggeredBy(source) },
        ...(options?.reason ? [{ type: "field" as const, label: "Reason", value: options.reason }] : []),
        ...(options?.next ? [{ type: "field" as const, label: "Next", value: options.next }] : [])
      ]
    });
  }

  private errorResult(session: SessionRecord | null, text: string): MessageSpec {
    return createMessage({
      kind: "error",
      ...messageContextForSession(session ? { id: session.id, directory: this.deps.getSessionDirectory(session) } : null),
      body: [{ type: "text", text }]
    });
  }
}

export class SessionCompactService {
  constructor(private readonly deps: SessionCompactDependencies) {}

  async compact(chatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(chatId);
    if (session) {
      const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (ownershipPrompt) return ownershipPrompt;
    }
    return this.deps.compactService.compactActiveSession(chatId);
  }
}
