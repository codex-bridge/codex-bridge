import crypto from "node:crypto";

import Database from "better-sqlite3";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { queuedSubmissionsTable } from "./schema.js";

function now(): number {
  return Date.now();
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export type QueuedSubmissionRecord = {
  id: string;
  sessionId: string;
  telegramChatId: string;
  codexThreadId: string;
  codexQueueId: string | null;
  clientUserMessageId: string;
  sourceMessageId: string;
  summary: string;
  attachmentPaths: string[];
  state: "submitting" | "queued" | "started" | "cancelled" | "unknown";
  createdAt: number;
  updatedAt: number;
};

export class QueueRepository {
  constructor(
    private readonly sqlite: InstanceType<typeof Database>,
    private readonly db: ReturnType<typeof drizzle>
  ) {}

  async create(
    input: Omit<QueuedSubmissionRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<QueuedSubmissionRecord> {
    const timestamp = now();
    const record: QueuedSubmissionRecord = {
      ...input,
      id: createId("queue"),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.db.insert(queuedSubmissionsTable).values(record).run();
    return record;
  }

  async update(
    id: string,
    patch: Partial<Pick<QueuedSubmissionRecord, "codexQueueId" | "state">>
  ): Promise<void> {
    await this.db
      .update(queuedSubmissionsTable)
      .set({ ...patch, updatedAt: now() })
      .where(eq(queuedSubmissionsTable.id, id))
      .run();
  }

  async markAccepted(id: string, codexQueueId: string): Promise<void> {
    this.sqlite
      .prepare(`
        UPDATE queued_submissions
        SET codex_queue_id = ?, state = CASE WHEN state = 'submitting' THEN 'queued' ELSE state END, updated_at = ?
        WHERE id = ?
      `)
      .run(codexQueueId, now(), id);
  }

  async get(id: string): Promise<QueuedSubmissionRecord | null> {
    return (
      (await this.db
        .select()
        .from(queuedSubmissionsTable)
        .where(eq(queuedSubmissionsTable.id, id))
        .get() as QueuedSubmissionRecord | undefined) ?? null
    );
  }

  async listPending(threadId: string): Promise<QueuedSubmissionRecord[]> {
    return (await this.db
      .select()
      .from(queuedSubmissionsTable)
      .where(
        and(
          eq(queuedSubmissionsTable.codexThreadId, threadId),
          or(
            eq(queuedSubmissionsTable.state, "submitting"),
            eq(queuedSubmissionsTable.state, "queued"),
            eq(queuedSubmissionsTable.state, "unknown")
          )
        )
      )
      .orderBy(queuedSubmissionsTable.createdAt)) as QueuedSubmissionRecord[];
  }

  async countPending(threadId: string): Promise<number> {
    return (await this.listPending(threadId)).length;
  }

  async startNext(threadId: string): Promise<QueuedSubmissionRecord | null> {
    const take = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(`
          SELECT * FROM queued_submissions
          WHERE codex_thread_id = ? AND state IN ('submitting', 'queued')
          ORDER BY created_at LIMIT 1
        `)
        .get(threadId) as Record<string, unknown> | undefined;
      if (!row) return null;

      const updatedAt = now();
      this.sqlite
        .prepare(
          "UPDATE queued_submissions SET state = 'started', updated_at = ? WHERE id = ? AND state IN ('submitting', 'queued')"
        )
        .run(updatedAt, row.id);
      return {
        id: row.id,
        sessionId: row.session_id,
        telegramChatId: row.telegram_chat_id,
        codexThreadId: row.codex_thread_id,
        codexQueueId: row.codex_queue_id,
        clientUserMessageId: row.client_user_message_id,
        sourceMessageId: row.source_message_id,
        summary: row.summary,
        attachmentPaths: JSON.parse(String(row.attachment_paths)),
        state: "started",
        createdAt: row.created_at,
        updatedAt
      } as QueuedSubmissionRecord;
    });
    return take.immediate();
  }
}
