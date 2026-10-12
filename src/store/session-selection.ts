import type Database from "better-sqlite3";

/** Selection expresses intent only; it neither claims a lease nor changes a turn route. */
export function recordSessionSelection(sqlite: InstanceType<typeof Database>, sourceId: string, sessionId: string): void {
  const timestamp = Date.now();
  sqlite.prepare(`INSERT INTO chats (telegram_chat_id, active_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(telegram_chat_id) DO UPDATE
    SET active_session_id = excluded.active_session_id, updated_at = excluded.updated_at`)
    .run(sourceId, sessionId, timestamp, timestamp);
}
