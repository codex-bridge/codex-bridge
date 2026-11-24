import type { ProgressPhaseDeliveryState, ProgressPhaseMessageRecord } from "../../shared/types.js";
import { logger } from "../../logging/logger.js";
import { createMessage } from "../messages/factory.js";
import { truncateTemporaryMessageSpec } from "../messages/temporary.js";
import { createProgressPhaseSummarySpec } from "../renderers/progress.js";
import type { PhaseDeliveryAdapter } from "./delivery.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";

type FinalDeliveryDependencies = {
  getRecord: (id: string) => ProgressPhaseMessageRecord | null;
  listPending: () => ProgressPhaseMessageRecord[];
  mark: (input: { id: string; deliveryState: ProgressPhaseDeliveryState; correctionMessageId?: string | null; platformMessageId?: string }) => unknown;
  enqueue: (key: string, operation: () => Promise<void>) => Promise<void>;
  waitForThreadIdle?: (threadId: string, signal: AbortSignal) => Promise<boolean>;
  isThreadBusy?: (threadId: string) => boolean;
  waitForBackgroundRefresh?: (sourceId: string, sessionId: string, signal: AbortSignal) => Promise<boolean>;
};

const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

/** Closed phases create their first summary or edit their known message ID.
 * Ambiguous first sends are never automatically replayed. Does not control Codex.
 */
export class FinalProgressDelivery {
  private readonly retries = new Map<string, { attempts: number; dueAt: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private closed = false;
  private readonly deferred = new Map<string, { revision: number; task: Promise<void> }>();
  private idleCancellation = new AbortController();
  private readonly deferredQueue = new KeyedQueue();

  constructor(private readonly deps: FinalDeliveryDependencies, private readonly delivery: PhaseDeliveryAdapter) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.closed = false;
    if (this.idleCancellation.signal.aborted) this.idleCancellation = new AbortController();
    this.retries.clear();
    for (const record of this.deps.listPending()) this.retries.set(record.id, { attempts: 0, dueAt: Date.now() });
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.closed = true;
    this.idleCancellation.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    await Promise.allSettled([...this.deferred.values()].map(entry => entry.task));
  }

  /** Finalize state synchronously; edit old cards only after foreground work drains. */
  defer(id: string): void {
    if (this.closed) return;
    const existing = this.deferred.get(id);
    if (existing) { existing.revision++; return; }
    const entry = { revision: 0, task: Promise.resolve() };
    const signal = this.idleCancellation.signal;
    entry.task = Promise.resolve().then(async () => {
      const record = this.deps.getRecord(id);
      if (!record) return;
      // Old turns of the same thread must not flood the physical transport queue.
      await this.deferredQueue.run(record.codexThreadId, async () => {
        while (!this.closed) {
          const revision = entry.revision;
          if (this.deps.waitForThreadIdle && !await this.deps.waitForThreadIdle(record.codexThreadId, signal)) return;
          if (this.deps.waitForBackgroundRefresh && !await this.deps.waitForBackgroundRefresh(record.sourceId, record.sessionId, signal)) return;
          if (this.closed) return;
          await this.deps.enqueue(`${record.codexThreadId}:${record.turnId}`, () => this.deliver(id));
          if (revision === entry.revision) return;
        }
      });
    }).catch(error => {
      logger.warn("bridge.progress.final_delivery_deferred_failed", { phaseId: id, error: String(error) });
    }).finally(() => { this.deferred.delete(id); });
    this.deferred.set(id, entry);
  }

  async retryPending(): Promise<void> {
    for (const record of this.deps.listPending()) {
      await this.deps.enqueue(`${record.codexThreadId}:${record.turnId}`, () => this.deliver(record.id));
    }
  }

  // The caller holds the same per-turn queue used by normal and late progress events.
  async deliver(id: string): Promise<void> {
    const record = this.deps.getRecord(id);
    if (!record || record.state === "active" || (record.deliveryState === "synced" && !record.correctionMessageId)
      || ["unavailable", "sending", "send_unknown"].includes(record.deliveryState)) {
      this.retries.delete(id);
      return;
    }
    const summary = truncateTemporaryMessageSpec(createProgressPhaseSummarySpec({ directory: record.directory, record }));
    if (record.platformMessageId === null) {
      if (this.closed) return;
      // A first send can have an unknown outcome. Claim before I/O and never
      // automatically duplicate a send after a crash or ambiguous failure.
      this.deps.mark({ id, deliveryState: "sending" });
      try {
        const sent = await this.delivery.send(record.sourceId, summary, { deliverySignal: this.idleCancellation.signal });
        this.deps.mark(sent ? { id, deliveryState: "synced", platformMessageId: sent.messageId }
          : { id, deliveryState: "send_unknown" });
      } catch {
        this.deps.mark({ id, deliveryState: "send_unknown" });
        logger.warn("bridge.progress.summary_send_unknown", { phaseId: id });
      }
      return;
    }
    let postponed = false;
    const options = { deliverySignal: this.idleCancellation.signal, onRateDeferred: () => { postponed = true; }, canSend: async () => {
      if (this.closed) { postponed = true; return false; }
      if (this.deps.waitForThreadIdle && this.deps.isThreadBusy?.(record.codexThreadId)) { postponed = true; return false; }
      return true;
    } };
    let result = record.deliveryState === "synced" ? "synced" as const
      : await this.delivery.editResult(record.sourceId, record.platformMessageId, summary, options);
    if (postponed) { this.defer(id); return; }
    if (result === "synced" && record.correctionMessageId) {
      this.deps.mark({ id, deliveryState: "synced" });
      // Old placeholder messages are resolved in place, never deleted or replaced by a new send.
      result = await this.delivery.editResult(record.sourceId, record.correctionMessageId, createMessage({
        kind: "system", titleLabel: "System", session: { id: null, directory: record.directory },
        body: [{ type: "text", text: "Progress summary synced." }]
      }), options);
      if (postponed) { this.defer(id); return; }
      // A deleted/forbidden old notice must not disable later edits to the synced original.
      if (result === "unavailable") result = "synced";
    }
    if (result !== "retryable") {
      this.deps.mark({ id, deliveryState: result, ...(result === "synced" ? { correctionMessageId: null } : {}) });
      this.retries.delete(id);
    } else {
      const attempts = this.retries.get(id)?.attempts ?? 0;
      const delay = RETRY_DELAYS_MS[attempts];
      if (delay === undefined) {
        this.retries.delete(id);
        logger.warn("bridge.progress.final_delivery_exhausted", { phaseId: id });
      } else {
        this.retries.set(id, { attempts: attempts + 1, dueAt: Date.now() + delay });
      }
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || this.running) return;
    const next = [...this.retries.values()].reduce((time, retry) => Math.min(time, retry.dueAt), Infinity);
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.drainDue().catch((error) => {
        logger.warn("bridge.progress.final_delivery_retry_failed", { error: error instanceof Error ? error.message : String(error) });
      }).finally(() => { this.running = null; this.schedule(); });
    }, Math.max(0, next - Date.now()));
    this.timer.unref();
  }

  private async drainDue(): Promise<void> {
    for (const [id, retry] of this.retries) {
      if (this.stopped) break;
      if (retry.dueAt > Date.now()) continue;
      // Unexpected storage/queue failures must not leave a hot retry loop.
      this.retries.set(id, { ...retry, dueAt: Infinity });
      const record = this.deps.getRecord(id);
      if (!record) { this.retries.delete(id); continue; }
      this.defer(id);
    }
  }
}
