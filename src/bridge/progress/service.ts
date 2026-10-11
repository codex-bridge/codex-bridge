import type { SessionRecord } from "../../shared/types.js";
import type {
  ProgressFailureReason,
  ProgressPhaseAggregate,
  ProgressPhaseDeliveryState,
  ProgressPhaseMessageRecord,
  ProgressPhaseState
} from "../../shared/types.js";
import { logger } from "../../logging/logger.js";
import { createMessage } from "../messages/factory.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import { truncateTemporaryMessageSpec } from "../messages/temporary.js";
import type { BridgeMessageOptions } from "../transport.js";
import { createProgressMessageSpec, createProgressPhaseSummarySpec } from "../renderers/progress.js";
import { PhaseDeliveryAdapter } from "./delivery.js";
import { appendPhaseEvent, emptyPhaseAggregate, opensNewPhase } from "./lifecycle.js";
import {
  normalizeProgressEvent,
  type ProgressNotificationEvent
} from "./normalizer.js";

export type { ProgressNotificationEvent } from "./normalizer.js";

type ProgressTerminal = "completed" | "failed" | "interrupted";

export type ProgressServiceDependencies = {
  getSessionDirectory: (session: SessionRecord) => string;
  getInFlightTurnId: (threadId: string) => string | null;
  shouldSkipCalledProgress: (session: SessionRecord, now: number) => boolean;
  getActiveProgressPhaseMessage: (threadId: string, turnId: string) => ProgressPhaseMessageRecord | null;
  getLatestProgressPhaseMessage: (threadId: string, turnId: string) => ProgressPhaseMessageRecord | null;
  getProgressPhaseMessageForFileEdit: (threadId: string, turnId: string, itemId: string) => ProgressPhaseMessageRecord | null;
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
  private readonly queueByTurn = new Map<string, Promise<void>>();
  private readonly lastProgressByTurn = new Map<string, { text: string; failed: boolean; sentAt: number }>();

  constructor(private readonly deps: ProgressServiceDependencies) {
    this.delivery = new PhaseDeliveryAdapter(deps);
  }

  async sendProgressMessage(session: SessionRecord, event: ProgressNotificationEvent, turnId?: string): Promise<void> {
    const resolvedTurnId = turnId ?? this.deps.getInFlightTurnId(event.threadId);
    if (!resolvedTurnId) return;
    const normalized = normalizeProgressEvent(event);
    if (!normalized) return;
    const key = this.turnKey(event.threadId, resolvedTurnId);
    const preview = truncateTemporaryMessageSpec(createProgressMessageSpec({
      directory: this.deps.getSessionDirectory(session),
      event: { ...event, failureReason: normalized.failureReason },
      includeDiffPreview: true
    }));
    const text = renderLegacyMessage(preview);
    await this.enqueue(key, async () => {
      const directory = this.deps.getSessionDirectory(session);
      let active = this.deps.getActiveProgressPhaseMessage(event.threadId, resolvedTurnId);
      const owner = normalized.kind === "edited" && event.itemId
        ? this.deps.getProgressPhaseMessageForFileEdit(event.threadId, resolvedTurnId, event.itemId)
        : null;
      if (owner && owner.state !== "active") {
        // A late completion updates its original summary, never opens another phase.
        const aggregate = appendPhaseEvent(owner.aggregate, normalized);
        if (aggregate === owner.aggregate) return;
        let updated = this.deps.updateFinalProgressPhaseAggregate(owner.id, aggregate);
        if (updated && event.failed && updated.state === "phase_complete") {
          updated = this.deps.updateFinalProgressPhaseMessageState({
            id: updated.id, state: "step_failed", failureReason: normalized.failureReason
          });
        }
        if (updated) await this.deliverFinalSummary(updated, updated.directory);
        return;
      }
      const now = Date.now();
      const previous = this.lastProgressByTurn.get(key);
      const duplicatePreview = previous?.text === text && previous.failed === event.failed && now - previous.sentAt < 30_000;
      // Edited completion/identity must reach the aggregate even when the preview is unchanged.
      if (duplicatePreview && normalized.kind !== "edited") return;
      if (normalized.kind === "called" && !event.failed && this.deps.shouldSkipCalledProgress(session, now)) return;
      if (opensNewPhase(active, normalized) && active) {
        await this.finalizePhase(active, "phase_complete", null, directory);
        active = null;
      }

      const aggregate = appendPhaseEvent(active?.aggregate ?? emptyPhaseAggregate(), normalized);
      if (active && aggregate === active.aggregate) return;
      let record: ProgressPhaseMessageRecord | null;
      if (active) {
        const updated = this.deps.updateActiveProgressPhaseMessage(active.id, {
          text: "",
          directory,
          sourceId: session.telegramChatId,
          aggregate
        });
        record = updated ?? active;
        if (!duplicatePreview && await this.delivery.edit(record.sourceId, record.platformMessageId, preview)) {
          this.lastProgressByTurn.set(key, { text, failed: event.failed, sentAt: now });
          if (record.phaseKind === "run") record = this.deps.recordSuccessfulRunContentUpdate(record.id) ?? record;
        }
      } else {
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
        await this.finalizePhase(record, "step_failed", normalized.failureReason, directory);
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
      const active = this.deps.getActiveProgressPhaseMessage(threadId, turnId);
      if (active) {
        await this.finalizePhase(active, terminalState(terminal), null, active.directory);
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
      if (promoted) await this.deliverFinalSummary(promoted, promoted.directory);
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
  }

  async retryPendingFinalDeliveries(): Promise<void> {
    for (const record of this.deps.listPendingProgressPhaseFinalDelivery()) {
      await this.deliverFinalSummary(record, record.directory);
    }
  }

  private async finalizePhase(
    active: ProgressPhaseMessageRecord,
    state: Exclude<ProgressPhaseState, "active">,
    failureReason: ProgressFailureReason | null,
    directory: string
  ): Promise<void> {
    const finalized = this.deps.finalizeProgressPhaseMessage({
      id: active.id,
      state,
      failureReason,
      deliveryState: "pending_finalization"
    });
    if (!finalized) return;
    await this.deliverFinalSummary(finalized, directory);
  }

  private async deliverFinalSummary(record: ProgressPhaseMessageRecord, directory: string): Promise<void> {
    const summary = truncateTemporaryMessageSpec(createProgressPhaseSummarySpec({ directory, record }));
    if (await this.delivery.edit(record.sourceId, record.platformMessageId, summary)) {
      this.deps.markProgressPhaseMessageDeliveryState({ id: record.id, deliveryState: "synced" });
      return;
    }

    if (record.correctionMessageId) return;
    const correction = await this.delivery.send(record.sourceId, createMessage({
      kind: "system",
      titleLabel: "System",
      session: { id: null, directory },
      body: [{ type: "text", text: "Phase update pending" }]
    }));
    this.deps.markProgressPhaseMessageDeliveryState({
      id: record.id,
      deliveryState: correction ? "correction_sent" : "pending_finalization",
      ...(correction ? { correctionMessageId: correction.messageId } : {})
    });
  }

  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queueByTurn.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queueByTurn.set(key, current);
    void current.finally(() => {
      if (this.queueByTurn.get(key) === current) this.queueByTurn.delete(key);
    }).catch(() => undefined);
    return current.catch((error) => {
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
