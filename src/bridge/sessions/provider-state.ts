import type { CodexAppServerClient } from "../../codex/client.js";
import type { CodexConfigSnapshot } from "../../codex/config-snapshot.js";
import { resolveCodexProvider } from "../../codex/provider.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";

export type SessionProviderDetails = {
  activeProvider: string | null;
  configError: string | null;
  configOrigin: string | null;
  effectiveProvider: string | null;
};

export type SessionProviderMismatch = {
  configProvider: string;
  threadProvider: string;
};

export type SessionProviderStateDependencies = {
  codexClient: Pick<CodexAppServerClient, "readThreadStatus" | "readCodexConfigSnapshot" | "getObservedThreadModel">;
  isRuntimeConnected: () => boolean;
  canReadThreadStatus: () => boolean;
  getSessionDirectory: (session: SessionRecord) => string;
  formatShortError: (error: string) => string;
};

export class SessionProviderStateService {
  constructor(private readonly deps: SessionProviderStateDependencies) {}

  async getSessionProviderDetails(
    session: SessionRecord,
    options?: {
      activeProvider?: string | null;
      configError?: string | null;
      readActive?: boolean;
      snapshot?: CodexConfigSnapshot | null;
    }
  ): Promise<SessionProviderDetails> {
    let activeProvider =
      options && "activeProvider" in options ? (options.activeProvider ?? null) : null;
    if (
      activeProvider === null &&
      options?.readActive &&
      this.deps.isRuntimeConnected() &&
      this.deps.canReadThreadStatus()
    ) {
      try {
        const threadStatus = await this.deps.codexClient.readThreadStatus(
          session.codexThreadId,
          this.deps.getSessionDirectory(session)
        );
        activeProvider = threadStatus.modelProvider;
      } catch (error) {
        logger.warn("bridge.session.provider_active_read_failed", {
          sessionId: session.id,
          threadId: session.codexThreadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    let snapshot = options?.snapshot ?? null;
    let configError = options?.configError ?? null;
    if (!(options && "snapshot" in options) && this.deps.isRuntimeConnected()) {
      const config = await this.readEffectiveConfigSnapshot(this.deps.getSessionDirectory(session));
      snapshot = config.snapshot;
      configError = config.error;
    } else if (!this.deps.isRuntimeConnected()) {
      configError = "runtime disconnected";
    }

    return {
      activeProvider,
      configError,
      configOrigin: snapshot?.origins?.model_provider?.type ?? null,
      effectiveProvider: snapshot?.modelProvider ?? null
    };
  }

  async readEffectiveConfigSnapshot(directory: string): Promise<{
    snapshot: CodexConfigSnapshot | null;
    error: string | null;
  }> {
    const reader = this.deps.codexClient.readCodexConfigSnapshot;
    if (typeof reader !== "function") {
      return { snapshot: null, error: "config/read unavailable" };
    }
    try {
      return { snapshot: await reader.call(this.deps.codexClient, directory), error: null };
    } catch (error) {
      return {
        snapshot: null,
        error: this.deps.formatShortError(error instanceof Error ? error.message : String(error))
      };
    }
  }

  async resolveModelForRateLimit(session: SessionRecord): Promise<string | null> {
    const observed = this.deps.codexClient.getObservedThreadModel?.(session.codexThreadId) ?? null;
    if (observed) return observed;
    const config = await this.readEffectiveConfigSnapshot(this.deps.getSessionDirectory(session));
    return config.snapshot?.model ?? null;
  }

  async findProviderMismatch(
    session: SessionRecord,
    snapshot?: CodexConfigSnapshot
  ): Promise<SessionProviderMismatch | null> {
    if (
      !this.deps.isRuntimeConnected() ||
      !this.deps.canReadThreadStatus() ||
      typeof this.deps.codexClient.readCodexConfigSnapshot !== "function"
    ) {
      return null;
    }

    const directory = this.deps.getSessionDirectory(session);
    try {
      const [threadStatus, resolvedSnapshot] = await Promise.all([
        this.deps.codexClient.readThreadStatus(
          session.codexThreadId,
          directory,
          { readOnly: true, timeoutMs: 3_000 }
        ),
        snapshot ?? this.deps.codexClient.readCodexConfigSnapshot(directory)
      ]);
      const threadProvider = threadStatus.modelProvider;
      const configProvider = resolveCodexProvider(resolvedSnapshot.modelProvider);
      if (!threadProvider || threadProvider === configProvider) return null;
      return { threadProvider, configProvider };
    } catch (error) {
      logger.warn("bridge.session.provider_mismatch_read_failed", {
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  getProviderDetailsValues(details: SessionProviderDetails): { config: string; thread: string } {
    return {
      config: details.configError
        ? `unavailable (${details.configError})`
        : `${details.effectiveProvider ?? "built-in default"}${details.configOrigin ? ` (${details.configOrigin})` : ""}`,
      thread: details.activeProvider ?? "unknown"
    };
  }

  async readEffectiveProviderLabel(directory: string): Promise<string> {
    if (!this.deps.isRuntimeConnected()) return "unknown";
    const config = await this.readEffectiveConfigSnapshot(directory);
    if (config.snapshot) {
      return config.snapshot.modelProvider ?? "built-in default";
    }
    if (config.error) {
      logger.warn("bridge.session.provider_config_read_failed", {
        directory,
        error: config.error
      });
    }
    return "unknown";
  }

  async readEffectiveProviderForFilter(directory: string): Promise<string | null> {
    const config = await this.readEffectiveConfigSnapshot(directory);
    return config.snapshot ? resolveCodexProvider(config.snapshot.modelProvider) : null;
  }
}
