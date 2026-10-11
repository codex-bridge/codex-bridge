import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { createMessage } from "../messages/factory.js";
import { refreshAction } from "../messages/actions.js";
import type { MessageSpec } from "../messages/types.js";
import type { BridgeMessageOptions, BridgeMessageTransport } from "../transport.js";

type RefreshStatusEntry = { chatId: string; messageId: string };

export type SessionRefreshStatusDependencies = {
  store: Pick<BridgeStore, "getSessionLease">;
  refreshStatusMessageBySession: Map<string, RefreshStatusEntry>;
  getSessionDirectory: (session: SessionRecord) => string;
  refreshSessionCallback: (sessionId: string, leaseVersion: number) => string;
  editMessageSpec: (
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ) => Promise<boolean>;
  sendSpecAndGetLastMessage: (
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ) => Promise<{ messageId: string; text: string } | null>;
  requireMessageTransport: (chatId: string) => BridgeMessageTransport;
};

export class SessionRefreshStatusService {
  constructor(private readonly deps: SessionRefreshStatusDependencies) {}

  async post(chatId: string, session: SessionRecord): Promise<void> {
    const lease = this.deps.store.getSessionLease(session.id);
    if (lease?.state !== "external_unknown") {
      logger.info("bridge.session.refresh_status_skipped", {
        chatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        leaseState: lease?.state ?? "unbound"
      });
      return;
    }

    const messageSpec = createMessage({
      kind: "refresh",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        { type: "text", text: "This session is occupied outside the Bridge." },
        { type: "text", text: "Wait for the external Codex operation to finish, then refresh." }
      ],
      actions: [refreshAction(this.deps.refreshSessionCallback(session.id, lease.version))]
    });
    const previous = this.deps.refreshStatusMessageBySession.get(session.id);
    if (previous?.chatId === chatId) {
      try {
        const edited = await this.deps.editMessageSpec(chatId, previous.messageId, messageSpec, {
          purpose: "session_refresh_status"
        });
        if (edited) {
          logger.info("bridge.session.refresh_status_sent", {
            chatId,
            sessionId: session.id,
            threadId: session.codexThreadId,
            delivery: "edit",
            messageId: previous.messageId,
            leaseVersion: lease.version
          });
          return;
        }
      } catch (error) {
        logger.info("bridge.session.refresh_status_edit_failed", {
          chatId,
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const sent = await this.deps.sendSpecAndGetLastMessage(chatId, messageSpec, {
      purpose: "session_refresh_status"
    });
    if (sent) {
      this.deps.refreshStatusMessageBySession.set(session.id, { chatId, messageId: sent.messageId });
      logger.info("bridge.session.refresh_status_sent", {
        chatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        delivery: "send",
        messageId: sent.messageId,
        leaseVersion: lease.version
      });
    } else {
      logger.warn("bridge.session.refresh_status_send_failed", {
        chatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        leaseVersion: lease.version
      });
    }
  }

  async remove(chatId: string, sessionId: string): Promise<void> {
    const previous = this.deps.refreshStatusMessageBySession.get(sessionId);
    if (!previous || previous.chatId !== chatId) return;
    this.deps.refreshStatusMessageBySession.delete(sessionId);
    try {
      await this.deps.editMessageSpec(chatId, previous.messageId, createMessage({
        kind: "refresh",
        titleLabel: "Refresh Status Closed",
        body: [{ type: "text", text: "External Codex activity is no longer blocking this session." }],
        actions: []
      }), { purpose: "session_refresh_status" });
      logger.info("bridge.session.refresh_status_removed", {
        chatId,
        sessionId,
        messageId: previous.messageId
      });
    } catch (error) {
      logger.info("bridge.session.refresh_status_finalize_failed", {
        chatId,
        sessionId,
        messageId: previous.messageId,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.deps.requireMessageTransport(chatId).clearMessageActions(chatId, previous.messageId).catch(() => undefined);
    }
  }
}
