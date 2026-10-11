import type { BridgeSlackTurnWorkflowPort } from "../../bridge/contracts.js";
import { helpAction, sessionAction } from "../../bridge/messages/actions.js";
import { createMessage } from "../../bridge/messages/factory.js";
import type { InteractionContext } from "../../bridge/interactions/types.js";
import type { SlackMessageTransport } from "../transport.js";

type TurnWorkflowAction = { type: "queue.open" } | { type: "turn.continue"; text: "go" | "next" };

export function parseTurnWorkflowAction(value: string): TurnWorkflowAction | null {
  if (value === "quick:queue") return { type: "queue.open" };
  if (value === "quick:go" || value === "quick:next") {
    return { type: "turn.continue", text: value === "quick:go" ? "go" : "next" };
  }
  return null;
}

export async function handleSlackTurnWorkflow(input: {
  action: string;
  context: InteractionContext;
  messageText: string | null;
  openQueueModal: (triggerId: string, chatId: string) => Promise<void>;
  service: BridgeSlackTurnWorkflowPort;
  transport: SlackMessageTransport;
}): Promise<boolean> {
  const action = parseTurnWorkflowAction(input.action);
  if (!action) return false;
  const { context, service, transport } = input;
  const chatId = context.conversationId;
  const sendPrompt = async (text: string, actions = [helpAction()]) => {
    await transport.sendMessageSpec(chatId, createMessage({
      kind: "system",
      titleLabel: "Codex",
      session: await service.getActiveSessionContext(chatId),
      body: [{ type: "text", text }],
      actions
    }));
  };

  if (action.type === "queue.open") {
    if (!context.triggerId) {
      await sendPrompt("Queue input could not be opened. Try again from the current Working message.");
      return true;
    }
    await input.openQueueModal(context.triggerId, chatId);
    return true;
  }

  const result = await service.handleIncomingUserText({
    telegramChatId: chatId,
    telegramMessageId: context.sourceMessageId ?? `slack-callback:${Date.now()}`,
    text: action.text
  });
  if (input.messageText) {
    const messageSpec = createMessage({
      kind: "system",
      titleLabel: "Codex",
      session: await service.getActiveSessionContext(context.surfaceId),
      body: [{ type: "text", text: input.messageText }],
      actions: [helpAction()]
    });
    if (context.sourceMessageId) {
      await transport.editMessageSpec(
        context.surfaceId,
        context.sourceMessageId,
        messageSpec
      );
    } else {
      await transport.sendMessageSpec(context.surfaceId, messageSpec);
    }
  }
  if (!result.routed) {
    if (result.prompt) await transport.sendMessageSpec(chatId, result.prompt);
    else await sendPrompt("Choose a session first.", [sessionAction(), helpAction()]);
  }
  return true;
}
