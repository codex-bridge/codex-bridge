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
  onSelectionChanged?: (sourceId: string) => Promise<void>;
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
    await this.deps.store.selectSession(telegramChatId, sessionId);
    try {
      return await this.activateSelectedSession(telegramChatId, targetSession, previousActiveSession);
    } finally {
      await this.deps.onSelectionChanged?.(telegramChatId);
    }
  }

  private async assertSelected(sourceId: string, sessionId: string): Promise<void> {
    if ((await this.deps.store.getActiveSession(sourceId))?.id !== sessionId) {
      throw new SessionActivationError(this.deps.createSessionActionSpec(null, "system",
        "The session selection changed. Use the latest selected session.", [sessionAction()]));
    }
  }

  private async activateSelectedSession(telegramChatId: string, targetSession: SessionRecord,
    previousActiveSession: SessionRecord | null): Promise<SessionActivationResult> {
    const sessionId = targetSession.id;
    await this.assertSelected(telegramChatId, sessionId);
    const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(targetSession, telegramChatId,
      { assertCurrent: () => this.assertSelected(telegramChatId, sessionId) });
    await this.assertSelected(telegramChatId, sessionId);
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
        await this.deps.sessionOwnershipService.assertSessionSwitchCanRelease(telegramChatId, previousActiveSession);
        await this.deps.sessionOwnershipService.releasePreviousSessionAfterClaim(telegramChatId, previousActiveSession);
      } catch (error) {
        // Navigation does not interrupt accepted work or depend on releasing its lease.
        logger.info("bridge.session.switch_previous_kept", { sessionId: previousActiveSession.id,
          chatId: telegramChatId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.assertSelected(telegramChatId, sessionId);
    const session = (await this.deps.store.getSessionById(sessionId))!;
    logger.info("bridge.session.activate", {
      chatId: telegramChatId,
      sessionId,
      threadId: session.codexThreadId,
      pathKey: session.pathKey
    });
    try {
      const result = await this.deps.sessionReader.resumeSession(session, telegramChatId);
      await this.assertSelected(telegramChatId, sessionId);
      const lease = this.deps.store.getSessionLease(sessionId);
      const binding = this.deps.store.getSessionBinding(sessionId, telegramChatId);
      if (!binding || lease?.ownerBindingId !== binding.id) {
        throw new SessionActivationError(this.deps.createSessionActionSpec(session, "system",
          "Session ownership changed. Refresh before continuing.", [sessionAction()]));
      }
      return result;
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
      const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, telegramChatId, { retryExternal: false });
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
