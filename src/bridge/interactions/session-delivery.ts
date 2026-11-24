import type { MessageSpec } from "../messages/types.js";
import type { InteractionContext, InteractionDelivery } from "./types.js";

export function sessionSelectorDelivery(message: MessageSpec): InteractionDelivery {
  return { mode: "edit", target: "surface", message };
}

export function sessionActionResultDelivery(context: InteractionContext, message: MessageSpec): InteractionDelivery {
  const result = { ...message, surface: "action-result" as const };
  // Telegram keeps action receipts on the triggering message, including in topics.
  return context.platform === "slack"
    ? { mode: "send", target: "conversation", message: result }
    : { mode: "edit", target: "surface", message: result };
}
