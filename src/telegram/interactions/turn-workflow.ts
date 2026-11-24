import type { InteractionContext } from "../../bridge/interactions/types.js";
import { helpAction, sessionAction } from "../../bridge/messages/actions.js";
import { createMessage, messageContextForSession } from "../../bridge/messages/factory.js";
import type { BridgeTelegramTurnWorkflowPort } from "../../bridge/contracts.js";
import { createTelegramHelpMessage } from "./help.js";
import type { TelegramInteractionResponder } from "./responder.js";
import { parseAssistantReplyCallback } from "../../bridge/interactions/assistant-replies.js";
import { parseUserQuestionAction } from "../../bridge/decisions/user-input.js";
import { sendTelegramInteractionNotice } from "./feedback.js";

export async function handleTelegramTurnWorkflow(input: {
  action: string;
  callbackId: string;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeTelegramTurnWorkflowPort;
}): Promise<boolean> {
  const { action, context, responder, service } = input;
  const chatId = context.conversationId;

  const question = parseUserQuestionAction(action);
  if (question) {
    const result = await service.handleUserQuestion(chatId, question);
    if (!result.ok) await sendTelegramInteractionNotice(service, responder, chatId, result.message);
    return true;
  }

  if (action === "quick:help") {
    await responder.send(createTelegramHelpMessage(
      await service.getActiveSessionContext(chatId),
      await service.getHelpMenuActions(chatId)
    ));
    return true;
  }
  if (action === "quick:session_new") {
    await responder.send(await service.requestCreateSessionForCurrentDirectory(chatId));
    return true;
  }
  if (action === "quick:queue") {
    await sendTelegramInteractionNotice(service, responder, chatId, "Send /queue followed by the message to run after the current turn.");
    return true;
  }
  const token = parseAssistantReplyCallback(action);
  if (!token && action !== "quick:go" && action !== "quick:next") return false;

  const result = token ? await service.replyToAssistantOption(chatId, token) : await service.handleIncomingUserText({
    telegramChatId: chatId,
    telegramMessageId: `telegram-callback:${input.callbackId}`,
    text: action === "quick:go" ? "go" : "next"
  });
  if (!result.routed) {
    if (result.prompt) await responder.send(result.prompt);
    else {
      await responder.send(createMessage({
        kind: "system",
        titleLabel: "Codex",
        ...messageContextForSession(await service.getActiveSessionContext(chatId)),
        body: [{ type: "text", text: "Choose a session first." }],
        actions: [sessionAction(), helpAction()]
      }));
    }
  }
  return true;
}
