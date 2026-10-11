import crypto from "node:crypto";

import Database from "better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { messagesTable } from "./schema.js";
import type { MessageRecord } from "../shared/types.js";

const MAX_MESSAGES_PER_SESSION = 20;

function now(): number {
  return Date.now();
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function asMessageRecord(row: {
  id: string;
  sessionId: string;
  role: string;
  text: string;
  codexTurnId: string | null;
  telegramMessageId: string | null;
  createdAt: number;
}): MessageRecord {
  return {
    ...row,
    role: row.role as MessageRecord["role"]
  };
}

export class MessageRepository {
  constructor(
    private readonly sqlite: InstanceType<typeof Database>,
    private readonly db: ReturnType<typeof drizzle>,
    private readonly touchSession: (sessionId: string) => Promise<void>
  ) {}

  async add(input: {
    sessionId: string;
    role: MessageRecord["role"];
    text: string;
    codexTurnId?: string | null;
    telegramMessageId?: string | null;
    createdAt?: number;
  }): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      codexTurnId: input.codexTurnId ?? null,
      telegramMessageId: input.telegramMessageId ?? null,
      createdAt: input.createdAt ?? now()
    };

    await this.db.insert(messagesTable).values(record).run();
    await this.touchSession(input.sessionId);
    await this.pruneForSession(input.sessionId);
    return record;
  }

  async hasTelegramMessage(sessionId: string, telegramMessageId: string): Promise<boolean> {
    if (!telegramMessageId) return false;
    const row = await this.db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.sessionId, sessionId),
          eq(messagesTable.telegramMessageId, telegramMessageId)
        )
      )
      .get();
    return Boolean(row);
  }

  async listRecent(sessionId: string, limit: number): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(limit)
      .all();
    return rows.reverse().map(asMessageRecord);
  }

  async listLatestTimes(sessionIds: string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.sqlite
      .prepare(`
        SELECT session_id, MAX(created_at) AS latest_message_at
        FROM messages
        WHERE session_id IN (${placeholders})
        GROUP BY session_id
      `)
      .all(...sessionIds) as Array<{
        session_id: string;
        latest_message_at: number | null;
      }>;
    return new Map(
      rows
        .filter((row) => typeof row.latest_message_at === "number")
        .map((row) => [row.session_id, row.latest_message_at as number])
    );
  }

  private async pruneForSession(sessionId: string): Promise<void> {
    const rows = this.sqlite
      .prepare(`
        SELECT id
        FROM messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      `)
      .all(sessionId, MAX_MESSAGES_PER_SESSION) as Array<{ id: string }>;

    for (const row of rows) {
      await this.db.delete(messagesTable).where(eq(messagesTable.id, row.id)).run();
    }
  }
}
