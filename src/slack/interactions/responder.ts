import type { InteractionContext, InteractionDelivery } from "../../bridge/interactions/types.js";
import type { SlackMessageTransport } from "../transport.js";

export async function deliverSlackInteraction(
  transport: SlackMessageTransport,
  context: InteractionContext,
  delivery: InteractionDelivery
): Promise<void> {
  if (delivery.mode === "send" || context.sourceSurface === "session-status") {
    await transport.sendMessageSpec(context.conversationId, delivery.message);
    return;
  }
  if (!context.sourceMessageId) {
    await transport.sendMessageSpec(context.conversationId, delivery.message);
    return;
  }
  await transport.editMessageSpec(context.surfaceId, context.sourceMessageId, delivery.message);
}
