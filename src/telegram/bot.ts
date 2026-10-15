import { Bot, Context, InlineKeyboard } from "grammy";

import type { BridgeTelegramBotPort } from "../bridge/contracts.js";
import type { AppConfig } from "../config/index.js";
import { createMessage } from "../bridge/messages/factory.js";
import { helpAction, sessionAction } from "../bridge/messages/actions.js";
import { renderLegacyMessage } from "../bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { logger } from "../logging/logger.js";
import { isTelegramRichMessageRejection } from "./errors.js";
import { renderTelegramMessageSpec } from "./message-renderer.js";
import { createTelegramInteractionContext } from "./interactions/context.js";
import { createTelegramHelpMessage } from "./interactions/help.js";
import { dispatchTelegramInteraction } from "./interactions/router.js";

const knownCommands = new Set([
  "help",
  "session_new",
  "sessions",
  "goal",
  "goals",
  "section_rename",
  "go",
  "next",
  "queue",
  "bot_connect",
  "bot_disconnect",
  "interrupt",
  "codex_status",
  "codex_status_full",
  "compact",
  "bot_restart"
]);

function isKnownCommand(text: string): boolean {
  if (!text.startsWith("/")) {
    return false;
  }

  const firstToken = text.trim().split(/\s+/, 1)[0] ?? "";
  const command = firstToken.slice(1).split("@", 1)[0] ?? "";
  return knownCommands.has(command);
}

function getCommandArgument(text: string): string {
  const trimmed = text.trim();
  const match = /\s/.exec(trimmed);
  if (!match) {
    return "";
  }
  return trimmed.slice(match.index).trim();
}

export function buildTelegramBot(config: AppConfig, service: BridgeTelegramBotPort): Bot {
  const bot = new Bot(config.telegramBotToken);
  const replyPrompt = async (
    ctx: Context,
    text: string,
    actions: MessageSpec["actions"] = [helpAction()]
  ): Promise<void> => {
    await replySpec(ctx, createMessage({
      kind: "system",
      titleLabel: "Codex",
      session: await service.getActiveSessionContext(String(ctx.chat?.id ?? "")),
      body: [{ type: "text", text }],
      actions
    }));
  };
  const replySpec = async (ctx: Context, messageSpec: MessageSpec) => {
    const rendered = renderTelegramMessageSpec(messageSpec);
    try {
      await ctx.replyWithRichMessage({ markdown: rendered.markdown }, {
        reply_markup: rendered.keyboard
      });
    } catch (error) {
      if (!isTelegramRichMessageRejection(error)) throw error;
      logger.warn("telegram.rich_message_rejected", {
        operation: "reply",
        chatId: ctx.chat?.id,
        description: error.description
      });
      try {
        await ctx.reply(rendered.html, {
          parse_mode: "HTML",
          reply_markup: rendered.keyboard
        });
      } catch (fallbackError) {
        if (!isTelegramRichMessageRejection(fallbackError)) throw fallbackError;
        await ctx.reply(renderLegacyMessage(messageSpec), { reply_markup: rendered.keyboard });
      }
    }
  };
  const editSpec = async (ctx: Context, messageSpec: MessageSpec) => {
    const rendered = renderTelegramMessageSpec(messageSpec);
    try {
      await ctx.editMessageText({ markdown: rendered.markdown }, {
        reply_markup: rendered.keyboard
      });
    } catch (error) {
      if (!isTelegramRichMessageRejection(error)) throw error;
      logger.warn("telegram.rich_message_rejected", {
        operation: "context_edit",
        chatId: ctx.chat?.id,
        description: error.description
      });
      try {
        await ctx.editMessageText(rendered.html, {
          parse_mode: "HTML",
          reply_markup: rendered.keyboard
        });
      } catch (fallbackError) {
        if (!isTelegramRichMessageRejection(fallbackError)) throw fallbackError;
        await ctx.editMessageText(renderLegacyMessage(messageSpec), { reply_markup: rendered.keyboard });
      }
    }
  };

  void bot.api
    .setMyCommands([
      { command: "bot_disconnect", description: "Disconnect this bot from Codex" },
      { command: "bot_connect", description: "Reconnect this bot to Codex" },
      { command: "bot_restart", description: "Restart the bridge service" },
      { command: "interrupt", description: "Interrupt the active Codex run" },
      { command: "queue", description: "Queue input after the active run" },
      { command: "go", description: "Send 'go' to the active Codex session" },
      { command: "next", description: "Send 'next' to the active Codex session" },
      { command: "codex_status", description: "Show the active Codex session status" },
      { command: "codex_status_full", description: "Show detailed Codex runtime status" },
      { command: "compact", description: "Compact the active session" },
      { command: "session_new", description: "Create a new session in the current directory" },
      { command: "sessions", description: "Open the session menu" },
      { command: "goal", description: "Show or set the active session goal" },
      { command: "goals", description: "List unfinished goals" },
      { command: "section_rename", description: "Rename the active section" },
      { command: "help", description: "Show bot help" },
    ])
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("telegram.set_my_commands.failed", { message });
    });

  const handleHelp = async (ctx: Context) => {
    if (!ctx.chat) {
      return;
    }
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.help", { chatId });
    await service.ensureChatAllowed(chatId);
    await replySpec(ctx, createTelegramHelpMessage(
      await service.getActiveSessionContext(chatId),
      await service.getHelpMenuActions(chatId)
    ));
  };

  bot.command("help", handleHelp);

  bot.command("session_new", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.session_new", { chatId });
    await service.ensureChatAllowed(chatId);
    const prompt = await service.requestCreateSessionForCurrentDirectory(chatId);
    await replySpec(ctx, prompt);
  });

  bot.command("sessions", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.sessions", { chatId });
    await service.ensureChatAllowed(chatId);
    const menu = await service.renderSessionMenu(chatId, 0, { refresh: true, includeUnknownThreads: true });
    await replySpec(ctx, menu);
  });

  bot.command("goal", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await service.ensureChatAllowed(chatId);
    const menu = await service.setActiveGoalObjective(chatId, getCommandArgument(ctx.message?.text ?? ""));
    await replySpec(ctx, menu);
  });

  bot.command("goals", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await service.ensureChatAllowed(chatId);
    const menu = await service.renderGoalsMenu(chatId);
    await replySpec(ctx, menu);
  });

  bot.command("section_rename", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const name = getCommandArgument(ctx.message?.text ?? "");
    logger.info("telegram.command.section_rename", { chatId });
    await service.ensureChatAllowed(chatId);
    await replySpec(ctx, await service.renameActiveSectionMessage(chatId, name));
  });

  bot.command("go", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.go", { chatId });
    await service.ensureChatAllowed(chatId);
    const result = await service.handleIncomingUserText({
      telegramChatId: chatId,
      telegramMessageId: String(ctx.msg?.message_id ?? ""),
      text: "go"
    });

    if (!result.routed) {
      if (result.prompt) await replySpec(ctx, result.prompt);
      else await replyPrompt(ctx, "Choose a session first.", [sessionAction(), helpAction()]);
    }
  });

  bot.command("next", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.next", { chatId });
    await service.ensureChatAllowed(chatId);
    const result = await service.handleIncomingUserText({
      telegramChatId: chatId,
      telegramMessageId: String(ctx.msg?.message_id ?? ""),
      text: "next"
    });

    if (!result.routed) {
      if (result.prompt) await replySpec(ctx, result.prompt);
      else await replyPrompt(ctx, "Choose a session first.", [sessionAction(), helpAction()]);
    }
  });

  bot.command("queue", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = getCommandArgument(ctx.message?.text ?? "");
    if (!text) {
      await replyPrompt(ctx, "Send /queue followed by the message to run after the current turn.");
      return;
    }
    const result = await service.handleIncomingUserText({
      telegramChatId: chatId,
      telegramMessageId: String(ctx.msg?.message_id ?? ""),
      text,
      queue: true
    });
    if (!result.routed) {
      if (result.prompt) await replySpec(ctx, result.prompt);
      else await replyPrompt(ctx, "Could not queue this message.", [helpAction(), sessionAction()]);
    }
  });

  bot.command("bot_disconnect", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.bot_disconnect", { chatId });
    await service.ensureChatAllowed(chatId);
    await replySpec(ctx, await service.disconnectBotRuntimeMessage(chatId));
  });

  bot.command("bot_connect", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.bot_connect", { chatId });
    await service.ensureChatAllowed(chatId);
    await replySpec(ctx, await service.connectBotRuntimeMessage(chatId));
  });

  bot.command("interrupt", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.interrupt", { chatId });
    await service.ensureChatAllowed(chatId);
    await replySpec(ctx, await service.stopActiveSessionMessage(chatId));
  });

  bot.command("codex_status", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.codex_status", { chatId });
    await service.ensureChatAllowed(chatId);
    const result = await service.statusActiveSessionMessage(chatId);
    await replySpec(ctx, result);
  });

  bot.command("codex_status_full", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.codex_status_full", { chatId });
    await service.ensureChatAllowed(chatId);
    const result = await service.statusActiveSessionMessage(chatId, true);
    await replySpec(ctx, result);
  });

  bot.command("compact", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.compact", { chatId });
    await service.ensureChatAllowed(chatId);
    const result = await service.compactActiveSessionMessage(chatId);
    await replySpec(ctx, result);
  });

  bot.command("bot_restart", async (ctx) => {
    const chatId = String(ctx.chat.id);
    logger.info("telegram.command.bot_restart", { chatId });
    await service.ensureChatAllowed(chatId);
    await replySpec(ctx, await service.restartServiceMessage(chatId));
  });

  bot.on("message:text", async (ctx) => {
    if (isKnownCommand(ctx.message.text)) {
      return;
    }

    const chatId = String(ctx.chat.id);
    logger.info("telegram.message.received", {
      chatId,
      messageId: ctx.message.message_id,
      text: ctx.message.text
    });
    const result = await service.handleIncomingUserText({
      telegramChatId: chatId,
      telegramMessageId: String(ctx.message.message_id),
      text: ctx.message.text
    });

    if (!result.routed) {
      logger.info("telegram.message.prompted", {
        chatId,
        hasActions: Boolean(result.prompt?.actions.length),
        promptKind: result.prompt?.kind ?? null,
        promptTitle: result.prompt?.title ?? null
      });
      if (result.prompt) await replySpec(ctx, result.prompt);
      else await replyPrompt(ctx, "Choose a session first.", [sessionAction(), helpAction()]);
      return;
    }

    logger.info("telegram.message.routed", { chatId, messageId: ctx.message.message_id });
  });

  bot.on("callback_query:data", async (ctx) => {
    if (!ctx.chat) {
      await ctx.answerCallbackQuery({ text: "No chat context is available for this callback." });
      return;
    }

    const chatId = String(ctx.chat.id);
    const data = ctx.callbackQuery.data;
    logger.info("telegram.callback.received", { chatId, data });

    const interaction = createTelegramInteractionContext(
      chatId,
      ctx.callbackQuery.message?.message_id
    );
    await dispatchTelegramInteraction({
      action: data,
      acknowledge: async (text) => {
        await ctx.answerCallbackQuery(text ? { text } : undefined);
      },
      callbackId: ctx.callbackQuery.id,
      context: interaction,
      responder: {
        clearActions: async () => {
          await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
        },
        edit: async (message) => editSpec(ctx, message),
        send: async (message) => replySpec(ctx, message)
      },
      service
    });
    return;
  });

  bot.catch((error) => {
    const message =
      error.error instanceof Error ? error.error.message : String(error.error);
    logger.error("telegram.bot.error", {
      message,
      updateId: error.ctx.update.update_id
    });
  });

  return bot;
}
