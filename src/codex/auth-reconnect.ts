import { unwatchFile, watchFile, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseDotenv } from "dotenv";

import { logger } from "../logging/logger.js";
import { getCodexEnvFilePath, readCodexAuthIdentity } from "./auth-identity.js";

export type AuthReconnectCoordinatorDependencies = {
  authFilePath: string;
  isIdle: () => boolean;
  notifyReconnected: () => void;
  reconnect: () => Promise<void>;
  transport: "stdio" | "websocket";
};

export class AuthReconnectCoordinator {
  private authCheckTimer: NodeJS.Timeout | null = null;
  private authIdentity: string | null = null;
  private authReconnectPending = false;
  private authReconnectPromise: Promise<void> | null = null;
  private authReconnectRetryTimer: NodeJS.Timeout | null = null;
  private authWatchCallback: ((current: Stats, previous: Stats) => void) | null = null;

  constructor(private readonly deps: AuthReconnectCoordinatorDependencies) {}

  start(): void {
    if (this.authWatchCallback || this.deps.transport !== "stdio") {
      return;
    }

    this.authIdentity = readCodexAuthIdentity(this.deps.authFilePath);
    this.authWatchCallback = (current, previous) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.ino === previous.ino
      ) {
        return;
      }
      this.scheduleIdentityCheck();
    };
    watchFile(this.deps.authFilePath, { interval: 1_000, persistent: false }, this.authWatchCallback);
    logger.info("codex.auth.watch.started", { authFile: this.deps.authFilePath });
  }

  stop(): void {
    if (this.authCheckTimer) {
      clearTimeout(this.authCheckTimer);
      this.authCheckTimer = null;
    }
    if (this.authReconnectRetryTimer) {
      clearTimeout(this.authReconnectRetryTimer);
      this.authReconnectRetryTimer = null;
    }
    if (this.authWatchCallback) {
      unwatchFile(this.deps.authFilePath, this.authWatchCallback);
      this.authWatchCallback = null;
    }
  }

  handleTurnCompleted(): void {
    this.reconnectAfterAuthChange();
  }

  private scheduleIdentityCheck(): void {
    if (this.authCheckTimer) {
      clearTimeout(this.authCheckTimer);
    }
    this.authCheckTimer = setTimeout(() => {
      this.authCheckTimer = null;
      this.checkIdentity();
    }, 250);
    this.authCheckTimer.unref();
  }

  private checkIdentity(): void {
    const nextIdentity = readCodexAuthIdentity(this.deps.authFilePath);
    if (!nextIdentity || nextIdentity === this.authIdentity) {
      return;
    }

    const previousIdentity = this.authIdentity;
    this.authIdentity = nextIdentity;
    this.authReconnectPending = true;
    logger.info("codex.auth.identity_changed", {
      authFile: this.deps.authFilePath,
      hadPreviousIdentity: Boolean(previousIdentity),
      reconnect: this.deps.isIdle() ? "now" : "after_turn"
    });
    this.reconnectAfterAuthChange();
  }

  private reconnectAfterAuthChange(): void {
    if (!this.authReconnectPending || !this.deps.isIdle() || this.authReconnectPromise) {
      return;
    }

    this.authReconnectPending = false;
    this.authReconnectPromise = this.deps.reconnect()
      .then(() => {
        this.deps.notifyReconnected();
        logger.info("codex.auth.reconnected", { authFile: this.deps.authFilePath });
      })
      .catch((error) => {
        this.authReconnectPending = true;
        logger.warn("codex.auth.reconnect_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        this.scheduleRetry();
      })
      .finally(() => {
        this.authReconnectPromise = null;
        if (this.authReconnectPending && !this.authReconnectRetryTimer) {
          this.reconnectAfterAuthChange();
        }
      });
  }

  private scheduleRetry(): void {
    if (this.authReconnectRetryTimer) {
      return;
    }
    this.authReconnectRetryTimer = setTimeout(() => {
      this.authReconnectRetryTimer = null;
      this.reconnectAfterAuthChange();
    }, 1_000);
    this.authReconnectRetryTimer.unref();
  }
}

export async function readCodexEnvironment(): Promise<Record<string, string>> {
  const path = getCodexEnvFilePath();
  try {
    const raw = await readFile(path, "utf8");
    const values = parseDotenv(raw);
    logger.info("codex.env.loaded", { path, variableCount: Object.keys(values).length });
    return values;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
    if (code === "ENOENT") {
      logger.info("codex.env.missing", { path });
    } else {
      logger.warn("codex.env.load_failed", {
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return {};
  }
}
