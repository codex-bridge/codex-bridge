import type { CodexAppServerClient } from "../../codex/client.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";
import { USER_INPUT_METHOD, validateUserInputAnswers, type UserInputAnswers } from "../../shared/user-input.js";
import type { DecisionRecord, SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { SessionAccessService } from "../sessions/access.js";
import type { DecisionOperationGuard } from "./commands.js";
import type { ActionSpec } from "../messages/types.js";
import { messageAction } from "../messages/actions.js";
import { logger } from "../../logging/logger.js";

export type UserQuestionAction = { decisionId: string; type: "pick"; question: number; option: number }
  | { decisionId: string; type: "write"; question: number }
  | { decisionId: string; type: "edit"; question: number }
  | { decisionId: string; type: "submit" };
export function parseUserQuestionAction(value: string): UserQuestionAction | null {
  const match = /^uq:([A-Za-z0-9_-]+):(s|w|p|e)(?::(\d+))?(?::(\d+))?$/.exec(value);
  if (!match) return null;
  const [, decisionId, action, q, o] = match;
  if (action === "s" && q === undefined && o === undefined) return { decisionId: decisionId!, type: "submit" };
  if (q === undefined || !Number.isSafeInteger(Number(q))) return null;
  if (action === "w" && o === undefined) return { decisionId: decisionId!, type: "write", question: Number(q) };
  if (action === "e" && o === undefined) return { decisionId: decisionId!, type: "edit", question: Number(q) };
  return action === "p" && o !== undefined && Number.isSafeInteger(Number(o))
    ? { decisionId: decisionId!, type: "pick", question: Number(q), option: Number(o) } : null;
}

export function userQuestionActions(decision: DecisionRecord): ActionSpec[] {
  if (!decision.userInput || !["pending", "awaitingInput"].includes(decision.state)) return [];
  const { questions, answeredQuestionIds = [] } = decision.userInput;
  const index = decision.userInput.activeQuestionId ? questions.findIndex(question => question.id === decision.userInput!.activeQuestionId)
    : questions.findIndex(question => !answeredQuestionIds.includes(question.id));
  const question = questions[index];
  const choices = question?.options?.map((option, optionIndex) => messageAction(`option-${optionIndex}`, option.label,
    `uq:${decision.id}:p:${index}:${optionIndex}`)) ?? [];
  if (question?.isOther && question.options) choices.push(messageAction("write", "Write an answer", `uq:${decision.id}:w:${index}`));
  if (index < 0) choices.push({ ...messageAction("submit-answers", "Submit answers", `uq:${decision.id}:s`), style: "primary" });
  questions.forEach((question, questionIndex) => {
    if (answeredQuestionIds.includes(question.id) && questionIndex !== index)
      choices.push(messageAction(`edit-${questionIndex}`, `Edit answer ${questionIndex + 1}`, `uq:${decision.id}:e:${questionIndex}`));
  });
  choices.push(messageAction("skip-questions", "Skip questions", `decision:${decision.id}:c`));
  return choices;
}

type Draft = { answers: UserInputAnswers; writing?: string };
type Result = { ok: boolean; message: string };
export class UserInputService {
  private readonly drafts = new Map<string, Draft>();
  private readonly operations = new KeyedQueue();
  constructor(private readonly deps: {
    store: BridgeStore;
    client: Pick<CodexAppServerClient, "readUserInputRequest" | "resolveUserInput" | "isApprovalPending">;
    refresh: (session: SessionRecord, decision: DecisionRecord) => Promise<void>;
    finish: (decision: DecisionRecord) => Promise<void>;
  }) {}

  clear(): void { this.drafts.clear(); }

  present(decision: DecisionRecord): DecisionRecord {
    if (decision.kind !== USER_INPUT_METHOD) return decision;
    for (const key of this.drafts.keys()) if (!this.deps.client.isApprovalPending(key)) this.drafts.delete(key);
    const prompt = this.deps.client.readUserInputRequest(decision.approvalId);
    return { ...decision, userInput: prompt ? { ...prompt,
      answeredQuestionIds: Object.keys(this.drafts.get(decision.approvalId)?.answers ?? {}),
      activeQuestionId: this.drafts.get(decision.approvalId)?.writing } : undefined };
  }

  async submit(id: string, content: unknown | null, sourceId: string, guard?: DecisionOperationGuard): Promise<Result> {
    return this.run(id, sourceId, guard, async (decision, session, assertCurrent) => this.complete(decision, session, content, assertCurrent));
  }

  async act(action: UserQuestionAction, sourceId: string): Promise<Result> {
    return this.run(action.decisionId, sourceId, undefined, async (decision, session, assertCurrent) => {
      const prompt = this.deps.client.readUserInputRequest(decision.approvalId)!;
      const draft = this.drafts.get(decision.approvalId) ?? { answers: {} };
      if (action.type === "submit") return this.complete(decision, session, { answers: draft.answers }, assertCurrent);
      const question = prompt.questions[action.question];
      if (!question) throw new Error("This question is no longer available.");
      if (action.type === "pick") {
        const option = question.options?.[action.option];
        if (!option) throw new Error("Choose an available option.");
        draft.answers = { ...draft.answers, [question.id]: { answers: [option.label] } };
        draft.writing = undefined;
      } else {
        if (action.type === "write" && question.options && !question.isOther) throw new Error("Choose an available option.");
        draft.writing = question.id;
      }
      this.drafts.set(decision.approvalId, draft); assertCurrent();
      await this.deps.refresh(session, decision);
      return { ok: true, message: action.type === "write" ? "Reply with your answer as text." : "Answer saved. Submit when all questions are answered." };
    });
  }

  async text(decision: DecisionRecord, text: string, sourceId: string): Promise<Result> {
    return this.run(decision.id, sourceId, undefined, async (current, session, assertCurrent) => {
      const prompt = this.deps.client.readUserInputRequest(current.approvalId)!;
      const draft = this.drafts.get(current.approvalId) ?? { answers: {} };
      const question = prompt.questions.find(question => question.id === draft.writing) ??
        prompt.questions.find(question => !Object.hasOwn(draft.answers, question.id));
      if (!question) throw new Error("All questions have answers. Use Submit answers to continue.");
      if (!text.trim()) throw new Error("Enter a non-empty answer.");
      if (question.options && !question.isOther && !question.options.some(option => option.label === text))
        throw new Error("Choose one of the available options.");
      draft.answers = { ...draft.answers, [question.id]: { answers: [text] } }; draft.writing = undefined;
      this.drafts.set(current.approvalId, draft); assertCurrent();
      await this.deps.refresh(session, current);
      return { ok: true, message: "Answer saved. Submit when all questions are answered." };
    });
  }

  private async run(id: string, sourceId: string, guard: DecisionOperationGuard | undefined,
    operation: (decision: DecisionRecord, session: SessionRecord, assertCurrent: () => void) => Promise<Result>): Promise<Result> {
    return this.operations.run(id, async () => {
      try {
        const decision = await this.deps.store.getDecision(id); guard?.assertCurrent();
        if (!decision || decision.kind !== USER_INPUT_METHOD || !["pending", "awaitingInput"].includes(decision.state)) throw new Error("This question is no longer active.");
        if (guard && decision.sessionId !== guard.sessionId) throw new Error("This question belongs to another session.");
        const session = await this.deps.store.getSessionById(decision.sessionId); guard?.assertCurrent();
        if (!session || guard && session.codexThreadId !== guard.threadId) throw new Error("This question's session changed.");
        const access = await new SessionAccessService(this.deps.store).requireOwned(session.codexThreadId, sourceId, undefined, guard?.assertCurrent ?? (() => {}));
        const assertCurrent = () => {
          access.assertCurrent(); guard?.assertCurrent();
          if (!this.deps.client.readUserInputRequest(decision.approvalId)) throw new Error("This question is no longer active on the original connection.");
        };
        assertCurrent(); return await operation(decision, { ...session, telegramChatId: sourceId }, assertCurrent);
      } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "The answer could not be submitted. Check the original question." }; }
    });
  }

  private async complete(decision: DecisionRecord, _session: SessionRecord, content: unknown | null, assertCurrent: () => void): Promise<Result> {
    const prompt = this.deps.client.readUserInputRequest(decision.approvalId)!;
    const answer = content === null ? null : { answers: validateUserInputAnswers(prompt, content) };
    assertCurrent();
    try { await this.deps.client.resolveUserInput(decision.approvalId, answer); }
    catch {
      this.drafts.delete(decision.approvalId);
      const stale = await this.deps.store.resolveDecision(decision.id, "stale");
      await this.finish(stale ?? decision);
      return { ok: false, message: "Answer delivery outcome is unknown. Check the original question; answers will not be resent automatically." };
    }
    this.drafts.delete(decision.approvalId);
    const state = content === null ? "cancelled" : "answered";
    let resolved: DecisionRecord = { ...decision, state };
    try { resolved = await this.deps.store.resolveDecision(decision.id, state) ?? resolved; }
    catch { logger.warn("bridge.user_input.receipt_save_failed", { decisionId: decision.id }); }
    await this.finish(resolved);
    return { ok: true, message: content === null ? "Questions skipped." : "Answers submitted." };
  }

  private async finish(decision: DecisionRecord): Promise<void> {
    try { await this.deps.finish(decision); }
    catch { logger.warn("bridge.user_input.message_refresh_failed", { decisionId: decision.id }); }
  }
}
