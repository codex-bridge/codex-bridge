import { createMessage } from "../messages/factory.js";
import { helpAction } from "../messages/actions.js";
import type { MessageSpec } from "../messages/types.js";
import type { SessionRecord, MessageRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { logger } from "../../logging/logger.js";

export type CompletedAgentMessage = {
  threadId: string;
  text: string;
};

export type NotificationMessageDependencies = {
  store: BridgeStore;
  assistantOutputByThread: Map<string, boolean>;
  recentResolvedMcpBySession: Map<string, number>;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  resetTypingStatus: (sessionId: string) => void;
  clearRetryingRecovery: (sessionId: string) => void;
  getSessionDirectory: (session: SessionRecord) => string;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec) => Promise<void>;
  sendTranscriptMessage: (session: SessionRecord, message: MessageRecord, threadId: string) => Promise<void>;
  clearProgressMessageForThread: (threadId: string) => Promise<void>;
};

export class NotificationMessageService {
  constructor(private readonly deps: NotificationMessageDependencies) {}

  async handleCompletedAgentMessage(agentMessage: CompletedAgentMessage): Promise<void> {
    logger.info("bridge.notification.agent_message", {
      threadId: agentMessage.threadId,
      text: agentMessage.text
    });
    const session = await this.deps.resolveNotificationSession(agentMessage.threadId);
    if (!session) return;

    this.deps.assistantOutputByThread.set(agentMessage.threadId, true);
    const recentMessages = await this.deps.store.listRecentMessages(session.id, 1);
    const latestMessage = recentMessages.at(-1);
    if (
      latestMessage &&
      latestMessage.role === "assistant" &&
      latestMessage.text.trim() === agentMessage.text.trim() &&
      Date.now() - latestMessage.createdAt < 15_000
    ) {
      logger.info("bridge.notification.agent_message.duplicate_skipped", {
        sessionId: session.id,
        threadId: agentMessage.threadId,
        messageId: latestMessage.id
      });
      await this.deps.clearProgressMessageForThread(agentMessage.threadId);
      return;
    }

    this.deps.resetTypingStatus(session.id);
    this.deps.clearRetryingRecovery(session.id);
    const message = await this.deps.store.addMessage({
      sessionId: session.id,
      role: "assistant",
      text: agentMessage.text
    });
    const resolvedAt = this.deps.recentResolvedMcpBySession.get(session.id);
    if (resolvedAt && Date.now() - resolvedAt < 120_000) {
      this.deps.recentResolvedMcpBySession.delete(session.id);
      const messageSpec = createMessage({
        kind: "mcp",
        session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
        body: [{ type: "text", text: agentMessage.text.trim() }],
        actions: [helpAction()]
      });
      await this.deps.sendLongSpec(session.telegramChatId, messageSpec);
      await this.deps.clearProgressMessageForThread(agentMessage.threadId);
      return;
    }
    await this.deps.sendTranscriptMessage(session, message, agentMessage.threadId);
    await this.deps.clearProgressMessageForThread(agentMessage.threadId);
  }
}
