import type { InteractionContext } from "../../bridge/interactions/types.js";
import type { BridgeTelegramSessionWorkflowPort } from "../../bridge/contracts.js";
import { parseSessionActionCallback } from "../../bridge/sessions/action-callbacks.js";
import { SessionActivationError } from "../../bridge/sessions/ownership.js";
import type { TelegramInteractionResponder } from "./responder.js";

export async function handleTelegramSessionWorkflow(input: {
  action: string;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeTelegramSessionWorkflowPort;
}): Promise<boolean> {
  const { action, context, responder, service } = input;
  const chatId = context.conversationId;

  if (action.startsWith("section:") || action.startsWith("session:")) {
    const legacySection = action.startsWith("section:");
    const sessionId = action.slice(legacySection ? "section:".length : "session:".length);
    try {
      const activation = legacySection
        ? await service.activateSection(chatId, sessionId)
        : await service.activateSession(chatId, sessionId);
      await service.postSessionSwitchTranscript(
        chatId,
        activation.session,
        activation.recentMessages,
        {
          ...(legacySection ? { heading: "Switched to section" } : {})
        }
      );
    } catch (error) {
      if (!(error instanceof SessionActivationError)) throw error;
      await responder.edit(error.messageSpec);
    }
    return true;
  }

  const callback = parseSessionActionCallback(action);
  if (callback?.kind !== "refresh") return false;

  const state = await service.refreshSessionView(chatId, callback.sessionId, callback.expectedLeaseVersion);
  await responder.edit(state);
  return true;
}
