import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateGenerated } from "../src/store/migration-019_progress_summary_delivery.js";

test("summary migration preserves records, unrelated columns, indexes and uniqueness while allowing an unsent phase", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE progress_phase_messages (id TEXT PRIMARY KEY, platform_message_id TEXT NOT NULL,
      unrelated TEXT NOT NULL, UNIQUE(unrelated));
      CREATE INDEX original_message_idx ON progress_phase_messages(platform_message_id);
      INSERT INTO progress_phase_messages VALUES ('old', '123', 'preserved');`);
    db.transaction(() => migrateGenerated(db))();
    assert.deepEqual(db.prepare("SELECT * FROM progress_phase_messages WHERE id = 'old'").get(),
      { id: "old", platform_message_id: "123", unrelated: "preserved" });
    db.prepare("INSERT INTO progress_phase_messages VALUES (?, ?, ?)").run("new", null, "unsent");
    assert.throws(() => db.prepare("INSERT INTO progress_phase_messages VALUES (?, ?, ?)").run("duplicate", null, "preserved"), /UNIQUE/);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'original_message_idx'").get());
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally { db.close(); }
});
