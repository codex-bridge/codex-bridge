import { assistantPresentation } from "../../shared/assistant-questions.js";
import { createMessage } from "../messages/factory.js";
import { helpAction } from "../messages/actions.js";
import type { MessageSpec } from "../messages/types.js";
import type { SessionRecord, MessageRecord, TranscriptMessage } from "../../shared/types.js";
import type { PresentedAssistantMessage } from "../../shared/assistant-display.js";
import { protectPresentedAssistantText } from "../../shared/assistant-display.js";
import { BridgeStore } from "../../store/index.js";
import { logger } from "../../logging/logger.js";
import type { WorkflowAppend } from "../progress/workflow-sequence.js";

export type CompletedAgentMessage = PresentedAssistantMessage & { threadId: string; turnId?: string };

export type NotificationMessageDependencies = {
  appendWorkflowMessage: WorkflowAppend;
  store: BridgeStore;
  assistantOutputByThread: Map<string, boolean>;
  recentResolvedMcpBySession: Map<string, number>;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  resetTypingStatus: (sessionId: string) => void;
  clearRetryingRecovery: (sessionId: string) => void;
  getSessionDirectory: (session: SessionRecord) => string;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec) => Promise<void>;
  sendTranscriptMessage: (session: SessionRecord, message: MessageRecord & TranscriptMessage, threadId: string) => Promise<void>;
};

export class NotificationMessageService {
  private readonly nativeMessages = new Map<string, PresentedAssistantMessage>();
  constructor(private readonly deps: NotificationMessageDependencies) {}

  async handleCompletedAgentMessage(agentMessage: CompletedAgentMessage): Promise<void> {
    const nativeKey = agentMessage.sourceItemId ? JSON.stringify([agentMessage.threadId, agentMessage.sourceItemId]) : null;
    const previous = nativeKey ? this.nativeMessages.get(nativeKey) : undefined;
    const displayed = protectPresentedAssistantText(agentMessage.text, agentMessage.assistantDisplay, previous?.assistantDisplay);
    agentMessage = { threadId: agentMessage.threadId, turnId: agentMessage.turnId, sourceItemId: agentMessage.sourceItemId, ...displayed,
      ...assistantPresentation({ ...agentMessage, ...displayed }) };
    logger.info("bridge.notification.agent_message", {
      threadId: agentMessage.threadId,
      text: agentMessage.text
    });
    const session = await this.deps.resolveNotificationSession(agentMessage.threadId);
    if (!session) return;

    this.deps.assistantOutputByThread.set(agentMessage.threadId, true);
    const recentMessages = await this.deps.store.listRecentMessages(session.id, 1);
    const latestMessage = recentMessages.at(-1);
    const duplicate = nativeKey ? previous?.text === agentMessage.text &&
      JSON.stringify(assistantPresentation(previous)) === JSON.stringify(assistantPresentation(agentMessage)) : latestMessage &&
      latestMessage.role === "assistant" &&
      latestMessage.text.trim() === agentMessage.text.trim() &&
      Date.now() - latestMessage.createdAt < 15_000;
    if (duplicate) {
      logger.info("bridge.notification.agent_message.duplicate_skipped", {
        sessionId: session.id,
        threadId: agentMessage.threadId,
        messageId: latestMessage?.id
      });
      return;
    }

    this.deps.resetTypingStatus(session.id);
    this.deps.clearRetryingRecovery(session.id);
    const message = await this.deps.store.addMessage({
      sessionId: session.id,
      role: "assistant",
      text: agentMessage.text
    });
    if (nativeKey) {
      this.nativeMessages.set(nativeKey, agentMessage);
      if (this.nativeMessages.size > 256) this.nativeMessages.delete(this.nativeMessages.keys().next().value!);
    }
    const resolvedAt = this.deps.recentResolvedMcpBySession.get(session.id);
    if (resolvedAt) this.deps.recentResolvedMcpBySession.delete(session.id);
    await this.deps.appendWorkflowMessage(session, async () => {
      if (resolvedAt && Date.now() - resolvedAt < 120_000 && agentMessage.delivery !== "async") {
        const messageSpec = createMessage({
          kind: "mcp",
          session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
          body: [{ type: "text", text: agentMessage.text.trim() }],
          ...(agentMessage.assistantDisplay ? { assistantDisplay: agentMessage.assistantDisplay } : {}),
          ...(agentMessage.sourceItemId ? { sourceItemId: agentMessage.sourceItemId } : {}),
          actions: [helpAction()]
        });
        await this.deps.sendLongSpec(session.telegramChatId, messageSpec);
        return;
      }
      await this.deps.sendTranscriptMessage(session, {
        ...message, ...assistantPresentation(agentMessage),
        ...(agentMessage.sourceItemId ? { sourceItemId: agentMessage.sourceItemId } : {})
      }, agentMessage.threadId);
    }, { turnId: agentMessage.turnId });
  }
}
