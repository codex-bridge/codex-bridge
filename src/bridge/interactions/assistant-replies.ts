import { randomBytes } from "node:crypto";
import type { SessionRecord, TranscriptMessage } from "../../shared/types.js";
import { assistantPresentation } from "../../shared/assistant-questions.js";
import { userTextAction } from "../messages/actions.js";
import type { ActionSpec } from "../messages/types.js";

type Reply = { sessionId: string; threadId: string; sourceId: string; leaseVersion: number | undefined;
  text: string; group: Set<string> };

export function parseAssistantReplyCallback(value: string): string | null {
  return /^reply:([A-Za-z0-9_-]{16})$/.exec(value)?.[1] ?? null;
}

export class AssistantReplyError extends Error {
  readonly reason = "stale_option";
  constructor() { super("This option is no longer available for the current session. Reply with text instead."); }
}

/** Short platform callbacks refer to one-use choices; no RPC or answer is persisted. */
export class AssistantReplyService {
  private readonly replies = new Map<string, Reply>();
  private readonly messages = new Map<string, Set<string>>();

  constructor(private readonly readLeaseVersion: (sessionId: string) => number | undefined) {}

  createActions(session: SessionRecord, message: TranscriptMessage): ActionSpec[] {
    if (message.role !== "assistant" || !message.sourceItemId) return [];
    const key = JSON.stringify([session.id, message.sourceItemId]);
    this.removeMessage(key);
    const questions = assistantPresentation(message).questions;
    if (!questions) return [];
    const tokens = new Set<string>();
    const actions = questions.flatMap(question => {
      const group = new Set<string>();
      const questionId = randomBytes(12).toString("base64url");
      return (question.options ?? []).map((text, index) => {
        const token = randomBytes(12).toString("base64url");
        tokens.add(token); group.add(token);
        this.replies.set(token, { sessionId: session.id, threadId: session.codexThreadId,
          sourceId: session.telegramChatId, leaseVersion: this.readLeaseVersion(session.id), text, group });
        return { ...userTextAction(`reply-${token}`, text, `reply:${token}`, text, question.title),
          execution: { type: "send-text" as const, text, reply: { threadId: session.codexThreadId, token, questionId } },
          ...(index ? { sameRowAsPrevious: true } : {}) };
      });
    });
    this.messages.set(key, tokens);
    while (this.messages.size > 256) this.removeMessage(this.messages.keys().next().value!);
    return actions;
  }

  resolve(token: string, sessionId: string, sourceId: string): Reply {
    const reply = this.replies.get(token);
    if (!reply || reply.sessionId !== sessionId || reply.sourceId !== sourceId ||
        reply.leaseVersion !== this.readLeaseVersion(sessionId)) {
      throw new AssistantReplyError();
    }
    return reply;
  }

  consume(token: string, sessionId: string, sourceId: string): void {
    const reply = this.resolve(token, sessionId, sourceId);
    for (const entry of reply.group) this.replies.delete(entry);
  }

  private removeMessage(key: string): void {
    for (const token of this.messages.get(key) ?? []) this.replies.delete(token);
    this.messages.delete(key);
  }
}
