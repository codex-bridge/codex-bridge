import type { DecisionRecord, SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import type { BridgeMessageOptions, BridgeMessageTransport, BridgeSentMessage } from "../transport.js";
import { logger } from "../../logging/logger.js";
import { actionRow, messageAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec, SessionContext } from "../messages/types.js";
import type { SessionDecisionOperationQueue } from "./session-operation-queue.js";
import { canDeliverSession } from "../notifications/delivery-target.js";

type DecisionStore = Pick<
  BridgeStore,
  | "attachDecisionMessage"
  | "getActiveSession"
  | "getSessionById"
  | "getSessionLease"
  | "getSessionBindingById"
  | "listPendingDecisions"
  | "updateDecisionMessageTarget"
  | "updateSessionBatchDecisionMessageId"
>;

export type DecisionDeliveryDependencies = {
  store: DecisionStore;
  requireMessageTransport: (chatId: string) => BridgeMessageTransport;
  sessionOperationQueue: Pick<SessionDecisionOperationQueue, "run">;
  isBatchableDecision: (decision: DecisionRecord) => boolean;
  createDecisionMessageSpec: (session: SessionRecord, decision: DecisionRecord, actions: MessageSpec["actions"]) => MessageSpec;
  createBatchDecisionMessageSpec: (session: SessionContext, count: number, actions: MessageSpec["actions"]) => MessageSpec;
  getSessionDirectory: (session: SessionRecord) => string;
  getExecpolicyAmendment: (decision: DecisionRecord) => string[] | null;
  sendMessageSpec: (chatId: string, messageSpec: MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<BridgeSentMessage | null>;
  editMessageSpec: (chatId: string, messageId: string, messageSpec: MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<boolean>;
};

export class DecisionDeliveryService {
  constructor(private readonly deps: DecisionDeliveryDependencies) {}

  async sendDecisionMessage(session: SessionRecord, decision: DecisionRecord): Promise<void> {
    const targetChatId = session.telegramChatId;
    if (decision.telegramMessageId && decision.telegramChatId === targetChatId) {
      logger.info("bridge.decision.delivery_deduped", {
        decisionId: decision.id,
        sessionId: session.id,
        chatId: targetChatId,
        messageId: decision.telegramMessageId
      });
      return;
    }

    if (decision.telegramMessageId && decision.telegramChatId !== targetChatId) {
      await this.retireDecisionMessage(session, decision);
    }

    const actions = decision.kind === "mcpServer/elicitation/request"
      ? actionRow(
          messageAction("accept", "Accept", `decision:${decision.id}:a`),
          messageAction("decline", "Decline", `decision:${decision.id}:d`),
          messageAction("cancel", "Cancel", `decision:${decision.id}:c`)
        )
      : [
          ...actionRow(
            { ...messageAction("approve", "Approve Once", `decision:${decision.id}:a`), style: "primary" as const },
            { ...messageAction("allow", this.deps.getExecpolicyAmendment(decision) ? "Allow Command" : "Allow Session", `decision:${decision.id}:s`), style: "primary" as const }
          ),
          ...actionRow(
            messageAction("decline", "Decline", `decision:${decision.id}:d`),
            { ...messageAction("cancel", "Cancel", `decision:${decision.id}:c`), style: "danger" as const }
          )
        ];
    const messageSpec = this.deps.createDecisionMessageSpec(session, decision, actions);
    const sent = await this.deps.sendMessageSpec(
      targetChatId,
      messageSpec,
      { unavailableThreadNotice: { kind: "action-required" } }
    );
    if (sent) {
      await this.deps.store.updateDecisionMessageTarget(
        decision.id,
        targetChatId,
        String(sent.message_id)
      );
    }
  }

  private async retireDecisionMessage(session: SessionRecord, decision: DecisionRecord): Promise<void> {
    if (!decision.telegramMessageId) return;
    try {
      await this.deps.editMessageSpec(
        decision.telegramChatId,
        decision.telegramMessageId,
        createMessage({
          kind: "decision",
          session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
          titleLabel: "Decision Moved",
          body: [{ type: "text", text: "This approval moved to the active conversation." }],
          actions: []
        })
      );
      logger.info("bridge.decision.message_retired", {
        decisionId: decision.id,
        chatId: decision.telegramChatId,
        messageId: decision.telegramMessageId
      });
    } catch (error) {
      logger.warn("bridge.decision.message_retire_failed", {
        decisionId: decision.id,
        chatId: decision.telegramChatId,
        messageId: decision.telegramMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.clearDecisionReplyMarkup(decision.telegramChatId, decision.telegramMessageId);
    }
  }

  async syncBatchDecisionMessageForSessionId(sessionId: string): Promise<void> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (session) await this.syncBatchDecisionMessage(session);
  }

  async syncBatchDecisionMessage(session: SessionRecord): Promise<void> {
    await this.deps.sessionOperationQueue.run(session.id, async () => {
      const latestSession = await this.deps.store.getSessionById(session.id);
      if (!latestSession) return;
      const lease = this.deps.store.getSessionLease(latestSession.id);
      const owner = lease?.ownerBindingId ? this.deps.store.getSessionBindingById(lease.ownerBindingId) : null;
      const ownerSourceId = owner?.sourceId ?? latestSession.telegramChatId;
      if (!await canDeliverSession(this.deps.store, latestSession, ownerSourceId)) {
        await this.clearBatchDecisionMessage(latestSession);
        return;
      }
      const batchable = (await this.deps.store.listPendingDecisions(latestSession.id))
        .filter((decision) => this.deps.isBatchableDecision(decision));
      if (batchable.length <= 1) {
        await this.clearBatchDecisionMessage(latestSession);
        return;
      }
      const actions = actionRow(
        messageAction("approve-all", "Approve All", `decision-batch:${latestSession.id}:${lease?.version ?? 0}:a`),
        messageAction("decline-all", "Decline All", `decision-batch:${latestSession.id}:${lease?.version ?? 0}:d`),
        messageAction("cancel-all", "Cancel All", `decision-batch:${latestSession.id}:${lease?.version ?? 0}:c`)
      );
      await this.clearBatchDecisionMessage(latestSession);
      const messageSpec = this.deps.createBatchDecisionMessageSpec(
        { id: latestSession.id, directory: this.deps.getSessionDirectory(latestSession) }, batchable.length, actions
      );
      const sent = await this.deps.sendMessageSpec(
        ownerSourceId,
        messageSpec,
        { unavailableThreadNotice: { kind: "action-required" } }
      );
      if (sent) await this.deps.store.updateSessionBatchDecisionMessageId(latestSession.id, String(sent.message_id));
    });
  }

  async clearBatchDecisionMessage(session: SessionRecord): Promise<void> {
    const latestSession = await this.deps.store.getSessionById(session.id);
    if (!latestSession?.batchDecisionMessageId) return;
    try {
      await this.deps.editMessageSpec(
        latestSession.telegramChatId,
        latestSession.batchDecisionMessageId,
        createMessage({
          kind: "decision-batch",
          titleLabel: "No Pending Approvals",
          session: { id: latestSession.id, directory: this.deps.getSessionDirectory(latestSession) },
          body: [{ type: "text", text: "All batchable approvals have been resolved or moved." }],
          actions: []
        })
      );
    } catch (error) {
      logger.warn("bridge.batch_decision.finalize_failed", {
        sessionId: latestSession.id,
        messageId: latestSession.batchDecisionMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await this.deps.store.updateSessionBatchDecisionMessageId(latestSession.id, null);
  }

  async clearDecisionReplyMarkup(chatId: string, messageId: string | null): Promise<void> {
    if (!messageId) return;
    try {
      await this.deps.requireMessageTransport(chatId).clearMessageActions(chatId, messageId);
    } catch (error) {
      logger.warn("bridge.decision.actions_clear_failed", {
        chatId,
        messageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async clearDecisionMessageActions(decision: DecisionRecord): Promise<void> {
    if (!decision.telegramMessageId) return;
    const session = await this.deps.store.getSessionById(decision.sessionId);
    if (!session) {
      await this.clearDecisionReplyMarkup(decision.telegramChatId, decision.telegramMessageId);
      return;
    }
    try {
      const messageSpec = this.deps.createDecisionMessageSpec(session, decision, []);
      await this.deps.editMessageSpec(
        decision.telegramChatId,
        decision.telegramMessageId,
        messageSpec
      );
    } catch (error) {
      logger.warn("bridge.decision.message_action_clear_failed", {
        chatId: decision.telegramChatId,
        decisionId: decision.id,
        messageId: decision.telegramMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.clearDecisionReplyMarkup(decision.telegramChatId, decision.telegramMessageId);
    }
  }
}
