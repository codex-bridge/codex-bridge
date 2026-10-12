import { actionRow, archiveAction, deleteAction, helpAction, messageAction, refreshAction, sessionAction } from "../messages/actions.js";
import { SessionBindingService, sourceLabel } from "./binding.js";
import type { MessageSpec } from "../messages/types.js";
import { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";

export type SessionMutationDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  isRuntimeConnected: () => boolean;
  inFlightTurnIdByThread: Map<string, string>;
  bindingService: SessionBindingService;
  createSessionActionSpec: (
    session: SessionRecord | null,
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"]
  ) => MessageSpec;
  sessionRefreshCallback: (sessionId: string, leaseVersion?: number) => string;
  sessionReleaseBridgeCallback: (sessionId: string, leaseVersion?: number) => string;
  sessionDeleteConfirmCallback: (sessionId: string, leaseVersion?: number) => string;
  getSessionArchiveCallback: (chatId: string, sessionId: string) => Promise<string | null>;
  getSessionDeleteCallback: (chatId: string, sessionId: string) => Promise<string | null>;
  getSessionSelectorChatId: (chatId: string) => string;
  getSessionDirectory: (session: SessionRecord) => string;
  clearSessionState: (session: SessionRecord) => void;
  onStateChanged?: (sourceId: string) => Promise<void>;
};

export class SessionMutationService {
  constructor(private readonly deps: SessionMutationDependencies) {}

  async unarchiveSession(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    const sourceId = this.deps.getSessionSelectorChatId(telegramChatId);
    const archivedActions = [messageAction("archived", "Archived", "session-archived"), sessionAction()];
    if (!session) return this.result(null, "error", "This session is no longer available.", archivedActions);
    if (session.codexArchivedAt === null) return this.result(session, "system", "This session is already available.", [sessionAction()]);
    const binding = this.deps.store.getSessionBinding(session.id, sourceId);
    if (!binding && session.telegramChatId !== sourceId) {
      return this.result(session, "error", "This archived session is not available to this conversation.", archivedActions);
    }
    try {
      await this.deps.codexClient.unarchiveThread(session.codexThreadId);
      const restored = await this.deps.store.markSessionCodexUnarchived(session.id);
      this.deps.store.ensureSessionBinding(restored.id, sourceId);
      this.deps.clearSessionState(restored);
      logger.info("bridge.session.unarchived", { chatId: telegramChatId, sourceId, sessionId: restored.id, threadId: restored.codexThreadId });
      return this.result(restored, "system", "Session restored.\nUse Sessions to select it.", actionRow(helpAction(), sessionAction()));
    } catch (error) {
      logger.warn("bridge.session.unarchive_failed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
      return this.result(session, "error", `Session restore failed.\n${error instanceof Error ? error.message : String(error)}`, archivedActions);
    }
  }

  async requestSessionHandoff(telegramChatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec> {
    const { session, outcome: result } = await this.deps.bindingService.request(telegramChatId, sessionId, expectedLeaseVersion);
    if (!session || !result) return this.result(session, "error", "This session is no longer available.", [sessionAction()]);
    if (result.reason === "stale") {
      return this.result(session, "error", "This session action is stale. Refresh the session state before requesting a handoff.", [refreshAction(this.deps.sessionRefreshCallback(session.id, result.lease.version))]);
    }
    if (result.lease.state === "external_unknown") {
      return this.result(session, "error", "This session is occupied outside the Bridge. Wait for the external Codex operation to finish, then refresh.", [refreshAction(this.deps.sessionRefreshCallback(session.id, result.lease.version))]);
    }
    if (result.owned) {
      const archiveCallback = await this.deps.getSessionArchiveCallback(telegramChatId, session.id);
      const deleteCallback = await this.deps.getSessionDeleteCallback(telegramChatId, session.id);
      return this.result(session, "system", [
        "Session is now bound to this conversation.",
        ...(result.replacedSourceId ? [`Replaced the pending request from ${sourceLabel(result.replacedSourceId)}.`] : [])
      ].join("\n"), [
        ...actionRow(
          messageAction("release", "Release to Codex", this.deps.sessionReleaseBridgeCallback(session.id, result.lease.version), "Current session"),
          helpAction()
        ),
        ...(archiveCallback ? [archiveAction(archiveCallback, "Current session")] : []),
        ...(deleteCallback ? [deleteAction(deleteCallback, "Current session")] : []),
        sessionAction()
      ]);
    }
    if (result.pending) {
      return this.result(session, "system", [
        "Next turn requested.",
        "The current conversation continues until its accepted work is finished.",
        ...(result.replacedSourceId ? [`Replaced the pending request from ${sourceLabel(result.replacedSourceId)}.`] : []),
        "The latest request wins; refresh after the handoff completes."
      ].join("\n"), [refreshAction(this.deps.sessionRefreshCallback(session.id, result.lease.version))]);
    }
    return this.result(session, "error", "This session is temporarily unavailable to this conversation.", [refreshAction(this.deps.sessionRefreshCallback(session.id, result.lease.version))]);
  }

  async cancelSessionHandoff(sourceId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return this.result(null, "error", "This session is no longer available.", [sessionAction()]);
    const result = await this.deps.bindingService.cancel(sourceId, session.id, expectedLeaseVersion);
    return this.result(session, result.cancelled ? "system" : "error",
      result.cancelled ? "Your pending session request was cancelled."
        : result.reason === "stale" ? "This session action is stale. Refresh the session state."
        : "There is no pending request from this conversation to cancel.",
      [refreshAction(this.deps.sessionRefreshCallback(session.id, result.lease?.version))]);
  }

  async releaseBridgeSessionLock(telegramChatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return this.result(null, "error", "This session is no longer available.", [sessionAction()]);
    const inFlight = this.deps.bindingService.hasPendingDispatch(session.codexThreadId) ||
      this.deps.inFlightTurnIdByThread.has(session.codexThreadId);
    const lease = this.deps.store.getSessionLease(session.id);
    if (inFlight) {
      return this.result(session, "error", "The Bridge lock cannot be released while work is still active.", [refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))]);
    }
    const result = this.deps.store.beginBridgeSessionRelease(session.id, telegramChatId, expectedLeaseVersion);
    if (!result.started) {
      const text = result.reason === "stale"
        ? "This release action is stale. Refresh the session state first."
        : result.reason === "not_owner"
          ? "Only the current owner can release the Bridge lock."
          : result.reason === "busy"
            ? "The Bridge lock cannot be released while work, a queue, a pending decision, or a handoff request is active."
          : "The Bridge lock cannot be released in the current session state.";
      return this.result(session, "error", text, [refreshAction(this.deps.sessionRefreshCallback(session.id, result.lease.version))]);
    }
    let status: Awaited<ReturnType<CodexAppServerClient["unsubscribeThread"]>> | "connectionClosed" = "connectionClosed";
    try {
      if (this.deps.isRuntimeConnected()) {
        status = await this.deps.codexClient.unsubscribeThread(session.codexThreadId);
      }
    } catch (error) {
      const restored = this.deps.store.finishBridgeSessionRelease(session.id, result.lease.version, false);
      logger.warn("bridge.session.release_failed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        leaseRestored: restored?.state === "active",
        error: error instanceof Error ? error.message : String(error)
      });
      return this.result(session, "error", [
        "The Bridge lock was not released.",
        error instanceof Error ? error.message : String(error)
      ].join("\n"), [refreshAction(this.deps.sessionRefreshCallback(session.id, restored?.version))]);
    }
    const released = this.deps.store.finishBridgeSessionRelease(session.id, result.lease.version, true);
    if (!released || released.state !== "unbound") {
      throw new Error("Session ownership changed before the Bridge release completed.");
    }
    try {
      await this.deps.store.clearActiveSession(telegramChatId, session.id);
      await this.deps.onStateChanged?.(telegramChatId);
    } catch (error) {
      logger.warn("bridge.session.release_selection_cleanup_failed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    logger.info("bridge.session.released", {
      chatId: telegramChatId,
      sessionId: session.id,
      threadId: session.codexThreadId,
      unsubscribeStatus: status
    });
    return this.result(session, "system", "Bridge lock released.", actionRow(helpAction(), sessionAction()));
  }

  async releaseCodexSession(telegramChatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return this.result(null, "error", "This session is no longer available.", [sessionAction()]);
    if (this.deps.inFlightTurnIdByThread.has(session.codexThreadId) || (await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId)) > 0) {
      return this.result(session, "error", "The Codex session cannot be released while a turn or accepted queue is still active.", [refreshAction(this.deps.sessionRefreshCallback(session.id, this.deps.store.getSessionLease(session.id)?.version))]);
    }
    const releasing = this.deps.store.beginCodexSessionRelease(session.id, expectedLeaseVersion);
    if (!releasing) {
      const lease = this.deps.store.getSessionLease(session.id);
      return this.result(session, "error", "The Codex session is no longer in a recoverable external-lock state. Refresh and try again.", [refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))]);
    }
    try {
      await this.deps.codexClient.resumeThread(session.codexThreadId, this.deps.getSessionDirectory(session));
      this.deps.store.finishCodexSessionRelease(session.id, true);
      return this.result(session, "system", "Codex session recovery completed.", [helpAction(), sessionAction()]);
    } catch (error) {
      this.deps.store.finishCodexSessionRelease(session.id, false);
      logger.warn("bridge.session.codex_release_failed", { chatId: telegramChatId, sessionId: session.id, threadId: session.codexThreadId, error: error instanceof Error ? error.message : String(error) });
      const lease = this.deps.store.getSessionLease(session.id);
      return this.result(session, "error", "The Codex session is still occupied externally. Wait for it to finish, then refresh. No interrupt was sent.", [refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))]);
    }
  }

  async archiveSession(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) {
      return this.result(null, "error", "This session is no longer available.", [sessionAction()]);
    }
    const lease = this.deps.store.getSessionLease(session.id);
    const binding = this.deps.store.getSessionBinding(session.id, telegramChatId);
    const refreshSpec = (body: string) => this.result(session, "error", body, [
      refreshAction(this.deps.sessionRefreshCallback(session.id, this.deps.store.getSessionLease(session.id)?.version))
    ]);
    if (expectedLeaseVersion !== undefined && lease?.version !== expectedLeaseVersion) {
      return this.result(session, "error", "This archive action is stale. Refresh the session state first.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))
      ]);
    }
    if (!lease || !binding || lease.ownerBindingId !== binding.id ||
      (lease.state !== "active" && lease.state !== "handoff_pending")) {
      return this.result(session, "error", "Only the current Bridge owner can archive this session.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))
      ]);
    }
    const pendingCount = await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId);
    const pendingDecisions = await this.deps.store.listPendingDecisions(session.id);
    const inFlight = this.deps.inFlightTurnIdByThread.get(session.codexThreadId);
    if (inFlight || lease.ownerTurnId || pendingCount > 0 || pendingDecisions.length > 0 ||
      await this.deps.store.getAwaitingInputDecisionForSession(session.id)) {
      return refreshSpec("This session can be archived only when no turn, accepted queue, or pending approval is active.");
    }
    try {
      await this.deps.codexClient.archiveThread(session.codexThreadId);
      await this.deps.store.markSessionCodexArchived(session.id);
      this.deps.clearSessionState(session);
      logger.info("bridge.session.archived", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId
      });
      return this.result(session, "system", "Session archived.", [helpAction(), sessionAction()]);
    } catch (error) {
      logger.warn("bridge.session.archive_failed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
      return this.result(session, "error", `Session archive failed.\n${error instanceof Error ? error.message : String(error)}`,
        [refreshAction(this.deps.sessionRefreshCallback(session.id, this.deps.store.getSessionLease(session.id)?.version))]);
    }
  }

  async requestDeleteSession(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return this.result(null, "error", "This session is no longer available.", [sessionAction()]);
    const lease = this.deps.store.getSessionLease(session.id);
    if (expectedLeaseVersion !== undefined && lease?.version !== expectedLeaseVersion) {
      return this.result(session, "error", "This delete action is stale. Refresh the session state first.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))
      ]);
    }
    const binding = this.deps.store.getSessionBinding(session.id, telegramChatId);
    if (!lease || !binding || lease.ownerBindingId !== binding.id ||
      (lease.state !== "active" && lease.state !== "handoff_pending")) {
      return this.result(session, "error", "Only the current Bridge owner can delete this session.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))
      ]);
    }
    const pendingCount = await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId);
    const pendingDecisions = await this.deps.store.listPendingDecisions(session.id);
    if (this.deps.inFlightTurnIdByThread.has(session.codexThreadId) || lease.ownerTurnId || pendingCount > 0 ||
      pendingDecisions.length > 0 || await this.deps.store.getAwaitingInputDecisionForSession(session.id)) {
      return this.result(session, "error", "This session can be deleted only when no turn, accepted queue, or pending approval is active.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease.version))
      ]);
    }
    return this.result(session, "decision", "Delete this session permanently?\nThis removes the Codex thread and all Bridge history.", [
      { id: "confirm-delete", label: "Confirm delete", callback: this.deps.sessionDeleteConfirmCallback(session.id, lease.version), style: "danger" },
      messageAction("cancel", "Cancel", this.deps.sessionRefreshCallback(session.id, lease.version))
    ]);
  }

  async deleteSession(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return this.result(null, "error", "This session is no longer available.", [sessionAction()]);
    const lease = this.deps.store.getSessionLease(session.id);
    const binding = this.deps.store.getSessionBinding(session.id, telegramChatId);
    if (expectedLeaseVersion !== undefined && lease?.version !== expectedLeaseVersion) {
      return this.result(session, "error", "This delete confirmation is stale. Refresh the session state first.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))
      ]);
    }
    if (!lease || !binding || lease.ownerBindingId !== binding.id ||
      (lease.state !== "active" && lease.state !== "handoff_pending")) {
      return this.result(session, "error", "Only the current Bridge owner can delete this session.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease?.version))
      ]);
    }
    const pendingCount = await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId);
    const pendingDecisions = await this.deps.store.listPendingDecisions(session.id);
    if (this.deps.inFlightTurnIdByThread.has(session.codexThreadId) || lease.ownerTurnId || pendingCount > 0 ||
      pendingDecisions.length > 0 || await this.deps.store.getAwaitingInputDecisionForSession(session.id)) {
      return this.result(session, "error", "This session can be deleted only when no turn, accepted queue, or pending approval is active.", [
        refreshAction(this.deps.sessionRefreshCallback(session.id, lease.version))
      ]);
    }
    try {
      await this.deps.codexClient.deleteThread(session.codexThreadId);
      const deleted = await this.deps.store.deleteSession(session.id);
      if (!deleted) return this.result(session, "error", "The session was already deleted.", [sessionAction()]);
      this.deps.clearSessionState(session);
      logger.info("bridge.session.deleted", { chatId: telegramChatId, sessionId: session.id, threadId: session.codexThreadId });
      return this.result(session, "system", "Session deleted.", [helpAction(), sessionAction()]);
    } catch (error) {
      logger.warn("bridge.session.delete_failed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
      return this.result(session, "error", `Session delete failed.\n${error instanceof Error ? error.message : String(error)}`,
        [refreshAction(this.deps.sessionRefreshCallback(session.id, this.deps.store.getSessionLease(session.id)?.version))]);
    }
  }

  private result(
    session: SessionRecord | null,
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"]
  ): MessageSpec {
    return this.deps.createSessionActionSpec(session, kind, body, actions);
  }
}
