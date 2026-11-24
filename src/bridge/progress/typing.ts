import type { SessionRecord } from "../../shared/types.js";
import type { BridgeMessageTransport } from "../transport.js";
import { logger } from "../../logging/logger.js";
import { extractRetryAfterSeconds } from "../../codex/error-policy.js";

export type TypingServiceDependencies = {
  waitForThreadIdle?: (threadId: string, signal: AbortSignal) => Promise<boolean>;
  intervalMs: number;
  requireMessageTransport: (chatId: string) => BridgeMessageTransport;
};

export class TypingService {
  private readonly statusAt = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly inFlight = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly deps: TypingServiceDependencies) {}

  stop(): void { this.stopped = true; this.clearAll(); }

  clear(sessionId: string): void {
    this.inFlight.get(sessionId)?.abort();
    this.statusAt.delete(sessionId);
    this.cooldownUntil.delete(sessionId);
    this.inFlight.delete(sessionId);
  }

  clearAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.statusAt.clear();
    this.cooldownUntil.clear();
    this.inFlight.clear();
  }

  resetStatus(sessionId: string): void {
    this.statusAt.delete(sessionId);
  }

  async sendOnce(session: SessionRecord, canRefresh?: () => boolean): Promise<void> {
    if (this.stopped || canRefresh?.() === false) return;
    const now = Date.now();
    const cooldownUntil = this.cooldownUntil.get(session.id) ?? 0;
    if (now < cooldownUntil || this.inFlight.has(session.id)) return;
    const lastTypingAt = this.statusAt.get(session.id) ?? 0;
    if (now - lastTypingAt < this.deps.intervalMs) return;

    const token = new AbortController();
    this.inFlight.set(session.id, token);
    this.statusAt.set(session.id, now);
    try {
      if (this.deps.waitForThreadIdle && !await this.deps.waitForThreadIdle(session.codexThreadId, token.signal)) return;
      if (this.inFlight.get(session.id) !== token || canRefresh?.() === false) return;
      await this.deps.requireMessageTransport(session.telegramChatId).sendTyping(session.telegramChatId, {
        canSend: async () => this.inFlight.get(session.id) === token && canRefresh?.() !== false
      });
      if (this.inFlight.get(session.id) === token) this.cooldownUntil.delete(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAfterSeconds = extractRetryAfterSeconds(message);
      if (retryAfterSeconds > 0 && this.inFlight.get(session.id) === token) {
        this.cooldownUntil.set(session.id, Date.now() + retryAfterSeconds * 1000);
      }
      logger.warn("bridge.status.typing_failed", {
        sessionId: session.id,
        retryAfterSeconds: retryAfterSeconds || null,
        error: message
      });
    } finally {
      if (this.inFlight.get(session.id) === token) this.inFlight.delete(session.id);
    }
  }
}
