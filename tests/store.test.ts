import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { BridgeStore } from "../src/store/index.js";

test("persists session bindings and detects Telegram message duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      displayName: "saved name"
    });
    assert.equal((await store.getSessionById(session.id))?.codexThreadId, "thread-1");
    const rediscovered = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    assert.equal(rediscovered.displayName, "saved name");
    const otherSession = await store.upsertDiscoveredSession({
      telegramChatId: "chat-2",
      codexThreadId: "thread-2",
      pathKey: "/workspace/other"
    });
    await assert.rejects(
      store.setActiveSession("chat-1", otherSession.id),
      /Session does not belong to chat/
    );

    assert.equal(await store.hasTelegramMessage(session.id, "42"), false);
    await store.addMessage({
      sessionId: session.id,
      role: "user",
      text: "hello",
      telegramMessageId: "42"
    });
    assert.equal(await store.hasTelegramMessage(session.id, "42"), true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps only a small local fallback message window", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    for (let index = 0; index < 25; index += 1) {
      await store.addMessage({
        sessionId: session.id,
        role: "assistant",
        text: `message-${index}`,
        createdAt: index + 1
      });
    }

    const messages = await store.listRecentMessages(session.id, 100);
    assert.equal(messages.length, 20);
    assert.equal(messages[0]?.text, "message-5");
    assert.equal(messages.at(-1)?.text, "message-24");
  } finally {
    store.close();
  }
});

test("persists and finalizes chronological progress phase cards", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    const first = store.createProgressPhaseMessage({
      sessionId: session.id,
      codexThreadId: session.codexThreadId,
      turnId: "turn-1",
      phaseKind: "called",
      sourceId: session.telegramChatId,
      platformMessageId: "10",
      directory: "/workspace/project",
      text: "Called search"
    });
    assert.equal(first.phaseSeq, 1);
    assert.equal(store.getActiveProgressPhaseMessage(session.codexThreadId, "turn-1")?.id, first.id);

    const updated = store.updateActiveProgressPhaseMessage(first.id, {
      sourceId: session.telegramChatId,
      directory: "/workspace/project",
      text: "Called fetch"
    });
    assert.equal(updated?.updateCount, 2);
    assert.equal(store.finalizeProgressPhaseMessage({ id: first.id, state: "phase_complete" })?.state, "phase_complete");
    assert.equal(store.getActiveProgressPhaseMessage(session.codexThreadId, "turn-1"), null);

    const second = store.createProgressPhaseMessage({
      sessionId: session.id,
      codexThreadId: session.codexThreadId,
      turnId: "turn-1",
      phaseKind: "edited",
      sourceId: session.telegramChatId,
      platformMessageId: "11",
      directory: "/workspace/project",
      text: "Edited src/a.ts"
    });
    assert.equal(second.phaseSeq, 2);
    assert.equal(second.state, "active");
  } finally {
    store.close();
  }
});

test("legacy Run aggregates load with zero updates before counting new replacements", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1", codexThreadId: "thread-1", pathKey: "/workspace/project"
    });
    const legacyAggregate = JSON.parse(JSON.stringify({
      eventCount: 1, operations: [], files: {}, run: { succeeded: 2, failed: 0 }, explored: {}
    }));
    const record = store.createProgressPhaseMessage({
      sessionId: session.id, codexThreadId: "thread-1", turnId: "turn-1",
      phaseKind: "run", sourceId: "chat-1", platformMessageId: "1",
      directory: "/workspace/project", text: "", aggregate: legacyAggregate
    });
    assert.deepEqual(record.aggregate.run, { updates: 0, succeeded: 2, failed: 0 });
    assert.deepEqual(store.recordSuccessfulRunContentUpdate(record.id)?.aggregate.run,
      { updates: 1, succeeded: 2, failed: 0 });
    store.finalizeProgressPhaseMessage({ id: record.id, state: "phase_complete" });
    assert.equal(store.recordSuccessfulRunContentUpdate(record.id), null);
  } finally {
    store.close();
  }
});

test("keeps discovered session created time from Codex metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-created-at-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const codexCreatedAt = Date.UTC(2026, 6, 20, 8, 30);
  const correctedCodexCreatedAt = Date.UTC(2026, 5, 18, 9, 45);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      latestActivityAt: Date.UTC(2026, 6, 21, 10, 0),
      createdAt: codexCreatedAt
    });
    assert.equal(session.createdAt, codexCreatedAt);

    const sqlite = new Database(databasePath);
    try {
      sqlite
        .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
        .run(Date.UTC(2026, 7, 1, 12, 0), session.id);
    } finally {
      sqlite.close();
    }

    const correctedSession = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      latestActivityAt: Date.UTC(2026, 6, 22, 11, 0),
      createdAt: correctedCodexCreatedAt
    });
    assert.equal(correctedSession.createdAt, correctedCodexCreatedAt);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stores each Codex thread as its own session without a section table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-section-sync-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);

  try {
    const first = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "first",
      latestActivityAt: 100
    });
    const second = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-2",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      displayName: "second",
      latestActivityAt: 200
    });
    const otherDirectory = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-3",
      pathKey: "/workspace/other",
      currentCwd: "/workspace/other",
      displayName: "third",
      latestActivityAt: 300
    });

    assert.notEqual(first.id, second.id);
    assert.notEqual(second.id, otherDirectory.id);
    assert.equal(first.displayName, "first");
    assert.equal(second.displayName, "second");
    assert.equal(otherDirectory.currentCwd, "/workspace/other");

    const sqlite = new Database(databasePath, { readonly: true });
    try {
      assert.equal(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sections'").get(), undefined);
      const sessionColumns = (sqlite.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name);
      assert.equal(sessionColumns.includes("section_id"), false);
    } finally {
      sqlite.close();
    }

    const check = store.checkDatabase();
    assert.equal(check.ok, true);
    assert.deepEqual(check.appliedMigrations, [
      "001_current_schema",
      "002_session_model_provider",
      "003_permission_mode_required",
      "004_session_service_tier",
      "005_queued_submissions",
      "006_remove_session_codex_config",
      "007_codex_archive_state",
      "008_remove_runtime_state",
      "009_remove_sections",
      "010_shared_session_bindings",
      "011_durable_turn_routes",
      "012_session_discovery_state",
      "013_durable_progress_phase_messages",
      "014_progress_phase_aggregate",
      "015_progress_phase_lifecycle",
      "016_web_directories"
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes legacy session Codex configuration during migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-config-migration-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const migrationBackupPath = join(directory, "bridge.pre-migration.sqlite");

  try {
    const sqlite = new Database(databasePath);
    sqlite.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at)
      VALUES
        ('001_current_schema', 1),
        ('002_session_model_provider', 1),
        ('003_permission_mode_required', 1),
        ('004_session_service_tier', 1),
        ('005_queued_submissions', 1);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        telegram_chat_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        path_key TEXT NOT NULL,
        current_cwd TEXT,
        display_name TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'auto-review',
        model TEXT,
        model_provider TEXT,
        reasoning_effort TEXT,
        service_tier_override TEXT,
        batch_decision_message_id TEXT,
        section_id TEXT,
        latest_activity_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_chat_idx ON sessions (telegram_chat_id, latest_activity_at DESC);
      CREATE INDEX sessions_section_idx ON sessions (section_id, latest_activity_at DESC);
      CREATE TABLE sections (
        id TEXT PRIMARY KEY,
        telegram_chat_id TEXT NOT NULL,
        directory_key TEXT NOT NULL,
        name TEXT,
        description TEXT,
        active_session_id TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX sections_chat_directory_idx ON sections (telegram_chat_id, directory_key, archived_at, updated_at DESC);
      CREATE UNIQUE INDEX sections_active_session_idx ON sections (active_session_id) WHERE active_session_id IS NOT NULL;
      INSERT INTO sections (
        id, telegram_chat_id, directory_key, name, description, active_session_id,
        archived_at, created_at, updated_at
      ) VALUES (
        'section-legacy', 'chat-1', '/workspace/project', 'renamed legacy', NULL,
        'session-legacy', NULL, 1, 3
      );
      INSERT INTO sessions (
        id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
        permission_mode, model, model_provider, reasoning_effort, service_tier_override,
        batch_decision_message_id, section_id, latest_activity_at, created_at, updated_at
      ) VALUES (
        'session-legacy', 'chat-1', 'thread-1', '/workspace/project', '/workspace/project', 'legacy',
        'auto-review', 'old-model', 'old-provider', 'high', '{"id":"priority"}',
        NULL, 'section-legacy', 3, 1, 3
      );
    `);
    sqlite.close();

    const store = new BridgeStore(databasePath, { migrationBackupPath });
    try {
      assert.equal(store.getLastMigrationBackupPath(), migrationBackupPath);
      assert.equal(store.getLastMigrationBackupIntegrity(), "ok");
      const session = await store.getSessionById("session-legacy");
      assert.deepEqual(session, {
        id: "session-legacy",
        telegramChatId: "chat-1",
        codexThreadId: "thread-1",
        pathKey: "/workspace/project",
        currentCwd: "/workspace/project",
        displayName: "renamed legacy",
        batchDecisionMessageId: null,
        codexArchivedAt: null,
        latestActivityAt: 3,
        createdAt: 1,
        discoveryMissingSince: null,
        discoveryMissingCount: 0,
        lastDiscoveredAt: 3
      });
      const check = store.checkDatabase();
      assert.equal(check.integrity, "ok");
      assert.equal(check.missingMigrations.length, 0);
      assert.match(check.appliedMigrations.join(","), /006_remove_session_codex_config/);
    } finally {
      store.close();
    }

    const backup = new Database(migrationBackupPath, { readonly: true });
    try {
      const legacyColumns = (backup.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>)
        .map((row) => row.name);
      assert.ok(legacyColumns.includes("model"));
      assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
    } finally {
      backup.close();
    }

    const migrated = new Database(databasePath, { readonly: true });
    try {
      const columns = (migrated.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name);
      assert.deepEqual(columns, [
        "id", "telegram_chat_id", "codex_thread_id", "path_key", "current_cwd", "display_name",
        "batch_decision_message_id", "codex_archived_at", "latest_activity_at", "created_at", "updated_at",
        "discovery_missing_since", "discovery_missing_count", "last_discovered_at"
      ]);
      assert.equal(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sections'").get(), undefined);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports pending destructive migration without changing a database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-migration-plan-test-"));
  const databasePath = join(directory, "bridge.sqlite");

  try {
    const sqlite = new Database(databasePath);
    sqlite.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, applied_at)
      VALUES
        ('001_current_schema', 1),
        ('002_session_model_provider', 1),
        ('003_permission_mode_required', 1),
        ('004_session_service_tier', 1),
        ('005_queued_submissions', 1);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        permission_mode TEXT NOT NULL,
        model TEXT,
        model_provider TEXT,
        reasoning_effort TEXT,
        service_tier_override TEXT
      );
    `);
    sqlite.close();

    const store = new BridgeStore(databasePath, { readonly: true });
    try {
      assert.deepEqual(store.getMigrationPlan(), {
        appliedMigrations: [
          "001_current_schema",
          "002_session_model_provider",
          "003_permission_mode_required",
          "004_session_service_tier",
          "005_queued_submissions"
        ],
        pendingMigrations: ["006_remove_session_codex_config", "007_codex_archive_state", "008_remove_runtime_state", "009_remove_sections", "010_shared_session_bindings", "011_durable_turn_routes", "012_session_discovery_state", "013_durable_progress_phase_messages", "014_progress_phase_aggregate", "015_progress_phase_lifecycle", "016_web_directories"],
        destructiveMigrations: ["006_remove_session_codex_config", "010_shared_session_bindings"],
        backupRequired: true
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes persisted runtime connection state with a migration backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-runtime-state-migration-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec(`
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations (version, applied_at) VALUES
      ('001_current_schema', 1),
      ('002_session_model_provider', 1),
      ('003_permission_mode_required', 1),
      ('004_session_service_tier', 1),
      ('005_queued_submissions', 1),
      ('006_remove_session_codex_config', 1),
      ('007_codex_archive_state', 1);
    CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO runtime_state (key, value, updated_at) VALUES ('codex_runtime_connected', '0', 1);
  `);
  sqlite.close();

  try {
    const store = new BridgeStore(databasePath);
    const backupPath = store.getLastMigrationBackupPath();
    store.close();

    assert.ok(backupPath);
    const migrated = new Database(databasePath, { readonly: true });
    try {
      const runtimeTable = migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_state'")
        .get();
      assert.equal(runtimeTable, undefined);
      assert.ok(migrated.prepare("SELECT 1 FROM schema_migrations WHERE version = '008_remove_runtime_state'").get());
      assert.ok(migrated.prepare("SELECT 1 FROM schema_migrations WHERE version = '012_session_discovery_state'").get());
      assert.ok(migrated.prepare("SELECT 1 FROM schema_migrations WHERE version = '013_durable_progress_phase_messages'").get());
    } finally {
      migrated.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports active-session integrity failures without changing the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-check-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  let store: BridgeStore | null = new BridgeStore(databasePath);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    await store.selectSession("chat-2", session.id);
    store.close();
    store = null;

    const sqlite = new Database(databasePath);
    sqlite.prepare(`UPDATE chats SET active_session_id = 'missing-session' WHERE telegram_chat_id = 'chat-1'`).run();
    sqlite.close();

    const readOnlyStore = new BridgeStore(databasePath, { readonly: true });
    try {
      const check = readOnlyStore.checkDatabase();
      assert.equal(check.ok, false);
      assert.equal(check.chatsWithDanglingActiveSession, 1);
      assert.equal(check.chatsWithCrossChatActiveSession, 0);
    } finally {
      readOnlyStore.close();
    }
  } finally {
    if (store) {
      store.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates an integrity-checked SQLite backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-backup-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const backupPath = join(directory, "bridge.backup.sqlite");
  const store = new BridgeStore(databasePath);

  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    const backup = await BridgeStore.backupDatabase(databasePath, backupPath);
    assert.equal(backup.destinationPath, backupPath);
    assert.equal(backup.integrity, "ok");
    assert.ok(backup.bytes > 0);

    const backupStore = new BridgeStore(backupPath, { readonly: true });
    try {
      assert.equal(backupStore.checkDatabase().ok, true);
    } finally {
      backupStore.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("resets bridge state without dropping the current schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-reset-state-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat-1",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project"
    });
    await store.setActiveSession("chat-1", session.id);
    await store.addMessage({
      sessionId: session.id,
      role: "user",
      text: "hello",
      telegramMessageId: "42"
    });
    const dryRun = store.resetState({ dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.integrity, "ok");
    assert.equal(dryRun.deletedRows.sessions, 1);
    assert.equal((await store.getSessionById(session.id))?.id, session.id);

    const reset = store.resetState();
    assert.equal(reset.dryRun, false);
    assert.equal(reset.integrity, "ok");
    assert.equal(reset.deletedRows.sessions, 1);
    assert.equal(reset.deletedRows.chats, 1);
    assert.equal(reset.deletedRows.messages, 1);
    const check = store.checkDatabase();
    assert.equal(check.ok, true);
    assert.deepEqual(check.appliedMigrations, [
      "001_current_schema",
      "002_session_model_provider",
      "003_permission_mode_required",
      "004_session_service_tier",
      "005_queued_submissions",
      "006_remove_session_codex_config",
      "007_codex_archive_state",
      "008_remove_runtime_state",
      "009_remove_sections",
      "010_shared_session_bindings",
      "011_durable_turn_routes",
      "012_session_discovery_state",
      "013_durable_progress_phase_messages",
      "014_progress_phase_aggregate",
      "015_progress_phase_lifecycle",
      "016_web_directories"
    ]);
    assert.deepEqual(await store.listSessionsForPolling(), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dedupes duplicate Slack sessions by root chat and Codex thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-dedupe-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));

  try {
    const rootSession = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      latestActivityAt: 1_000
    });
    const otherChannelSession = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:D",
      codexThreadId: "thread-2",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project",
      latestActivityAt: 3_000
    });
    await store.ensureChat("slack:T:C:111.222");
    const sqlite = new Database(join(directory, "bridge.sqlite"));
    sqlite.exec("DROP INDEX sessions_codex_thread_idx");
    sqlite.prepare(`
      INSERT INTO sessions (
        id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
        batch_decision_message_id, codex_archived_at, latest_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      "session-duplicate",
      "slack:T:C:111.222",
      "thread-1",
      "/workspace/project",
      "/workspace/project",
      null,
      2_000,
      1_000,
      2_000
    );
    sqlite.prepare("UPDATE chats SET active_session_id = ? WHERE telegram_chat_id = ?")
      .run("session-duplicate", "slack:T:C:111.222");
    sqlite.close();
    const threadSessionId = "session-duplicate";
    await store.addMessage({
      sessionId: threadSessionId,
      role: "user",
      text: "duplicate binding"
    });

    const dryRun = store.dedupeSlackSessions({ dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.integrity, "ok");
    assert.equal(dryRun.duplicateGroups.length, 1);
    assert.equal(dryRun.duplicateGroups[0]?.keepSessionId, threadSessionId);
    assert.deepEqual(dryRun.duplicateGroups[0]?.deleteSessionIds, [rootSession.id]);
    assert.equal(dryRun.deletedRows.sessions, 1);
    assert.equal(dryRun.deletedRows.messages, 0);
    assert.equal((await store.getSessionById(rootSession.id))?.id, rootSession.id);

    const result = store.dedupeSlackSessions({ dryRun: false });
    assert.equal(result.dryRun, false);
    assert.equal(result.integrity, "ok");
    assert.equal(result.deletedRows.sessions, 1);
    assert.equal(result.deletedRows.messages, 0);
    assert.equal(result.deletedRows.chats, 1);
    assert.equal(await store.getSessionById(rootSession.id), null);
    assert.equal((await store.getSessionById(threadSessionId))?.id, threadSessionId);
    assert.equal((await store.getSessionById(otherChannelSession.id))?.id, otherChannelSession.id);
    assert.equal((await store.getActiveSession("slack:T:C:111.222"))?.id, threadSessionId);
    assert.equal(store.checkDatabase().ok, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
