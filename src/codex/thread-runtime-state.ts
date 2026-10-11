import type { AppServerThreadStatus } from "./client.js";

const MAX_OBSERVED_THREAD_SETTINGS = 256;

export class ThreadRuntimeState {
  private readonly observedThreadSettings = new Map<string, AppServerThreadStatus>();
  private readonly activeTurnIds = new Set<string>();
  private turnStartInFlight = 0;

  isIdle(): boolean {
    return this.activeTurnIds.size === 0 && this.turnStartInFlight === 0;
  }

  getObservedSettings(threadId: string): AppServerThreadStatus | undefined {
    return this.observedThreadSettings.get(threadId);
  }

  getObservedModel(threadId: string): string | null {
    return this.getObservedSettings(threadId)?.model ?? null;
  }

  getObservedProvider(threadId: string): string | null {
    return this.getObservedSettings(threadId)?.modelProvider ?? null;
  }

  rememberSettings(threadId: string, settings: AppServerThreadStatus): void {
    this.observedThreadSettings.set(threadId, settings);
    if (this.observedThreadSettings.size > MAX_OBSERVED_THREAD_SETTINGS) {
      this.observedThreadSettings.delete(this.observedThreadSettings.keys().next().value!);
    }
  }

  beginTurnStart(): void {
    this.turnStartInFlight += 1;
  }

  finishTurnStart(): void {
    this.turnStartInFlight = Math.max(0, this.turnStartInFlight - 1);
  }

  trackTurnLifecycle(kind: "started" | "completed", turnId: string): void {
    if (kind === "started") {
      this.activeTurnIds.add(turnId);
    } else {
      this.activeTurnIds.delete(turnId);
    }
  }

  updateObservedServiceTier(
    threadId: string,
    observed: AppServerThreadStatus | undefined,
    serviceTier: unknown
  ): void {
    if (!observed || this.observedThreadSettings.get(threadId) !== observed) {
      return;
    }
    // A requested tier is not evidence that the provider applied it.
    observed.serviceTier = typeof serviceTier === "string" ? serviceTier : null;
    observed.serviceTierKnown = serviceTier !== undefined;
  }

  updateObservedModel(threadId: string, model: string): void {
    const observed = this.observedThreadSettings.get(threadId);
    if (!observed) return;
    observed.model = model;
  }

  handleConnectionLost(expected: boolean): void {
    this.observedThreadSettings.clear();
    if (expected) {
      this.activeTurnIds.clear();
      this.turnStartInFlight = 0;
    }
  }
}
