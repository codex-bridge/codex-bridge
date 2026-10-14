import type { MessageSpec } from "../messages/types.js";
import type { InteractionContext, InteractionDelivery } from "./types.js";

export function sessionSelectorDelivery(message: MessageSpec): InteractionDelivery {
  return { mode: "edit", target: "surface", message };
}

export function sessionActionResultDelivery(context: InteractionContext, message: MessageSpec): InteractionDelivery {
  const result = { ...message, surface: "action-result" as const };
  // Telegram has one current conversation; retain its existing in-place receipts.
  return context.platform === "slack"
    ? { mode: "send", target: "conversation", message: result }
    : { mode: "edit", target: "surface", message: result };
}
