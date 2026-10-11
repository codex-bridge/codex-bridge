import type { SessionRecord } from "../../shared/types.js";
import type { BridgeMessageTransport } from "../transport.js";
import { logger } from "../../logging/logger.js";
import { extractRetryAfterSeconds } from "../../codex/error-policy.js";

export type TypingServiceDependencies = {
  intervalMs: number;
  requireMessageTransport: (chatId: string) => BridgeMessageTransport;
};

export class TypingService {
  private readonly statusAt = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: TypingServiceDependencies) {}

  clear(sessionId: string): void {
    this.statusAt.delete(sessionId);
    this.cooldownUntil.delete(sessionId);
    this.inFlight.delete(sessionId);
  }

  clearAll(): void {
    this.statusAt.clear();
    this.cooldownUntil.clear();
    this.inFlight.clear();
  }

  resetStatus(sessionId: string): void {
    this.statusAt.delete(sessionId);
  }

  async sendOnce(session: SessionRecord): Promise<void> {
    const now = Date.now();
    const cooldownUntil = this.cooldownUntil.get(session.id) ?? 0;
    if (now < cooldownUntil || this.inFlight.has(session.id)) return;
    const lastTypingAt = this.statusAt.get(session.id) ?? 0;
    if (now - lastTypingAt < this.deps.intervalMs) return;

    this.inFlight.add(session.id);
    this.statusAt.set(session.id, now);
    try {
      await this.deps.requireMessageTransport(session.telegramChatId).sendTyping(session.telegramChatId);
      this.cooldownUntil.delete(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAfterSeconds = extractRetryAfterSeconds(message);
      if (retryAfterSeconds > 0) {
        this.cooldownUntil.set(session.id, Date.now() + retryAfterSeconds * 1000);
      }
      logger.warn("bridge.status.typing_failed", {
        sessionId: session.id,
        retryAfterSeconds: retryAfterSeconds || null,
        error: message
      });
    } finally {
      this.inFlight.delete(session.id);
    }
  }
}
