import type { InteractionContext, InteractionDelivery } from "../../bridge/interactions/types.js";
import type { SlackMessageTransport } from "../transport.js";
import { isSlackConversationAnchor } from "./context.js";

export async function deliverSlackInteraction(
  transport: SlackMessageTransport,
  context: InteractionContext,
  delivery: InteractionDelivery
): Promise<void> {
  if (delivery.mode === "send" || isSlackConversationAnchor(context)) {
    await transport.sendMessageSpec(context.conversationId, delivery.message);
    return;
  }
  if (!context.sourceMessageId) {
    await transport.sendMessageSpec(context.conversationId, delivery.message);
    return;
  }
  await transport.editMessageSpec(context.surfaceId, context.sourceMessageId, delivery.message);
}
