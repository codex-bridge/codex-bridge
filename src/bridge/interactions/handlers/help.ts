import type { BridgeChatPort } from "../../contracts.js";
import { createMessage } from "../../messages/factory.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";

export async function handleHelpAction(
  service: Pick<BridgeChatPort, "getActiveSessionContext" | "getHelpMenuActions">,
  context: InteractionContext
): Promise<InteractionDelivery> {
  return {
    mode: "send",
    target: "conversation",
    message: createMessage({
      kind: "menu",
      titleLabel: "Help",
      session: await service.getActiveSessionContext(context.conversationId),
      actions: await service.getHelpMenuActions(context.conversationId)
    })
  };
}
