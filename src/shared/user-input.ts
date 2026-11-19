export const USER_INPUT_METHOD = "item/tool/requestUserInput";
export type UserInputQuestion = { id: string; header: string; question: string; isOther: boolean; isSecret: boolean;
  options: Array<{ label: string; description: string }> | null };
export type UserInputPrompt = { questions: UserInputQuestion[]; isBlocking: boolean; answeredQuestionIds?: string[]; activeQuestionId?: string };
export type UserInputAnswers = Record<string, { answers: string[] }>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseUserInputPrompt(value: unknown): UserInputPrompt {
  if (!record(value) || typeof value.isBlocking !== "boolean" || !Array.isArray(value.questions) || !value.questions.length)
    throw new Error("Invalid user question request.");
  const ids = new Set<string>();
  const questions = value.questions.map(raw => {
    if (!record(raw) || typeof raw.id !== "string" || !raw.id.trim() || ids.has(raw.id) ||
        typeof raw.header !== "string" || typeof raw.question !== "string" || !raw.question.trim() ||
        typeof raw.isOther !== "boolean" || typeof raw.isSecret !== "boolean") throw new Error("Invalid or duplicate user question.");
    ids.add(raw.id);
    let options: UserInputQuestion["options"] = null;
    if (raw.options != null) {
      if (!Array.isArray(raw.options) || !raw.options.length) throw new Error("Invalid question options.");
      options = raw.options.map(option => {
        if (!record(option) || typeof option.label !== "string" || !option.label.trim() || typeof option.description !== "string")
          throw new Error("Invalid question option.");
        return { label: option.label, description: option.description };
      });
    }
    return { id: raw.id, header: raw.header, question: raw.question, isOther: raw.isOther, isSecret: raw.isSecret, options };
  });
  return { questions, isBlocking: value.isBlocking };
}

export function validateUserInputAnswers(prompt: UserInputPrompt, value: unknown): UserInputAnswers {
  if (!record(value) || !record(value.answers)) throw new Error("Answer every question before submitting.");
  const answers = value.answers;
  if (Object.keys(answers).length !== prompt.questions.length) throw new Error("Answer every question before submitting.");
  return Object.fromEntries(prompt.questions.map(question => {
    const entry = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
    if (!record(entry) || !Array.isArray(entry.answers) || !entry.answers.length ||
        entry.answers.some(answer => typeof answer !== "string" || !answer.trim())) throw new Error(`An answer is required for ${question.header || question.id}.`);
    const text = entry.answers as string[];
    if (!question.isOther && question.options && text.some(answer => !question.options!.some(option => option.label === answer)))
      throw new Error(`Choose an available option for ${question.header || question.id}.`);
    return [question.id, { answers: [...text] }];
  }));
}
