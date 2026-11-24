import { Bot, Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";

import type { BridgeTelegramBotPort } from "../bridge/contracts.js";
import type { AppConfig } from "../config/index.js";
import { createMessage, messageContextForSession } from "../bridge/messages/factory.js";
import { helpAction, sessionAction } from "../bridge/messages/actions.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { logger } from "../logging/logger.js";
import { createTelegramInteractionContext } from "./interactions/context.js";
import { createTelegramHelpMessage } from "./interactions/help.js";
import { dispatchTelegramInteraction } from "./interactions/router.js";
import { acknowledgeTelegramCallback } from "./interactions/acknowledge.js";

import { telegramSourceForContext } from "../shared/telegram-address.js";
import { TelegramMessageTransport } from "./transport.js";
import { formatTelegramHtml } from "./text.js";
import { configureTelegramApi, type TelegramApiOptions } from "./api-policy.js";
import { downloadTelegramMedia, telegramMediaStorage, telegramMediaKind, TelegramAttachmentError } from "./attachments.js";
import { TelegramMediaGroups, registerTelegramMediaGroups } from "./media-groups.js";
import { markManagedAttachmentPathsStatus } from "../bridge/input/attachment-files.js";

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

export function buildTelegramBot(config: AppConfig, service: BridgeTelegramBotPort, bot = new Bot(config.telegramBotToken), apiOptions?: TelegramApiOptions): Bot {
  configureTelegramApi(bot, 10_000, apiOptions);
  const transport = new TelegramMessageTransport(bot, formatTelegramHtml);
  const acknowledge = (ctx: Context, text?: string): Promise<void> => acknowledgeTelegramCallback(
    // grammY types signals through its legacy polyfill; Node's native signal is runtime-compatible.
    signal => ctx.answerCallbackQuery(text ? { text } : undefined,
      signal as unknown as Parameters<Context["answerCallbackQuery"]>[1]),
    { chatId: ctx.chat?.id, callbackId: ctx.callbackQuery?.id }
  );
  bot.use(sequentialize((ctx: Context) => ctx.chat ? telegramSourceForContext(ctx) : undefined));
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery?.message?.date === 0) {
      await acknowledge(ctx, "This message is unavailable. Open /sessions in the intended topic.");
      return;
    }
    if (ctx.chat) await service.ensureChatAllowed(telegramSourceForContext(ctx));
    await next();
  });
  const replyPrompt = async (
    ctx: Context,
    text: string,
    actions: MessageSpec["actions"] = [helpAction()]
  ): Promise<void> => {
    await replySpec(ctx, createMessage({
      kind: "system",
      titleLabel: "Codex",
      ...messageContextForSession(await service.getActiveSessionContext(telegramSourceForContext(ctx))),
      body: [{ type: "text", text }],
      actions
    }));
  };
  const replySpec = async (ctx: Context, messageSpec: MessageSpec): Promise<boolean> => {
    return Boolean(await transport.sendMessageSpec(telegramSourceForContext(ctx), messageSpec));
  };
  const editSpec = async (ctx: Context, messageSpec: MessageSpec): Promise<boolean> => {
    if (!ctx.msg) throw new Error("No Telegram message context is available.");
    return transport.editMessageSpec(telegramSourceForContext(ctx), String(ctx.msg.message_id), messageSpec);
  };

  const mediaError = async (contexts: Context[], error: unknown): Promise<void> => {
    const ctx = contexts[0]!;
    logger.warn("telegram.attachment.failed", { chatId: telegramSourceForContext(ctx),
      errorType: error instanceof Error ? error.name : "Unknown" });
    await replyPrompt(ctx, error instanceof TelegramAttachmentError
      ? error.message : "Attachment processing failed. Check the Bridge logs before retrying.");
  };
  const deliverMedia = async (contexts: Context[]): Promise<void> => {
    const ctx = contexts[0]!, source = telegramSourceForContext(ctx);
    const session = await service.getActiveSessionContext(source);
    if (!session?.id) { await replyPrompt(ctx, "Choose a session first.", [sessionAction(), helpAction()]); return; }
    const kind = telegramMediaKind(ctx);
    if (!kind) throw new TelegramAttachmentError("Only supported images and audio can be attached.");
    const storage = telegramMediaStorage(kind);
    const files = await downloadTelegramMedia(bot, contexts, kind);
    const attachments = await storage.save(files, { requestId: String(ctx.message!.message_id), sessionId: session.id, status: "downloaded" });
    const paths = attachments.map(attachment => attachment.localPath);
    try {
      if ((await service.getActiveSessionContext(source))?.id !== session.id) {
        await markManagedAttachmentPathsStatus(paths, "failed");
        await replyPrompt(ctx, "The selected session changed while downloading. Send the attachment again in the intended session.");
        return;
      }
      const result = await service.handleIncomingUserPayload({
        telegramChatId: source, telegramMessageId: String(ctx.message!.message_id), attachments,
        text: [...new Set(contexts.map(item => item.message?.caption?.trim()).filter(Boolean))].join("\n\n")
      });
      await markManagedAttachmentPathsStatus(paths, result.routed ? "sent-to-codex" : "failed");
      if (!result.routed) {
        if (result.prompt) await replySpec(ctx, result.prompt);
        else await replyPrompt(ctx, "Choose a session first.", [sessionAction(), helpAction()]);
      }
    } catch (error) { await markManagedAttachmentPathsStatus(paths, "failed"); throw error; }
  };
  const mediaGroups = new TelegramMediaGroups(deliverMedia, mediaError);
  registerTelegramMediaGroups(bot, mediaGroups);
  bot.use(async (ctx, next) => {
    if (!ctx.message) return next();
    if (ctx.message.media_group_id) { mediaGroups.add(ctx); return; }
    await mediaGroups.flushSource(telegramSourceForContext(ctx));
    if (ctx.message.photo || ctx.message.document || ctx.message.voice || ctx.message.audio) {
      try { await deliverMedia([ctx]); } catch (error) { await mediaError([ctx], error); }
      return;
    }
    return next();
  });

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
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.help", { chatId });
    await replySpec(ctx, createTelegramHelpMessage(
      await service.getActiveSessionContext(chatId),
      await service.getHelpMenuActions(chatId)
    ));
  };

  bot.command("help", handleHelp);

  bot.command("session_new", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.session_new", { chatId });
    const prompt = await service.requestCreateSessionForCurrentDirectory(chatId);
    await replySpec(ctx, prompt);
  });

  bot.command("sessions", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.sessions", { chatId });
    const menu = await service.renderSessionMenu(chatId, 0, { refresh: true, includeUnknownThreads: true });
    await replySpec(ctx, menu);
  });

  bot.command("goal", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    const menu = await service.setActiveGoalObjective(chatId, getCommandArgument(ctx.message?.text ?? ""));
    await replySpec(ctx, menu);
  });

  bot.command("goals", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    const menu = await service.renderGoalsMenu(chatId);
    await replySpec(ctx, menu);
  });

  bot.command("section_rename", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    const name = getCommandArgument(ctx.message?.text ?? "");
    logger.info("telegram.command.section_rename", { chatId });
    await replySpec(ctx, await service.renameActiveSectionMessage(chatId, name));
  });

  bot.command("go", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.go", { chatId });
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
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.next", { chatId });
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
    const chatId = telegramSourceForContext(ctx);
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
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.bot_disconnect", { chatId });
    await replySpec(ctx, await service.disconnectBotRuntimeMessage(chatId));
  });

  bot.command("bot_connect", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.bot_connect", { chatId });
    await replySpec(ctx, await service.connectBotRuntimeMessage(chatId));
  });

  bot.command("interrupt", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.interrupt", { chatId });
    await replySpec(ctx, await service.stopActiveSessionMessage(chatId));
  });

  bot.command("codex_status", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.codex_status", { chatId });
    const result = await service.statusActiveSessionMessage(chatId);
    await replySpec(ctx, result);
  });

  bot.command("codex_status_full", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.codex_status_full", { chatId });
    const result = await service.statusActiveSessionMessage(chatId, true);
    await replySpec(ctx, result);
  });

  bot.command("compact", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.compact", { chatId });
    const result = await service.compactActiveSessionMessage(chatId);
    await service.deliverCompactResult(chatId, result, async () => { await replySpec(ctx, result); });
  });

  bot.command("bot_restart", async (ctx) => {
    const chatId = telegramSourceForContext(ctx);
    logger.info("telegram.command.bot_restart", { chatId });
    await replySpec(ctx, await service.restartServiceMessage(chatId));
  });

  bot.on("message:text", async (ctx) => {
    if (isKnownCommand(ctx.message.text)) {
      return;
    }

    const chatId = telegramSourceForContext(ctx);
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
      await acknowledge(ctx, "No chat context is available for this callback.");
      return;
    }

    const chatId = telegramSourceForContext(ctx);
    const data = ctx.callbackQuery.data;
    logger.info("telegram.callback.received", { chatId, data });

    const interaction = createTelegramInteractionContext(
      chatId,
      ctx.callbackQuery.message?.message_id
    );
    // Disposable spinner feedback is bounded and nonrejecting. It must not delay
    // business execution; failures use durable messages through the responder.
    void acknowledge(ctx);
    await dispatchTelegramInteraction({
      action: data,
      callbackId: ctx.callbackQuery.id,
      context: interaction,
      responder: {
        clearActions: async () => {
          await transport.clearMessageActions(chatId, String(ctx.callbackQuery.message!.message_id));
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
