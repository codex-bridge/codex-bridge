import type { InteractionContext } from "../../bridge/interactions/types.js";
import { buildSlackChatId, parseSlackChatId } from "../transport.js";

export type SlackActionSource = {
  channelId: string;
  containerType: string | null;
  messageTs: string | null;
  teamId: string;
  threadTs: string | null;
};

function isFinalSessionSelectionAction(action: string): boolean {
  return action.startsWith("section:") ||
    (action.startsWith("session:") && !action.startsWith("session-dir:") && !action.startsWith("session-page:"));
}

export function resolveSlackInteractionContext(
  encodedChatId: string,
  action: string,
  source: SlackActionSource,
  triggerId?: string | null
): InteractionContext | null {
  const encoded = parseSlackChatId(encodedChatId);
  if (!encoded || source.containerType === "view") return null;

  const sourceChatId = source.channelId && source.teamId
    ? buildSlackChatId({ channelId: source.channelId, teamId: source.teamId, threadTs: source.threadTs })
    : encodedChatId;

  let conversationId = encodedChatId;
  if (source.threadTs && source.channelId && source.teamId) {
    conversationId = sourceChatId;
  } else if (!encoded.threadTs && source.messageTs && isFinalSessionSelectionAction(action)) {
    conversationId = buildSlackChatId({
      channelId: encoded.channelId,
      teamId: encoded.teamId,
      threadTs: source.messageTs
    });
  }

  return {
    platform: "slack",
    conversationId,
    surfaceId: sourceChatId,
    ...(source.messageTs ? { sourceMessageId: source.messageTs } : {}),
    ...(triggerId ? { triggerId } : {})
  };
}
