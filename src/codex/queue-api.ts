import { asRecord, firstString } from "./protocol-utils.js";
import type { CodexTurnInputPart } from "./client.js";

export type CodexQueuedSubmission = {
  id: string;
  input: CodexTurnInputPart[];
  clientUserMessageId: string;
};

export type QueueApiDependencies = {
  connect: () => Promise<void>;
  requestKnownMethod: (
    method: "thread/queue/add" | "thread/queue/list" | "thread/queue/delete",
    params?: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>;
};

export class CodexQueueApi {
  constructor(private readonly deps: QueueApiDependencies) {}

  async addQueuedSubmission(
    threadId: string,
    input: CodexTurnInputPart[],
    clientUserMessageId: string
  ): Promise<CodexQueuedSubmission> {
    await this.deps.connect();
    const result = asRecord(await this.deps.requestKnownMethod(
      "thread/queue/add",
      { threadId, input, clientUserMessageId },
      { timeoutMs: 5_000 }
    ));
    const queued = asRecord(result?.queuedSubmission);
    const id = firstString(queued?.id);
    if (!id) {
      throw new Error("Queue outcome unknown: response did not include a submission id.");
    }
    return { id, input, clientUserMessageId };
  }

  async listQueuedSubmissions(threadId: string): Promise<CodexQueuedSubmission[]> {
    await this.deps.connect();
    const submissions: CodexQueuedSubmission[] = [];
    let cursor: string | null = null;
    do {
      const result = asRecord(await this.deps.requestKnownMethod(
        "thread/queue/list",
        { threadId, cursor, limit: 100 },
        { timeoutMs: 5_000 }
      ));
      for (const value of Array.isArray(result?.data) ? result.data : []) {
        const row = asRecord(value);
        const id = firstString(row?.id);
        const clientUserMessageId = firstString(row?.clientUserMessageId);
        if (id && clientUserMessageId) {
          submissions.push({
            id,
            clientUserMessageId,
            input: (Array.isArray(row?.input) ? row.input : []) as CodexTurnInputPart[]
          });
        }
      }
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor);
    return submissions;
  }

  async deleteQueuedSubmission(threadId: string, queuedSubmissionId: string): Promise<boolean> {
    await this.deps.connect();
    const result = asRecord(await this.deps.requestKnownMethod(
      "thread/queue/delete",
      { threadId, queuedSubmissionId },
      { timeoutMs: 5_000 }
    ));
    return result?.deleted === true;
  }
}
