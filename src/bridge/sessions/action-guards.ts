import { BridgeStore } from "../../store/index.js";

export type SessionActionGuard = "archive" | "delete" | "releaseBridge";

export type SessionActionGuardDependencies = {
  store: BridgeStore;
  inFlightTurnIdByThread: Map<string, string>;
  hasPendingDispatch: (threadId: string) => boolean;
  buildCallback: (action: SessionActionGuard, sessionId: string, leaseVersion: number) => string;
};

export class SessionActionGuardService {
  constructor(private readonly deps: SessionActionGuardDependencies) {}

  async isAvailable(chatId: string, sessionId: string): Promise<boolean> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return false;
    const lease = this.deps.store.getSessionLease(session.id);
    const binding = this.deps.store.getSessionBinding(session.id, chatId);
    if (!lease || !binding || lease.ownerBindingId !== binding.id ||
      (lease.state !== "active" && lease.state !== "handoff_pending")) {
      return false;
    }
    // Releasing or mutating an owner must not silently discard a newer handoff request.
    if (lease.pendingBindingId || lease.ownerTurnId || this.deps.hasPendingDispatch(session.codexThreadId) ||
      this.deps.inFlightTurnIdByThread.has(session.codexThreadId)) return false;
    if (await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId) > 0) return false;
    if ((await this.deps.store.listPendingDecisions(session.id)).length > 0) return false;
    if (await this.deps.store.getAwaitingInputDecisionForSession(session.id)) return false;
    return true;
  }

  async getCallback(chatId: string, sessionId: string, action: SessionActionGuard): Promise<string | null> {
    if (!await this.isAvailable(chatId, sessionId)) return null;
    const lease = this.deps.store.getSessionLease(sessionId);
    if (!lease) return null;
    return this.deps.buildCallback(action, sessionId, lease.version);
  }
}
