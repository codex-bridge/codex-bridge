import type { Bot, InlineKeyboard } from "grammy";

import type {
  BridgeMessageOptions,
  BridgeMessageTransport,
  BridgeSentMessage
} from "../bridge/transport.js";
import { renderLegacyMessage } from "../bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { logger } from "../logging/logger.js";
import { isTelegramRichMessageRejection } from "./errors.js";
import { renderTelegramMessageSpec } from "./message-renderer.js";
import { messageTransportPlatform } from "../shared/source-address.js";

export class TelegramMessageTransport implements BridgeMessageTransport {
  readonly name = "telegram";

  constructor(
    private readonly bot: Bot,
    private readonly formatHtml: (text: string) => string
  ) {}

  canHandle(chatId: string): boolean {
    return messageTransportPlatform(chatId) === "telegram";
  }

  async sendMessageSpec(
    chatId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null> {
    const { formattedText, messageSpec: _messageSpec, purpose, textFormat, ...telegramOptions } = options ?? {};
    void formattedText;
    void _messageSpec;
    void purpose;
    void textFormat;
    const rendered = renderTelegramMessageSpec(messageSpec);
    try {
      const sent = await this.bot.api.sendRichMessage(chatId, { markdown: rendered.markdown }, {
        ...telegramOptions,
        reply_markup: rendered.keyboard
      });
      return { message_id: String(sent.message_id) };
    } catch (error) {
      if (!isTelegramRichMessageRejection(error)) throw error;
      logger.warn("telegram.rich_message_rejected", {
        operation: "send",
        chatId,
        description: error.description
      });
      return this.sendHtmlFallback(chatId, messageSpec, rendered.html, rendered.keyboard, telegramOptions);
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null> {
    if (options?.messageSpec) {
      return this.sendMessageSpec(chatId, options.messageSpec, options);
    }
    const { textFormat = "plain", formattedText, purpose, messageSpec: _messageSpec, ...telegramOptions } = options ?? {};
    void purpose;
    void _messageSpec;
    const textToSend = textFormat === "html" ? (formattedText ?? this.formatHtml(text)) : text;
    const sent = await this.bot.api.sendMessage(chatId, textToSend, {
      ...telegramOptions,
      parse_mode: textFormat === "html" ? "HTML" : undefined
    });
    return { message_id: String(sent.message_id) };
  }

  async editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<boolean> {
    if (options?.messageSpec) {
      return this.editMessageSpec(chatId, messageId, options.messageSpec, options);
    }
    const { textFormat = "plain", formattedText, purpose, messageSpec: _messageSpec, ...telegramOptions } = options ?? {};
    void purpose;
    void _messageSpec;
    const textToSend = textFormat === "html" ? (formattedText ?? this.formatHtml(text)) : text;
    await this.bot.api.editMessageText(chatId, Number.parseInt(messageId, 10), textToSend, {
      ...telegramOptions,
      parse_mode: textFormat === "html" ? "HTML" : undefined
    });
    return true;
  }

  async editMessageSpec(
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<boolean> {
    const { formattedText, messageSpec: _messageSpec, purpose, textFormat, ...telegramOptions } = options ?? {};
    void formattedText;
    void _messageSpec;
    void purpose;
    void textFormat;
    const rendered = renderTelegramMessageSpec(messageSpec);
    const parsedMessageId = Number.parseInt(messageId, 10);
    try {
      await this.bot.api.editMessageText(chatId, parsedMessageId, { markdown: rendered.markdown }, {
        ...telegramOptions,
        reply_markup: rendered.keyboard
      });
      return true;
    } catch (error) {
      if (!isTelegramRichMessageRejection(error)) throw error;
      logger.warn("telegram.rich_message_rejected", {
        operation: "edit",
        chatId,
        messageId,
        description: error.description
      });
      await this.editHtmlFallback(
        chatId,
        parsedMessageId,
        messageSpec,
        rendered.html,
        rendered.keyboard,
        telegramOptions
      );
      return true;
    }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<boolean> {
    await this.bot.api.deleteMessage(chatId, Number.parseInt(messageId, 10));
    return true;
  }

  async clearMessageActions(
    chatId: string,
    messageId: string,
    _text?: string,
    _contentBlocks?: unknown[]
  ): Promise<boolean> {
    void _text;
    void _contentBlocks;
    await this.bot.api.editMessageReplyMarkup(chatId, Number.parseInt(messageId, 10), {
      reply_markup: undefined
    });
    return true;
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, "typing");
  }

  private async sendHtmlFallback(
    chatId: string,
    messageSpec: MessageSpec,
    html: string,
    replyMarkup: InlineKeyboard | undefined,
    telegramOptions: Pick<BridgeMessageOptions, "disable_notification">
  ): Promise<BridgeSentMessage> {
    try {
      const sent = await this.bot.api.sendMessage(chatId, html, {
        ...telegramOptions,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      });
      return { message_id: String(sent.message_id) };
    } catch (error) {
      if (!isTelegramRichMessageRejection(error)) throw error;
      const sent = await this.bot.api.sendMessage(chatId, renderLegacyMessage(messageSpec), {
        ...telegramOptions,
        reply_markup: replyMarkup
      });
      return { message_id: String(sent.message_id) };
    }
  }

  private async editHtmlFallback(
    chatId: string,
    messageId: number,
    messageSpec: MessageSpec,
    html: string,
    replyMarkup: InlineKeyboard | undefined,
    telegramOptions: Pick<BridgeMessageOptions, "disable_notification">
  ): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, html, {
        ...telegramOptions,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      });
    } catch (error) {
      if (!isTelegramRichMessageRejection(error)) throw error;
      await this.bot.api.editMessageText(chatId, messageId, renderLegacyMessage(messageSpec), {
        ...telegramOptions,
        reply_markup: replyMarkup
      });
    }
  }
}
