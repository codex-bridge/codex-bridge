import {
  App,
  LogLevel,
  SocketModeReceiver,
  type SlackActionMiddlewareArgs
} from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";

import type { BridgeSlackBotPort } from "../bridge/contracts.js";
import { helpAction, sessionAction } from "../bridge/messages/actions.js";
import type { AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  classifySlackFile,
  downloadSlackAttachments,
  type SlackDownloadedAttachment,
  type SlackFile
} from "./attachments.js";
import {
  decodeSlackCallbackValue,
  isSlackCallbackValue,
  SLACK_CALLBACK_ACTION_ID_PATTERN
} from "./callback.js";
import { SlackMessageTransport } from "./transport.js";
import { createSlackMessageHandler } from "./message-handler.js";
import { resolveSlackInteractionContext, type SlackActionSource } from "./interactions/context.js";
import { readSlackSurface } from "./surfaces.js";
import { buildSlackQueueModal, readSlackQueueModalText } from "./interactions/queue.js";
import {
  dispatchSlackInteraction
} from "./interactions/router.js";
import {
  isAllowedSlackChannel,
  isSlackRootEntryCommand,
  isSlackRootManagementCommand,
  makeChatId,
  normalizeSlackCommand,
  stripBotMention
} from "./routing.js";

export { classifySlackFile, sanitizeSlackFileName } from "./attachments.js";
export { buildSlackQueueModal, readSlackQueueModalText } from "./interactions/queue.js";
export {
  getSlackRootTextCommand,
  isSlackRootEntryCommand,
  isSlackRootManagementCommand,
  makeChatId,
  normalizeSlackCommand
} from "./routing.js";

type SlackRuntime = {
  app: App;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type SlackMessageEvent = {
  bot_id?: string;
  channel: string;
  channel_type?: string;
  client_msg_id?: string;
  event_ts?: string;
  files?: SlackFile[];
  subtype?: string;
  team?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};

type SlackAppMentionEvent = {
  channel: string;
  event_ts?: string;
  team?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
};


function requireSlackConfig(config: AppConfig): {
  appToken: string;
  botToken: string;
  signingSecret: string;
} {
  if (!config.slackBotToken || !config.slackAppToken || !config.slackSigningSecret) {
    throw new Error("Slack is enabled but Slack credentials are incomplete.");
  }
  return {
    appToken: config.slackAppToken,
    botToken: config.slackBotToken,
    signingSecret: config.slackSigningSecret
  };
}

export function buildSlackBot(config: AppConfig, service: BridgeSlackBotPort): SlackRuntime {
  const slackConfig = requireSlackConfig(config);
  // Bolt's App socketMode shortcut does not forward heartbeat settings to its
  // SocketModeReceiver. Keep reconnecting native, but tolerate short stalls.
  const receiver = new SocketModeReceiver({
    appToken: slackConfig.appToken,
    autoReconnectEnabled: true,
    clientPingTimeout: config.slackSocketClientPingTimeoutMs,
    logLevel: LogLevel.INFO,
    serverPingTimeout: config.slackSocketServerPingTimeoutMs
  });
  const app = new App({
    logLevel: LogLevel.INFO,
    receiver,
    signingSecret: slackConfig.signingSecret,
    socketMode: true,
    token: slackConfig.botToken
  });
  // A timed-out write may already have succeeded. Do not automatically repeat it.
  const transport = new SlackMessageTransport(new WebClient(slackConfig.botToken, {
    retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000
  }), config.bridgeCallbackSecret);
  service.registerMessageTransport(transport);

  let botUserId: string | null = null;
  let teamIdFallback = "unknown";

  const { handleText, sendPrompt, sendSpec } = createSlackMessageHandler({
    config,
    getBotUserId: () => botUserId,
    service,
    transport
  });

  app.event("message", async ({ event }) => {
    const message = event as SlackMessageEvent;
    const files = message.files ?? [];
    const supportedFileCount = files.filter((file) => Boolean(classifySlackFile(file))).length;
    logger.info("slack.event.message", {
      botId: message.bot_id ?? null,
      channel: message.channel,
      channelType: message.channel_type ?? null,
      fileCount: files.length,
      hasText: Boolean(message.text),
      supportedFileCount,
      subtype: message.subtype ?? null,
      ts: message.ts ?? null
    });
    if (
      message.bot_id ||
      !message.ts ||
      (!message.text && supportedFileCount === 0) ||
      (message.subtype && message.subtype !== "file_share")
    ) {
      return;
    }
    const teamId = message.team ?? teamIdFallback;
    const isMention =
      botUserId && (message.text ?? "").includes(`<@${botUserId}>`);
    const isDirect = message.channel_type === "im";
    const isThreadReply = Boolean(message.thread_ts);
    const text = stripBotMention(message.text ?? "", botUserId);
    const command = normalizeSlackCommand(text);
    if (isDirect && !isThreadReply && !isSlackRootManagementCommand(command) && supportedFileCount === 0) {
      logger.info("slack.message.ignored_dm_root_freeform", {
        channel: message.channel,
        command,
        ts: message.ts
      });
      return;
    }
    if (!isDirect && isMention && supportedFileCount === 0) {
      return;
    }
    if (!isDirect && !isMention && !isThreadReply) {
      return;
    }

    const handleInput = {
      channelId: message.channel,
      channelType: message.channel_type,
      messageId: message.client_msg_id ?? message.event_ts ?? message.ts,
      rawText: message.text ?? "",
      rootCreatesThread: !isThreadReply,
      teamId,
      threadTs: message.thread_ts,
      ts: message.ts
    };
    let attachments: SlackDownloadedAttachment[];
    try {
      attachments = await downloadSlackAttachments(files, slackConfig.botToken, {
        chatId: makeChatId(handleInput),
        messageId: handleInput.messageId,
        receivedAt: message.ts ? new Date(Number(message.ts.split(".")[0]) * 1000) : undefined
      });
    } catch (error) {
      logger.error("slack.attachment.download_failed", {
        channel: message.channel,
        error: error instanceof Error ? error.message : String(error),
        ts: message.ts
      });
      await sendPrompt(
        makeChatId(handleInput),
        "Attachment download failed. Check that the Slack app has the `files:read` bot scope and has been reinstalled."
      );
      return;
    }
    await handleText({
      ...handleInput,
      attachments
    });
  });

  app.event("app_mention", async ({ event }) => {
    const mention = event as SlackAppMentionEvent;
    logger.info("slack.event.app_mention", {
      channel: mention.channel,
      hasText: Boolean(mention.text),
      threadTs: mention.thread_ts ?? null,
      ts: mention.ts ?? null
    });
    if (!mention.text || !mention.ts) {
      return;
    }
    const text = stripBotMention(mention.text, botUserId);
    const command = normalizeSlackCommand(text);
    if (!mention.thread_ts && !isSlackRootEntryCommand(command)) {
      logger.info("slack.app_mention.ignored_root_freeform", {
        channel: mention.channel,
        command,
        ts: mention.ts
      });
      return;
    }
    await handleText({
      channelId: mention.channel,
      messageId: mention.event_ts ?? mention.ts,
      rawText: mention.text,
      rootCreatesThread: false,
      teamId: mention.team ?? teamIdFallback,
      threadTs: mention.thread_ts,
      ts: mention.ts
    });
  });

  app.command(/.*/, async ({ ack, body, respond }) => {
    await ack();
    const isDirectCommand = body.channel_name === "directmessage";
    if (!isAllowedSlackChannel(
      config,
      body.channel_id,
      isDirectCommand ? "im" : undefined
    )) {
      await respond("*Codex*\nThis Slack channel is not allowed for codex-bridge.");
      return;
    }
    if (!isDirectCommand) {
      await respond("*Codex*\nUse @CodexBridge in a channel thread, or send this command in DM.");
      return;
    }
    const commandText = `${body.command} ${body.text ?? ""}`.trim();
    await handleText({
      channelId: body.channel_id,
      channelType: "im",
      messageId: body.trigger_id,
      rawText: commandText,
      teamId: body.team_id ?? teamIdFallback
    });
  });

  app.action(SLACK_CALLBACK_ACTION_ID_PATTERN, async (args: SlackActionMiddlewareArgs) => {
    await args.ack();
    const body = args.body as {
      trigger_id?: string;
      actions?: Array<{ value?: string }>;
      channel?: { id?: string };
      container?: { channel_id?: string; message_ts?: string; thread_ts?: string; type?: string };
      message?: { blocks?: KnownBlock[]; text?: string; ts?: string; thread_ts?: string };
      team?: { id?: string };
    };
    const data = body.actions?.[0]?.value ?? "";
    const source: SlackActionSource = {
      channelId: body.channel?.id ?? body.container?.channel_id ?? "",
      containerType: body.container?.type ?? null,
      messageTs: body.message?.ts ?? body.container?.message_ts ?? null,
      teamId: body.team?.id ?? teamIdFallback,
      threadTs: body.message?.thread_ts ?? body.container?.thread_ts ?? null,
      surface: readSlackSurface(body.message?.blocks)
    };
    const decoded = decodeSlackCallbackValue(data, config.bridgeCallbackSecret);
    if (decoded) {
      const interaction = resolveSlackInteractionContext(
        decoded.chatId,
        decoded.action,
        source,
        body.trigger_id
      );
      if (!interaction) {
        logger.info("slack.callback.ignored_unroutable_surface", {
          action: decoded.action,
          containerType: source.containerType
        });
        return;
      }
      logger.info("slack.callback.routed", {
        action: decoded.action,
        encodedChatId: decoded.chatId,
        conversationId: interaction.conversationId,
        surfaceId: interaction.surfaceId,
        messageTs: source.messageTs
      });
      await dispatchSlackInteraction({
        action: decoded.action,
        context: interaction,
        messageText: body.message?.text ?? null,
        messageBlocks: body.message?.blocks ?? null,
        openQueueModal: async (triggerId, chatId) => {
          await app.client.views.open({
            trigger_id: triggerId,
            view: buildSlackQueueModal(chatId, config.bridgeCallbackSecret)
          });
        },
        service,
        transport
      });
      return;
    }
    if (isSlackCallbackValue(data)) {
      logger.warn("slack.callback.invalid_bridge_value");
      return;
    }

    const channelId = body.channel?.id ?? body.container?.channel_id ?? "";
    const teamId = body.team?.id ?? teamIdFallback;
    const chatId = makeChatId({
      channelId,
      channelType: channelId.startsWith("D") ? "im" : undefined,
      teamId,
      threadTs: body.message?.thread_ts ?? body.container?.thread_ts ?? null,
      ts: body.container?.message_ts ?? body.message?.ts ?? null
    });
    logger.warn("slack.callback.legacy_value", { chatId });
    const interaction = resolveSlackInteractionContext(chatId, data, source, body.trigger_id);
    if (!interaction) {
      logger.info("slack.callback.legacy_ignored_unroutable_surface", {
        action: data,
        containerType: source.containerType
      });
      return;
    }
    await dispatchSlackInteraction({
      action: data,
      context: interaction,
      messageText: body.message?.text ?? null,
      messageBlocks: body.message?.blocks ?? null,
      openQueueModal: async (triggerId, targetChatId) => {
        await app.client.views.open({
          trigger_id: triggerId,
          view: buildSlackQueueModal(targetChatId, config.bridgeCallbackSecret)
        });
      },
      service,
      transport
    });
  });

  app.view("bridge_queue_submit", async ({ ack, body, view }) => {
    await ack();
    const decoded = decodeSlackCallbackValue(view.private_metadata, config.bridgeCallbackSecret);
    const text = readSlackQueueModalText(view.state.values);
    if (!decoded || decoded.action !== "queue:submit" || !text) return;
    const result = await service.handleIncomingUserText({
      telegramChatId: decoded.chatId,
      telegramMessageId: `slack-queue:${body.view.id}`,
      text,
      queue: true
    });
    if (!result.routed) {
      if (result.prompt) await sendSpec(decoded.chatId, result.prompt);
      else await sendPrompt(decoded.chatId, "Could not queue this message.", [helpAction(), sessionAction()]);
    }
  });

  app.error(async (error) => {
    logger.error("slack.app.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return {
    app,
    start: async () => {
      const auth = await app.client.auth.test({ token: slackConfig.botToken });
      botUserId = auth.user_id ?? null;
      teamIdFallback = auth.team_id ?? teamIdFallback;
      await app.start();
      logger.info("slack.app.ready", {
        botUserId,
        teamId: teamIdFallback
      });
    },
    stop: async () => {
      await app.stop();
    }
  };
}
