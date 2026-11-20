import { createMessage } from "../messages/factory.js";
import { sourceLabel } from "./binding.js";
import { actionRow, helpAction, messageAction, sessionAction } from "../messages/actions.js";
import type { MessageKind, MessageSpec } from "../messages/types.js";
import { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";

export const DEFAULT_STALE_BRIDGE_LEASE_MS = 24 * 60 * 60 * 1_000;

export class SessionActivationError extends Error {
  constructor(public readonly messageSpec: MessageSpec) {
    super("Session activation was blocked by session ownership.");
    this.name = "SessionActivationError";
  }
}

export type SessionOwnershipDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  isRuntimeConnected: () => boolean;
  inFlightTurnIdByThread: Map<string, string>;
  staleBridgeLeaseMs: number;
  getSessionDirectory: (session: SessionRecord) => string;
  canReadThreadStatus: () => boolean;
  recoverExternalSession?: (session: SessionRecord) => Promise<number | null>;
  createSessionActionSpec: (
    session: SessionRecord | null,
    kind: MessageKind,
    body: string,
    actions: MessageSpec["actions"]
  ) => MessageSpec;
  sessionHandoffCallback: (sessionId: string, leaseVersion?: number) => string;
};

export class SessionOwnershipService {
  constructor(private readonly deps: SessionOwnershipDependencies) {}

  async getSessionOwnershipPrompt(
    session: SessionRecord,
    telegramChatId: string,
    options?: { retryExternal?: boolean; assertCurrent?: () => Promise<void> }
  ): Promise<MessageSpec | null> {
    await this.reconcileIdleBridgeLease(session);
    if (options?.retryExternal !== false) {
      try { await this.deps.recoverExternalSession?.(session); }
      catch (error) {
        if (error instanceof SessionActivationError) return error.messageSpec;
        throw error;
      }
    }
    await options?.assertCurrent?.();
    const ownership = this.deps.store.claimSession(session.id, telegramChatId);
    if (ownership.owned) return null;

    return this.getSessionStatePrompt(session, telegramChatId);
  }

  /** Presentation only: never claims, selects, resumes, or reconciles a lease. */
  getSessionStatePrompt(session: SessionRecord, sourceId: string, notice?: string): MessageSpec {
    const lease = this.deps.store.getSessionLease(session.id);
    const binding = this.deps.store.getSessionBinding(session.id, sourceId);
    const owner = lease?.ownerBindingId ? this.deps.store.getSessionBindingById(lease.ownerBindingId) : null;
    const isOwner = Boolean(binding && owner?.id === binding.id);
    const pendingHere = Boolean(binding && lease?.pendingBindingId === binding.id);
    const available = session.codexArchivedAt === null &&
      (!lease || ["unbound", "active", "handoff_pending", "external_unknown"].includes(lease.state));
    let state: string;
    if (session.codexArchivedAt !== null) state = "This session is archived.";
    else if (lease?.state === "external_unknown") state = "This session is occupied outside the Bridge. Use this session next to try again after external work finishes.";
    else if (isOwner) state = "Session is now bound to this conversation.";
    else if (pendingHere) state = "Waiting for handoff. Recent conversation will appear automatically when accepted work finishes and this conversation acquires the session.";
    else if (owner) state = `Session is currently in use by ${sourceLabel(owner.sourceId)}.` +
      (lease?.pendingBindingId ? " Another conversation is waiting for handoff; the latest request wins." : "");
    else state = available ? "This session is not bound. Use this session next to acquire it." : "This session is temporarily unavailable.";
    return createMessage({
      kind: isOwner || pendingHere ? "system" : "error",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [{ type: "text", text: [notice, state].filter(Boolean).join("\n") }],
      actions: actionRow(
        ...(available && !isOwner && !pendingHere
          ? [messageAction("handoff", "Use this session next", this.deps.sessionHandoffCallback(session.id, lease?.version))]
          : []),
        sessionAction(), helpAction()
      )
    });
  }

  async reconcileIdleBridgeLease(session: SessionRecord): Promise<void> {
    const lease = this.deps.store.getSessionLease(session.id);
    if (!lease || lease.state !== "active" || lease.ownerTurnId) return;
    if (this.deps.inFlightTurnIdByThread.has(session.codexThreadId)) return;
    if (this.deps.store.hasPendingSessionWork(session.id)) return;
    if (Date.now() - lease.updatedAt < this.deps.staleBridgeLeaseMs) return;
    if (!this.deps.canReadThreadStatus()) return;

    try {
      const status = await this.deps.codexClient.readThreadStatus(
        session.codexThreadId,
        this.deps.getSessionDirectory(session),
        { readOnly: true, timeoutMs: 5_000 }
      );
      if (this.deps.store.getSessionLease(session.id)?.version !== lease.version ||
          this.deps.inFlightTurnIdByThread.has(session.codexThreadId) ||
          this.deps.store.hasPendingSessionWork(session.id)) return;
      if (status.activity === "running") {
        const externalLease = this.deps.store.markSessionExternalUnknown(session.id);
        logger.warn("bridge.session.external_activity_detected", {
          sessionId: session.id,
          threadId: session.codexThreadId,
          activityType: status.activityType,
          leaseVersion: externalLease.version
        });
        return;
      }
      if (status.activity !== "idle") {
        logger.info("bridge.session.stale_lease_check_deferred", {
          sessionId: session.id,
          threadId: session.codexThreadId,
          activityType: status.activityType
        });
        return;
      }
      if (this.deps.store.releaseStaleBridgeSessionLock(session.id, lease.version)) {
        logger.info("bridge.session.stale_lease_released", {
          sessionId: session.id,
          threadId: session.codexThreadId,
          previousOwnerBindingId: lease.ownerBindingId,
          leaseVersion: lease.version
        });
      }
    } catch (error) {
      logger.warn("bridge.session.stale_lease_check_failed", {
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async assertSessionSwitchCanRelease(
    telegramChatId: string,
    session: SessionRecord
  ): Promise<void> {
    const lease = this.deps.store.getSessionLease(session.id);
    const pendingApprovals = await this.deps.store.listPendingDecisions(session.id);
    const hasAwaitingInput = Boolean(await this.deps.store.getAwaitingInputDecisionForSession(session.id));
    const isBusy = Boolean(
      this.deps.inFlightTurnIdByThread.has(session.codexThreadId) ||
      lease?.ownerTurnId ||
      (await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId)) > 0 ||
      pendingApprovals.length > 0 ||
      hasAwaitingInput
    );
    if (!isBusy) return;

    throw new SessionActivationError(this.deps.createSessionActionSpec(
      session,
      "error",
      "The current session cannot be released while a turn, accepted queue, or pending decision is active.",
      actionRow(sessionAction(), helpAction())
    ));
  }

  async releasePreviousSessionAfterClaim(telegramChatId: string, session: SessionRecord): Promise<void> {
    const lease = this.deps.store.getSessionLease(session.id);
    const binding = this.deps.store.getSessionBinding(session.id, telegramChatId);
    if (!lease || !binding || lease.ownerBindingId !== binding.id ||
      (lease.state !== "active" && lease.state !== "handoff_pending")) return;
    const result = this.deps.store.beginBridgeSessionRelease(session.id, telegramChatId, lease.version);
    if (!result.started) {
      throw new SessionActivationError(this.deps.createSessionActionSpec(
        session,
        "error",
        "The current session could not be released, so the session was not switched.",
        actionRow(sessionAction(), helpAction())
      ));
    }
    try {
      const status = this.deps.isRuntimeConnected()
        ? await this.deps.codexClient.unsubscribeThread(session.codexThreadId)
        : "connectionClosed";
      const released = this.deps.store.finishBridgeSessionRelease(session.id, result.lease.version, true);
      if (!released || released.state !== "unbound") {
        throw new Error("Session ownership changed before the previous session was released.");
      }
      logger.info("bridge.session.switch_previous_released", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        unsubscribeStatus: status
      });
    } catch (error) {
      const restored = this.deps.store.finishBridgeSessionRelease(session.id, result.lease.version, false);
      logger.warn("bridge.session.switch_previous_release_failed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        leaseRestored: restored?.state === "active",
        error: error instanceof Error ? error.message : String(error)
      });
      throw new SessionActivationError(this.deps.createSessionActionSpec(
        session,
        "error",
        "The current session could not be released, so the session was not switched.",
        actionRow(sessionAction(), helpAction())
      ));
    }
  }
}
