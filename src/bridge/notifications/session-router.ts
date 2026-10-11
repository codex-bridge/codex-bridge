import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";

/** Resolves Codex notifications to the Bridge session that owns the thread. */
export class NotificationSessionRouter {
  private readonly sessionIdByThread = new Map<string, string>();

  constructor(private readonly store: BridgeStore) {}

  remember(session: SessionRecord): void {
    this.sessionIdByThread.set(session.codexThreadId, session.id);
  }

  rememberSessionId(threadId: string, sessionId: string): void {
    this.sessionIdByThread.set(threadId, sessionId);
  }

  getRememberedSessionId(threadId: string): string | undefined {
    return this.sessionIdByThread.get(threadId);
  }

  // COMPATIBILITY(TEST): legacy service tests seed notification ownership directly.
  get compatibilityMap(): Map<string, string> {
    return this.sessionIdByThread;
  }

  clearThread(threadId: string): void {
    this.sessionIdByThread.delete(threadId);
  }

  clear(): void {
    this.sessionIdByThread.clear();
  }

  async resolve(threadId: string): Promise<SessionRecord | null> {
    const routedSessionId = this.sessionIdByThread.get(threadId);
    if (routedSessionId) {
      const session = await this.store.getSessionById(routedSessionId);
      if (session?.codexThreadId === threadId) {
        return session;
      }
      this.clearThread(threadId);
    }

    const route = this.store.getActiveTurnRoute(threadId);
    if (route) {
      const session = await this.store.getSessionById(route.sessionId);
      if (session?.codexThreadId === threadId) {
        this.remember(session);
        return session;
      }
    }
    return this.store.getSessionByThreadId(threadId);
  }
}
