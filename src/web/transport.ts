import crypto from "node:crypto";
import type { BridgeStore } from "../store/index.js";
import type { BridgeMessageOptions, BridgeMessageTransport, BridgeSentMessage } from "../bridge/transport.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { messageTransportPlatform, WEB_SOURCE_ID } from "../shared/source-address.js";
import type { SessionBindingEvent } from "../bridge/sessions/binding.js";
import { presentWebDecision } from "./decisions.js";
import { presentWebMessage, type WebMessageSpec } from "./message-presentation.js";

export type WebMessageEvent = {
  operation: "send" | "edit" | "delete" | "clear-actions";
  sessionId: string;
  threadId: string;
  leaseVersion: number;
  messageId: string;
  message?: WebMessageSpec;
};
export type WebMessageDelivery = { event: WebMessageEvent; isCurrent: () => boolean };
type MessageTarget = { sessionId: string; threadId: string; leaseVersion: number; active: boolean };

/** Ephemeral native events, never a replay buffer or a second conversation store. */
export class WebMessageTransport implements BridgeMessageTransport {
  readonly name = "web";
  readonly wholeMessageSpecs = true;
  private readonly targets = new Map<string, MessageTarget>();
  private readonly listeners = new Set<(delivery: WebMessageDelivery) => void>();

  constructor(private readonly store: Pick<BridgeStore,
    "getSessionById" | "getSessionLease" | "getSessionBindingById" | "getActiveTurnRoute" | "getDecision">,
    private readonly runtime?: { isRuntimeConnected: () => boolean; isApprovalPending: (approvalId: string) => boolean }) {}

  private async prepareSpec(spec: MessageSpec, target: MessageTarget): Promise<MessageSpec | null> {
    if (!spec.decision || !this.runtime) return spec;
    const decision = await this.store.getDecision(spec.decision.id);
    const session = spec.session?.id ? await this.store.getSessionById(spec.session.id) : null;
    if (!decision || !session || session.codexArchivedAt !== null || session.codexThreadId !== target.threadId || decision.sessionId !== session.id) return null;
    return presentWebDecision(session, decision, this.runtime.isRuntimeConnected(), this.runtime.isApprovalPending(decision.approvalId));
  }

  canHandle(sourceId: string): boolean { return messageTransportPlatform(sourceId) === "web"; }

  subscribe(listener: (delivery: WebMessageDelivery) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  observeBinding(event: SessionBindingEvent): void {
    for (const [id, target] of this.targets) {
      if (target.sessionId !== event.sessionId) continue;
      if (event.kind === "acquired" || event.kind === "transferred") {
        target.active = false;
        this.targets.delete(id);
      }
      else if (event.leaseVersion > target.leaseVersion) target.leaseVersion = event.leaseVersion;
    }
  }

  private isCurrent(target: MessageTarget): boolean {
    const lease = this.store.getSessionLease(target.sessionId);
    if (!target.active || !lease ||
        (lease.state !== "active" && lease.state !== "handoff_pending") || !lease.ownerBindingId) return false;
    const route = this.store.getActiveTurnRoute(target.threadId);
    const ownedRoute = route?.sessionId === target.sessionId && route.sourceId === WEB_SOURCE_ID;
    if (this.store.getSessionBindingById(lease.ownerBindingId)?.sourceId !== WEB_SOURCE_ID || (route && !ownedRoute)) return false;
    // Recording a real ownerTurn also increments the lease version. A still-active
    // original Web route proves continuity; absence/mismatch must fail closed.
    if (lease.version !== target.leaseVersion && !ownedRoute) return false;
    target.leaseVersion = lease.version;
    return true;
  }

  private async target(spec: MessageSpec): Promise<MessageTarget | null> {
    if (!spec.session?.id) return null;
    const session = await this.store.getSessionById(spec.session.id);
    if (!session || session.codexArchivedAt !== null) return null;
    const lease = this.store.getSessionLease(session.id);
    if (!lease) return null;
    const target = { sessionId: session.id, threadId: session.codexThreadId, leaseVersion: lease.version, active: true };
    return this.isCurrent(target) ? target : null;
  }

  private publish(operation: WebMessageEvent["operation"], messageId: string,
    target: MessageTarget, message?: MessageSpec): boolean {
    if (!this.isCurrent(target)) return false;
    const { sessionId, threadId, leaseVersion } = target;
    const event: WebMessageEvent = { operation, messageId, sessionId, threadId, leaseVersion,
      ...(message ? { message: presentWebMessage(message) } : {}) };
    for (const listener of this.listeners) {
      if (!this.isCurrent(target)) break;
      try { listener({ event, isCurrent: () => this.isCurrent(target) }); } catch { /* A disconnected subscriber does not fail Bridge delivery. */ }
    }
    return true;
  }

  async sendMessageSpec(sourceId: string, spec: MessageSpec): Promise<BridgeSentMessage | null> {
    if (!this.canHandle(sourceId)) return null;
    const target = await this.target(spec);
    if (!target) return null;
    const message = await this.prepareSpec(spec, target);
    if (!message) return null;
    const messageId = `web-message-${crypto.randomUUID()}`;
    if (!this.publish("send", messageId, target, message)) return null;
    this.targets.set(messageId, target);
    // Bounded identifiers only. Disconnected clients refresh conversation history instead of replay.
    if (this.targets.size > 2048) {
      const oldest = this.targets.keys().next().value!;
      this.targets.get(oldest)!.active = false;
      this.targets.delete(oldest);
    }
    return { message_id: messageId };
  }

  async editMessageSpec(sourceId: string, messageId: string, spec: MessageSpec): Promise<boolean> {
    const target = this.targets.get(messageId);
    if (!this.canHandle(sourceId) || !target || spec.session?.id !== target.sessionId) return false;
    const message = await this.prepareSpec(spec, target);
    return !!message && this.publish("edit", messageId, target, message);
  }

  async deleteMessage(sourceId: string, messageId: string): Promise<boolean> {
    const target = this.targets.get(messageId);
    if (!this.canHandle(sourceId) || !target) return false;
    const sent = this.publish("delete", messageId, target);
    target.active = false;
    this.targets.delete(messageId);
    return sent;
  }

  async clearMessageActions(sourceId: string, messageId: string): Promise<boolean> {
    const target = this.targets.get(messageId);
    return this.canHandle(sourceId) && !!target && this.publish("clear-actions", messageId, target);
  }

  sendMessage(sourceId: string, _text: string, options?: BridgeMessageOptions): Promise<BridgeSentMessage | null> {
    return options?.messageSpec ? this.sendMessageSpec(sourceId, options.messageSpec) : Promise.resolve(null);
  }
  editMessageText(sourceId: string, messageId: string, _text: string, options?: BridgeMessageOptions): Promise<boolean> {
    return options?.messageSpec ? this.editMessageSpec(sourceId, messageId, options.messageSpec) : Promise.resolve(false);
  }
  async sendTyping(): Promise<void> { /* Bridge state, not typing, drives the Web UI. */ }
}
