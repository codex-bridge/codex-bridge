import type { MessageSpec } from "./messages/types.js";

export type BridgeMessageOptions = {
  disable_notification?: boolean;
  formattedText?: string;
  messageSpec?: MessageSpec;
  purpose?: string;
  textFormat?: "plain" | "html";
};

export type BridgeSentMessage = {
  message_id: string;
};

export interface BridgeMessageTransport {
  readonly name: string;
  /** Native structured transports receive whole specs, without chat-platform splitting. */
  readonly wholeMessageSpecs?: boolean;
  canHandle(chatId: string): boolean;
  sendMessageSpec?(
    chatId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null>;
  sendMessage(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null>;
  editMessageSpec?(
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<boolean>;
  editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<boolean>;
  deleteMessage(chatId: string, messageId: string): Promise<boolean>;
  clearMessageActions(
    chatId: string,
    messageId: string,
    text?: string,
    contentBlocks?: unknown[]
  ): Promise<boolean>;
  sendTyping(chatId: string): Promise<void>;
}
