import type { SessionRecord, TurnRouteRecord } from "../../shared/types.js";
import type {
  ProgressFailureReason,
  ProgressPhaseAggregate,
  ProgressPhaseDeliveryState,
  ProgressPhaseMessageRecord,
  ProgressPhaseState
} from "../../shared/types.js";
import { logger } from "../../logging/logger.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";
import { truncateTemporaryMessageSpec } from "../messages/temporary.js";
import type { BridgeMessageOptions, MessageRefreshPolicy } from "../transport.js";
import { createProgressMessageSpec } from "../renderers/progress.js";
import { PhaseDeliveryAdapter } from "./delivery.js";
import { FinalProgressDelivery } from "./final-delivery.js";
import { appendPhaseEvent, emptyPhaseAggregate, opensNewPhase } from "./lifecycle.js";
import {
  normalizeProgressEvent,
  type ProgressDeliveryOptions,
  type ProgressNotificationEvent
} from "./normalizer.js";

import { WorkflowSequence, type WorkflowAppend } from "./workflow-sequence.js";

export type { ProgressNotificationEvent } from "./normalizer.js";

type ProgressTerminal = "completed" | "failed" | "interrupted";
type ProgressPreview = { spec: MessageSpec; text: string; failed: boolean };

export type ProgressServiceDependencies = {
  getRefreshPolicy?: (sourceId: string) => MessageRefreshPolicy | undefined;
  waitForBackgroundRefresh?: (sourceId: string, sessionId: string, signal: AbortSignal) => Promise<boolean>;
  waitForThreadIdle?: (threadId: string, signal: AbortSignal) => Promise<boolean>;
  isThreadBusy?: (threadId: string) => boolean;
  getActiveTurnRoute: (threadId: string) => TurnRouteRecord | null;
  getProgressPhaseMessageForItem: (threadId: string, turnId: string, itemId: string) => ProgressPhaseMessageRecord | null;
  getSessionDirectory: (session: SessionRecord) => string;
  getInFlightTurnId: (threadId: string) => string | null;
  shouldSkipCalledProgress: (session: SessionRecord, now: number) => boolean;
  getActiveProgressPhaseMessage: (threadId: string, turnId: string) => ProgressPhaseMessageRecord | null;
  getProgressPhaseMessage: (id: string) => ProgressPhaseMessageRecord | null;
  getLatestProgressPhaseMessage: (threadId: string, turnId: string) => ProgressPhaseMessageRecord | null;
  getProgressPhaseMessageForFileEdit: (threadId: string, turnId: string, itemId: string) => ProgressPhaseMessageRecord | null;
  getProgressPhaseMessageForActivity?: (threadId: string, turnId: string, key: string) => ProgressPhaseMessageRecord | null;
  updateFinalProgressPhaseAggregate: (id: string, aggregate: ProgressPhaseAggregate) => ProgressPhaseMessageRecord | null;
  listActiveProgressPhaseMessages: () => ProgressPhaseMessageRecord[];
  listPendingProgressPhaseFinalDelivery: () => ProgressPhaseMessageRecord[];
  createProgressPhaseMessage: (input: {
    sessionId: string;
    codexThreadId: string;
    turnId: string;
    phaseKind: ProgressPhaseMessageRecord["phaseKind"];
    sourceId: string;
    platformMessageId: string | null;
    directory: string;
    text: string;
    aggregate: ProgressPhaseAggregate;
  }) => ProgressPhaseMessageRecord;
  updateActiveProgressPhaseMessage: (id: string, input: {
    text: string;
    directory: string;
    sourceId: string;
    aggregate: ProgressPhaseAggregate;
  }) => ProgressPhaseMessageRecord | null;
  recordSuccessfulRunContentUpdate: (id: string) => ProgressPhaseMessageRecord | null;
  finalizeProgressPhaseMessage: (input: {
    id: string;
    state: Exclude<ProgressPhaseState, "active">;
    failureReason?: ProgressFailureReason | null;
    deliveryState?: ProgressPhaseDeliveryState;
  }) => ProgressPhaseMessageRecord | null;
  updateFinalProgressPhaseMessageState: (input: {
    id: string;
    state: Exclude<ProgressPhaseState, "active">;
    failureReason?: ProgressFailureReason | null;
  }) => ProgressPhaseMessageRecord | null;
  markProgressPhaseMessageDeliveryState: (input: {
    id: string;
    deliveryState: ProgressPhaseDeliveryState;
    correctionMessageId?: string | null;
    platformMessageId?: string;
  }) => ProgressPhaseMessageRecord | null;
  editMessageSpec: (chatId: string, messageId: string, messageSpec: import("../messages/types.js").MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<boolean>;
  sendTemporaryMessageSpec: (chatId: string, messageSpec: import("../messages/types.js").MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<{ messageId: string; text: string } | null>;
};

export class ProgressService {
  private readonly delivery: PhaseDeliveryAdapter;
  private readonly finalDelivery: FinalProgressDelivery;
  private readonly sequence: WorkflowSequence;
  private readonly lastProgressByTurn = new Map<string, { text: string; failed: boolean; sentAt: number }>();
  private readonly pendingPreviewByTurn = new Map<string, { phaseId: string; preview: ProgressPreview }>();
  private readonly refreshes = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private stopped = false;

  constructor(private readonly deps: ProgressServiceDependencies) {
    this.delivery = new PhaseDeliveryAdapter(deps);
    this.sequence = new WorkflowSequence(deps.getActiveTurnRoute, async (threadId, turnId) => {
      this.lastProgressByTurn.delete(this.turnKey(threadId, turnId));
      const active = deps.getActiveProgressPhaseMessage(threadId, turnId);
      if (active) await this.finalizePhase(active, "phase_complete", null);
    });
    this.finalDelivery = new FinalProgressDelivery({
      getRecord: deps.getProgressPhaseMessage,
      listPending: deps.listPendingProgressPhaseFinalDelivery,
      mark: deps.markProgressPhaseMessageDeliveryState,
      waitForThreadIdle: deps.waitForThreadIdle,
      isThreadBusy: deps.isThreadBusy,
      waitForBackgroundRefresh: deps.waitForBackgroundRefresh,
      enqueue: (key, operation) => this.enqueue(key, operation)
    }, this.delivery);
  }

  start(): void { this.stopped = false; this.finalDelivery.start(); }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const refresh of this.refreshes.values()) refresh.controller.abort();
    await this.finalDelivery.stop();
    await Promise.allSettled([...this.refreshes.values()].map(refresh => refresh.task));
    await this.sequence.drain();
    this.pendingPreviewByTurn.clear();
  }

  readonly appendWorkflowMessage: WorkflowAppend = (session, operation, context) => this.sequence.append(session, operation, context);

  async sendProgressMessage(session: SessionRecord, event: ProgressNotificationEvent, turnId?: string,
    delivery: ProgressDeliveryOptions = {}): Promise<void> {
    if (this.stopped) return;
    const resolvedTurnId = turnId ?? this.deps.getInFlightTurnId(event.threadId);
    if (!resolvedTurnId) return;
    const normalized = normalizeProgressEvent(event);
    if (!normalized) return;
    const key = this.turnKey(event.threadId, resolvedTurnId);
    const preview = truncateTemporaryMessageSpec(createProgressMessageSpec({
      directory: this.deps.getSessionDirectory(session),
      event: { ...event, failureReason: normalized.failureReason },
      includeLivePreview: true
    }));
    preview.session = { id: session.id, directory: this.deps.getSessionDirectory(session) };
    const text = renderLegacyMessage(preview);
    await this.enqueue(key, async () => {
      const directory = this.deps.getSessionDirectory(session);
      let active = this.deps.getActiveProgressPhaseMessage(event.threadId, resolvedTurnId);
      const owner = this.findOwner(event, resolvedTurnId, normalized.kind);
      if (owner && owner.state !== "active") {
        // A late completion updates its original summary, never opens another phase.
        const aggregate = appendPhaseEvent(owner.aggregate, normalized);
        if (aggregate === owner.aggregate) {
          if (!delivery.suppressPreview) await this.flushPendingPreview(key, active);
          return;
        }
        let updated = this.deps.updateFinalProgressPhaseAggregate(owner.id, aggregate);
        if (updated && event.failed && updated.state === "phase_complete") {
          updated = this.deps.updateFinalProgressPhaseMessageState({
            id: updated.id, state: "step_failed", failureReason: normalized.failureReason
          });
        }
        if (updated) this.finalDelivery.defer(updated.id);
        if (!delivery.suppressPreview) await this.flushPendingPreview(key, active);
        return;
      }
      const now = Date.now();
      const previous = this.lastProgressByTurn.get(key);
      const duplicatePreview = previous?.text === text && previous.failed === event.failed && now - previous.sentAt < 30_000;
      const throttlePreview = normalized.kind === "thinking" && active?.phaseKind === "thinking" &&
        event.completed !== true && previous && now - previous.sentAt < 5_000;
      if (normalized.kind === "called" && event.operationKind !== "dynamicTool" && !event.failed && this.deps.shouldSkipCalledProgress(session, now)) return;
      if (opensNewPhase(active, normalized) && active) {
        this.lastProgressByTurn.delete(key);
        await this.finalizePhase(active, "phase_complete", null);
        active = null;
      }

      const refreshPolicy = this.deps.getRefreshPolicy?.(session.telegramChatId);
      const summaryOnly = refreshPolicy?.progressMode === "summary";
      const aggregate = appendPhaseEvent(active?.aggregate ?? { ...emptyPhaseAggregate(),
        ...(summaryOnly ? { summaryOnly: true, itemCountReliable: true } : {}) }, normalized);
      if (active && aggregate === active.aggregate) {
        if (!delivery.suppressPreview) await this.flushPendingPreview(key, active);
        return;
      }
      let record: ProgressPhaseMessageRecord | null;
      if (active) {
        const updated = this.deps.updateActiveProgressPhaseMessage(active.id, {
          text: "",
          directory,
          sourceId: session.telegramChatId,
          aggregate
        });
        record = updated ?? active;
        if (summaryOnly) {
          this.pendingPreviewByTurn.delete(key);
        } else if (refreshPolicy?.progressIntervalMs) {
          if (!duplicatePreview && !event.failed) {
            this.pendingPreviewByTurn.set(key, { phaseId: record.id, preview: { spec: preview, text, failed: event.failed } });
            this.schedulePreview(key, record);
          } else this.pendingPreviewByTurn.delete(key);
        } else if (delivery.suppressPreview && !event.failed) {
          if (!duplicatePreview && !throttlePreview) {
            this.pendingPreviewByTurn.set(key, { phaseId: record.id, preview: { spec: preview, text, failed: event.failed } });
          } else this.pendingPreviewByTurn.delete(key);
        } else {
          this.pendingPreviewByTurn.delete(key);
          if (!duplicatePreview && !throttlePreview) {
            await this.editPreview(key, record, { spec: preview, text, failed: event.failed });
          }
        }
      } else {
        // Creation is never coalesced: later edits need the platform message ID.
        const sent = summaryOnly ? null : await this.delivery.send(session.telegramChatId, preview);
        if (!summaryOnly && !sent) return;
        if (sent) this.lastProgressByTurn.set(key, { text, failed: event.failed, sentAt: Date.now() });
        record = this.deps.createProgressPhaseMessage({
          sessionId: session.id,
          codexThreadId: event.threadId,
          turnId: resolvedTurnId,
          phaseKind: normalized.kind,
          sourceId: session.telegramChatId,
          platformMessageId: sent?.messageId ?? null,
          directory,
          text: "",
          aggregate
        });
      }

      if (event.failed && record) {
        await this.finalizePhase(record, "step_failed", normalized.failureReason);
      }
    });
  }

  async recordBridgeConnectionFailure(session: SessionRecord, threadId: string, turnId: string): Promise<boolean> {
    if (this.deps.getActiveProgressPhaseMessage(threadId, turnId)) return false;
    await this.sendProgressMessage(session, {
      threadId,
      label: "System",
      toolName: null,
      action: null,
      target: null,
      input: null,
      changes: null,
      failed: true,
      text: "Codex connection lost.",
      completed: true
    }, turnId);
    return true;
  }

  async clearProgressMessageForThread(
    threadId: string,
    options: { terminal?: ProgressTerminal; turnId?: string } = {}
  ): Promise<void> {
    const turnId = options.turnId ?? this.deps.getInFlightTurnId(threadId);
    if (!turnId) return;
    const terminal = options.terminal ?? "completed";
    await this.enqueue(this.turnKey(threadId, turnId), async () => {
      this.lastProgressByTurn.delete(this.turnKey(threadId, turnId));
      this.pendingPreviewByTurn.delete(this.turnKey(threadId, turnId));
      const active = this.deps.getActiveProgressPhaseMessage(threadId, turnId);
      if (active) {
        await this.finalizePhase(active, terminalState(terminal), null);
        return;
      }
      if (terminal !== "failed") return;
      const latest = this.deps.getLatestProgressPhaseMessage(threadId, turnId);
      if (latest?.state !== "step_failed") return;
      const promoted = this.deps.updateFinalProgressPhaseMessageState({
        id: latest.id,
        state: "failed",
        failureReason: latest.failureReason
      });
      if (promoted) this.finalDelivery.defer(promoted.id);
    });
  }

  async clearAllProgressMessages(): Promise<void> {
    for (const active of this.deps.listActiveProgressPhaseMessages()) {
      await this.clearProgressMessageForThread(active.codexThreadId, {
        terminal: "interrupted",
        turnId: active.turnId
      });
    }
    await this.retryPendingFinalDeliveries();
    this.lastProgressByTurn.clear();
    this.pendingPreviewByTurn.clear();
  }

  async retryPendingFinalDeliveries(): Promise<void> {
    await this.finalDelivery.retryPending();
  }

  private findOwner(event: ProgressNotificationEvent, turnId: string, kind: ProgressPhaseMessageRecord["phaseKind"]): ProgressPhaseMessageRecord | null {
    // Turn-wide snapshots are new observations after a boundary, not late item results.
    if (event.activity?.updateMode === "snapshot") return null;
    if (event.itemId) {
      const owner = this.deps.getProgressPhaseMessageForItem(event.threadId, turnId, event.itemId);
      if (owner?.phaseKind === kind) return owner;
      // Old rows predate generic item ownership; their typed identities still apply.
      if (kind === "edited") {
        return this.deps.getProgressPhaseMessageForFileEdit(event.threadId, turnId, event.itemId);
      }
    }
    return event.activity ? this.deps.getProgressPhaseMessageForActivity?.(event.threadId, turnId, event.activity.key) ?? null : null;
  }

  private async finalizePhase(
    active: ProgressPhaseMessageRecord,
    state: Exclude<ProgressPhaseState, "active">,
    failureReason: ProgressFailureReason | null
  ): Promise<void> {
    const key = this.turnKey(active.codexThreadId, active.turnId);
    this.pendingPreviewByTurn.delete(key);
    this.refreshes.get(key)?.controller.abort();
    const finalized = this.deps.finalizeProgressPhaseMessage({
      id: active.id,
      state,
      failureReason,
      deliveryState: "pending_finalization"
    });
    if (!finalized) return;
    if (finalized.platformMessageId === null) await this.finalDelivery.deliver(finalized.id);
    else this.finalDelivery.defer(finalized.id);
  }

  private async editPreview(key: string, record: ProgressPhaseMessageRecord, preview: ProgressPreview,
    options?: Pick<BridgeMessageOptions, "canSend" | "deliverySignal" | "onRateDeferred">): Promise<void> {
    if (record.platformMessageId === null) return;
    if (await this.delivery.editResult(record.sourceId, record.platformMessageId, preview.spec, options) === "synced") {
      this.lastProgressByTurn.set(key, { text: preview.text, failed: preview.failed, sentAt: Date.now() });
      if (record.phaseKind === "run") this.deps.recordSuccessfulRunContentUpdate(record.id);
    }
  }

  private async flushPendingPreview(key: string, active: ProgressPhaseMessageRecord | null): Promise<void> {
    const pending = this.pendingPreviewByTurn.get(key);
    const policy = active && this.deps.getRefreshPolicy?.(active.sourceId);
    if (policy?.progressMode === "summary") { this.pendingPreviewByTurn.delete(key); return; }
    if (active && pending?.phaseId === active.id && policy?.progressIntervalMs) {
      this.schedulePreview(key, active);
      return;
    }
    this.pendingPreviewByTurn.delete(key);
    // A duplicate/late result may be the last queued notification. It must not
    // swallow the latest meaningful preview of the current phase.
    if (active && pending?.phaseId === active.id) await this.editPreview(key, active, pending.preview);
  }

  private schedulePreview(key: string, record: ProgressPhaseMessageRecord): void {
    if (this.stopped || this.refreshes.has(key)) return;
    const controller = new AbortController(), signal = controller.signal;
    const entry = { controller, task: Promise.resolve() };
    entry.task = Promise.resolve().then(async () => {
      while (!signal.aborted && this.pendingPreviewByTurn.get(key)?.phaseId === record.id) {
        const policy = this.deps.getRefreshPolicy?.(record.sourceId);
        if (policy?.progressMode === "summary") { this.pendingPreviewByTurn.delete(key); return; }
        const interval = policy?.progressIntervalMs ?? 0;
        const wait = Math.max(0, (this.lastProgressByTurn.get(key)?.sentAt ?? 0) + interval - Date.now());
        if (wait) {
          await this.waitForPreview(wait, signal);
        }
        if (this.deps.waitForThreadIdle && !await this.deps.waitForThreadIdle(record.codexThreadId, signal)) return;
        if (this.deps.waitForBackgroundRefresh && !await this.deps.waitForBackgroundRefresh(record.sourceId, record.sessionId, signal)) return;
        if (signal.aborted) return;
        await this.enqueue(key, async () => {
          const current = this.deps.getProgressPhaseMessage(record.id);
          const pending = this.pendingPreviewByTurn.get(key);
          if (signal.aborted || current?.state !== "active" || pending?.phaseId !== record.id) return;
          if (this.deps.isThreadBusy?.(record.codexThreadId)) return;
          this.pendingPreviewByTurn.delete(key);
          await this.editPreview(key, current, pending.preview, {
            deliverySignal: signal,
            onRateDeferred: () => {
              if (!this.pendingPreviewByTurn.has(key)) this.pendingPreviewByTurn.set(key, pending);
            },
            canSend: async () => {
              if (signal.aborted) return false;
              if (!this.deps.isThreadBusy?.(record.codexThreadId)) return true;
              if (!this.pendingPreviewByTurn.has(key)) this.pendingPreviewByTurn.set(key, pending);
              return false;
            }
          });
        });
      }
    }).catch(error => {
      if (!signal.aborted) logger.warn("bridge.progress.preview_refresh_failed", { phaseId: record.id, error: String(error) });
    }).finally(() => {
      if (this.refreshes.get(key) !== entry) return;
      this.refreshes.delete(key);
      const pending = this.pendingPreviewByTurn.get(key);
      // A new phase may have arrived while the previous task was being cancelled.
      const current = pending && this.deps.getProgressPhaseMessage(pending.phaseId);
      if (current?.state === "active") this.schedulePreview(key, current);
    });
    this.refreshes.set(key, entry);
  }

  private waitForPreview(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      timer.unref();
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    return this.sequence.run(key, operation).catch((error) => {
      logger.warn("bridge.progress.lifecycle_failed", {
        key,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }
}

function terminalState(terminal: ProgressTerminal): Exclude<ProgressPhaseState, "active"> {
  switch (terminal) {
    case "completed": return "phase_complete";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
  }
}
