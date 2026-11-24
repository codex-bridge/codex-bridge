import type { BridgeChatPort } from "../../bridge/contracts.js";
import { createMessage, messageContextForSession } from "../../bridge/messages/factory.js";
import { helpAction } from "../../bridge/messages/actions.js";
import type { TelegramInteractionResponder } from "./responder.js";

/** Failures remain visible in the originating entry even if callback feedback expires. */
export async function sendTelegramInteractionNotice(
  service: Pick<BridgeChatPort, "getActiveSessionContext">,
  responder: TelegramInteractionResponder,
  chatId: string,
  text: string
): Promise<void> {
  await responder.send(createMessage({
    kind: "system",
    titleLabel: "Codex",
    ...messageContextForSession(await service.getActiveSessionContext(chatId)),
    body: [{ type: "text", text }],
    actions: [helpAction()]
  }));
}
