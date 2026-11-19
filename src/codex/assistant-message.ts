import { presentAssistantText, type PresentedAssistantMessage } from "../shared/assistant-display.js";
import { asRecord, extractMessageText, firstString } from "./protocol-utils.js";
import { assistantPresentation, normalizeAssistantQuestions } from "../shared/assistant-questions.js";

export function extractAssistantMessage(value: unknown): PresentedAssistantMessage | null {
  const item = asRecord(value);
  if (!item) return null;
  const message = presentAssistantText(firstString(item.text, item.review) ?? extractMessageText(item) ?? "", item.moderation);
  const metadata = assistantPresentation({ ...message, delivery: item.delivery === "async" ? "async" : undefined,
    questions: normalizeAssistantQuestions(item.questions) });
  const text = message.text || metadata.questions?.map(question =>
    [question.title, ...(question.options ?? []).map(option => `- ${option}`)].join("\n")).join("\n\n") || "";
  const sourceItemId = firstString(item.id);
  return text.trim() ? { text, ...metadata, ...(sourceItemId ? { sourceItemId } : {}) } : null;
}
