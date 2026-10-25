import type { ProgressPhaseDeliveryState, ProgressPhaseMessageRecord } from "../../shared/types.js";
import { logger } from "../../logging/logger.js";
import { createMessage } from "../messages/factory.js";
import { truncateTemporaryMessageSpec } from "../messages/temporary.js";
import { createProgressPhaseSummarySpec } from "../renderers/progress.js";
import type { PhaseDeliveryAdapter } from "./delivery.js";

type FinalDeliveryDependencies = {
  getRecord: (id: string) => ProgressPhaseMessageRecord | null;
  listPending: () => ProgressPhaseMessageRecord[];
  mark: (input: { id: string; deliveryState: ProgressPhaseDeliveryState; correctionMessageId?: string | null }) => unknown;
  enqueue: (key: string, operation: () => Promise<void>) => Promise<void>;
};

const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

/** Only edits known message IDs. Never sends messages or controls Codex work. */
export class FinalProgressDelivery {
  private readonly retries = new Map<string, { attempts: number; dueAt: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly deps: FinalDeliveryDependencies, private readonly delivery: PhaseDeliveryAdapter) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.retries.clear();
    for (const record of this.deps.listPending()) this.retries.set(record.id, { attempts: 0, dueAt: Date.now() });
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
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
      || record.deliveryState === "unavailable") {
      this.retries.delete(id);
      return;
    }
    const summary = truncateTemporaryMessageSpec(createProgressPhaseSummarySpec({ directory: record.directory, record }));
    let result = record.deliveryState === "synced" ? "synced" as const
      : await this.delivery.editResult(record.sourceId, record.platformMessageId, summary);
    if (result === "synced" && record.correctionMessageId) {
      this.deps.mark({ id, deliveryState: "synced" });
      // Old placeholder messages are resolved in place, never deleted or replaced by a new send.
      result = await this.delivery.editResult(record.sourceId, record.correctionMessageId, createMessage({
        kind: "system", titleLabel: "System", session: { id: null, directory: record.directory },
        body: [{ type: "text", text: "Progress summary synced." }]
      }));
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
      await this.deps.enqueue(`${record.codexThreadId}:${record.turnId}`, async () => {
        if (!this.stopped) await this.deliver(id);
      });
    }
  }
}
