import type { InteractionContext } from "../../bridge/interactions/types.js";

export function createTelegramInteractionContext(
  chatId: string,
  sourceMessageId?: number
): InteractionContext {
  return {
    platform: "telegram",
    conversationId: chatId,
    surfaceId: chatId,
    ...(sourceMessageId === undefined ? {} : { sourceMessageId: String(sourceMessageId) })
  };
}
