import type { BridgeStore } from "../store/index.js";
import type { SessionRecord } from "../shared/types.js";
import { WEB_SOURCE_ID } from "../shared/source-address.js";
import type { SessionBindingEvent } from "../bridge/sessions/binding.js";
import type { AppServerTurnLifecycleEvent } from "../codex/client.js";
import type { WebMessageDelivery } from "./transport.js";
import type { WebAttentionEvent, WebAttentionKind } from "./attention-protocol.js";
export type { WebAttentionEvent } from "./attention-protocol.js";
export type WebAttentionDelivery = { event: WebAttentionEvent; isCurrent: () => boolean };

type AttentionStore = Pick<BridgeStore, "getSessionById" | "getSessionLease" | "getSessionBindingById" | "getActiveTurnRoute">;

/** Ephemeral attention signals, independent of message text, timeline selection and history. */
export class WebAttentionService {
  private readonly listeners = new Set<(delivery: WebAttentionDelivery) => void>();
  private readonly pendingBindings = new Set<string>();

  constructor(private readonly store: AttentionStore, private readonly directory: (session: SessionRecord) => string) {}

  subscribe(listener: (delivery: WebAttentionDelivery) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(session: SessionRecord, kind: WebAttentionKind, identity: string,
    extraGuard: () => boolean = () => true): void {
    const lease = this.store.getSessionLease(session.id);
    if (!lease) return;
    const version = lease.version;
    const owner = lease.ownerBindingId;
    const isCurrent = (): boolean => {
      const current = this.store.getSessionLease(session.id);
      return !!current && current.ownerBindingId === owner && current.version === version &&
        (current.state === "active" || current.state === "handoff_pending") && !!owner &&
        this.store.getSessionBindingById(owner)?.sourceId === WEB_SOURCE_ID && extraGuard();
    };
    if (!isCurrent()) return;
    const event: WebAttentionEvent = { id: `${kind}:${session.id}:${identity}`, kind, sessionId: session.id,
      threadId: session.codexThreadId, directory: this.directory(session), name: session.displayName,
      leaseVersion: version };
    for (const listener of this.listeners) {
      if (!isCurrent()) break;
      try { listener({ event, isCurrent }); } catch { /* A subscriber must not interrupt a Codex turn. */ }
    }
  }

  turnSettled(session: SessionRecord, event: AppServerTurnLifecycleEvent): void {
    if (event.kind !== "completed") return;
    const route = this.store.getActiveTurnRoute(event.threadId);
    if (route?.turnId !== event.turnId || route.sessionId !== session.id || route.sourceId !== WEB_SOURCE_ID) return;
    if (event.terminalState === "completed") this.publish(session, "turn-ended", event.turnId);
    else if (event.terminalState === "failed" || event.error) this.publish(session, "turn-failed", event.turnId);
    // An explicit interrupt without a terminal error is not an attention event.
  }

  runtimeStopped(session: SessionRecord, turnId: string): void {
    const route = this.store.getActiveTurnRoute(session.codexThreadId);
    if (route?.turnId === turnId && route.sourceId === WEB_SOURCE_ID) this.publish(session, "turn-failed", turnId);
  }

  async observeMessage(delivery: WebMessageDelivery): Promise<void> {
    const { event, isCurrent } = delivery;
    if (event.operation !== "send" && event.operation !== "edit") return;
    const decision = event.message?.decision;
    if (!decision || decision.unavailableReason || !["pending", "awaitingInput"].includes(decision.state) ||
      (!decision.inputAllowed && !decision.availableActions.length)) return;
    const session = await this.store.getSessionById(event.sessionId);
    if (session && session.codexArchivedAt === null && isCurrent()) {
      this.publish(session, decision.requiresUserInput ? "input-required" : "approval-required", decision.id, isCurrent);
    }
  }

  async observeBinding(event: SessionBindingEvent): Promise<void> {
    if (event.kind === "requested" && event.otherSourceId === WEB_SOURCE_ID) {
      this.pendingBindings.add(event.sessionId);
      // No persistent replay; bound memory even if sessions disappear before resolution.
      if (this.pendingBindings.size > 2048) this.pendingBindings.delete(this.pendingBindings.values().next().value!);
      return;
    }
    if (event.kind === "replaced" || event.kind === "cancelled" || event.kind === "transferred") {
      if (event.sourceId === WEB_SOURCE_ID) this.pendingBindings.delete(event.sessionId);
      return;
    }
    if (event.kind !== "acquired") return;
    const waited = this.pendingBindings.delete(event.sessionId);
    if (!waited || event.sourceId !== WEB_SOURCE_ID) return;
    const session = await this.store.getSessionById(event.sessionId);
    if (session && session.codexArchivedAt === null && this.store.getSessionLease(session.id)?.version === event.leaseVersion) {
      this.publish(session, "binding-acquired", String(event.leaseVersion));
    }
  }
}
