import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";

export type SqliteDatabase = InstanceType<typeof Database>;

export type SchemaMigrationVersion =
  | "001_current_schema"
  | "002_session_model_provider"
  | "003_permission_mode_required"
  | "004_session_service_tier"
  | "005_queued_submissions"
  | "006_remove_session_codex_config"
  | "007_codex_archive_state"
  | "008_remove_runtime_state"
  | "009_remove_sections"
  | "010_shared_session_bindings"
  | "011_durable_turn_routes"
  | "012_session_discovery_state"
  | "013_durable_progress_phase_messages"
  | "014_progress_phase_aggregate"
  | "015_progress_phase_lifecycle"
  | "016_web_directories";

export const SCHEMA_MIGRATIONS: readonly SchemaMigrationVersion[] = [
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
];

export interface DatabaseMigrationPlan {
  appliedMigrations: string[];
  pendingMigrations: SchemaMigrationVersion[];
  destructiveMigrations: SchemaMigrationVersion[];
  backupRequired: boolean;
}

export interface DatabaseBackupResult {
  destinationPath: string;
  bytes: number;
  integrity: string;
}

function now(): number {
  return Date.now();
}

function hasSchemaMigration(sqlite: SqliteDatabase, version: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 AS present FROM schema_migrations WHERE version = ?")
    .get(version) as { present: number } | undefined;
  return Boolean(row);
}

export function getMigrationPlan(sqlite: SqliteDatabase): DatabaseMigrationPlan {
  const tableNames = new Set(
    (sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>).map((row) => row.name)
  );
  const appliedMigrations = tableNames.has("schema_migrations")
    ? (sqlite
      .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
      .all() as Array<{ version: string }>).map((row) => row.version)
    : [];
  const pendingMigrations = SCHEMA_MIGRATIONS.filter((version) => !appliedMigrations.includes(version));
  const sessionColumns = tableNames.has("sessions")
    ? new Set(
      (sqlite.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>)
        .map((row) => row.name)
    )
    : new Set<string>();
  const legacySessionConfigColumns = [
    "permission_mode",
    "model",
    "model_provider",
    "reasoning_effort",
    "service_tier_override"
  ];
  const destructiveMigrations = pendingMigrations.filter((version) =>
    (version === "006_remove_session_codex_config" &&
      legacySessionConfigColumns.some((column) => sessionColumns.has(column))) ||
    (version === "008_remove_runtime_state" && tableNames.has("runtime_state")) ||
    (version === "009_remove_sections" && (tableNames.has("sections") || sessionColumns.has("section_id"))) ||
    (version === "010_shared_session_bindings" && tableNames.has("sessions"))
  );
  return {
    appliedMigrations,
    pendingMigrations,
    destructiveMigrations,
    backupRequired: destructiveMigrations.length > 0
  };
}

export async function backupDatabase(sourcePath: string, destinationPath: string): Promise<DatabaseBackupResult> {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw new Error("Backup destination must differ from the source database");
  }
  if (!fs.existsSync(source)) {
    throw new Error(`Database does not exist: ${source}`);
  }
  if (fs.existsSync(destination)) {
    throw new Error(`Backup destination already exists: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const sourceDatabase = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await sourceDatabase.backup(destination);
  } finally {
    sourceDatabase.close();
  }

  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") {
      throw new Error(`Backup integrity check failed: ${integrity}`);
    }
    return {
      destinationPath: destination,
      bytes: fs.statSync(destination).size,
      integrity
    };
  } finally {
    backup.close();
  }
}

export function createMigrationBackup(
  sqlite: SqliteDatabase,
  sourcePath: string,
  requestedPath?: string
): { destinationPath: string; integrity: string } {
  if (sourcePath === ":memory:") {
    throw new Error("Cannot back up an in-memory database before migration");
  }
  const source = path.resolve(sourcePath);
  const destination = requestedPath
    ? path.resolve(requestedPath)
    : `${source}.pre-migration-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.sqlite`;
  if (source === destination) {
    throw new Error("Migration backup destination must differ from the source database");
  }
  if (fs.existsSync(destination)) {
    throw new Error(`Migration backup destination already exists: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  sqlite.prepare("VACUUM INTO ?").run(destination);

  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") {
      throw new Error(`Migration backup integrity check failed: ${integrity}`);
    }
    return { destinationPath: destination, integrity };
  } finally {
    backup.close();
  }
}

export function migrate(sqlite: SqliteDatabase): void {
  ensureSchemaMigrationsTable(sqlite);
  const migrations: Array<{
    version: SchemaMigrationVersion;
    run: () => void;
  }> = [
    { version: "001_current_schema", run: () => migrateCurrentSchema(sqlite) },
    { version: "002_session_model_provider", run: () => migrateSessionModelProvider(sqlite) },
    { version: "003_permission_mode_required", run: () => migratePermissionModeDefault(sqlite) },
    { version: "004_session_service_tier", run: () => {
      sqlite.exec("ALTER TABLE sessions ADD COLUMN service_tier_override TEXT");
    } },
    { version: "005_queued_submissions", run: () => {
      sqlite.exec(`
        CREATE TABLE queued_submissions (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, telegram_chat_id TEXT NOT NULL,
          codex_thread_id TEXT NOT NULL, codex_queue_id TEXT,
          client_user_message_id TEXT NOT NULL UNIQUE, source_message_id TEXT NOT NULL,
          summary TEXT NOT NULL, attachment_paths TEXT NOT NULL DEFAULT '[]',
          state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX queued_submissions_thread_state_idx
          ON queued_submissions (codex_thread_id, state, created_at);
      `);
    } },
    { version: "006_remove_session_codex_config", run: () => migrateRemoveSessionCodexConfig(sqlite) },
    { version: "007_codex_archive_state", run: () => {
      sqlite.exec("ALTER TABLE sessions ADD COLUMN codex_archived_at INTEGER");
    } },
    { version: "008_remove_runtime_state", run: () => {
      sqlite.exec("DROP TABLE IF EXISTS runtime_state");
    } },
    { version: "009_remove_sections", run: () => migrateRemoveSections(sqlite) },
    { version: "010_shared_session_bindings", run: () => migrateSharedSessionBindings(sqlite) },
    { version: "011_durable_turn_routes", run: () => migrateDurableTurnRoutes(sqlite) },
    { version: "012_session_discovery_state", run: () => {
      const tableExists = sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get();
      if (!tableExists) {
        return;
      }
      sqlite.exec("ALTER TABLE sessions ADD COLUMN discovery_missing_since INTEGER");
      sqlite.exec("ALTER TABLE sessions ADD COLUMN discovery_missing_count INTEGER NOT NULL DEFAULT 0");
      sqlite.exec("ALTER TABLE sessions ADD COLUMN last_discovered_at INTEGER NOT NULL DEFAULT 0");
      sqlite.exec("UPDATE sessions SET last_discovered_at = latest_activity_at WHERE last_discovered_at = 0");
    } },
    { version: "013_durable_progress_phase_messages", run: () => migrateDurableProgressPhaseMessages(sqlite) },
    { version: "014_progress_phase_aggregate", run: () => {
      sqlite.exec("ALTER TABLE progress_phase_messages ADD COLUMN aggregate_json TEXT NOT NULL DEFAULT '{}'");
    } },
    { version: "015_progress_phase_lifecycle", run: () => {
      sqlite.exec(`
        ALTER TABLE progress_phase_messages ADD COLUMN failure_reason TEXT;
        ALTER TABLE progress_phase_messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'synced';
        ALTER TABLE progress_phase_messages ADD COLUMN correction_message_id TEXT;
        UPDATE progress_phase_messages
        SET state = 'interrupted', finished_at = COALESCE(finished_at, updated_at)
        WHERE phase_kind = 'other' AND state = 'active';
        CREATE INDEX IF NOT EXISTS progress_phase_messages_turn_state_idx
          ON progress_phase_messages (codex_thread_id, turn_id, state, updated_at DESC);
      `);
    } },
    { version: "016_web_directories", run: () => {
      sqlite.exec(`
        CREATE TABLE web_directories (
          directory TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    } }
  ];

  for (const migration of migrations) {
    if (hasSchemaMigration(sqlite, migration.version)) {
      continue;
    }
    const applyMigration = sqlite.transaction(() => {
      if (hasSchemaMigration(sqlite, migration.version)) {
        return;
      }
      migration.run();
      sqlite.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(migration.version, now());
    });
    applyMigration.immediate();
  }
}

function ensureSchemaMigrationsTable(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function migrateCurrentSchema(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      telegram_chat_id TEXT PRIMARY KEY,
      active_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      codex_turn_id TEXT,
      telegram_message_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      telegram_chat_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      kind TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      requires_user_input INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      telegram_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
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
      batch_decision_message_id TEXT,
      section_id TEXT,
      latest_activity_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sections (
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
    CREATE UNIQUE INDEX IF NOT EXISTS decisions_approval_id_idx ON decisions (approval_id);
    CREATE INDEX IF NOT EXISTS sessions_chat_idx ON sessions (telegram_chat_id, latest_activity_at DESC);
    CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS decisions_session_idx ON decisions (session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sections_chat_directory_idx
      ON sections (telegram_chat_id, directory_key, archived_at, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS sections_active_session_idx
      ON sections (active_session_id)
      WHERE active_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sessions_section_idx
      ON sessions (section_id, latest_activity_at DESC);
  `);
}

function migrateSessionModelProvider(sqlite: SqliteDatabase): void {
  const columns = new Set(
    (sqlite.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((row) => row.name)
  );
  if (!columns.has("model_provider")) {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN model_provider TEXT`);
  }
}

function migratePermissionModeDefault(sqlite: SqliteDatabase): void {
  const columns = sqlite.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
    dflt_value: string | null;
    name: string;
    notnull: 0 | 1;
  }>;
  const permissionModeColumn = columns.find((column) => column.name === "permission_mode");
  if (
    permissionModeColumn?.notnull === 1 &&
    permissionModeColumn.dflt_value?.replaceAll("'", "") === "auto-review"
  ) {
    sqlite.exec(`UPDATE sessions SET permission_mode = 'auto-review' WHERE permission_mode IS NULL`);
    return;
  }

  sqlite.exec(`
    DROP INDEX IF EXISTS sessions_chat_idx;
    DROP INDEX IF EXISTS sessions_section_idx;
    ALTER TABLE sessions RENAME TO sessions_old_permission_mode;
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
      batch_decision_message_id TEXT,
      section_id TEXT,
      latest_activity_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO sessions (
      id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
      permission_mode, model, model_provider, reasoning_effort, batch_decision_message_id, section_id,
      latest_activity_at, created_at, updated_at
    )
    SELECT
      id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
      COALESCE(permission_mode, 'auto-review'), model, model_provider, reasoning_effort,
      batch_decision_message_id, section_id, latest_activity_at, created_at, updated_at
    FROM sessions_old_permission_mode;
    DROP TABLE sessions_old_permission_mode;
    CREATE INDEX IF NOT EXISTS sessions_chat_idx
      ON sessions (telegram_chat_id, latest_activity_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_section_idx
      ON sessions (section_id, latest_activity_at DESC);
  `);
}

function migrateRemoveSessionCodexConfig(sqlite: SqliteDatabase): void {
  const columns = new Set(
    (sqlite.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((row) => row.name)
  );
  const removedColumns = [
    "permission_mode",
    "model",
    "model_provider",
    "reasoning_effort",
    "service_tier_override"
  ];
  if (!removedColumns.some((column) => columns.has(column))) {
    return;
  }

  sqlite.exec(`
    DROP INDEX IF EXISTS sessions_chat_idx;
    DROP INDEX IF EXISTS sessions_section_idx;
    ALTER TABLE sessions RENAME TO sessions_before_codex_config_removal;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      path_key TEXT NOT NULL,
      current_cwd TEXT,
      display_name TEXT,
      batch_decision_message_id TEXT,
      section_id TEXT,
      latest_activity_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO sessions (
      id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
      batch_decision_message_id, section_id, latest_activity_at, created_at, updated_at
    )
    SELECT
      id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
      batch_decision_message_id, section_id, latest_activity_at, created_at, updated_at
    FROM sessions_before_codex_config_removal;
    DROP TABLE sessions_before_codex_config_removal;
    CREATE INDEX IF NOT EXISTS sessions_chat_idx
      ON sessions (telegram_chat_id, latest_activity_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_section_idx
      ON sessions (section_id, latest_activity_at DESC);
  `);
}

function migrateRemoveSections(sqlite: SqliteDatabase): void {
  const tableNames = new Set(
    (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  const columns = new Set(
    (sqlite.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((row) => row.name)
  );

  if (tableNames.has("sections") && columns.has("section_id")) {
    sqlite.exec(`
      UPDATE sessions
      SET display_name = COALESCE(
        (SELECT NULLIF(TRIM(sec.name), '') FROM sections sec WHERE sec.id = sessions.section_id),
        display_name
      )
      WHERE section_id IS NOT NULL;
    `);
  }

  if (columns.has("section_id")) {
    sqlite.exec(`
      DROP INDEX IF EXISTS sessions_chat_idx;
      DROP INDEX IF EXISTS sessions_section_idx;
      ALTER TABLE sessions RENAME TO sessions_before_section_removal;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        telegram_chat_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        path_key TEXT NOT NULL,
        current_cwd TEXT,
        display_name TEXT,
        batch_decision_message_id TEXT,
        codex_archived_at INTEGER,
        latest_activity_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions (
        id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
        batch_decision_message_id, codex_archived_at, latest_activity_at, created_at, updated_at
      )
      SELECT
        id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
        batch_decision_message_id, codex_archived_at, latest_activity_at, created_at, updated_at
      FROM sessions_before_section_removal;
      DROP TABLE sessions_before_section_removal;
      CREATE INDEX IF NOT EXISTS sessions_chat_idx
        ON sessions (telegram_chat_id, latest_activity_at DESC);
    `);
  }

  sqlite.exec(`
    DROP INDEX IF EXISTS sections_chat_directory_idx;
    DROP INDEX IF EXISTS sections_active_session_idx;
    DROP TABLE IF EXISTS sections;
  `);
}

function migrateSharedSessionBindings(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_bindings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      bot_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      channel_id TEXT,
      thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (session_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS session_bindings_source_idx
      ON session_bindings (source_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS session_bindings_session_idx
      ON session_bindings (session_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS session_leases (
      session_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      owner_binding_id TEXT,
      pending_binding_id TEXT,
      owner_turn_id TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  const tableNames = new Set(
    (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  if (!tableNames.has("sessions")) {
    return;
  }

  sqlite.exec(`DROP INDEX IF EXISTS sessions_codex_thread_idx`);

  const legacySessions = sqlite.prepare(`
    SELECT id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
      batch_decision_message_id, codex_archived_at, latest_activity_at, created_at, updated_at
    FROM sessions
    ORDER BY codex_thread_id, latest_activity_at DESC, updated_at DESC, id
  `).all() as Array<{
    id: string;
    telegram_chat_id: string;
    codex_thread_id: string;
    path_key: string;
    current_cwd: string | null;
    display_name: string | null;
    batch_decision_message_id: string | null;
    codex_archived_at: number | null;
    latest_activity_at: number;
    created_at: number;
    updated_at: number;
  }>;

  const groups = new Map<string, typeof legacySessions>();
  for (const session of legacySessions) {
    const group = groups.get(session.codex_thread_id) ?? [];
    group.push(session);
    groups.set(session.codex_thread_id, group);
  }

  const canonicalSessionByLegacyId = new Map<string, string>();
  const updateReferences = sqlite.transaction((group: typeof legacySessions, keeper: typeof legacySessions[number]) => {
    const duplicateIds = group.filter((session) => session.id !== keeper.id).map((session) => session.id);
    for (const duplicateId of duplicateIds) {
      if (tableNames.has("chats")) {
        sqlite.prepare("UPDATE chats SET active_session_id = ? WHERE active_session_id = ?").run(keeper.id, duplicateId);
      }
      if (tableNames.has("messages")) {
        sqlite.prepare("UPDATE messages SET session_id = ? WHERE session_id = ?").run(keeper.id, duplicateId);
      }
      if (tableNames.has("decisions")) {
        sqlite.prepare("UPDATE decisions SET session_id = ? WHERE session_id = ?").run(keeper.id, duplicateId);
      }
      if (tableNames.has("queued_submissions")) {
        sqlite.prepare("UPDATE queued_submissions SET session_id = ? WHERE session_id = ?").run(keeper.id, duplicateId);
      }
      sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(duplicateId);
    }

    const createdAt = Math.min(...group.map((session) => session.created_at));
    const latestActivityAt = Math.max(...group.map((session) => session.latest_activity_at));
    const updatedAt = Math.max(...group.map((session) => session.updated_at));
    const firstNonEmpty = <T>(values: Array<T | null>): T | null =>
      values.find((value) => value !== null && (typeof value !== "string" || value.trim() !== "")) ?? null;
    const currentCwd = firstNonEmpty(group.map((session) => session.current_cwd));
    const displayName = firstNonEmpty(group.map((session) => session.display_name));
    const batchDecisionMessageId = firstNonEmpty(group.map((session) => session.batch_decision_message_id));
    const archivedAt = group.reduce<number | null>((latest, session) => {
      if (session.codex_archived_at === null) return latest;
      return latest === null ? session.codex_archived_at : Math.max(latest, session.codex_archived_at);
    }, null);
    sqlite.prepare(`
      UPDATE sessions
      SET path_key = ?, current_cwd = ?, display_name = ?, batch_decision_message_id = ?,
        codex_archived_at = ?, latest_activity_at = ?, created_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      keeper.path_key,
      currentCwd,
      displayName,
      batchDecisionMessageId,
      archivedAt,
      latestActivityAt,
      createdAt,
      updatedAt,
      keeper.id
    );
    for (const session of group) canonicalSessionByLegacyId.set(session.id, keeper.id);
  });

  for (const group of groups.values()) {
    updateReferences.immediate(group, group[0]!);
  }

  const sourceBindingIdBySessionAndSource = new Map<string, string>();
  const insertBinding = sqlite.prepare(`
    INSERT OR IGNORE INTO session_bindings (
      id, session_id, platform, bot_key, source_id, channel_id, thread_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bindingSource = (sourceId: string): { platform: string; botKey: string; channelId: string | null; threadId: string | null } => {
    const match = /^slack:([^:]+):([^:]+)(?::(.+))?$/.exec(sourceId);
    if (!match) return { platform: "telegram", botKey: "telegram", channelId: null, threadId: null };
    return { platform: "slack", botKey: "slack", channelId: match[2]!, threadId: match[3] ?? null };
  };
  for (const legacySession of legacySessions) {
    const sessionId = canonicalSessionByLegacyId.get(legacySession.id);
    if (!sessionId) continue;
    const sourceId = legacySession.telegram_chat_id;
    const key = `${sessionId}\u0000${sourceId}`;
    if (sourceBindingIdBySessionAndSource.has(key)) continue;
    const binding = bindingSource(sourceId);
    const id = `binding_${crypto.randomUUID()}`;
    const timestamp = now();
    insertBinding.run(id, sessionId, binding.platform, binding.botKey, sourceId, binding.channelId, binding.threadId, timestamp, timestamp);
    const row = sqlite.prepare("SELECT id FROM session_bindings WHERE session_id = ? AND source_id = ?").get(sessionId, sourceId) as { id: string };
    sourceBindingIdBySessionAndSource.set(key, row.id);
  }

  const sessionIds = sqlite.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
  const leaseTimestamp = now();
  const insertLease = sqlite.prepare(`
    INSERT OR IGNORE INTO session_leases (
      session_id, state, owner_binding_id, pending_binding_id, owner_turn_id, version, updated_at
    ) VALUES (?, 'unbound', NULL, NULL, NULL, 0, ?)
  `);
  for (const session of sessionIds) insertLease.run(session.id, leaseTimestamp);

  if (!tableNames.has("chats")) {
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS sessions_codex_thread_idx ON sessions (codex_thread_id)`);
    return;
  }

  const activeChats = sqlite.prepare(`
    SELECT telegram_chat_id, active_session_id, updated_at
    FROM chats
    WHERE active_session_id IS NOT NULL
    ORDER BY updated_at DESC, telegram_chat_id
  `).all() as Array<{ telegram_chat_id: string; active_session_id: string; updated_at: number }>;
  const claimedSessions = new Set<string>();
  const updateLease = sqlite.prepare(`
    UPDATE session_leases
    SET state = 'active', owner_binding_id = ?, pending_binding_id = NULL, owner_turn_id = NULL,
      version = version + 1, updated_at = ?
    WHERE session_id = ? AND state = 'unbound'
  `);
  for (const chat of activeChats) {
    if (claimedSessions.has(chat.active_session_id)) continue;
    const binding = sqlite.prepare(`
      SELECT id FROM session_bindings WHERE session_id = ? AND source_id = ?
    `).get(chat.active_session_id, chat.telegram_chat_id) as { id: string } | undefined;
    if (!binding) continue;
    updateLease.run(binding.id, chat.updated_at, chat.active_session_id);
    claimedSessions.add(chat.active_session_id);
    sqlite.prepare("UPDATE sessions SET telegram_chat_id = ?, updated_at = ? WHERE id = ?")
      .run(chat.telegram_chat_id, chat.updated_at, chat.active_session_id);
  }

  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS sessions_codex_thread_idx ON sessions (codex_thread_id)`);

}

function migrateDurableTurnRoutes(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS turn_routes (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      binding_id TEXT,
      source_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_routes_thread_state_idx
      ON turn_routes (codex_thread_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS turn_routes_session_idx
      ON turn_routes (session_id, updated_at DESC);
  `);
}

function migrateDurableProgressPhaseMessages(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS progress_phase_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      phase_seq INTEGER NOT NULL,
      phase_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      text TEXT NOT NULL,
      update_count INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (codex_thread_id, turn_id, phase_seq)
    );
    CREATE INDEX IF NOT EXISTS progress_phase_messages_thread_state_idx
      ON progress_phase_messages (codex_thread_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS progress_phase_messages_session_idx
      ON progress_phase_messages (session_id, updated_at DESC);
  `);
}
