import { presentAssistantText, type PresentedAssistantMessage } from "../shared/assistant-display.js";
import { asRecord, extractMessageText, firstString } from "./protocol-utils.js";

export function extractAssistantMessage(value: unknown): PresentedAssistantMessage | null {
  const item = asRecord(value);
  if (!item) return null;
  const message = presentAssistantText(firstString(item.text, item.review) ?? extractMessageText(item) ?? "", item.moderation);
  const sourceItemId = firstString(item.id);
  return message.text.trim() ? { ...message, ...(sourceItemId ? { sourceItemId } : {}) } : null;
}
