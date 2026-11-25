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
import { WorkingWindow, type WorkingUpdate } from "./working-window.js";

type StatusEntry = { messageId: string; text: string };
type StatusGeneration = { initialSendUncertain?: boolean };
type StatusPreparationEntry = { canSend: () => Promise<boolean> };
export type StatusPreparation = { finish: (started: boolean) => void };
type StatusRefresh = {
  label?: string;
  update?: WorkingUpdate;
  canRefresh?: () => boolean;
  admissionSignal?: AbortSignal;
  activation?: StatusPreparationEntry;
};

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
  private readonly queueCountBySession = new Map<string, number>();
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly generations = new Map<string, StatusGeneration>();
  private readonly preparations = new Map<string, StatusPreparationEntry>();
  private readonly windows = new Map<string, WorkingWindow>();
  private readonly retryNotBefore = new Map<string, number>();
  private readonly preparationTasks = new Set<Promise<void>>();
  private readonly idleRefreshes = new Map<string, { revision: number; operation: (signal: AbortSignal) => Promise<void>; controller: AbortController; task: Promise<void> }>();
  private stopped = false;

  constructor(private readonly deps: StatusLifecycleDependencies) {}

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelRefreshes();
    await Promise.allSettled(this.deps.statusOpBySession.values());
    await Promise.allSettled([...this.idleRefreshes.values()].map(entry => entry.task));
    await Promise.allSettled(this.preparationTasks);
  }

  beginPreparation(session: SessionRecord, canSend: () => Promise<boolean>): StatusPreparation {
    if (this.stopped || this.deps.statusMessageBySession.has(session.id) || this.preparations.has(session.id)) {
      return { finish: () => {} };
    }
    const entry = { canSend };
    this.preparations.set(session.id, entry);
    this.trackPreparation(this.setSessionStatus(session, "Preparing"));
    return { finish: started => {
      if (this.preparations.get(session.id) !== entry) return;
      if (started) {
        this.preparations.delete(session.id);
        this.trackPreparation(this.setSessionStatus(session, "Working", undefined, undefined, undefined, entry));
      } else this.trackPreparation(this.clearSessionStatus(session, "Start failed"));
    } };
  }

  private trackPreparation(operation: Promise<void>): void {
    const task = operation.catch(error => logger.warn("bridge.status.preparation_failed", { error: String(error) }))
      .finally(() => this.preparationTasks.delete(task));
    this.preparationTasks.add(task);
  }

  async refreshSessionStatus(session: SessionRecord): Promise<void> {
    if (!this.deps.statusMessageBySession.has(session.id)) return;
    const queueCount = await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId);
    if (!this.deps.statusMessageBySession.has(session.id) || this.queueCountBySession.get(session.id) === queueCount) return;
    this.pendingEdits.add(session.id);
    // A pending latest-state refresh already re-reads the queue count. Do not
    // replace its new label with the older label currently displayed on the card.
    if (this.idleRefreshes.has(session.id) || this.refreshTimers.has(session.id)) return;
    await this.refreshLatest(session);
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
    const activation = this.preparations.get(session.id);
    this.preparations.delete(session.id);
    await this.setSessionStatus(session, update.label ?? "Working", undefined, canRefresh, undefined, activation);
    // Typing is disposable and must never hold up chronological notifications.
    void this.deps.sendTypingOnce(session, canRefresh).catch(error => logger.warn("bridge.status.typing_failed", { error: String(error) }));
  }

  async setSessionStatus(
    session: SessionRecord,
    label: string,
    update?: WorkingUpdate,
    canRefresh?: () => boolean,
    admissionSignal?: AbortSignal,
    activation?: StatusPreparationEntry
  ): Promise<void> {
    return this.updateSessionStatus(session, { label, update, canRefresh, admissionSignal, activation });
  }

  private async updateSessionStatus(session: SessionRecord, request: StatusRefresh): Promise<void> {
    const { canRefresh, admissionSignal, activation } = request;
    if (this.stopped) return;
    const refreshPolicy = this.deps.getRefreshPolicy?.(session.telegramChatId);
    const generation: StatusGeneration = this.generations.get(session.id) ?? {};
    const preparation = activation ?? this.preparations.get(session.id);
    const activating = activation !== undefined;
    this.generations.set(session.id, generation);
    const eligible = () => !admissionSignal?.aborted && this.generations.get(session.id) === generation && canRefresh?.() !== false;
    const authorized = async () => eligible() && (!preparation || await preparation.canSend()) && eligible();
    if (!eligible()) return;
    return this.runSessionStatusOp(session.id, async () => {
      if (!eligible()) return;
      // Resolve refresh-only work inside the serialized operation. A timer can
      // have been queued while a newer observation was still waiting for I/O.
      if (request.label === undefined && !this.windows.has(session.id)) return;
      const window = this.windows.get(session.id) ?? new WorkingWindow();
      const label = request.label ?? window.label;
      const update = request.label === undefined
        ? { detail: window.detail, detailMode: "replace" as const } : request.update;
      this.windows.set(session.id, window);
      const observed = window.observe(label, update);
      if (observed && this.deps.statusMessageBySession.has(session.id)) this.pendingEdits.add(session.id);
      const immediate = activating || Boolean(update?.immediate && observed);
      if (immediate) this.idleRefreshes.get(session.id)?.controller.abort();
      if (!immediate && this.deps.waitForThreadIdle && this.deps.isThreadBusy?.(session.codexThreadId) && this.deps.statusMessageBySession.has(session.id)) {
        this.cancelRefresh(session.id);
        this.deferRefresh(session, signal => this.refreshLatest(session, canRefresh, signal, eligible));
        return;
      }
      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(session.id) ?? now;
      this.deps.statusStartedAtBySession.set(session.id, startedAt);

      const previousLabel = this.deps.statusLabelBySession.get(session.id);
      const labelChanged = previousLabel !== label;
      const previousDetail = this.deps.statusDetailBySession.get(session.id) ?? "";
      const detail = window.detail;
      if (detail) this.deps.statusDetailBySession.set(session.id, detail);
      else this.deps.statusDetailBySession.delete(session.id);

      const detailChanged = detail !== previousDetail;
      const lastEditAt = this.deps.statusLastEditAtBySession.get(session.id) ?? 0;
      const existing = this.deps.statusMessageBySession.get(session.id);
      if (!existing && generation.initialSendUncertain) return;
      if (existing && (labelChanged || detailChanged || observed)) this.pendingEdits.add(session.id);
      const interval = refreshPolicy?.workingIntervalMs ?? 20_000;
      const nextEditAt = Math.max(lastEditAt + interval, this.retryNotBefore.get(session.id) ?? 0);
      if (existing && !immediate && now < nextEditAt) {
        this.cancelRefresh(session.id);
        if (labelChanged || detailChanged || this.pendingEdits.has(session.id)) {
          const timer = setTimeout(() => {
            this.refreshTimers.delete(session.id);
            if (eligible()) void this.refreshLatest(session, canRefresh)
              .catch(error => logger.warn("bridge.status.refresh_failed", { sessionId: session.id, error: String(error) }));
          }, nextEditAt - now);
          timer.unref();
          this.refreshTimers.set(session.id, timer);
        }
        return;
      }
      if (existing && !labelChanged && !detailChanged && !this.pendingEdits.has(session.id)) return;
      this.cancelRefresh(session.id);
      if (existing && !immediate && this.deps.getRefreshPolicy?.(session.telegramChatId) && this.deps.waitForBackgroundRefresh && !admissionSignal) {
        this.deferRefresh(session, signal => this.refreshLatest(session, canRefresh, signal, eligible));
        return;
      }

      const queueCount = await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId);
      const revision = window.revision;
      const messageSpec = this.createSessionStatusMessageSpec(session, label, startedAt, now, detail, queueCount, false, existing ? window.summary() : "");
      const text = renderLegacyMessage(messageSpec);
      if (existing?.text === text && !this.pendingEdits.has(session.id)) return;

      if (existing) {
        let result: MessageEditResult;
        let postponed = false;
        try {
          result = await this.deps.editMessageSpec(session.telegramChatId, existing.messageId, messageSpec,
            { canSend: authorized, deliverySignal: admissionSignal,
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
          this.deferRefresh(session, signal => this.refreshLatest(session, canRefresh, signal, eligible));
          return;
        }
        if (result === "synced") {
          this.rememberStatus(session.id, existing.messageId, text, label, queueCount);
          window.acknowledge(revision);
          return;
        }
        if (result !== "missing") {
          if (!eligible()) return;
          // Preserve the original ID and clock. Later status events retry the edit,
          // including an unchanged detail, without flooding on every streamed delta.
          this.pendingEdits.add(session.id);
          this.deps.statusLabelBySession.set(session.id, label);
          this.retryNotBefore.set(session.id, Date.now() + interval);
          return;
        }
        this.deps.statusMessageBySession.delete(session.id);
      }

      let skipped = false;
      try {
        const sent = await this.deps.sendMessageSpec(session.telegramChatId, messageSpec,
          { disable_notification: true, canSend: async () => {
            const allowed = await authorized();
            if (!allowed) skipped = true;
            return allowed;
          } });
        if (sent) {
          this.rememberStatus(session.id, sent.message_id, text, label, queueCount);
          window.acknowledge(revision);
        }
        else if (!skipped) generation.initialSendUncertain = true;
      } catch (error) {
        generation.initialSendUncertain = true;
        throw error;
      }
    });
  }

  async clearSessionStatus(session: SessionRecord, label = "Done"): Promise<void> {
    this.preparations.delete(session.id);
    this.generations.delete(session.id);
    this.cancelRefresh(session.id);
    this.idleRefreshes.get(session.id)?.controller.abort();
    return this.runSessionStatusOp(session.id, async () => {
      const existing = this.deps.statusMessageBySession.get(session.id);
      if (!existing) { this.clearStatusState(session.id); return; }

      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(session.id) ?? now;
      try {
        await this.deps.editMessageSpec(
          session.telegramChatId,
          existing.messageId,
          this.createSessionStatusMessageSpec(session, label, startedAt, now, "", 0, true)
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
          this.createSessionStatusMessageSpec(session, "Interrupted", startedAt, now, "Runtime connection closed before this status finished.", 0, true)
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
    queueCount: number,
    terminal = false,
    recent = ""
  ): MessageSpec {
    const stage = label.trim() || "Working";
    return createMessage({
      kind: "working",
      titleLabel: "Codex",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        { type: "text", text: `Working · ${stage} · ${formatElapsed(now - startedAt)}` },
        ...(recent ? [{ type: "text" as const, text: `Recent: ${recent}` }] : []),
        ...(detail ? [{ type: "text" as const, text: detail }] : []),
        ...(queueCount > 0 ? [{ type: "text" as const, text: `Queued: ${queueCount}` }] : [])
      ],
      actions: terminal || this.preparations.has(session.id)
        ? []
        : actionRow(messageAction("queue", "Queue", "quick:queue"), interruptAction("quick:interrupt"))
    });
  }

  private async refreshLatest(session: SessionRecord, canRefresh?: () => boolean, signal?: AbortSignal, eligible: () => boolean = () => true): Promise<void> {
    if (!this.windows.has(session.id) || !eligible()) return;
    await this.updateSessionStatus(session, { canRefresh, admissionSignal: signal });
  }

  private rememberStatus(sessionId: string, messageId: string, text: string, label: string, queueCount: number): void {
    this.retryNotBefore.delete(sessionId);
    this.pendingEdits.delete(sessionId);
    this.queueCountBySession.set(sessionId, queueCount);
    this.deps.statusMessageBySession.set(sessionId, { messageId, text });
    this.deps.statusLabelBySession.set(sessionId, label);
    this.deps.statusLastEditAtBySession.set(sessionId, Date.now());
  }

  private clearStatusState(sessionId: string): void {
    this.windows.delete(sessionId);
    this.retryNotBefore.delete(sessionId);
    this.pendingEdits.delete(sessionId);
    this.queueCountBySession.delete(sessionId);
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
    this.preparations.clear();
    this.windows.clear();
    this.retryNotBefore.clear();
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
