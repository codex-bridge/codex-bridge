import type { SqliteDatabase } from "./migrations.js";

export function migrateGenerated(sqlite: SqliteDatabase): void {
  const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'progress_phase_messages'").get() as { sql: string };
  const indexes = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'progress_phase_messages' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  const definition = row.sql.replace(/CREATE TABLE(?: IF NOT EXISTS)? progress_phase_messages/i, "CREATE TABLE progress_phase_messages_new")
    .replace(/platform_message_id TEXT NOT NULL/i, "platform_message_id TEXT");
  if (definition === row.sql || /platform_message_id TEXT NOT NULL/i.test(definition)) throw new Error("Unexpected progress schema; migration was not applied");
  sqlite.exec(definition);
  sqlite.exec(`INSERT INTO progress_phase_messages_new SELECT * FROM progress_phase_messages;
    DROP TABLE progress_phase_messages;
    ALTER TABLE progress_phase_messages_new RENAME TO progress_phase_messages;`);
  for (const index of indexes) sqlite.exec(index.sql);
}
