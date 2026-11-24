import type { Bot, InlineKeyboard } from "grammy";
import type { BridgeMessageOptions, BridgeMessageTransport, BridgeSentMessage } from "../bridge/transport.js";
import { renderLegacyMessage } from "../bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { logger } from "../logging/logger.js";
import { parseTelegramAddress, type TelegramAddress } from "../shared/telegram-address.js";
import { isTelegramRichMessageRejection } from "./errors.js";
import { renderTelegramMessageSpec } from "./message-renderer.js";
import { timeTelegramApi } from "./delivery-timing.js";
import { TelegramApiScheduler, telegramSchedulerFor } from "./api-scheduler.js";
import { classifyMessageEditError } from "../bridge/messages/edit-result.js";

type TelegramSendOptions = { disable_notification?: boolean; message_thread_id?: number };

export class TelegramMessageTransport implements BridgeMessageTransport {
  readonly name = "telegram";

  constructor(private readonly bot: Bot, private readonly formatHtml: (text: string) => string,
    private readonly scheduler: TelegramApiScheduler = telegramSchedulerFor(bot)) {}

  canHandle(sourceId: string): boolean { return parseTelegramAddress(sourceId) !== null; }

  async sendMessageSpec(sourceId: string, spec: MessageSpec, options?: BridgeMessageOptions): Promise<BridgeSentMessage | null> {
    const rendered = renderTelegramMessageSpec(spec);
    return this.write(sourceId, options, async target => {
      const sendOptions = this.sendOptions(target, options);
      try {
        const sent = await timeTelegramApi("sendRichMessage", () => this.bot.api.sendRichMessage(target.chatId, { markdown: rendered.markdown }, {
          ...sendOptions, reply_markup: rendered.keyboard
        }));
        return { message_id: String(sent.message_id) };
      } catch (error) {
        if (!isTelegramRichMessageRejection(error)) throw error;
        logger.warn("telegram.rich_message_rejected", { operation: "send", chatId: sourceId, description: error.description });
        return this.sendHtmlFallback(target.chatId, spec, rendered.html, rendered.keyboard, sendOptions, options?.canSend);
      }
    }, { operation: "send", messageKind: spec.kind });
  }

  async sendMessage(sourceId: string, text: string, options?: BridgeMessageOptions): Promise<BridgeSentMessage | null> {
    if (options?.messageSpec) return this.sendMessageSpec(sourceId, options.messageSpec, options);
    const html = options?.textFormat === "html";
    return this.write(sourceId, options, async target => {
      const sent = await timeTelegramApi("sendMessage", () => this.bot.api.sendMessage(target.chatId, html ? options.formattedText ?? this.formatHtml(text) : text, {
        ...this.sendOptions(target, options), parse_mode: html ? "HTML" : undefined
      }));
      return { message_id: String(sent.message_id) };
    }, { operation: "send" });
  }

  async editMessageText(sourceId: string, messageId: string, text: string, options?: BridgeMessageOptions): Promise<boolean> {
    if (options?.messageSpec) return this.editMessageSpec(sourceId, messageId, options.messageSpec, options);
    const html = options?.textFormat === "html";
    return this.edit(sourceId, options, async target => {
      await timeTelegramApi("editMessageText", () => this.bot.api.editMessageText(target.chatId, Number(messageId), html ? options.formattedText ?? this.formatHtml(text) : text, {
        parse_mode: html ? "HTML" : undefined
      }));
      return true;
    }, { operation: "edit" });
  }

  async editMessageSpec(sourceId: string, messageId: string, spec: MessageSpec, options?: BridgeMessageOptions): Promise<boolean> {
    const rendered = renderTelegramMessageSpec(spec);
    return this.edit(sourceId, options, async target => {
      // Edits identify an existing message in the physical chat; no topic field is accepted.
      const editOptions = { disable_notification: options?.disable_notification, reply_markup: rendered.keyboard };
      try {
        await timeTelegramApi("editMessageText", () => this.bot.api.editMessageText(target.chatId, Number(messageId), { markdown: rendered.markdown }, editOptions));
        return true;
      } catch (error) {
        if (!isTelegramRichMessageRejection(error)) throw error;
        logger.warn("telegram.rich_message_rejected", { operation: "edit", chatId: sourceId, messageId, description: error.description });
        if (await options?.canSend?.() === false) return false;
        try {
          await timeTelegramApi("editMessageText", () => this.bot.api.editMessageText(target.chatId, Number(messageId), rendered.html, { ...editOptions, parse_mode: "HTML" }));
        } catch (fallbackError) {
          if (!isTelegramRichMessageRejection(fallbackError)) throw fallbackError;
          if (await options?.canSend?.() === false) return false;
          await timeTelegramApi("editMessageText", () => this.bot.api.editMessageText(target.chatId, Number(messageId), renderLegacyMessage(spec), editOptions));
        }
        return true;
      }
    }, { operation: "edit", messageKind: spec.kind });
  }

  async deleteMessage(sourceId: string, messageId: string): Promise<boolean> {
    return await this.write(sourceId, undefined, async target => {
      await timeTelegramApi("deleteMessage", () => this.bot.api.deleteMessage(target.chatId, Number(messageId))); return true;
    }, { operation: "delete" }) ?? false;
  }

  async clearMessageActions(sourceId: string, messageId: string, _text?: string, _contentBlocks?: unknown[]): Promise<boolean> {
    void _text; void _contentBlocks;
    return this.edit(sourceId, undefined, async target => {
      await timeTelegramApi("editMessageReplyMarkup", () => this.bot.api.editMessageReplyMarkup(target.chatId, Number(messageId), { reply_markup: undefined })); return true;
    }, { operation: "clear_actions" });
  }

  async sendTyping(sourceId: string): Promise<void> {
    await this.write(sourceId, undefined, target => timeTelegramApi("sendChatAction", () => this.bot.api.sendChatAction(target.chatId, "typing", {
      ...(target.topicId === null ? {} : { message_thread_id: target.topicId })
    })), { operation: "typing" });
  }

  private sendOptions(target: TelegramAddress, options?: BridgeMessageOptions): TelegramSendOptions {
    return {
      ...(options?.disable_notification === undefined ? {} : { disable_notification: options.disable_notification }),
      ...(target.topicId === null ? {} : { message_thread_id: target.topicId })
    };
  }

  private async edit(sourceId: string, options: BridgeMessageOptions | undefined,
    operation: (target: TelegramAddress) => Promise<boolean>, context: { operation: string; messageKind?: string }): Promise<boolean> {
    return await this.write(sourceId, options, async target => {
      try { return await operation(target); }
      catch (error) {
        if (classifyMessageEditError(error) === "synced") return true;
        throw error;
      }
    }, context) ?? false;
  }

  private write<T>(sourceId: string, options: BridgeMessageOptions | undefined,
    operation: (target: TelegramAddress) => Promise<T>,
    context: { operation: string; messageKind?: string } = { operation: "write" }): Promise<T | null> {
    const target = parseTelegramAddress(sourceId);
    if (!target) throw new Error("Invalid Telegram source address.");
    return this.scheduler.run(target.chatId, async () => {
      // Queuing and server-directed backoff may outlive a revocable delivery lease.
      if (await options?.canSend?.() === false) return null;
      return operation(target);
    }, { ...context, chatId: sourceId, topicId: target.topicId });
  }

  private async sendHtmlFallback(chatId: string, spec: MessageSpec, html: string, keyboard: InlineKeyboard | undefined,
    options: TelegramSendOptions, canSend?: () => Promise<boolean>): Promise<BridgeSentMessage | null> {
    if (await canSend?.() === false) return null;
    try {
      const sent = await timeTelegramApi("sendMessage", () => this.bot.api.sendMessage(chatId, html, { ...options, parse_mode: "HTML", reply_markup: keyboard }));
      return { message_id: String(sent.message_id) };
    } catch (error) {
      if (!isTelegramRichMessageRejection(error)) throw error;
      if (await canSend?.() === false) return null;
      const sent = await timeTelegramApi("sendMessage", () => this.bot.api.sendMessage(chatId, renderLegacyMessage(spec), { ...options, reply_markup: keyboard }));
      return { message_id: String(sent.message_id) };
    }
  }
}
