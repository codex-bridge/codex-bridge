import { compareCodexVersions } from "../../codex/version-reader.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";

type TimerHandle = ReturnType<typeof setInterval>;

export type CodexVersionUpdate = {
  baseline: string;
  latest: string;
};

export type VersionUpdateNotifierDependencies = {
  readInstalledVersion: () => Promise<string | null>;
  readLatestVersion: () => Promise<string | null>;
  deliver: (session: SessionRecord, sourceId: string, update: CodexVersionUpdate,
    canSend: () => Promise<boolean>) => Promise<boolean>;
  intervalMs?: number;
  scheduleInterval?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearScheduledInterval?: (timer: TimerHandle) => void;
};

/** One process-wide reminder per new release; checks continue after a reminder. */
export class VersionUpdateNotifier {
  private installed: string | null = null;
  private pending: CodexVersionUpdate | null = null;
  private lastAttemptedVersion: string | null = null;
  private delivering = false;
  private timer: TimerHandle | null = null;
  private checkPromise: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly deps: VersionUpdateNotifierDependencies) {}

  start(): Promise<void> {
    if (this.timer) return this.checkPromise ?? Promise.resolve();
    const schedule = this.deps.scheduleInterval ?? setInterval;
    this.timer = schedule(() => { void this.checkNow(); }, this.deps.intervalMs ?? 24 * 60 * 60 * 1_000);
    this.timer.unref();
    return this.checkNow();
  }

  stop(): void {
    if (this.timer) (this.deps.clearScheduledInterval ?? clearInterval)(this.timer);
    this.timer = null;
    this.generation++;
    this.checkPromise = null;
  }

  checkNow(): Promise<void> {
    if (this.checkPromise) return this.checkPromise;
    const check = this.performCheck(this.generation).finally(() => {
      if (this.checkPromise === check) this.checkPromise = null;
    });
    this.checkPromise = check;
    return check;
  }

  async deliverBeforeActions(session: SessionRecord, sourceId: string, canSend: () => Promise<boolean>): Promise<boolean> {
    if (!this.pending || this.delivering) return false;
    const update = this.pending;
    if (this.lastAttemptedVersion && compareCodexVersions(update.latest, this.lastAttemptedVersion) <= 0) {
      this.pending = null;
      return false;
    }
    const generation = this.generation;
    this.delivering = true;
    this.pending = null; // Reserve synchronously across concurrent sessions.
    let attempted = false;
    const authorizeSend = async () => {
      if (!await canSend() || generation !== this.generation || !this.installed ||
          compareCodexVersions(update.latest, this.installed) <= 0) return false;
      attempted = true;
      this.lastAttemptedVersion = update.latest;
      return true;
    };
    try {
      if (!await canSend() || generation !== this.generation) return false;
      const sent = await this.deps.deliver(session, sourceId, update, authorizeSend);
      if (sent) {
        attempted = true;
        this.lastAttemptedVersion = update.latest;
        logger.info("bridge.codex_version_update.sent", {
          sessionId: session.id, baseline: update.baseline, latest: update.latest
        });
      }
      return sent;
    } catch (error) {
      logger.warn("bridge.codex_version_update.delivery_failed", {
        sessionId: session.id, baseline: update.baseline, latest: update.latest,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    } finally {
      this.delivering = false;
      // Only a skipped send may be deferred. Unknown network outcomes never replay.
      if (!attempted && generation === this.generation) this.defer(update);
    }
  }

  private defer(update: CodexVersionUpdate): void {
    if (this.installed && compareCodexVersions(update.latest, this.installed) > 0 &&
        (!this.pending || compareCodexVersions(update.latest, this.pending.latest) > 0)) {
      this.pending = { ...update, baseline: this.installed };
    }
  }

  private async performCheck(generation: number): Promise<void> {
    try {
      const installed = await this.deps.readInstalledVersion();
      if (generation !== this.generation || !installed) return;
      this.installed = installed;
      if (this.pending && compareCodexVersions(this.pending.latest, installed) <= 0) this.pending = null;
      const latest = await this.deps.readLatestVersion();
      if (generation !== this.generation || !latest) return;
      if (compareCodexVersions(latest, installed) <= 0 ||
          (this.lastAttemptedVersion && compareCodexVersions(latest, this.lastAttemptedVersion) <= 0)) {
        this.pending = null;
        return;
      }
      this.pending = { baseline: installed, latest };
      logger.info("bridge.codex_version_update.pending", { baseline: installed, latest });
    } catch (error) {
      logger.warn("bridge.codex_version_update.check_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
