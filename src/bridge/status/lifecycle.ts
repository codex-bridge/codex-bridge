import type { AppServerErrorEvent, AppServerStatusUpdate } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { actionRow, interruptAction, messageAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import { classifyMessageEditError, type MessageEditResult } from "../messages/edit-result.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";
import { formatStatusDetailPreview } from "../renderers/progress.js";
import { formatElapsed } from "./formatters.js";
import type { BridgeMessageOptions, MessageRefreshPolicy } from "../transport.js";

type StatusEntry = { messageId: string; text: string };

export type StatusLifecycleDependencies = {
  getRefreshPolicy?: (sourceId: string) => MessageRefreshPolicy | undefined;
  waitForBackgroundRefresh?: (sourceId: string, sessionId: string, signal: AbortSignal) => Promise<boolean>;
  isThreadBusy?: (threadId: string) => boolean;
  waitForThreadIdle?: (threadId: string, signal: AbortSignal) => Promise<boolean>;
  store: Pick<BridgeStore, "countPendingQueuedSubmissions" | "getSessionById">;
  statusMessageBySession: Map<string, StatusEntry>;
  statusStartedAtBySession: Map<string, number>;
  statusLabelBySession: Map<string, string>;
  statusDetailBySession: Map<string, string>;
  statusLastEditAtBySession: Map<string, number>;
  statusOpBySession: Map<string, Promise<void>>;
  sendMessageSpec: (chatId: string, messageSpec: MessageSpec, options?: BridgeMessageOptions) => Promise<{ message_id: string } | null>;
  editMessageSpec: (chatId: string, messageId: string, messageSpec: MessageSpec, options?: BridgeMessageOptions) => Promise<boolean>;
  getSessionDirectory: (session: SessionRecord) => string;
  isCompactStatusUpdate: (update: AppServerStatusUpdate) => boolean;
  notifyCompactStarted: (session: SessionRecord, source: "runtime") => Promise<void>;
  clearTypingState: (sessionId: string) => void;
  sendTypingOnce: (session: SessionRecord, canRefresh?: () => boolean) => Promise<void>;
};

export class StatusLifecycleService {
  private readonly pendingEdits = new Set<string>();
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly generations = new Map<string, object>();
  private readonly idleRefreshes = new Map<string, { revision: number; operation: (signal: AbortSignal) => Promise<void>; controller: AbortController; task: Promise<void> }>();
  private stopped = false;

  constructor(private readonly deps: StatusLifecycleDependencies) {}

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelRefreshes();
    await Promise.allSettled(this.deps.statusOpBySession.values());
    await Promise.allSettled([...this.idleRefreshes.values()].map(entry => entry.task));
  }

  async refreshSessionStatus(session: SessionRecord): Promise<void> {
    // A pending latest-state refresh already re-reads the queue count. Do not
    // replace its new label with the older label currently displayed on the card.
    if (this.idleRefreshes.has(session.id) || this.refreshTimers.has(session.id)) return;
    await this.setSessionStatus(session, this.deps.statusLabelBySession.get(session.id) ?? "Working");
  }

  async applyStatusUpdate(session: SessionRecord, update: AppServerStatusUpdate, canRefresh?: () => boolean): Promise<void> {
    if (update.kind === "clear") {
      this.deps.clearTypingState(session.id);
      await this.clearSessionStatus(session);
      return;
    }

    if (this.deps.isCompactStatusUpdate(update)) {
      await this.deps.notifyCompactStarted(session, "runtime");
    }
    if (canRefresh?.() === false) return;
    await this.setSessionStatus(session, update.label ?? "Working", undefined, canRefresh);
    // Typing is disposable and must never hold up chronological notifications.
    void this.deps.sendTypingOnce(session, canRefresh).catch(error => logger.warn("bridge.status.typing_failed", { error: String(error) }));
  }

  async setSessionStatus(
    session: SessionRecord,
    label: string,
    update?: Pick<AppServerStatusUpdate, "detail" | "detailMode">,
    canRefresh?: () => boolean,
    admissionSignal?: AbortSignal
  ): Promise<void> {
    if (this.stopped) return;
    const generation = this.generations.get(session.id) ?? {};
    this.generations.set(session.id, generation);
    const eligible = () => !admissionSignal?.aborted && this.generations.get(session.id) === generation && canRefresh?.() !== false;
    if (!eligible()) return;
    if (this.deps.waitForThreadIdle && this.deps.isThreadBusy?.(session.codexThreadId) && this.deps.statusMessageBySession.has(session.id)) {
      this.cancelRefresh(session.id);
      this.deferRefresh(session, async signal => { if (eligible()) await this.setSessionStatus(session, label, update, canRefresh, signal); });
      return;
    }
    return this.runSessionStatusOp(session.id, async () => {
      if (!eligible()) return;
      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(session.id) ?? now;
      this.deps.statusStartedAtBySession.set(session.id, startedAt);

      const previousLabel = this.deps.statusLabelBySession.get(session.id);
      const labelChanged = previousLabel !== label;
      const previousDetail = this.deps.statusDetailBySession.get(session.id) ?? "";
      const detail = label === "Thinking" ? "" : this.resolveStatusDetail(labelChanged ? "" : previousDetail, update);
      if (detail) this.deps.statusDetailBySession.set(session.id, detail);
      else this.deps.statusDetailBySession.delete(session.id);

      const detailChanged = detail !== previousDetail;
      const resolvedUpdate = { detail, detailMode: "replace" as const };
      const lastEditAt = this.deps.statusLastEditAtBySession.get(session.id) ?? 0;
      const existing = this.deps.statusMessageBySession.get(session.id);
      if (existing && (labelChanged || detailChanged)) this.pendingEdits.add(session.id);
      const interval = this.deps.getRefreshPolicy?.(session.telegramChatId)?.workingIntervalMs ?? 5_000;
      if (existing && now - lastEditAt < interval) {
        this.cancelRefresh(session.id);
        if (labelChanged || detailChanged || this.pendingEdits.has(session.id)) {
          const timer = setTimeout(() => {
            this.refreshTimers.delete(session.id);
            if (eligible()) void this.setSessionStatus(session, label, resolvedUpdate, canRefresh)
              .catch(error => logger.warn("bridge.status.refresh_failed", { sessionId: session.id, error: String(error) }));
          }, interval - (now - lastEditAt));
          timer.unref();
          this.refreshTimers.set(session.id, timer);
        }
        return;
      }
      if (existing && !labelChanged && !detailChanged && !this.pendingEdits.has(session.id)) return;
      this.cancelRefresh(session.id);
      if (existing && this.deps.getRefreshPolicy?.(session.telegramChatId) && this.deps.waitForBackgroundRefresh && !admissionSignal) {
        this.deferRefresh(session, signal => this.setSessionStatus(session, label, resolvedUpdate, canRefresh, signal));
        return;
      }

      const queueCount = await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId);
      const messageSpec = this.createSessionStatusMessageSpec(session, label, startedAt, now, detail, queueCount);
      const text = renderLegacyMessage(messageSpec);
      if (existing?.text === text && !this.pendingEdits.has(session.id)) return;

      if (existing) {
        let result: MessageEditResult;
        let postponed = false;
        try {
          result = await this.deps.editMessageSpec(session.telegramChatId, existing.messageId, messageSpec,
            { canSend: async () => eligible(), deliverySignal: admissionSignal,
              ...(admissionSignal ? { onRateDeferred: () => { postponed = true; } } : {}) })
            ? "synced" : "unavailable";
        } catch (error) {
          result = classifyMessageEditError(error);
          if (result !== "synced") logger.warn("bridge.status.edit_failed", {
            sessionId: session.id,
            messageId: existing.messageId,
            result,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        if (postponed) {
          this.deferRefresh(session, signal => this.setSessionStatus(session, label, resolvedUpdate, canRefresh, signal));
          return;
        }
        if (result === "synced") {
          this.rememberStatus(session.id, existing.messageId, text, label, now);
          return;
        }
        if (result !== "missing") {
          if (!eligible()) return;
          // Preserve the original ID and clock. Later status events retry the edit,
          // including an unchanged detail, without flooding on every streamed delta.
          this.pendingEdits.add(session.id);
          this.deps.statusLabelBySession.set(session.id, label);
          this.deps.statusLastEditAtBySession.set(session.id, now);
          return;
        }
        this.deps.statusMessageBySession.delete(session.id);
      }

      const sent = await this.deps.sendMessageSpec(session.telegramChatId, messageSpec,
        { disable_notification: true, canSend: async () => eligible() });
      if (sent) this.rememberStatus(session.id, sent.message_id, text, label, now);
    });
  }

  async clearSessionStatus(session: SessionRecord): Promise<void> {
    this.generations.delete(session.id);
    this.cancelRefresh(session.id);
    this.idleRefreshes.get(session.id)?.controller.abort();
    return this.runSessionStatusOp(session.id, async () => {
      const existing = this.deps.statusMessageBySession.get(session.id);
      if (!existing) return;

      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(session.id) ?? now;
      try {
        await this.deps.editMessageSpec(
          session.telegramChatId,
          existing.messageId,
          this.createSessionStatusMessageSpec(session, "Done", startedAt, now, "", 0)
        );
      } catch (error) {
        if (classifyMessageEditError(error) !== "synced") logger.warn("bridge.status.finalize_failed", {
          sessionId: session.id,
          messageId: existing.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.clearStatusState(session.id);
      }
    });
  }

  async clearAllSessionStatusMessages(): Promise<void> {
    this.cancelRefreshes();
    await Promise.allSettled(this.deps.statusOpBySession.values());
    const entries = [...this.deps.statusMessageBySession.entries()];
    for (const [sessionId, status] of entries) {
      const session = await this.deps.store.getSessionById(sessionId);
      if (!session) {
        this.clearStatusState(sessionId);
        continue;
      }
      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(sessionId) ?? now;
      try {
        await this.deps.editMessageSpec(
          session.telegramChatId,
          status.messageId,
          this.createSessionStatusMessageSpec(session, "Interrupted", startedAt, now, "Runtime connection closed before this status finished.", 0)
        );
      } catch (error) {
        if (classifyMessageEditError(error) !== "synced") logger.warn("bridge.status.interrupt_finalize_failed", {
          sessionId,
          messageId: status.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.clearStatusState(sessionId);
      }
    }
  }

  formatRecoveryIssue(event: AppServerErrorEvent): string {
    return `Issue · ${this.summarizeRecoveryIssue(event)}`;
  }

  private createSessionStatusMessageSpec(
    session: SessionRecord,
    label: string,
    startedAt: number,
    now: number,
    detail: string,
    queueCount: number
  ): MessageSpec {
    const stage = label.trim() || "Working";
    return createMessage({
      kind: "working",
      titleLabel: "Codex",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        { type: "text", text: `Working · ${stage} · ${formatElapsed(now - startedAt)}` },
        ...(detail ? [{ type: "text" as const, text: detail }] : []),
        ...(queueCount > 0 ? [{ type: "text" as const, text: `Queued: ${queueCount}` }] : [])
      ],
      actions: label.trim() === "Done"
        ? []
        : actionRow(messageAction("queue", "Queue", "quick:queue"), interruptAction("quick:interrupt"))
    });
  }

  private resolveStatusDetail(previous: string, update?: Pick<AppServerStatusUpdate, "detail" | "detailMode">): string {
    if (!update?.detail) return previous;
    const raw = update.detailMode === "append" ? `${previous}${update.detail}` : update.detail;
    return formatStatusDetailPreview(raw);
  }

  private rememberStatus(sessionId: string, messageId: string, text: string, label: string, now: number): void {
    this.pendingEdits.delete(sessionId);
    this.deps.statusMessageBySession.set(sessionId, { messageId, text });
    this.deps.statusLabelBySession.set(sessionId, label);
    this.deps.statusLastEditAtBySession.set(sessionId, now);
  }

  private clearStatusState(sessionId: string): void {
    this.pendingEdits.delete(sessionId);
    this.deps.statusMessageBySession.delete(sessionId);
    this.deps.statusStartedAtBySession.delete(sessionId);
    this.deps.statusLabelBySession.delete(sessionId);
    this.deps.statusDetailBySession.delete(sessionId);
    this.deps.statusLastEditAtBySession.delete(sessionId);
  }

  private cancelRefresh(sessionId: string): void {
    const timer = this.refreshTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(sessionId);
  }

  private cancelRefreshes(): void {
    for (const id of this.refreshTimers.keys()) this.cancelRefresh(id);
    for (const entry of this.idleRefreshes.values()) entry.controller.abort();
    this.generations.clear();
  }

  private deferRefresh(session: SessionRecord, operation: (signal: AbortSignal) => Promise<void>): void {
    const existing = this.idleRefreshes.get(session.id);
    if (existing && !existing.controller.signal.aborted) { existing.operation = operation; existing.revision++; return; }
    const entry = { operation, revision: 0, controller: new AbortController(), task: Promise.resolve() };
    entry.task = Promise.resolve().then(async () => {
      while (!entry.controller.signal.aborted) {
        if (this.deps.waitForThreadIdle && !await this.deps.waitForThreadIdle(session.codexThreadId, entry.controller.signal)) return;
        if (this.deps.getRefreshPolicy?.(session.telegramChatId) && this.deps.waitForBackgroundRefresh &&
          !await this.deps.waitForBackgroundRefresh(session.telegramChatId, session.id, entry.controller.signal)) return;
        if (entry.controller.signal.aborted) return;
        const revision = entry.revision;
        await entry.operation(entry.controller.signal);
        if (revision === entry.revision) return;
      }
    }).catch(error => logger.warn("bridge.status.refresh_failed", { sessionId: session.id, error: String(error) }))
      .finally(() => { if (this.idleRefreshes.get(session.id) === entry) this.idleRefreshes.delete(session.id); });
    this.idleRefreshes.set(session.id, entry);
  }

  private async runSessionStatusOp(sessionId: string, op: () => Promise<void>): Promise<void> {
    const previous = this.deps.statusOpBySession.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(op);
    this.deps.statusOpBySession.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.deps.statusOpBySession.get(sessionId) === next) this.deps.statusOpBySession.delete(sessionId);
    }
  }

  private summarizeRecoveryIssue(event: AppServerErrorEvent): string {
    const message = event.message.replace(/\s+/g, " ").trim();
    const reconnectMatch = message.match(/Reconnecting\.\.\.\s*(\d+\s*\/\s*\d+)/i);
    if (reconnectMatch) return `Reconnecting ${reconnectMatch[1]?.replace(/\s+/g, "")}`;
    if (/apply_patch verification failed/i.test(message)) return "apply_patch failed";
    if (/No such file or directory/i.test(message) || /Failed to read file to update/i.test(message)) return "file not found";
    if (event.stage === "stream") return "stream error";
    return formatStatusDetailPreview(message);
  }
}
