import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const schemaMigrationsTable = sqliteTable("schema_migrations", {
  version: text("version").primaryKey(),
  appliedAt: integer("applied_at").notNull()
});

export const chatsTable = sqliteTable("chats", {
  telegramChatId: text("telegram_chat_id").primaryKey(),
  activeSessionId: text("active_session_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const sessionsTable = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  telegramChatId: text("telegram_chat_id").notNull(),
  codexThreadId: text("codex_thread_id").notNull(),
  pathKey: text("path_key").notNull(),
  currentCwd: text("current_cwd"),
  displayName: text("display_name"),
  batchDecisionMessageId: text("batch_decision_message_id"),
  codexArchivedAt: integer("codex_archived_at"),
  latestActivityAt: integer("latest_activity_at").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  discoveryMissingSince: integer("discovery_missing_since"),
  discoveryMissingCount: integer("discovery_missing_count").notNull().default(0),
  lastDiscoveredAt: integer("last_discovered_at").notNull().default(0)
});

export const messagesTable = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  text: text("text").notNull(),
  codexTurnId: text("codex_turn_id"),
  telegramMessageId: text("telegram_message_id"),
  createdAt: integer("created_at").notNull()
});

export const decisionsTable = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  telegramChatId: text("telegram_chat_id").notNull(),
  approvalId: text("approval_id").notNull(),
  kind: text("kind"),
  title: text("title").notNull(),
  summary: text("summary"),
  requiresUserInput: integer("requires_user_input").notNull(),
  state: text("state").notNull(),
  telegramMessageId: text("telegram_message_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const queuedSubmissionsTable = sqliteTable("queued_submissions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  telegramChatId: text("telegram_chat_id").notNull(),
  codexThreadId: text("codex_thread_id").notNull(),
  codexQueueId: text("codex_queue_id"),
  clientUserMessageId: text("client_user_message_id").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  summary: text("summary").notNull(),
  attachmentPaths: text("attachment_paths", { mode: "json" }).$type<string[]>().notNull(),
  state: text("state").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const sessionBindingsTable = sqliteTable("session_bindings", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  platform: text("platform").notNull(),
  botKey: text("bot_key").notNull(),
  sourceId: text("source_id").notNull(),
  channelId: text("channel_id"),
  threadId: text("thread_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const sessionLeasesTable = sqliteTable("session_leases", {
  sessionId: text("session_id").primaryKey(),
  state: text("state").notNull(),
  ownerBindingId: text("owner_binding_id"),
  pendingBindingId: text("pending_binding_id"),
  ownerTurnId: text("owner_turn_id"),
  version: integer("version").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const turnRoutesTable = sqliteTable("turn_routes", {
  turnId: text("turn_id").primaryKey(),
  sessionId: text("session_id").notNull(),
  codexThreadId: text("codex_thread_id").notNull(),
  bindingId: text("binding_id"),
  sourceId: text("source_id").notNull(),
  state: text("state").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const progressPhaseMessagesTable = sqliteTable("progress_phase_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  codexThreadId: text("codex_thread_id").notNull(),
  turnId: text("turn_id").notNull(),
  phaseSeq: integer("phase_seq").notNull(),
  phaseKind: text("phase_kind").notNull(),
  sourceId: text("source_id").notNull(),
  platformMessageId: text("platform_message_id").notNull(),
  directory: text("directory").notNull(),
  text: text("text").notNull(),
  aggregateJson: text("aggregate_json").notNull().default("{}"),
  updateCount: integer("update_count").notNull(),
  state: text("state").notNull(),
  failureReason: text("failure_reason"),
  deliveryState: text("delivery_state").notNull().default("synced"),
  correctionMessageId: text("correction_message_id"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  updatedAt: integer("updated_at").notNull()
});

export const webDirectoriesTable = sqliteTable("web_directories", {
  directory: text("directory").primaryKey(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});
