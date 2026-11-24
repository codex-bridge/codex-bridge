import type { InteractionContext, InteractionDelivery } from "../../bridge/interactions/types.js";
import { runInteractionDelivery } from "../../bridge/interactions/delivery.js";
import type { SlackMessageTransport } from "../transport.js";

export async function deliverSlackInteraction(
  transport: SlackMessageTransport,
  context: InteractionContext,
  delivery: InteractionDelivery
): Promise<void> {
  await runInteractionDelivery(delivery, async () => {
    if (delivery.mode === "send" || context.sourceSurface === "session-status" || !context.sourceMessageId) {
      return Boolean(await transport.sendMessageSpec(context.conversationId, delivery.message));
    }
    return transport.editMessageSpec(context.surfaceId, context.sourceMessageId, delivery.message);
  });
}
