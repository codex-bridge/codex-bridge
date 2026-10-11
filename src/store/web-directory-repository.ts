import type { SqliteDatabase } from "./migrations.js";

export type WebDirectoryRegistration = { directory: string; existing: boolean };

export class WebDirectoryRepository {
  constructor(private readonly sqlite: SqliteDatabase) {}

  list(): string[] {
    return (this.sqlite.prepare("SELECT directory FROM web_directories ORDER BY directory").all() as Array<{ directory: string }>)
      .map((row) => row.directory);
  }

  register(directory: string): WebDirectoryRegistration {
    return this.sqlite.transaction(() => {
      const existing = Boolean(this.sqlite.prepare("SELECT 1 FROM web_directories WHERE directory = ?").get(directory));
      const timestamp = Date.now();
      this.sqlite.prepare(`INSERT INTO web_directories (directory, created_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(directory) DO UPDATE SET updated_at = excluded.updated_at`)
        .run(directory, timestamp, timestamp);
      return { directory, existing };
    }).immediate();
  }
}
