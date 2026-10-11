import type { BridgeMessageOptions } from "../bridge/transport.js";
import type { BridgeSlackMessagePort } from "../bridge/contracts.js";
import type { IncomingAttachment } from "../bridge/input/payload.js";
import { createMessage } from "../bridge/messages/factory.js";
import { helpAction, sessionAction } from "../bridge/messages/actions.js";
import type { MessageSpec, SessionContext } from "../bridge/messages/types.js";
import type { AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  writeSlackAttachmentMetadata,
  type SlackAttachmentMetadata,
  type SlackDownloadedAttachment
} from "./attachments.js";
import { SlackMessageTransport } from "./transport.js";
import {
  getCommandArgument,
  getSlackRootTextCommand,
  isAllowedSlackChannel,
  isLockedSlackThread,
  makeChatId,
  stripBotMention
} from "./routing.js";

export type SlackMessageInput = {
  attachments?: SlackDownloadedAttachment[];
  channelId: string;
  channelType?: string;
  messageId: string;
  rawText: string;
  rootCreatesThread?: boolean;
  teamId: string;
  threadTs?: string | null;
  ts?: string | null;
};

function summarizeAttachments(attachments: SlackDownloadedAttachment[]): string {
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  const audioCount = attachments.filter((attachment) => attachment.kind === "audio").length;
  const parts = [
    imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
    audioCount ? `${audioCount} audio${audioCount === 1 ? "" : "s"}` : null
  ].filter(Boolean);
  return parts.join(", ");
}

function toIncomingAttachment(attachment: SlackDownloadedAttachment): IncomingAttachment {
  return {
    kind: attachment.kind,
    localPath: attachment.path,
    mimeType: attachment.mimeType,
    name: attachment.name,
    sizeBytes: attachment.size
  };
}

async function markSlackAttachmentStatus(
  attachments: SlackDownloadedAttachment[],
  context: { chatId: string; messageId?: string | null; status: SlackAttachmentMetadata["status"] }
): Promise<void> {
  await Promise.all(
    attachments.map((attachment) =>
      writeSlackAttachmentMetadata(attachment, {
        chatId: context.chatId,
        messageId: context.messageId,
        status: context.status
      }).catch((error) => {
        logger.warn("slack.attachment.metadata_update_failed", {
          error: error instanceof Error ? error.message : String(error),
          fileId: attachment.id,
          status: context.status
        });
      })
    )
  );
}

export function createSlackMessageHandler(input: {
  config: AppConfig;
  getBotUserId: () => string | null;
  service: BridgeSlackMessagePort;
  transport: SlackMessageTransport;
}): {
  handleText: (message: SlackMessageInput) => Promise<void>;
  sendPrompt: (chatId: string, text: string, actions?: MessageSpec["actions"]) => Promise<void>;
  sendSpec: (chatId: string, messageSpec: MessageSpec) => Promise<void>;
} {
  const { config, getBotUserId, service, transport } = input;
  const createPromptSpec = (
    text: string,
    actions: MessageSpec["actions"] = [helpAction()],
    session?: SessionContext
  ): MessageSpec => createMessage({
    kind: "system",
    titleLabel: "Codex",
    ...(session ? { session } : {}),
    body: [{ type: "text", text }],
    actions
  });

  const sendSpec = async (chatId: string, messageSpec: NonNullable<BridgeMessageOptions["messageSpec"]>) => {
    await transport.sendMessageSpec(chatId, messageSpec);
  };
  const sendPrompt = async (
    chatId: string,
    text: string,
    actions: MessageSpec["actions"] = [helpAction()]
  ): Promise<void> => {
    await sendSpec(chatId, createPromptSpec(text, actions, await service.getActiveSessionContext(chatId)));
  };
  const sendHelp = async (chatId: string) => {
    await sendSpec(chatId, createMessage({
      kind: "menu",
      titleLabel: "Help",
      session: await service.getActiveSessionContext(chatId),
      actions: await service.getHelpMenuActions(chatId)
    }));
  };

  const handleText = async (message: SlackMessageInput): Promise<void> => {
    if (!isAllowedSlackChannel(config, message.channelId, message.channelType)) {
      logger.info("slack.message.ignored_disallowed_channel", { channelId: message.channelId });
      return;
    }

    const chatId = makeChatId(message);
    const text = stripBotMention(message.rawText, getBotUserId());
    if (!text && !message.attachments?.length) return;

    const command = getSlackRootTextCommand(chatId, text);
    logger.info("slack.message.received", {
      chatId,
      channelId: message.channelId,
      command,
      messageId: message.messageId
    });
    await service.ensureChatAllowed(chatId);

    if (command === "help" || command === "/help" || command === "/codex") {
      await sendHelp(chatId);
      return;
    }
    if (command === "sessions" || command === "/sessions") {
      await sendSpec(chatId, await service.renderSessionMenu(chatId, 0, { refresh: true, includeUnknownThreads: true }));
      return;
    }
    if (command === "goals" || command === "/goals") {
      await sendSpec(chatId, await service.renderGoalsMenu(chatId));
      return;
    }
    if (command === "goal" || command === "/goal") {
      await sendSpec(chatId, await service.setActiveGoalObjective(chatId, getCommandArgument(text)));
      return;
    }
    if (command === "session_new" || command === "/session_new") {
      if (await isLockedSlackThread(service, chatId)) {
        await sendPrompt(chatId, "This thread is already bound to a session.", [helpAction(), sessionAction()]);
        return;
      }
      await sendSpec(chatId, await service.requestCreateSessionForCurrentDirectory(chatId));
      return;
    }
    if (command === "status" || command === "/status" || command === "/codex_status") {
      await sendSpec(chatId, await service.statusActiveSessionMessage(chatId));
      return;
    }
    if (command === "status_full" || command === "/status_full" || command === "/codex_status_full") {
      await sendSpec(chatId, await service.statusActiveSessionMessage(chatId, true));
      return;
    }
    if (command === "interrupt" || command === "/interrupt" || command === "/codex-interrupt") {
      await sendSpec(chatId, await service.stopActiveSessionMessage(chatId));
      return;
    }
    if (command === "compact" || command === "/compact") {
      await sendSpec(chatId, await service.compactActiveSessionMessage(chatId));
      return;
    }
    if (command === "bot_disconnect" || command === "/bot_disconnect") {
      await sendSpec(chatId, await service.disconnectBotRuntimeMessage(chatId));
      return;
    }
    if (command === "bot_connect" || command === "/bot_connect") {
      await sendSpec(chatId, await service.connectBotRuntimeMessage(chatId));
      return;
    }
    if (command === "bot_restart" || command === "/bot_restart") {
      await sendSpec(chatId, await service.restartServiceMessage());
      return;
    }
    if (command === "section_rename" || command === "/section_rename") {
      await sendSpec(chatId, await service.renameActiveSectionMessage(chatId, getCommandArgument(text)));
      return;
    }

    const queueRequested = command === "queue" || command === "/queue";
    const queuedText = queueRequested ? getCommandArgument(text) : text;
    if (queueRequested && !queuedText && !message.attachments?.length) {
      await sendPrompt(chatId, "Send queue followed by the message to run after the current turn.");
      return;
    }

    if (message.attachments?.length) {
      logger.info("slack.attachments.received", {
        attachments: message.attachments.map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          name: attachment.name,
          path: attachment.path,
          size: attachment.size
        })),
        chatId,
        messageId: message.messageId
      });
      const summary = summarizeAttachments(message.attachments);
      let result: Awaited<ReturnType<typeof service.handleIncomingUserPayload>>;
      try {
        result = await service.handleIncomingUserPayload({
          attachments: message.attachments.map(toIncomingAttachment),
          telegramChatId: chatId,
          telegramMessageId: message.messageId,
          text: queuedText,
          queue: queueRequested
        });
      } catch (error) {
        logger.error("slack.attachment.route_failed", {
          chatId,
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
        await markSlackAttachmentStatus(message.attachments, { chatId, messageId: message.messageId, status: "failed" });
        await sendPrompt(chatId, "Could not confirm attachment delivery to Codex. Check the session before retrying.");
        return;
      }
      await markSlackAttachmentStatus(message.attachments, {
        chatId,
        messageId: message.messageId,
        status: result.routed ? (queueRequested ? "queued" : "sent-to-codex") : "failed"
      });
      if (!result.routed) {
        if (result.prompt) await sendSpec(chatId, result.prompt);
        else await sendPrompt(chatId, "Choose a session first.", [sessionAction(), helpAction()]);
      } else if (!queueRequested && summary) {
        // The Codex request was accepted. A failed Slack receipt must not undo that result.
        try {
          await sendSpec(chatId, createPromptSpec(
            `Codex input accepted; attachments received: ${summary}.`,
            [],
            await service.getActiveSessionContext(chatId)
          ));
        } catch (error) {
          logger.warn("slack.attachment.receipt_failed", {
            chatId,
            messageId: message.messageId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return;
    }

    if (queueRequested) {
      const result = await service.handleIncomingUserText({
        telegramChatId: chatId,
        telegramMessageId: message.messageId,
        text: queuedText,
        queue: true
      });
      if (!result.routed) {
        if (result.prompt) await sendSpec(chatId, result.prompt);
        else await sendPrompt(chatId, "Could not queue this message.", [helpAction(), sessionAction()]);
      }
      return;
    }

    const routedText = command === "go" || command === "/go" || command === "/codex-go"
      ? "go"
      : command === "next" || command === "/next" || command === "/codex-next"
        ? "next"
        : text;
    const result = await service.handleIncomingUserText({
      telegramChatId: chatId,
      telegramMessageId: message.messageId,
      text: routedText
    });
    if (!result.routed) {
      if (result.prompt) await sendSpec(chatId, result.prompt);
      else await sendPrompt(chatId, "Choose a session first.", [sessionAction(), helpAction()]);
    }
  };

  return { handleText, sendPrompt, sendSpec };
}
