import { logger } from "../logging/logger.js";

export type ProviderReconnectCoordinatorDependencies = {
  isIdle: () => boolean;
  notifyReconnected: () => void;
  reconnect: () => Promise<void>;
};

export class ProviderReconnectCoordinator {
  private readonly lastProviderByCwd = new Map<string, string | null>();
  private pending = false;
  private reconnectPromise: Promise<void> | null = null;

  constructor(private readonly deps: ProviderReconnectCoordinatorDependencies) {}

  observe(cwd: string, provider: string | null): boolean {
    const hadPrevious = this.lastProviderByCwd.has(cwd);
    const previous = this.lastProviderByCwd.get(cwd);
    this.lastProviderByCwd.set(cwd, provider);
    if (!hadPrevious || previous === provider) {
      return false;
    }

    this.pending = true;
    logger.info("codex.provider.changed", {
      previousProvider: previous,
      nextProvider: provider,
      reconnect: this.deps.isIdle() ? "now" : "after_turn"
    });
    return true;
  }

  markPending(): void {
    this.pending = true;
  }

  async reconnectWhenIdle(): Promise<void> {
    if (!this.pending || !this.deps.isIdle()) {
      return;
    }
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    this.pending = false;
    this.reconnectPromise = this.deps.reconnect()
      .then(() => {
        this.deps.notifyReconnected();
        logger.info("codex.provider.reconnected");
      })
      .catch((error) => {
        this.pending = true;
        logger.warn("codex.provider.reconnect_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        throw new Error(
          `Codex provider reconnect failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        this.reconnectPromise = null;
      });

    return this.reconnectPromise;
  }

  handleTurnCompleted(): void {
    void this.reconnectWhenIdle().catch((error) => {
      logger.warn("codex.provider.reconnect_deferred_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}
