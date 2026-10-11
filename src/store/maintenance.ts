import type { SqliteDatabase } from "./migrations.js";
import { SCHEMA_MIGRATIONS } from "./migrations.js";

export interface DatabaseCheckResult {
  ok: boolean;
  integrity: string;
  appliedMigrations: string[];
  missingMigrations: string[];
  missingTables: string[];
  missingColumns: string[];
  chatsWithDanglingActiveSession: number | null;
  chatsWithCrossChatActiveSession: number | null;
}

export interface DatabaseResetStateResult {
  deletedRows: Record<string, number>;
  dryRun: boolean;
  integrity: string;
}

export interface SlackSessionDedupeCandidate {
  chatId: string;
  codexThreadId: string;
  currentCwd: string | null;
  decisionCount: number;
  isActive: boolean;
  isRootChat: boolean;
  latestActivityAt: number;
  messageCount: number;
  sessionId: string;
  updatedAt: number;
}

export interface SlackSessionDedupeGroup {
  codexThreadId: string;
  deleteSessionIds: string[];
  keepSessionId: string;
  rootChatId: string;
  sessions: SlackSessionDedupeCandidate[];
}

export interface SlackSessionDedupeResult {
  deletedRows: Record<"chats" | "decisions" | "messages" | "sessions", number>;
  dryRun: boolean;
  duplicateGroups: SlackSessionDedupeGroup[];
  integrity: string;
}

function now(): number {
  return Date.now();
}

function getSlackRootChatId(chatId: string): string | null {
  const match = /^slack:([^:]+):([^:]+)(?::.+)?$/.exec(chatId);
  return match ? `slack:${match[1]}:${match[2]}` : null;
}

export function resetState(sqlite: SqliteDatabase, options: { dryRun?: boolean } = {}): DatabaseResetStateResult {
  const tableNames = new Set(
    (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  const tables = [
    "progress_phase_messages",
    "turn_routes",
    "session_leases",
    "session_bindings",
    "queued_submissions",
    "messages",
    "decisions",
    "sessions",
    "chats",
    "callback_contexts",
    "discovered_sessions"
  ].filter((table) => tableNames.has(table));
  const deletedRows: Record<string, number> = {};
  const dryRun = options.dryRun ?? false;
  const reset = sqlite.transaction(() => {
    for (const table of tables) {
      if (dryRun) {
        deletedRows[table] = (sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
        continue;
      }
      deletedRows[table] = sqlite.prepare(`DELETE FROM ${table}`).run().changes;
    }
  });
  reset.immediate();

  const integrity = sqlite.pragma("integrity_check", { simple: true }) as string;
  if (integrity !== "ok") {
    throw new Error(`Database integrity check failed after reset: ${integrity}`);
  }
  return { deletedRows, dryRun, integrity };
}

export function dedupeSlackSessions(
  sqlite: SqliteDatabase,
  options: { dryRun?: boolean } = {}
): SlackSessionDedupeResult {
  const dryRun = options.dryRun ?? true;
  const rows = sqlite.prepare(`
    SELECT
      s.id AS session_id,
      s.telegram_chat_id AS chat_id,
      s.codex_thread_id,
      s.current_cwd,
      s.latest_activity_at,
      s.updated_at,
      EXISTS (
        SELECT 1 FROM chats c
        WHERE c.telegram_chat_id = s.telegram_chat_id AND c.active_session_id = s.id
      ) AS is_active,
      (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT count(*) FROM decisions d WHERE d.session_id = s.id) AS decision_count
    FROM sessions s
    WHERE s.telegram_chat_id LIKE 'slack:%' AND s.codex_thread_id IS NOT NULL
    ORDER BY s.codex_thread_id ASC, s.latest_activity_at DESC
  `).all() as Array<{
    session_id: string;
    chat_id: string;
    codex_thread_id: string;
    current_cwd: string | null;
    latest_activity_at: number;
    updated_at: number;
    is_active: 0 | 1;
    message_count: number;
    decision_count: number;
  }>;

  const grouped = new Map<string, SlackSessionDedupeCandidate[]>();
  for (const row of rows) {
    const rootChatId = getSlackRootChatId(row.chat_id);
    if (!rootChatId) continue;
    const candidate: SlackSessionDedupeCandidate = {
      chatId: row.chat_id,
      codexThreadId: row.codex_thread_id,
      currentCwd: row.current_cwd,
      decisionCount: row.decision_count,
      isActive: Boolean(row.is_active),
      isRootChat: row.chat_id === rootChatId,
      latestActivityAt: row.latest_activity_at,
      messageCount: row.message_count,
      sessionId: row.session_id,
      updatedAt: row.updated_at
    };
    const key = `${rootChatId}\u0000${row.codex_thread_id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const duplicateGroups = [...grouped.entries()]
    .flatMap(([, sessions]) => {
      if (sessions.length < 2) return [];
      const firstSession = sessions[0];
      if (!firstSession) return [];
      const rootChatId = getSlackRootChatId(firstSession.chatId);
      if (!rootChatId) return [];
      const sorted = [...sessions].sort((left, right) =>
        Number(right.isActive) - Number(left.isActive) ||
        right.messageCount - left.messageCount ||
        right.decisionCount - left.decisionCount ||
        right.latestActivityAt - left.latestActivityAt ||
        right.updatedAt - left.updatedAt ||
        Number(right.isRootChat) - Number(left.isRootChat) ||
        left.sessionId.localeCompare(right.sessionId)
      );
      const keepSession = sorted[0];
      if (!keepSession) return [];
      return [{
        codexThreadId: keepSession.codexThreadId,
        deleteSessionIds: sorted.slice(1).map((session) => session.sessionId),
        keepSessionId: keepSession.sessionId,
        rootChatId,
        sessions: sorted
      } satisfies SlackSessionDedupeGroup];
    })
    .sort((left, right) =>
      left.rootChatId.localeCompare(right.rootChatId) ||
      left.codexThreadId.localeCompare(right.codexThreadId)
    );

  const deleteSessionIds = duplicateGroups.flatMap((group) => group.deleteSessionIds);
  const deletedRows: SlackSessionDedupeResult["deletedRows"] = {
    chats: 0, decisions: 0, messages: 0, sessions: 0
  };

  if (deleteSessionIds.length > 0) {
    const placeholders = deleteSessionIds.map(() => "?").join(", ");
    deletedRows.messages = (sqlite.prepare(`SELECT count(*) AS count FROM messages WHERE session_id IN (${placeholders})`).get(...deleteSessionIds) as { count: number }).count;
    deletedRows.decisions = (sqlite.prepare(`SELECT count(*) AS count FROM decisions WHERE session_id IN (${placeholders})`).get(...deleteSessionIds) as { count: number }).count;
    deletedRows.sessions = deleteSessionIds.length;
    deletedRows.chats = (sqlite.prepare(`
      SELECT count(*) AS count FROM chats c
      WHERE c.telegram_chat_id LIKE 'slack:%'
        AND (c.active_session_id IS NULL OR c.active_session_id IN (${placeholders}))
        AND NOT EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.telegram_chat_id = c.telegram_chat_id AND s.id NOT IN (${placeholders})
        )
    `).get(...deleteSessionIds, ...deleteSessionIds) as { count: number }).count;

    if (!dryRun) {
      const apply = sqlite.transaction(() => {
        sqlite.prepare(`UPDATE chats SET active_session_id = NULL, updated_at = ? WHERE active_session_id IN (${placeholders})`).run(now(), ...deleteSessionIds);
        sqlite.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...deleteSessionIds);
        sqlite.prepare(`DELETE FROM decisions WHERE session_id IN (${placeholders})`).run(...deleteSessionIds);
        sqlite.prepare(`DELETE FROM queued_submissions WHERE session_id IN (${placeholders})`).run(...deleteSessionIds);
        sqlite.prepare(`DELETE FROM progress_phase_messages WHERE session_id IN (${placeholders})`).run(...deleteSessionIds);
        sqlite.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...deleteSessionIds);
        sqlite.prepare(`
          DELETE FROM chats
          WHERE telegram_chat_id LIKE 'slack:%' AND active_session_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.telegram_chat_id = chats.telegram_chat_id)
        `).run();
      });
      apply.immediate();
    }
  }

  const integrity = sqlite.pragma("integrity_check", { simple: true }) as string;
  if (integrity !== "ok") {
    throw new Error(`Database integrity check failed after Slack session dedupe: ${integrity}`);
  }
  return { deletedRows, dryRun, duplicateGroups, integrity };
}

export function checkDatabase(sqlite: SqliteDatabase): DatabaseCheckResult {
  const tableNames = new Set(
    (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  const requiredTables = ["schema_migrations", "chats", "sessions", "messages", "decisions", "queued_submissions", "progress_phase_messages", "web_directories"];
  const missingTables = requiredTables.filter((name) => !tableNames.has(name));
  const sessionColumns = tableNames.has("sessions")
    ? new Set((sqlite.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((row) => row.name))
    : new Set<string>();
  const missingColumns = tableNames.has("sessions")
    ? [
      !sessionColumns.has("codex_archived_at") ? "sessions.codex_archived_at" : null,
      null
    ].filter((value): value is string => Boolean(value))
    : [];
  const hasCoreTables = tableNames.has("sessions") && tableNames.has("chats") && missingColumns.length === 0;
  const appliedMigrations = tableNames.has("schema_migrations")
    ? (sqlite.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as Array<{ version: string }>).map((row) => row.version)
    : [];
  const missingMigrations = SCHEMA_MIGRATIONS.filter((version) => !appliedMigrations.includes(version));
  const count = (sql: string): number | null => hasCoreTables
    ? (sqlite.prepare(sql).get() as { count: number }).count
    : null;
  const hasSessionBindings = tableNames.has("session_bindings");
  const result: DatabaseCheckResult = {
    ok: false,
    integrity: sqlite.pragma("integrity_check", { simple: true }) as string,
    appliedMigrations,
    missingMigrations,
    missingTables,
    missingColumns,
    chatsWithDanglingActiveSession: count(`SELECT count(*) AS count FROM chats c LEFT JOIN sessions s ON s.id = c.active_session_id WHERE c.active_session_id IS NOT NULL AND s.id IS NULL`),
    chatsWithCrossChatActiveSession: count(hasSessionBindings
      ? `SELECT count(*) AS count
         FROM chats c JOIN sessions s ON s.id = c.active_session_id
         WHERE c.telegram_chat_id != s.telegram_chat_id
           AND NOT EXISTS (
             SELECT 1 FROM session_bindings b
             WHERE b.session_id = s.id AND b.source_id = c.telegram_chat_id
           )`
      : `SELECT count(*) AS count
         FROM chats c JOIN sessions s ON s.id = c.active_session_id
         WHERE c.telegram_chat_id != s.telegram_chat_id`)
  };
  result.ok = result.integrity === "ok" && result.missingTables.length === 0 && result.missingColumns.length === 0 && result.missingMigrations.length === 0 && [
    result.chatsWithDanglingActiveSession,
    result.chatsWithCrossChatActiveSession
  ].every((value) => value === 0);
  return result;
}
