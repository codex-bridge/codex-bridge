import { helpAction, refreshAction, sessionAction } from "../messages/actions.js";
import type { MessageSpec } from "../messages/types.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import type { SessionReader } from "./reader.js";
import { SessionActivationError, type SessionOwnershipService } from "./ownership.js";

export type SessionActivationResult = {
  session: SessionRecord;
  recentMessages: Awaited<ReturnType<SessionReader["resumeSession"]>>["recentMessages"];
};

export type SessionActivationDependencies = {
  store: BridgeStore;
  sessionReader: Pick<SessionReader, "resumeSession">;
  sessionOwnershipService: Pick<
    SessionOwnershipService,
    "assertSessionSwitchCanRelease" | "getSessionOwnershipPrompt" | "releasePreviousSessionAfterClaim"
  >;
  clearBatchDecisionMessage: (session: SessionRecord) => Promise<void>;
  isActiveWriterConflictError: (error: unknown) => boolean;
  sessionRefreshCallback: (sessionId: string, leaseVersion?: number) => string;
  createSessionActionSpec: (
    session: SessionRecord | null,
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"]
  ) => MessageSpec;
};

export class SessionActivationService {
  constructor(private readonly deps: SessionActivationDependencies) {}

  async activateSession(
    telegramChatId: string,
    sessionId: string
  ): Promise<SessionActivationResult> {
    const previousActiveSession = await this.deps.store.getActiveSession(telegramChatId);
    const targetSession = await this.deps.store.getSessionById(sessionId);
    if (!targetSession) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (previousActiveSession && previousActiveSession.id !== targetSession.id) {
      await this.deps.sessionOwnershipService.assertSessionSwitchCanRelease(telegramChatId, previousActiveSession);
    }
    const targetLeaseBeforeClaim = this.deps.store.getSessionLease(targetSession.id);
    const targetBindingBeforeClaim = this.deps.store.getSessionBinding(targetSession.id, telegramChatId);
    const targetWasOwned = Boolean(
      targetLeaseBeforeClaim && targetBindingBeforeClaim &&
      targetLeaseBeforeClaim.ownerBindingId === targetBindingBeforeClaim.id &&
      (targetLeaseBeforeClaim.state === "active" || targetLeaseBeforeClaim.state === "handoff_pending")
    );
    const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(targetSession, telegramChatId);
    if (ownershipPrompt) throw new SessionActivationError(ownershipPrompt);
    const ownership = this.deps.store.claimSession(sessionId, telegramChatId);
    if (!ownership.owned) {
      throw new SessionActivationError(await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(targetSession, telegramChatId) ?? this.deps.createSessionActionSpec(
        targetSession,
        "error",
        "This session is temporarily unavailable to this conversation.",
        [sessionAction(), helpAction()]
      ));
    }
    this.deps.store.ensureSessionBinding(sessionId, telegramChatId);
    if (previousActiveSession && previousActiveSession.id !== targetSession.id) {
      try {
        await this.deps.sessionOwnershipService.releasePreviousSessionAfterClaim(telegramChatId, previousActiveSession);
      } catch (error) {
        if (!targetWasOwned) {
          this.deps.store.releaseBridgeSessionLock(sessionId, telegramChatId, ownership.lease.version);
        }
        throw error;
      }
    }
    const session = await this.deps.store.selectSession(telegramChatId, sessionId);
    if (previousActiveSession && previousActiveSession.id !== session.id) {
      await this.deps.clearBatchDecisionMessage(previousActiveSession);
    }
    logger.info("bridge.session.activate", {
      chatId: telegramChatId,
      sessionId,
      threadId: session.codexThreadId,
      pathKey: session.pathKey
    });
    try {
      return await this.deps.sessionReader.resumeSession(session, telegramChatId);
    } catch (error) {
      if (!this.deps.isActiveWriterConflictError(error)) throw error;

      const lease = this.deps.store.markSessionExternalUnknown(session.id);
      logger.warn("bridge.session.activate_external_writer_conflict", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        leaseVersion: lease.version,
        error: error instanceof Error ? error.message : String(error)
      });
      const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, telegramChatId);
      const fallbackSpec = this.deps.createSessionActionSpec(
        session,
        "error",
        "This session is occupied outside the Bridge. Wait for the external Codex operation to finish, then refresh.",
        [refreshAction(this.deps.sessionRefreshCallback(session.id, lease.version)), sessionAction(), helpAction()]
      );
      throw new SessionActivationError(ownershipPrompt ?? fallbackSpec);
    }
  }
}
