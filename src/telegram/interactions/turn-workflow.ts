import type { InteractionContext } from "../../bridge/interactions/types.js";
import { helpAction, sessionAction } from "../../bridge/messages/actions.js";
import { createMessage } from "../../bridge/messages/factory.js";
import type { BridgeChatPort, BridgeTelegramTurnWorkflowPort } from "../../bridge/contracts.js";
import { createTelegramHelpMessage } from "./help.js";
import type { TelegramInteractionResponder } from "./responder.js";

async function sendPrompt(
  service: Pick<BridgeChatPort, "getActiveSessionContext">,
  responder: TelegramInteractionResponder,
  chatId: string,
  text: string
): Promise<void> {
  await responder.send(createMessage({
    kind: "system",
    titleLabel: "Codex",
    session: await service.getActiveSessionContext(chatId),
    body: [{ type: "text", text }],
    actions: [helpAction()]
  }));
}

export async function handleTelegramTurnWorkflow(input: {
  action: string;
  acknowledge: (text?: string) => Promise<void>;
  callbackId: string;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeTelegramTurnWorkflowPort;
}): Promise<boolean> {
  const { action, context, responder, service } = input;
  const chatId = context.conversationId;

  if (action === "quick:help") {
    await input.acknowledge();
    await responder.send(createTelegramHelpMessage(
      await service.getActiveSessionContext(chatId),
      await service.getHelpMenuActions(chatId)
    ));
    return true;
  }
  if (action === "quick:session_new") {
    await input.acknowledge();
    await responder.send(await service.requestCreateSessionForCurrentDirectory(chatId));
    return true;
  }
  if (action === "quick:queue") {
    await input.acknowledge();
    await sendPrompt(service, responder, chatId, "Send /queue followed by the message to run after the current turn.");
    return true;
  }
  if (action !== "quick:go" && action !== "quick:next") return false;

  await input.acknowledge();
  const result = await service.handleIncomingUserText({
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
        session: await service.getActiveSessionContext(chatId),
        body: [{ type: "text", text: "Choose a session first." }],
        actions: [sessionAction(), helpAction()]
      }));
    }
  }
  return true;
}
