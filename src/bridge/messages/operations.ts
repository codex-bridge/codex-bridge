import type { TelegramTextChunk } from "../../telegram/text.js";
import type { MessageRecord, SessionRecord } from "../../shared/types.js";
import type { BridgeMessageOptions, BridgeSentMessage } from "../transport.js";
import { createTranscriptMessageSpec } from "../renderers/thread-history.js";
import { renderLegacyMessage } from "./legacy-adapter.js";
import type { MessageSpec } from "./types.js";
import type { MessageDeliveryService } from "./sender.js";

type LastSentMessage = { messageId: string; text: string };
type LastAssistantMessage = LastSentMessage & { chatId: string };

export type BridgeMessageOperationsDependencies = {
  sender: Pick<
    MessageDeliveryService,
    | "requireTransport"
    | "sendSpec"
    | "sendLongSpec"
    | "editSpec"
    | "sendSpecAndGetLastMessage"
    | "sendLongTextAndGetLastMessage"
    | "sendTextChunksAndGetLastMessage"
  >;
  formatCodexTelegramHtml: (text: string) => TelegramTextChunk[] | null;
  getSessionDirectory: (session: SessionRecord) => string;
  rememberLastAssistantMessage: (threadId: string, message: LastAssistantMessage) => void;
};

export class BridgeMessageOperations {
  constructor(private readonly deps: BridgeMessageOperationsDependencies) {}

  async sendMessageSpec(
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<BridgeSentMessage | null> {
    return this.deps.sender.sendSpec(chatId, messageSpec, options);
  }

  async sendLongSpec(
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<void> {
    return this.deps.sender.sendLongSpec(chatId, messageSpec, options);
  }

  async editMessageSpec(
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<boolean> {
    return this.deps.sender.editSpec(chatId, messageId, messageSpec, options);
  }

  async sendSpecAndGetLastMessage(
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<LastSentMessage | null> {
    return this.deps.sender.sendSpecAndGetLastMessage(chatId, messageSpec, options);
  }

  async sendLongTextAndGetLastMessage(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<LastSentMessage | null> {
    return this.deps.sender.sendLongTextAndGetLastMessage(chatId, text, options);
  }

  async sendTelegramTextChunksAndGetLastMessage(
    chatId: string,
    chunks: TelegramTextChunk[],
    options?: Pick<BridgeMessageOptions, "purpose">
  ): Promise<LastSentMessage | null> {
    return this.deps.sender.sendTextChunksAndGetLastMessage(chatId, chunks, options);
  }

  async sendTranscriptMessage(
    session: SessionRecord,
    message: MessageRecord,
    threadId?: string
  ): Promise<void> {
    const lastSent = await this.sendRenderedTranscriptMessage(session, message);
    if (threadId && message.role === "assistant" && lastSent) {
      this.deps.rememberLastAssistantMessage(threadId, {
        chatId: session.telegramChatId,
        messageId: lastSent.messageId,
        text: lastSent.text
      });
    }
  }

  private async sendRenderedTranscriptMessage(
    session: SessionRecord,
    message: Pick<MessageRecord, "role" | "text">,
    purpose?: string
  ): Promise<LastSentMessage | null> {
    const messageSpec = createTranscriptMessageSpec({
      directory: this.deps.getSessionDirectory(session),
      role: message.role,
      text: message.text
    });
    messageSpec.session = { id: session.id, directory: this.deps.getSessionDirectory(session) };
    if (this.deps.sender.requireTransport(session.telegramChatId).sendMessageSpec) {
      return this.sendSpecAndGetLastMessage(session.telegramChatId, messageSpec, { purpose });
    }

    const rendered = renderLegacyMessage(messageSpec);
    const formattedChunks = message.role === "assistant"
      ? this.deps.formatCodexTelegramHtml(rendered)
      : null;
    return formattedChunks
      ? this.sendTelegramTextChunksAndGetLastMessage(session.telegramChatId, formattedChunks, { purpose })
      : this.sendLongTextAndGetLastMessage(session.telegramChatId, rendered, {
          purpose,
          textFormat: "html"
        });
  }
}
