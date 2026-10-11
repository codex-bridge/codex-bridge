import { compareCodexVersions } from "../../codex/version-reader.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";

type TimerHandle = ReturnType<typeof setInterval>;

export type CodexVersionUpdate = {
  baseline: string;
  latest: string;
};

export type VersionUpdateNotifierDependencies = {
  readVersion: () => Promise<string | null>;
  deliver: (session: SessionRecord, update: CodexVersionUpdate) => Promise<void>;
  intervalMs?: number;
  scheduleInterval?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearScheduledInterval?: (timer: TimerHandle) => void;
};

type DeliveryState = "idle" | "pending" | "delivering" | "sent";

export class VersionUpdateNotifier {
  private baseline: string | null = null;
  private pendingLatest: string | null = null;
  private deliveryState: DeliveryState = "idle";
  private timer: TimerHandle | null = null;
  private checkPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly deps: VersionUpdateNotifierDependencies) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    return this.startPromise;
  }

  stop(): void {
    if (!this.timer) return;
    (this.deps.clearScheduledInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  checkNow(): Promise<void> {
    if (this.checkPromise) return this.checkPromise;
    const check = this.performCheck().finally(() => {
      if (this.checkPromise === check) this.checkPromise = null;
    });
    this.checkPromise = check;
    return check;
  }

  async deliverAfterRootTurn(session: SessionRecord | null): Promise<boolean> {
    if (
      !session ||
      this.deliveryState !== "pending" ||
      !this.baseline ||
      !this.pendingLatest
    ) {
      return false;
    }

    const update = { baseline: this.baseline, latest: this.pendingLatest };
    this.deliveryState = "delivering";
    try {
      await this.deps.deliver(session, update);
      this.pendingLatest = null;
      this.deliveryState = "sent";
      this.stop();
      logger.info("bridge.codex_version_update.sent", {
        sessionId: session.id,
        baseline: update.baseline,
        latest: update.latest
      });
      return true;
    } catch (error) {
      this.deliveryState = "pending";
      logger.warn("bridge.codex_version_update.delivery_failed", {
        sessionId: session.id,
        baseline: update.baseline,
        latest: update.latest,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async startOnce(): Promise<void> {
    await this.checkNow();
    if (this.deliveryState === "sent" || this.timer) return;
    const schedule = this.deps.scheduleInterval ?? setInterval;
    this.timer = schedule(() => {
      void this.checkNow();
    }, this.deps.intervalMs ?? 60 * 60 * 1_000);
    this.timer.unref();
  }

  private async performCheck(): Promise<void> {
    if (this.deliveryState === "sent") return;
    let current: string | null;
    try {
      current = await this.deps.readVersion();
    } catch (error) {
      logger.warn("bridge.codex_version_update.check_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (!current) return;
    if (!this.baseline) {
      this.baseline = current;
      logger.info("bridge.codex_version_update.baseline", { version: current });
      return;
    }
    if (this.deliveryState === "delivering") return;
    if (compareCodexVersions(current, this.baseline) <= 0) return;
    if (this.pendingLatest && compareCodexVersions(current, this.pendingLatest) <= 0) return;
    this.pendingLatest = current;
    this.deliveryState = "pending";
    logger.info("bridge.codex_version_update.pending", {
      baseline: this.baseline,
      latest: current
    });
  }
}
