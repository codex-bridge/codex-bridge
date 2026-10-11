import type { BridgeTurnControlPort } from "../../contracts.js";
import type { StatusInteractionAction } from "../action.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";

export async function handleStatusAction(
  service: Pick<BridgeTurnControlPort, "statusActiveSessionMessage">,
  context: InteractionContext,
  action: StatusInteractionAction
): Promise<InteractionDelivery> {
  const message = await service.statusActiveSessionMessage(context.conversationId, action.full);
  return action.delivery === "send"
    ? { mode: "send", target: "conversation", message }
    : { mode: "edit", target: "surface", message };
}
