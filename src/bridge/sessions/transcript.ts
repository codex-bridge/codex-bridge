import type { BridgeMessageOptions } from "../transport.js";
import type { DecisionRecord, MessageRecord, SessionRecord } from "../../shared/types.js";
import { createTranscriptMessageSpec } from "../renderers/thread-history.js";
import { logger } from "../../logging/logger.js";
import { createMessage } from "../messages/factory.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";

type TranscriptMessage = Pick<MessageRecord, "role" | "text">;

export type SessionTranscriptHistoryBlock = {
  text: string;
  assistant: boolean;
  messageSpec: MessageSpec | null;
};

export type SessionTranscriptServiceDependencies = {
  listRecentMessages: (sessionId: string, limit: number) => Promise<TranscriptMessage[]>;
  listPendingDecisions: (sessionId: string) => Promise<DecisionRecord[]>;
  getAwaitingInputDecision: (sessionId: string) => Promise<DecisionRecord | null>;
  resolveDecision: (decisionId: string, state: "stale") => Promise<DecisionRecord | null>;
  getSessionDirectory: (session: SessionRecord) => string;
  getProviderDetails: (session: SessionRecord) => Promise<{ config: string; thread: string }>;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<void>;
  sendHistoryBlocks: (chatId: string, blocks: SessionTranscriptHistoryBlock[], purpose: string) => Promise<void>;
  sendDecisionMessage: (session: SessionRecord, decision: DecisionRecord) => Promise<void>;
  syncBatchDecisionMessage: (session: SessionRecord) => Promise<void>;
  postSessionRefreshStatus: (chatId: string, session: SessionRecord) => Promise<void>;
  sendGoNextHelpActions: (chatId: string, session: SessionRecord) => Promise<void>;
};

export class SessionTranscriptService {
  constructor(private readonly deps: SessionTranscriptServiceDependencies) {}

  async postSessionSwitchTranscript(
    telegramChatId: string,
    session: SessionRecord,
    recentMessages?: TranscriptMessage[],
    options?: { heading?: string; purpose?: "session_switch" | "session_refresh" }
  ): Promise<void> {
    const operation = options?.purpose ?? "session_switch";
    const directory = this.deps.getSessionDirectory(session);
    const history = (recentMessages ?? await this.deps.listRecentMessages(session.id, 5))
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-5);
    const pendingDecisions = await this.deps.listPendingDecisions(session.id);
    const awaitingInputDecision = await this.deps.getAwaitingInputDecision(session.id);
    const restorableDecisions: DecisionRecord[] = [];

    for (const decision of pendingDecisions) {
      if (decision.kind === "mcpServer/elicitation/request") {
        await this.deps.resolveDecision(decision.id, "stale");
        logger.info("bridge.session.skip_mcp_decision_restore", {
          chatId: telegramChatId,
          sessionId: session.id,
          decisionId: decision.id,
          state: decision.state
        });
        continue;
      }
      restorableDecisions.push(decision);
    }

    if (awaitingInputDecision?.kind === "mcpServer/elicitation/request") {
      await this.deps.resolveDecision(awaitingInputDecision.id, "stale");
      logger.info("bridge.session.skip_mcp_awaiting_restore", {
        chatId: telegramChatId,
        sessionId: session.id,
        decisionId: awaitingInputDecision.id
      });
    }

    logger.info("bridge.session.switch_transcript", {
      chatId: telegramChatId,
      sessionId: session.id,
      operation,
      historyCount: history.length,
      pendingDecisionCount: restorableDecisions.length,
      awaitingInputDecisionId: null
    });

    const headingSpec = createMessage({
      kind: "system",
      titleLabel: options?.heading ?? "Switched to session",
      session: { id: session.id, directory }
    });
    await this.deps.sendLongSpec(telegramChatId, headingSpec, {
      purpose: `${operation}_heading`
    });
    logger.info("bridge.session.transcript_heading_sent", {
      chatId: telegramChatId,
      sessionId: session.id,
      operation
    });

    if (history.length === 0) {
      const historySpec = createMessage({
        kind: "system",
        session: { id: session.id, directory },
        body: [{ type: "text", text: "No recent messages in the last 5 entries." }]
      });
      await this.deps.sendLongSpec(telegramChatId, historySpec, {
        purpose: `${operation}_history_empty`
      });
    } else {
      await this.deps.sendHistoryBlocks(
        telegramChatId,
        history.map((message) => {
          const messageSpec = createTranscriptMessageSpec({
            directory,
            role: message.role,
            text: message.text
          });
          return {
            text: renderLegacyMessage(messageSpec),
            assistant: message.role === "assistant",
            messageSpec
          };
        }),
        `${operation}_history`
      );
    }
    logger.info("bridge.session.transcript_history_sent", {
      chatId: telegramChatId,
      sessionId: session.id,
      operation,
      historyCount: history.length
    });

    const provider = await this.deps.getProviderDetails(session);
    const providerSpec = createMessage({
      kind: "system",
      titleLabel: "Provider",
      session: { id: session.id, directory },
      body: [
        { type: "field", label: "Config", value: provider.config },
        { type: "field", label: "Thread", value: provider.thread }
      ]
    });
    await this.deps.sendLongSpec(telegramChatId, providerSpec, {
      purpose: `${operation}_provider`
    });
    logger.info("bridge.session.transcript_provider_sent", {
      chatId: telegramChatId,
      sessionId: session.id,
      operation,
      hasHelpAction: false
    });

    for (const decision of restorableDecisions) {
      await this.deps.sendDecisionMessage(session, decision);
    }
    await this.deps.syncBatchDecisionMessage(session);
    if (operation === "session_refresh") {
      await this.deps.postSessionRefreshStatus(telegramChatId, session);
    }
    await this.deps.sendGoNextHelpActions(telegramChatId, session);
    logger.info("bridge.session.transcript_completed", {
      chatId: telegramChatId,
      sessionId: session.id,
      operation,
      restoredDecisionCount: restorableDecisions.length
    });
  }
}
