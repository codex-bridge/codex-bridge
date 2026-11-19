import { useState } from "react";
import type { UserInputPrompt } from "../../../src/shared/user-input";
import { validateUserInputAnswers } from "../../../src/shared/user-input";
import { Button } from "./ui/button";

export function UserQuestionForm({ id, prompt, disabled, onSubmit }: {
  id: string; prompt: UserInputPrompt; disabled: boolean; onSubmit: (content: Record<string, unknown>) => void;
}) {
  const [choices, setChoices] = useState<Map<string, number | "text">>(() => new Map());
  const [text, setText] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  return <form className="user-question-form" onSubmit={event => {
    event.preventDefault(); setError(null);
    const content = { answers: Object.fromEntries(prompt.questions.map(question => {
      const choice = choices.get(question.id);
      const value = typeof choice === "number" ? question.options?.[choice]?.label : text.get(question.id);
      return [question.id, { answers: value?.trim() ? [value] : [] }];
    })) };
    try { onSubmit({ answers: validateUserInputAnswers(prompt, content) }); }
    catch (error) { setError(error instanceof Error ? error.message : "Answer every question."); }
  }}>
    {prompt.questions.map((question, index) => {
      const free = !question.options || choices.get(question.id) === "text";
      return <fieldset key={question.id} disabled={disabled} className="user-question">
        <legend>{index + 1}. {question.question}</legend>
        {question.options?.map((option, optionIndex) => <label className="user-question-option" key={optionIndex}>
          <input type="radio" name={`${id}-${index}`} checked={choices.get(question.id) === optionIndex}
            onChange={() => setChoices(new Map(choices).set(question.id, optionIndex))} />
          <span>{option.label}{option.description && <small>{option.description}</small>}</span>
        </label>)}
        {question.options && question.isOther && <label className="user-question-option">
          <input type="radio" name={`${id}-${index}`} checked={free} onChange={() => setChoices(new Map(choices).set(question.id, "text"))} />
          <span>Write an answer</span>
        </label>}
        {(!question.options || question.isOther) && <input className="input" type={question.isSecret ? "password" : "text"}
          aria-label={`Answer ${index + 1}`} autoComplete="off" maxLength={6000} disabled={disabled || !free}
          value={text.get(question.id) ?? ""} onChange={event => setText(new Map(text).set(question.id, event.target.value))} />}
      </fieldset>;
    })}
    {error && <p role="alert" className="decision-input-error">{error}</p>}
    <Button type="submit" disabled={disabled}>Submit answers</Button>
  </form>;
}
