import { runInteractionDelivery } from "../../bridge/interactions/delivery.js";
import type { InteractionContext, InteractionDelivery } from "../../bridge/interactions/types.js";
import type { MessageSpec } from "../../bridge/messages/types.js";

export type TelegramInteractionResponder = {
  clearActions: () => Promise<void>;
  edit: (message: MessageSpec) => Promise<boolean>;
  send: (message: MessageSpec) => Promise<boolean>;
};

export async function deliverTelegramInteraction(
  context: InteractionContext,
  delivery: InteractionDelivery,
  responder: TelegramInteractionResponder
): Promise<void> {
  await runInteractionDelivery(delivery, async () => {
    return delivery.mode === "edit" && context.sourceMessageId
      ? responder.edit(delivery.message) : responder.send(delivery.message);
  });
}
