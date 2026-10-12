import crypto from "node:crypto";

import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { chatsTable, sessionsTable } from "./schema.js";
import { parseSourceAddress } from "../shared/source-address.js";
import { recordSessionSelection } from "./session-selection.js";
import type { SessionRecord } from "../shared/types.js";

function now(): number {
  return Date.now();
}

function escapeSqlLike(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

function slackChannelSourceScope(sourceId: string): string | null {
  const match = /^slack:([^:]+):([^:]+)(?::.+)?$/.exec(sourceId);
  return match ? `slack:${match[1]}:${match[2]}` : null;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function asSessionRecord(row: {
  id: string;
  telegramChatId: string;
  codexThreadId: string;
  pathKey: string;
  currentCwd: string | null;
  displayName: string | null;
  batchDecisionMessageId: string | null;
  codexArchivedAt: number | null;
  latestActivityAt: number;
  createdAt: number;
  discoveryMissingSince: number | null;
  discoveryMissingCount: number;
  lastDiscoveredAt: number;
}): SessionRecord {
  return {
    id: row.id,
    telegramChatId: row.telegramChatId,
    codexThreadId: row.codexThreadId,
    pathKey: row.pathKey,
    currentCwd: row.currentCwd,
    displayName: row.displayName,
    batchDecisionMessageId: row.batchDecisionMessageId,
    codexArchivedAt: row.codexArchivedAt,
    latestActivityAt: row.latestActivityAt,
    createdAt: row.createdAt,
    discoveryMissingSince: row.discoveryMissingSince,
    discoveryMissingCount: row.discoveryMissingCount,
    lastDiscoveredAt: row.lastDiscoveredAt
  };
}

function asSessionRecordFromSql(row: {
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
  discovery_missing_since?: number | null;
  discovery_missing_count?: number;
  last_discovered_at?: number;
}): SessionRecord {
  return asSessionRecord({
    id: row.id,
    telegramChatId: row.telegram_chat_id,
    codexThreadId: row.codex_thread_id,
    pathKey: row.path_key,
    currentCwd: row.current_cwd,
    displayName: row.display_name,
    batchDecisionMessageId: row.batch_decision_message_id,
    codexArchivedAt: row.codex_archived_at,
    latestActivityAt: row.latest_activity_at,
    createdAt: row.created_at,
    discoveryMissingSince: row.discovery_missing_since ?? null,
    discoveryMissingCount: row.discovery_missing_count ?? 0,
    lastDiscoveredAt: row.last_discovered_at ?? row.latest_activity_at
  });
}

export class SessionRepository {
  constructor(
    private readonly sqlite: InstanceType<typeof Database>,
    private readonly db: ReturnType<typeof drizzle>
  ) {}

  async ensureSeedChats(telegramChatIds: Iterable<string>): Promise<void> {
    for (const telegramChatId of telegramChatIds) await this.ensureChat(telegramChatId);
  }

  async upsertDiscoveredSession(input: {
    telegramChatId: string;
    codexThreadId: string;
    pathKey: string;
    currentCwd?: string | null;
    displayName?: string | null;
    latestActivityAt?: number | null;
    createdAt?: number | null;
    codexArchivedAt?: number | null;
  }): Promise<SessionRecord> {
    // Reject reserved malformed source IDs before writing the chat or session.
    parseSourceAddress(input.telegramChatId);
    await this.ensureChat(input.telegramChatId);
    const existing = await this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.codexThreadId, input.codexThreadId))
      .get();
    const timestamp = input.latestActivityAt ?? now();
    const discoveredAt = now();

    if (existing) {
      const latestActivityAt = Math.max(existing.latestActivityAt, timestamp);
      await this.db
        .update(sessionsTable)
        .set({
          pathKey: input.pathKey,
          currentCwd: input.currentCwd ?? existing.currentCwd,
          displayName: input.displayName ?? existing.displayName,
          codexArchivedAt: input.codexArchivedAt ?? null,
          latestActivityAt,
          createdAt: input.createdAt ?? existing.createdAt,
          discoveryMissingSince: null,
          discoveryMissingCount: 0,
          lastDiscoveredAt: discoveredAt,
          updatedAt: now()
      })
        .where(eq(sessionsTable.id, existing.id))
        .run();
      this.ensureLegacyBinding(existing.id, input.telegramChatId);
      return (await this.getById(existing.id)) as SessionRecord;
    }

    const sessionId = createId("session");
    const createdAt = input.createdAt ?? now();
    this.sqlite.prepare(`
        INSERT INTO sessions (
          id, telegram_chat_id, codex_thread_id, path_key, current_cwd, display_name,
          batch_decision_message_id, codex_archived_at,
          latest_activity_at, created_at, updated_at,
          discovery_missing_since, discovery_missing_count, last_discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?)
      `).run(
        sessionId,
        input.telegramChatId,
        input.codexThreadId,
        input.pathKey,
        input.currentCwd ?? null,
        input.displayName ?? null,
        input.codexArchivedAt ?? null,
        timestamp,
        createdAt,
        createdAt,
        discoveredAt
      );
    this.ensureLegacyBinding(sessionId, input.telegramChatId);
    return (await this.getById(sessionId)) as SessionRecord;
  }

  private ensureLegacyBinding(sessionId: string, sourceId: string): void {
    const { platform, botKey, channelId, threadId } = parseSourceAddress(sourceId);
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO session_bindings (
        id, session_id, platform, bot_key, source_id, channel_id, thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createId("binding"), sessionId, platform, botKey, sourceId, channelId, threadId, timestamp, timestamp);
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO session_leases (
        session_id, state, owner_binding_id, pending_binding_id, owner_turn_id, version, updated_at
      ) VALUES (?, 'unbound', NULL, NULL, NULL, 0, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state = CASE WHEN session_leases.state = 'archived' THEN 'unbound' ELSE session_leases.state END,
        owner_binding_id = CASE WHEN session_leases.state = 'archived' THEN NULL ELSE session_leases.owner_binding_id END,
        pending_binding_id = CASE WHEN session_leases.state = 'archived' THEN NULL ELSE session_leases.pending_binding_id END,
        owner_turn_id = CASE WHEN session_leases.state = 'archived' THEN NULL ELSE session_leases.owner_turn_id END,
        version = CASE WHEN session_leases.state = 'archived' THEN session_leases.version + 1 ELSE session_leases.version END,
        updated_at = excluded.updated_at
    `).run(sessionId, timestamp);
  }

  async ensureChat(telegramChatId: string): Promise<void> {
    const existing = await this.db
      .select()
      .from(chatsTable)
      .where(eq(chatsTable.telegramChatId, telegramChatId))
      .get();
    if (existing) return;
    const timestamp = now();
    await this.db.insert(chatsTable).values({
      telegramChatId,
      activeSessionId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }).run();
  }

  async listChatIds(): Promise<string[]> {
    const rows = await this.db
      .select({ telegramChatId: chatsTable.telegramChatId })
      .from(chatsTable)
      .all();
    return rows.map((row) => row.telegramChatId);
  }

  async listKnownSessions(telegramChatId: string, options: { includeArchived?: boolean } = {}): Promise<SessionRecord[]> {
    const includeArchivedLegacy = options.includeArchived === true;
    const slackChannelScope = slackChannelSourceScope(telegramChatId);
    const bindingPredicate = slackChannelScope
      ? "(b.source_id = ? OR b.source_id LIKE ? ESCAPE '\\')"
      : "b.source_id = ?";
    const legacyPredicate = slackChannelScope
      ? "(s.telegram_chat_id = ? OR s.telegram_chat_id LIKE ? ESCAPE '\\')"
      : "s.telegram_chat_id = ?";
    const bindingParameters = slackChannelScope
      ? [telegramChatId, `${escapeSqlLike(slackChannelScope)}:%`]
      : [telegramChatId];
    const legacyParameters = slackChannelScope
      ? [telegramChatId, `${escapeSqlLike(slackChannelScope)}:%`]
      : [telegramChatId];
    const sessions = (this.sqlite.prepare(`
      SELECT s.*
      FROM sessions s
      LEFT JOIN session_bindings b
        ON b.session_id = s.id AND ${bindingPredicate}
      WHERE b.id IS NOT NULL
        ${includeArchivedLegacy ? `OR (s.codex_archived_at IS NOT NULL AND ${legacyPredicate})` : ""}
      ORDER BY s.latest_activity_at DESC
    `).all(...(includeArchivedLegacy ? [...bindingParameters, ...legacyParameters] : bindingParameters)) as Array<Parameters<typeof asSessionRecordFromSql>[0]>).map(asSessionRecordFromSql);
    return this.takeUniqueSessions(options.includeArchived ? sessions : sessions.filter((session) => session.codexArchivedAt === null));
  }

  async listSessionsForPolling(options: { includeArchived?: boolean } = {}): Promise<SessionRecord[]> {
    const sessions = this.db
      .select()
      .from(sessionsTable)
      .orderBy(desc(sessionsTable.latestActivityAt))
      .all()
      .map(asSessionRecord);
    return this.takeUniqueSessions(options.includeArchived ? sessions : sessions.filter((session) => session.codexArchivedAt === null));
  }

  async listVisibleSessions(telegramChatId: string): Promise<SessionRecord[]> {
    const rows = this.sqlite
      .prepare(`
        SELECT s.*
        FROM sessions s
        LEFT JOIN chats c ON c.telegram_chat_id = ?
        LEFT JOIN session_bindings b ON b.session_id = s.id AND b.source_id = ?
        WHERE b.id IS NOT NULL
          AND s.codex_archived_at IS NULL
          AND (
            c.active_session_id = s.id
            OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
            OR EXISTS (SELECT 1 FROM decisions d WHERE d.session_id = s.id)
          )
        ORDER BY s.latest_activity_at DESC
      `)
      .all(telegramChatId, telegramChatId) as Array<{
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
        discovery_missing_since?: number | null;
        discovery_missing_count?: number;
        last_discovered_at?: number;
      }>;
    return this.takeUniqueSessions(rows.map(asSessionRecordFromSql));
  }

  private takeUniqueSessions(sessions: SessionRecord[]): SessionRecord[] {
    const seenThreadIds = new Set<string>();
    return sessions.filter((session) => {
      if (seenThreadIds.has(session.codexThreadId)) return false;
      seenThreadIds.add(session.codexThreadId);
      return true;
    });
  }

  async getById(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).get();
    return row ? asSessionRecord(row) : null;
  }

  async getByThreadId(codexThreadId: string): Promise<SessionRecord | null> {
    const row = await this.db.select().from(sessionsTable).where(eq(sessionsTable.codexThreadId, codexThreadId)).get();
    return row ? asSessionRecord(row) : null;
  }

  async getByChatAndThreadId(telegramChatId: string, codexThreadId: string): Promise<SessionRecord | null> {
    const row = this.sqlite.prepare(`
      SELECT s.*
      FROM sessions s
      LEFT JOIN session_bindings b ON b.session_id = s.id AND b.source_id = ?
      WHERE s.codex_thread_id = ? AND b.id IS NOT NULL
      LIMIT 1
    `).get(telegramChatId, codexThreadId) as Parameters<typeof asSessionRecordFromSql>[0] | undefined;
    return row ? asSessionRecordFromSql(row) : null;
  }

  async markCodexArchived(sessionId: string, archivedAt = now()): Promise<SessionRecord> {
    const timestamp = now();
    const markArchived = this.sqlite.transaction(() => {
      this.sqlite.prepare(`UPDATE sessions SET codex_archived_at = ?, updated_at = ? WHERE id = ?`).run(archivedAt, timestamp, sessionId);
      this.sqlite.prepare(`UPDATE chats SET active_session_id = NULL, updated_at = ? WHERE active_session_id = ?`).run(timestamp, sessionId);
      this.sqlite.prepare(`DELETE FROM session_bindings WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'archived', owner_binding_id = NULL, pending_binding_id = NULL,
          owner_turn_id = NULL, version = version + 1, updated_at = ?
        WHERE session_id = ?
      `).run(timestamp, sessionId);
    });
    markArchived.immediate();
    const session = await this.getById(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  async markCodexUnarchived(sessionId: string): Promise<SessionRecord> {
    await this.db.update(sessionsTable).set({ codexArchivedAt: null, updatedAt: now() }).where(eq(sessionsTable.id, sessionId)).run();
    this.sqlite.prepare(`
      INSERT INTO session_leases (
        session_id, state, owner_binding_id, pending_binding_id, owner_turn_id, version, updated_at
      ) VALUES (?, 'unbound', NULL, NULL, NULL, 0, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        state = 'unbound', owner_binding_id = NULL, pending_binding_id = NULL,
        owner_turn_id = NULL, version = version + 1, updated_at = excluded.updated_at
    `).run(sessionId, now());
    const session = await this.getById(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const deleted = this.sqlite.transaction(() => {
      const exists = this.sqlite.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId);
      if (!exists) return false;
      const timestamp = now();
      this.sqlite.prepare(`UPDATE chats SET active_session_id = NULL, updated_at = ? WHERE active_session_id = ?`).run(timestamp, sessionId);
      this.sqlite.prepare(`DELETE FROM progress_phase_messages WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`DELETE FROM turn_routes WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`DELETE FROM session_bindings WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`DELETE FROM session_leases WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`DELETE FROM decisions WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`DELETE FROM queued_submissions WHERE session_id = ?`).run(sessionId);
      this.sqlite.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
      return true;
    }).immediate();
    return deleted;
  }

  async markDiscoveryMissing(sessionId: string, observedAt = now()): Promise<SessionRecord> {
    this.sqlite.prepare(`
      UPDATE sessions
      SET discovery_missing_since = COALESCE(discovery_missing_since, ?),
          discovery_missing_count = discovery_missing_count + 1,
          updated_at = ?
      WHERE id = ?
    `).run(observedAt, observedAt, sessionId);
    return (await this.getById(sessionId)) as SessionRecord;
  }

  async clearDiscoveryMissing(sessionId: string, discoveredAt = now()): Promise<SessionRecord> {
    this.sqlite.prepare(`
      UPDATE sessions
      SET discovery_missing_since = NULL,
          discovery_missing_count = 0,
          last_discovered_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(discoveredAt, discoveredAt, sessionId);
    return (await this.getById(sessionId)) as SessionRecord;
  }

  async getActiveSession(telegramChatId: string): Promise<SessionRecord | null> {
    const chat = await this.db.select().from(chatsTable).where(eq(chatsTable.telegramChatId, telegramChatId)).get();
    return chat?.activeSessionId ? this.getById(chat.activeSessionId) : null;
  }

  async getLatestActiveSessionForChatPrefix(chatIdPrefix: string): Promise<SessionRecord | null> {
    const row = this.sqlite.prepare(`
      SELECT s.*
      FROM chats c JOIN sessions s ON s.id = c.active_session_id
      WHERE c.telegram_chat_id LIKE ?
      ORDER BY c.updated_at DESC LIMIT 1
    `).get(`${chatIdPrefix}%`) ?? null;
    return row ? asSessionRecord(row as Parameters<typeof asSessionRecord>[0]) : null;
  }

  async setActiveSession(telegramChatId: string, sessionId: string): Promise<SessionRecord> {
    const session = await this.getById(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.telegramChatId !== telegramChatId) {
      const binding = this.sqlite.prepare(`
        SELECT 1 FROM session_bindings WHERE session_id = ? AND source_id = ?
      `).get(sessionId, telegramChatId);
      if (!binding) throw new Error(`Session does not belong to chat: ${sessionId}`);
    }
    await this.ensureChat(telegramChatId);
    await this.db.update(chatsTable).set({ activeSessionId: sessionId, updatedAt: now() }).where(eq(chatsTable.telegramChatId, telegramChatId)).run();
    return session;
  }

  async selectSession(telegramChatId: string, sessionId: string): Promise<SessionRecord> {
    // Keep the write synchronous so a slow activation cannot overwrite a newer selection.
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare("SELECT * FROM sessions WHERE id = ? AND codex_archived_at IS NULL")
        .get(sessionId) as Parameters<typeof asSessionRecordFromSql>[0] | undefined;
      if (!row) throw new Error(`Unknown or archived session: ${sessionId}`);
      this.ensureLegacyBinding(sessionId, telegramChatId);
      recordSessionSelection(this.sqlite, telegramChatId, sessionId);
      return asSessionRecordFromSql(row);
    }).immediate();
  }

  async clearActiveSession(telegramChatId: string, expectedSessionId?: string): Promise<void> {
    this.sqlite.prepare(`UPDATE chats SET active_session_id = NULL, updated_at = ?
      WHERE telegram_chat_id = ? AND (? IS NULL OR active_session_id = ?)`)
      .run(now(), telegramChatId, expectedSessionId ?? null, expectedSessionId ?? null);
  }

  async touchSession(sessionId: string): Promise<void> {
    const timestamp = now();
    await this.db.update(sessionsTable).set({ latestActivityAt: timestamp, updatedAt: timestamp }).where(eq(sessionsTable.id, sessionId)).run();
  }

  private async getUpdatedSession(sessionId: string): Promise<SessionRecord> {
    return (await this.getById(sessionId)) as SessionRecord;
  }

  async updateDisplayName(sessionId: string, displayName: string): Promise<SessionRecord> {
    await this.db.update(sessionsTable).set({ displayName, updatedAt: now() }).where(eq(sessionsTable.id, sessionId)).run();
    return this.getUpdatedSession(sessionId);
  }

  async updateCurrentCwd(sessionId: string, currentCwd: string | null): Promise<SessionRecord> {
    await this.db.update(sessionsTable).set({ currentCwd, updatedAt: now() }).where(eq(sessionsTable.id, sessionId)).run();
    return this.getUpdatedSession(sessionId);
  }

  async updateBatchDecisionMessageId(sessionId: string, batchDecisionMessageId: string | null): Promise<SessionRecord> {
    await this.db.update(sessionsTable).set({ batchDecisionMessageId, updatedAt: now() }).where(eq(sessionsTable.id, sessionId)).run();
    return this.getUpdatedSession(sessionId);
  }

  async updateThreadId(sessionId: string, codexThreadId: string): Promise<SessionRecord> {
    await this.db.update(sessionsTable).set({ codexThreadId, updatedAt: now() }).where(eq(sessionsTable.id, sessionId)).run();
    const session = await this.getById(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }
}
