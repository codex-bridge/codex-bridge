import type { SqliteDatabase } from "./migrations.js";

export type SlackEndpoint = {
  sourceId: string;
  threadTs: string;
  operationId: string;
  state: "pending" | "ready";
  startedAt: number;
};

/** Slack addresses are replaceable; business conversation and message IDs stay stable. */
export class SlackContinuationRepository {
  constructor(private readonly sqlite: SqliteDatabase) {}

  resolveSource(physicalSourceId: string): string {
    const row = this.sqlite.prepare("SELECT source_id FROM slack_conversation_aliases WHERE physical_source_id = ?")
      .get(physicalSourceId) as { source_id: string } | undefined;
    return row?.source_id ?? physicalSourceId;
  }

  get(sourceId: string): SlackEndpoint | null {
    return this.sqlite.prepare(`SELECT source_id AS sourceId, thread_ts AS threadTs,
      operation_id AS operationId, state, started_at AS startedAt
      FROM slack_conversation_endpoints WHERE source_id = ?`).get(sourceId) as SlackEndpoint | undefined ?? null;
  }

  begin(sourceId: string, threadTs: string, operationId: string): SlackEndpoint {
    this.sqlite.prepare(`INSERT INTO slack_conversation_endpoints
      (source_id, thread_ts, operation_id, state, started_at) VALUES (?, ?, ?, 'pending', ?)
      ON CONFLICT(source_id) DO UPDATE SET operation_id = excluded.operation_id,
        state = 'pending', started_at = excluded.started_at
      WHERE slack_conversation_endpoints.state = 'ready' AND slack_conversation_endpoints.thread_ts = excluded.thread_ts`)
      .run(sourceId, threadTs, operationId, Date.now());
    return this.get(sourceId)!;
  }

  complete(sourceId: string, operationId: string, threadTs: string, physicalSourceId: string): void {
    this.sqlite.transaction(() => {
      const result = this.sqlite.prepare(`UPDATE slack_conversation_endpoints SET thread_ts = ?, state = 'ready'
        WHERE source_id = ? AND operation_id = ? AND state = 'pending'`).run(threadTs, sourceId, operationId);
      if (result.changes !== 1) throw new Error("Slack continuation state changed during recovery.");
      this.sqlite.prepare(`INSERT INTO slack_conversation_aliases (physical_source_id, source_id) VALUES (?, ?)`)
        .run(physicalSourceId, sourceId);
    }).immediate();
  }

  /** A definite rejected create is safe to try again later; an unknown outcome is not. */
  rejected(sourceId: string, operationId: string): void {
    this.sqlite.prepare(`UPDATE slack_conversation_endpoints SET state = 'ready'
      WHERE source_id = ? AND operation_id = ? AND state = 'pending'`).run(sourceId, operationId);
  }

  getMessage(sourceId: string, messageId: string): { threadTs: string; messageId: string } | null {
    return this.sqlite.prepare(`SELECT thread_ts AS threadTs, physical_message_id AS messageId
      FROM slack_message_endpoints WHERE source_id = ? AND message_id = ?`)
      .get(sourceId, messageId) as { threadTs: string; messageId: string } | undefined ?? null;
  }

  putMessage(sourceId: string, messageId: string, threadTs: string, physicalMessageId: string): void {
    this.sqlite.prepare(`INSERT INTO slack_message_endpoints
      (source_id, message_id, thread_ts, physical_message_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, message_id) DO UPDATE SET thread_ts = excluded.thread_ts,
        physical_message_id = excluded.physical_message_id`).run(sourceId, messageId, threadTs, physicalMessageId);
  }

  replaceMessage(sourceId: string, oldPhysicalId: string, threadTs: string, newId: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`UPDATE slack_message_endpoints SET thread_ts = ?, physical_message_id = ?
        WHERE source_id = ? AND physical_message_id = ?`).run(threadTs, newId, sourceId, oldPhysicalId);
      this.putMessage(sourceId, oldPhysicalId, threadTs, newId);
      this.sqlite.prepare("DELETE FROM slack_pending_replacements WHERE source_id = ? AND message_id = ?")
        .run(sourceId, oldPhysicalId);
    }).immediate();
  }

  reserveReplacement(sourceId: string, messageId: string): boolean {
    return this.sqlite.prepare("INSERT OR IGNORE INTO slack_pending_replacements (source_id, message_id) VALUES (?, ?)")
      .run(sourceId, messageId).changes === 1;
  }

  rejectReplacement(sourceId: string, messageId: string): void {
    this.sqlite.prepare("DELETE FROM slack_pending_replacements WHERE source_id = ? AND message_id = ?")
      .run(sourceId, messageId);
  }
}
