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
import type { BridgeMessageOptions } from "../transport.js";
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
    platformMessageId: string;
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
      enqueue: (key, operation) => this.enqueue(key, operation)
    }, this.delivery);
  }

  start(): void { this.finalDelivery.start(); }
  async stop(): Promise<void> {
    await this.finalDelivery.stop();
    await this.sequence.drain();
    this.pendingPreviewByTurn.clear();
  }

  readonly appendWorkflowMessage: WorkflowAppend = (session, operation, context) => this.sequence.append(session, operation, context);

  async sendProgressMessage(session: SessionRecord, event: ProgressNotificationEvent, turnId?: string,
    delivery: ProgressDeliveryOptions = {}): Promise<void> {
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

      const aggregate = appendPhaseEvent(active?.aggregate ?? emptyPhaseAggregate(), normalized);
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
        if (delivery.suppressPreview && !event.failed) {
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
        const sent = await this.delivery.send(session.telegramChatId, preview);
        if (!sent) return;
        this.lastProgressByTurn.set(key, { text, failed: event.failed, sentAt: now });
        record = this.deps.createProgressPhaseMessage({
          sessionId: session.id,
          codexThreadId: event.threadId,
          turnId: resolvedTurnId,
          phaseKind: normalized.kind,
          sourceId: session.telegramChatId,
          platformMessageId: sent.messageId,
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
    this.pendingPreviewByTurn.delete(this.turnKey(active.codexThreadId, active.turnId));
    const finalized = this.deps.finalizeProgressPhaseMessage({
      id: active.id,
      state,
      failureReason,
      deliveryState: "pending_finalization"
    });
    if (!finalized) return;
    this.finalDelivery.defer(finalized.id);
  }

  private async editPreview(key: string, record: ProgressPhaseMessageRecord, preview: ProgressPreview): Promise<void> {
    if (await this.delivery.edit(record.sourceId, record.platformMessageId, preview.spec)) {
      this.lastProgressByTurn.set(key, { text: preview.text, failed: preview.failed, sentAt: Date.now() });
      if (record.phaseKind === "run") this.deps.recordSuccessfulRunContentUpdate(record.id);
    }
  }

  private async flushPendingPreview(key: string, active: ProgressPhaseMessageRecord | null): Promise<void> {
    const pending = this.pendingPreviewByTurn.get(key);
    this.pendingPreviewByTurn.delete(key);
    // A duplicate/late result may be the last queued notification. It must not
    // swallow the latest meaningful preview of the current phase.
    if (active && pending?.phaseId === active.id) await this.editPreview(key, active, pending.preview);
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
