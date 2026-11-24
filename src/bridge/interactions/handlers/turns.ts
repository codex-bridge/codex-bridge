import type { BridgeRuntimePort, BridgeTurnControlPort } from "../../contracts.js";
import type { TurnInteractionAction } from "../action.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";

export async function handleTurnAction(
  service: BridgeRuntimePort & BridgeTurnControlPort,
  context: InteractionContext,
  action: TurnInteractionAction
): Promise<InteractionDelivery> {
  const chatId = context.conversationId;
  switch (action.type) {
    case "turn.interrupt":
      return { mode: "send", target: "conversation", message: await service.stopActiveSessionMessage(chatId) };
    case "turn.compact": {
      const message = await service.compactActiveSessionMessage(chatId);
      return { mode: "send", target: "conversation", message,
        aroundDelivery: operation => service.deliverCompactResult(chatId, message, operation) };
    }
    case "runtime.restart":
      return { mode: "send", target: "conversation", message: await service.restartServiceMessage(chatId) };
    case "queue.cancel":
      return { mode: "edit", target: "surface", message: await service.cancelQueuedSubmission(chatId, action.submissionId) };
  }
}
