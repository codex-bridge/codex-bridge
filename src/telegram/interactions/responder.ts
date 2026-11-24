import { runInteractionDelivery } from "../../bridge/interactions/delivery.js";
import type { InteractionContext, InteractionDelivery } from "../../bridge/interactions/types.js";
import type { MessageSpec } from "../../bridge/messages/types.js";

export type TelegramInteractionResponder = {
  clearActions: () => Promise<void>;
  edit: (message: MessageSpec) => Promise<void>;
  send: (message: MessageSpec) => Promise<void>;
};

export async function deliverTelegramInteraction(
  context: InteractionContext,
  delivery: InteractionDelivery,
  responder: TelegramInteractionResponder
): Promise<void> {
  await runInteractionDelivery(delivery, async () => {
    if (delivery.mode === "edit" && context.sourceMessageId) await responder.edit(delivery.message);
    else await responder.send(delivery.message);
    return true;
  });
}
