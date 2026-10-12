import { logger } from "../../logging/logger.js";
import { parseSourceAddress } from "../../shared/source-address.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore, SessionHandoffCancellation, SessionHandoffResult } from "../../store/index.js";

export function sourceLabel(sourceId: string): string {
  const platform = parseSourceAddress(sourceId).platform;
  return `${platform === "web" ? "Web" : platform === "slack" ? "Slack" : "Telegram"} · ${sourceId}`;
}

export type SessionBindingEvent = {
  kind: "requested" | "replaced" | "acquired" | "transferred" | "cancelled";
  sourceId: string;
  otherSourceId: string | null;
  sessionId: string;
  threadId: string;
  directory: string;
  leaseVersion: number;
};

export type SessionBindingResult = {
  session: SessionRecord | null;
  outcome: SessionHandoffResult | null;
};

/** Shared ownership rules. Explicit requests record intent; promotion never rewrites it. */
export class SessionBindingService {
  private readonly listeners = new Set<(event: SessionBindingEvent) => void>();
  private readonly dispatchesByThread = new Map<string, number>();

  constructor(private readonly deps: {
    store: BridgeStore;
    inFlightTurnIdByThread: Map<string, string>;
    getSessionDirectory: (session: SessionRecord) => string;
    notify: (event: SessionBindingEvent) => Promise<void>;
    onStateChanged?: (sourceId: string) => Promise<void>;
  }) {}

  subscribe(listener: (event: SessionBindingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Covers the gap before a start/steer response supplies a real turn ID. */
  async runDispatch<T>(session: SessionRecord, operation: () => Promise<T>): Promise<T> {
    const threadId = session.codexThreadId;
    this.dispatchesByThread.set(threadId, (this.dispatchesByThread.get(threadId) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.dispatchesByThread.get(threadId) ?? 1) - 1;
      if (remaining) this.dispatchesByThread.set(threadId, remaining);
      else this.dispatchesByThread.delete(threadId);
      // Accepted work now has its normal route/turn blocker; rejected work can hand off.
      await this.promote(session).catch((error) => {
        logger.warn("bridge.session.dispatch_handoff_failed", { sessionId: session.id, error: String(error) });
      });
    }
  }

  private isBusy(threadId: string): boolean {
    return this.hasPendingDispatch(threadId) || this.deps.inFlightTurnIdByThread.has(threadId);
  }

  hasPendingDispatch(threadId: string): boolean {
    return this.dispatchesByThread.has(threadId);
  }

  async request(sourceId: string, sessionId: string, expectedVersion?: number, assertCurrent: () => void = () => {},
    options?: { select: boolean }): Promise<SessionBindingResult> {
    const session = await this.deps.store.getSessionById(sessionId);
    assertCurrent();
    if (!session || session.codexArchivedAt !== null) return { session, outcome: null };
    // Everything from this check through the transaction is synchronous.
    const outcome = this.deps.store.requestSessionHandoff(session.id, sourceId,
      !this.isBusy(session.codexThreadId), expectedVersion, options?.select ?? true);
    const events: SessionBindingEvent[] = [];
    if (outcome.replacedSourceId) events.push(this.event(session, "replaced", outcome.replacedSourceId, sourceId, outcome.lease.version));
    if (outcome.owned && outcome.reason === "claimed") {
      events.push(...this.transferEvents(session, sourceId, outcome.previousOwnerSourceId, outcome.lease.version));
    } else if (outcome.pending && outcome.previousOwnerSourceId) {
      events.push(this.event(session, "requested", outcome.previousOwnerSourceId, sourceId, outcome.lease.version));
    }
    await this.publish(events, sourceId);
    return { session, outcome };
  }

  async cancel(sourceId: string, sessionId: string, expectedVersion?: number, assertCurrent: () => void = () => {}): Promise<SessionHandoffCancellation> {
    const session = await this.deps.store.getSessionById(sessionId);
    assertCurrent();
    const result = this.deps.store.cancelSessionHandoff(sessionId, sourceId, expectedVersion);
    if (result.cancelled && session && result.lease) {
      await this.publish([this.event(session, "cancelled", sourceId, null, result.lease.version)], sourceId);
    }
    return result;
  }

  async promote(session: SessionRecord): Promise<void> {
    if (this.isBusy(session.codexThreadId)) return;
    const previous = this.deps.store.getSessionLease(session.id);
    const promoted = this.deps.store.promotePendingSessionOwner(session.id, null);
    if (!promoted?.ownerBindingId) return;
    const owner = this.deps.store.getSessionBindingById(promoted.ownerBindingId);
    const old = previous?.ownerBindingId ? this.deps.store.getSessionBindingById(previous.ownerBindingId) : null;
    if (owner) await this.publish(this.transferEvents(session, owner.sourceId, old?.sourceId ?? null, promoted.version));
  }

  private event(session: SessionRecord, kind: SessionBindingEvent["kind"], sourceId: string, otherSourceId: string | null, leaseVersion: number): SessionBindingEvent {
    return { kind, sourceId, otherSourceId, sessionId: session.id, threadId: session.codexThreadId,
      directory: this.deps.getSessionDirectory(session), leaseVersion };
  }

  private transferEvents(session: SessionRecord, owner: string, old: string | null, version: number): SessionBindingEvent[] {
    return [this.event(session, "acquired", owner, old, version),
      ...(old && old !== owner ? [this.event(session, "transferred", old, owner, version)] : [])];
  }

  private async publish(events: SessionBindingEvent[], replySourceId?: string): Promise<void> {
    // All synchronous metadata events follow transaction order even while a chat delivery awaits I/O.
    for (const event of events) {
      for (const listener of this.listeners) {
        try { listener(event); } catch (error) { this.logDeliveryFailure(event, error); }
      }
    }
    for (const sourceId of new Set([...events.map((event) => event.sourceId),
      ...(replySourceId ? [replySourceId] : [])])) {
      try { await this.deps.onStateChanged?.(sourceId); }
      catch (error) { logger.warn("bridge.session.card_update_failed", { sourceId, error: String(error) }); }
    }
    for (const event of events) {
      // The requesting chat gets its synchronous action response instead of a duplicate notification.
      if (event.sourceId === replySourceId) continue;
      try { await this.deps.notify(event); } catch (error) { this.logDeliveryFailure(event, error); }
    }
  }

  private logDeliveryFailure(event: SessionBindingEvent, error: unknown): void {
    logger.warn("bridge.session.binding_notification_failed", {
      sessionId: event.sessionId, kind: event.kind, error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function bindingEventText(event: SessionBindingEvent): string {
  const other = event.otherSourceId ? sourceLabel(event.otherSourceId) : "another conversation";
  switch (event.kind) {
    case "requested": return `${other} requested this session. Current work stays here; the latest request takes effect when accepted work finishes.`;
    case "replaced": return `Your pending session request was replaced by ${other}.`;
    case "acquired": return "Session is now bound to this conversation.";
    case "transferred": return `Session was transferred to ${other}.`;
    case "cancelled": return "Your pending session request was cancelled.";
  }
}
