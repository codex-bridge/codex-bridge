import type { PresentedAssistantMessage } from "./assistant-display.js";
import { normalizeAssistantDisplay } from "./assistant-display.js";

export type AssistantQuestion = { title: string; options: string[] | null };

export function normalizeAssistantQuestions(value: unknown): AssistantQuestion[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const questions: AssistantQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || typeof raw.title !== "string" || !raw.title.trim()) return undefined;
    if (raw.options != null && (!Array.isArray(raw.options) || !raw.options.length ||
        raw.options.some((option: unknown) => typeof option !== "string" || !option.trim()))) return undefined;
    questions.push({ title: raw.title, options: raw.options == null ? null : [...raw.options] });
  }
  return questions;
}

/** Restricted answers must not reveal their original questions or options. */
export function assistantPresentation(message: Partial<PresentedAssistantMessage>) {
  const display = message.assistantDisplay === undefined ? undefined : normalizeAssistantDisplay(message.assistantDisplay);
  const visible = !display || display.mode === "show";
  const questions = visible && message.delivery === "async" ? normalizeAssistantQuestions(message.questions) : undefined;
  return {
    ...(display ? { assistantDisplay: display } : {}),
    ...(visible && message.delivery === "async" ? { delivery: "async" as const } : {}),
    ...(questions ? { questions } : {})
  };
}
