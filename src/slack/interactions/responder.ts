import type { InteractionContext, InteractionDelivery } from "../../bridge/interactions/types.js";
import type { SlackMessageTransport } from "../transport.js";

export async function deliverSlackInteraction(
  transport: SlackMessageTransport,
  context: InteractionContext,
  delivery: InteractionDelivery
): Promise<void> {
  if (delivery.mode === "send" || context.sourceSurface === "session-status") {
    const sent = await transport.sendMessageSpec(context.conversationId, delivery.message);
    if (sent) await delivery.afterDelivery?.();
    return;
  }
  if (!context.sourceMessageId) {
    const sent = await transport.sendMessageSpec(context.conversationId, delivery.message);
    if (sent) await delivery.afterDelivery?.();
    return;
  }
  const edited = await transport.editMessageSpec(context.surfaceId, context.sourceMessageId, delivery.message);
  if (edited) await delivery.afterDelivery?.();
}
