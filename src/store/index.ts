import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { parseSourceAddress } from "../shared/source-address.js";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import {
  backupDatabase,
  createMigrationBackup,
  getMigrationPlan,
  migrate as migrateDatabase
} from "./migrations.js";
import type { DatabaseBackupResult, DatabaseMigrationPlan } from "./migrations.js";
export type { DatabaseBackupResult, DatabaseMigrationPlan, SchemaMigrationVersion } from "./migrations.js";
import {
  checkDatabase,
  dedupeSlackSessions,
  resetState
} from "./maintenance.js";
import type {
  DatabaseCheckResult,
  DatabaseResetStateResult,
  SlackSessionDedupeResult
} from "./maintenance.js";
export type {
  DatabaseCheckResult,
  DatabaseResetStateResult,
  SlackSessionDedupeCandidate,
  SlackSessionDedupeGroup,
  SlackSessionDedupeResult
} from "./maintenance.js";
import type {
  DecisionRecord,
  MessageRecord,
  SessionRecord
} from "../shared/types.js";
import { QueueRepository, type QueuedSubmissionRecord } from "./queue-repository.js";
export type { QueuedSubmissionRecord } from "./queue-repository.js";
import { DecisionRepository } from "./decision-repository.js";
import { MessageRepository } from "./message-repository.js";
import { SessionRepository } from "./session-repository.js";
import {
  SessionBindingRepository,
  type SessionHandoffResult,
  type SessionHandoffCancellation,
  type SessionOwnershipResult,
  type SessionReleaseResult
} from "./session-binding-repository.js";
export type { SessionHandoffResult, SessionHandoffCancellation, SessionOwnershipResult, SessionReleaseResult } from "./session-binding-repository.js";
import type {
  ProgressPhaseKind,
  ProgressPhaseAggregate,
  ProgressPhaseMessageRecord,
  ProgressPhaseState,
  SessionBindingRecord,
  SessionLeaseRecord,
  TurnRouteRecord,
  TurnRouteState
} from "../shared/types.js";
import { TurnRouteRepository } from "./turn-route-repository.js";
import { ProgressPhaseMessageRepository } from "./progress-phase-message-repository.js";
import { WebDirectoryRepository, type WebDirectoryRegistration } from "./web-directory-repository.js";
export type { WebDirectoryRegistration } from "./web-directory-repository.js";

function now(): number {
  return Date.now();
}

export interface BridgeStoreOptions {
  migrate?: boolean;
  readonly?: boolean;
  migrationBackupPath?: string;
}

export class BridgeStore {
  private sqlite: InstanceType<typeof Database>;
  private lastMigrationBackupPath: string | null = null;
  private lastMigrationBackupIntegrity: string | null = null;
  private readonly queueRepository: QueueRepository;
  private readonly decisionRepository: DecisionRepository;
  private readonly messageRepository: MessageRepository;
  private readonly sessionRepository: SessionRepository;
  private readonly sessionBindingRepository: SessionBindingRepository;
  private readonly turnRouteRepository: TurnRouteRepository;
  private readonly progressPhaseMessageRepository: ProgressPhaseMessageRepository;
  private readonly webDirectoryRepository: WebDirectoryRepository;
  readonly db: ReturnType<typeof drizzle>;

  constructor(filePath: string, options: BridgeStoreOptions = {}) {
    const readonly = options.readonly ?? false;
    const migrate = options.migrate ?? !readonly;
    if (readonly && migrate) {
      throw new Error("Cannot migrate a read-only BridgeStore");
    }
    if (!readonly) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.sqlite = new Database(filePath, readonly ? { readonly: true, fileMustExist: true } : undefined);
    if (!readonly) {
      this.sqlite.pragma("journal_mode = WAL");
    }
    this.db = drizzle(this.sqlite);
    this.queueRepository = new QueueRepository(this.sqlite, this.db);
    this.decisionRepository = new DecisionRepository(this.sqlite, this.db);
    this.sessionRepository = new SessionRepository(this.sqlite, this.db);
    this.sessionBindingRepository = new SessionBindingRepository(this.sqlite);
    this.turnRouteRepository = new TurnRouteRepository(this.sqlite);
    this.progressPhaseMessageRepository = new ProgressPhaseMessageRepository(this.sqlite);
    this.webDirectoryRepository = new WebDirectoryRepository(this.sqlite);
    this.messageRepository = new MessageRepository(
      this.sqlite,
      this.db,
      (sessionId) => this.sessionRepository.touchSession(sessionId)
    );
    if (migrate) {
      const migrationPlan = getMigrationPlan(this.sqlite);
      if (migrationPlan.backupRequired) {
        const backup = createMigrationBackup(
          this.sqlite,
          filePath,
          options.migrationBackupPath
        );
        this.lastMigrationBackupPath = backup.destinationPath;
        this.lastMigrationBackupIntegrity = backup.integrity;
      }
      migrateDatabase(this.sqlite);
    }
  }

  close(): void {
    this.sqlite.close();
  }

  getLastMigrationBackupPath(): string | null {
    return this.lastMigrationBackupPath;
  }

  getLastMigrationBackupIntegrity(): string | null {
    return this.lastMigrationBackupIntegrity;
  }

  getMigrationPlan(): DatabaseMigrationPlan {
    return getMigrationPlan(this.sqlite);
  }

  static async backupDatabase(sourcePath: string, destinationPath: string): Promise<DatabaseBackupResult> {
    return backupDatabase(sourcePath, destinationPath);
  }

  resetState(options: { dryRun?: boolean } = {}): DatabaseResetStateResult {
    return resetState(this.sqlite, options);
  }

  dedupeSlackSessions(options: { dryRun?: boolean } = {}): SlackSessionDedupeResult {
    return dedupeSlackSessions(this.sqlite, options);
  }

  checkDatabase(): DatabaseCheckResult {
    return checkDatabase(this.sqlite);
  }

  async createQueuedSubmission(input: Omit<QueuedSubmissionRecord, "id" | "createdAt" | "updatedAt">): Promise<QueuedSubmissionRecord> {
    return this.queueRepository.create(input);
  }

  async updateQueuedSubmission(id: string, patch: Partial<Pick<QueuedSubmissionRecord, "codexQueueId" | "state">>): Promise<void> {
    return this.queueRepository.update(id, patch);
  }

  async markQueuedSubmissionAccepted(id: string, codexQueueId: string): Promise<void> {
    return this.queueRepository.markAccepted(id, codexQueueId);
  }

  async getQueuedSubmission(id: string): Promise<QueuedSubmissionRecord | null> {
    return this.queueRepository.get(id);
  }

  async listPendingQueuedSubmissions(threadId: string): Promise<QueuedSubmissionRecord[]> {
    return this.queueRepository.listPending(threadId);
  }

  async countPendingQueuedSubmissions(threadId: string): Promise<number> {
    return this.queueRepository.countPending(threadId);
  }

  async startNextQueuedSubmission(threadId: string): Promise<QueuedSubmissionRecord | null> {
    return this.queueRepository.startNext(threadId);
  }

  async ensureSeedChats(telegramChatIds: Iterable<string>): Promise<void> {
    return this.sessionRepository.ensureSeedChats(telegramChatIds);
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
    return this.sessionRepository.upsertDiscoveredSession(input);
  }

  async ensureChat(telegramChatId: string): Promise<void> {
    return this.sessionRepository.ensureChat(telegramChatId);
  }

  async listChatIds(): Promise<string[]> {
    return this.sessionRepository.listChatIds();
  }

  async listKnownSessions(
    telegramChatId: string,
    options: { includeArchived?: boolean } = {}
  ): Promise<SessionRecord[]> {
    return this.sessionRepository.listKnownSessions(telegramChatId, options);
  }

  async listSessionsForPolling(options: { includeArchived?: boolean } = {}): Promise<SessionRecord[]> {
    return this.sessionRepository.listSessionsForPolling(options);
  }

  listWebDirectories(): string[] {
    return this.webDirectoryRepository.list();
  }

  registerWebDirectory(directory: string): WebDirectoryRegistration {
    return this.webDirectoryRepository.register(directory);
  }

  async listVisibleSessions(telegramChatId: string): Promise<SessionRecord[]> {
    return this.sessionRepository.listVisibleSessions(telegramChatId);
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessionRepository.getById(sessionId);
  }

  async getSessionByThreadId(codexThreadId: string): Promise<SessionRecord | null> {
    return this.sessionRepository.getByThreadId(codexThreadId);
  }

  async getSessionByChatAndThreadId(
    telegramChatId: string,
    codexThreadId: string
  ): Promise<SessionRecord | null> {
    return this.sessionRepository.getByChatAndThreadId(telegramChatId, codexThreadId);
  }

  async markSessionCodexArchived(sessionId: string, archivedAt = now()): Promise<SessionRecord> {
    return this.sessionRepository.markCodexArchived(sessionId, archivedAt);
  }

  async markSessionCodexUnarchived(sessionId: string): Promise<SessionRecord> {
    return this.sessionRepository.markCodexUnarchived(sessionId);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.sessionRepository.deleteSession(sessionId);
  }

  async markSessionDiscoveryMissing(sessionId: string, observedAt?: number): Promise<SessionRecord> {
    return this.sessionRepository.markDiscoveryMissing(sessionId, observedAt);
  }

  async clearSessionDiscoveryMissing(sessionId: string, discoveredAt?: number): Promise<SessionRecord> {
    return this.sessionRepository.clearDiscoveryMissing(sessionId, discoveredAt);
  }

  async getActiveSession(telegramChatId: string): Promise<SessionRecord | null> {
    return this.sessionRepository.getActiveSession(telegramChatId);
  }

  async getLatestActiveSessionForChatPrefix(chatIdPrefix: string): Promise<SessionRecord | null> {
    return this.sessionRepository.getLatestActiveSessionForChatPrefix(chatIdPrefix);
  }

  async setActiveSession(telegramChatId: string, sessionId: string): Promise<SessionRecord> {
    return this.sessionRepository.setActiveSession(telegramChatId, sessionId);
  }

  async selectSession(telegramChatId: string, sessionId: string): Promise<SessionRecord> {
    return this.sessionRepository.selectSession(telegramChatId, sessionId);
  }

  async clearActiveSession(telegramChatId: string): Promise<void> {
    return this.sessionRepository.clearActiveSession(telegramChatId);
  }

  async touchSession(sessionId: string): Promise<void> {
    return this.sessionRepository.touchSession(sessionId);
  }

  async updateSessionDisplayName(sessionId: string, displayName: string): Promise<SessionRecord> {
    return this.sessionRepository.updateDisplayName(sessionId, displayName);
  }

  async updateSessionCurrentCwd(
    sessionId: string,
    currentCwd: string | null
  ): Promise<SessionRecord> {
    return this.sessionRepository.updateCurrentCwd(sessionId, currentCwd);
  }

  async updateSessionBatchDecisionMessageId(
    sessionId: string,
    batchDecisionMessageId: string | null
  ): Promise<SessionRecord> {
    return this.sessionRepository.updateBatchDecisionMessageId(sessionId, batchDecisionMessageId);
  }

  async updateSessionThreadId(sessionId: string, codexThreadId: string): Promise<SessionRecord> {
    return this.sessionRepository.updateThreadId(sessionId, codexThreadId);
  }

  ensureSessionBinding(sessionId: string, sourceId: string): SessionBindingRecord {
    return this.sessionBindingRepository.ensureBinding(sessionId, sourceId);
  }

  getSessionBinding(sessionId: string, sourceId: string): SessionBindingRecord | null {
    return this.sessionBindingRepository.getBinding(sessionId, sourceId);
  }

  getSessionBindingById(bindingId: string): SessionBindingRecord | null {
    return this.sessionBindingRepository.getBindingById(bindingId);
  }

  listSessionBindings(sessionId: string): SessionBindingRecord[] {
    return this.sessionBindingRepository.listBindings(sessionId);
  }

  getSessionLease(sessionId: string): SessionLeaseRecord | null {
    return this.sessionBindingRepository.getLease(sessionId);
  }

  claimSession(sessionId: string, sourceId: string): SessionOwnershipResult {
    return this.sessionBindingRepository.claim(sessionId, sourceId);
  }

  requestSessionHandoff(sessionId: string, sourceId: string, transferNow: boolean, expectedVersion?: number): SessionHandoffResult {
    return this.sessionBindingRepository.requestHandoff(sessionId, sourceId, transferNow, expectedVersion);
  }

  cancelSessionHandoff(sessionId: string, sourceId: string, expectedVersion?: number): SessionHandoffCancellation {
    return this.sessionBindingRepository.cancelHandoff(sessionId, sourceId, expectedVersion);
  }

  hasPendingSessionWork(sessionId: string): boolean {
    return this.sessionBindingRepository.hasPendingWork(sessionId);
  }

  /** Synchronous explicit registration: caller checks its window grant immediately before this write. */
  registerCatalogSession(input: { threadId: string; directory: string; pathKey: string; name: string | null }, sourceId: string): string {
    parseSourceAddress(sourceId);
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare("SELECT id FROM sessions WHERE codex_thread_id = ?").get(input.threadId) as { id: string } | undefined;
      const timestamp = Date.now();
      this.sqlite.prepare(`INSERT OR IGNORE INTO chats (telegram_chat_id, created_at, updated_at) VALUES (?, ?, ?)`)
        .run(sourceId, timestamp, timestamp);
      if (existing) return existing.id;
      const id = `session_${randomUUID()}`;
      this.sqlite.prepare(`INSERT INTO sessions (id, telegram_chat_id, codex_thread_id, path_key, current_cwd,
        display_name, latest_activity_at, created_at, updated_at, last_discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sourceId, input.threadId, input.pathKey, input.directory, input.name, timestamp, timestamp, timestamp, timestamp);
      return id;
    }).immediate();
  }

  markSessionExternalUnknown(sessionId: string): SessionLeaseRecord {
    return this.sessionBindingRepository.markExternalUnknown(sessionId);
  }

  clearSessionExternalUnknown(sessionId: string): boolean {
    return this.sessionBindingRepository.clearExternalUnknown(sessionId);
  }

  releaseBridgeSessionLock(sessionId: string, sourceId: string, expectedVersion?: number): SessionReleaseResult {
    return this.sessionBindingRepository.releaseBridgeLock(sessionId, sourceId, expectedVersion);
  }

  beginBridgeSessionRelease(sessionId: string, sourceId: string, expectedVersion?: number) {
    return this.sessionBindingRepository.beginBridgeRelease(sessionId, sourceId, expectedVersion);
  }

  finishBridgeSessionRelease(sessionId: string, expectedVersion: number, released: boolean): SessionLeaseRecord | null {
    return this.sessionBindingRepository.finishBridgeRelease(sessionId, expectedVersion, released);
  }

  releaseStaleBridgeSessionLock(sessionId: string, expectedVersion: number): boolean {
    return this.sessionBindingRepository.releaseStaleBridgeLock(sessionId, expectedVersion);
  }

  releaseBridgeLocksAfterAuthChange(): number {
    return this.sessionBindingRepository.releaseBridgeLocksAfterAuthChange();
  }

  beginCodexSessionRelease(sessionId: string, expectedVersion?: number): SessionLeaseRecord | null {
    return this.sessionBindingRepository.beginCodexRelease(sessionId, expectedVersion);
  }

  finishCodexSessionRelease(sessionId: string, recovered: boolean): SessionLeaseRecord | null {
    return this.sessionBindingRepository.finishCodexRelease(sessionId, recovered);
  }

  recordTurnRoute(input: Omit<TurnRouteRecord, "createdAt" | "updatedAt" | "state"> & { state?: TurnRouteState }): TurnRouteRecord {
    return this.turnRouteRepository.record(input);
  }

  getActiveTurnRoute(codexThreadId: string): TurnRouteRecord | null {
    return this.turnRouteRepository.getActiveByThread(codexThreadId);
  }

  listActiveTurnRoutes(): TurnRouteRecord[] {
    return this.turnRouteRepository.listActive();
  }

  completeTurnRoute(turnId: string, state: Extract<TurnRouteState, "completed" | "failed" | "interrupted">): TurnRouteRecord | null {
    return this.turnRouteRepository.complete(turnId, state);
  }

  getActiveProgressPhaseMessage(codexThreadId: string, turnId: string): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.getActiveByTurn(codexThreadId, turnId);
  }

  listActiveProgressPhaseMessages(): ProgressPhaseMessageRecord[] {
    return this.progressPhaseMessageRepository.listActive();
  }

  getProgressPhaseMessage(id: string): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.get(id);
  }

  getLatestProgressPhaseMessage(codexThreadId: string, turnId: string): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.getLatestByTurn(codexThreadId, turnId);
  }

  getProgressPhaseMessageForFileEdit(codexThreadId: string, turnId: string, itemId: string): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.getByFileEdit(codexThreadId, turnId, itemId);
  }

  updateFinalProgressPhaseAggregate(id: string, aggregate: ProgressPhaseAggregate): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.updateFinalAggregate(id, aggregate);
  }

  listPendingProgressPhaseFinalDelivery(): ProgressPhaseMessageRecord[] {
    return this.progressPhaseMessageRepository.listPendingFinalDelivery();
  }

  createProgressPhaseMessage(input: {
    sessionId: string;
    codexThreadId: string;
    turnId: string;
    phaseKind: ProgressPhaseKind;
    sourceId: string;
    platformMessageId: string;
    directory: string;
    text: string;
    aggregate?: ProgressPhaseAggregate;
  }): ProgressPhaseMessageRecord {
    return this.progressPhaseMessageRepository.create(input);
  }

  updateActiveProgressPhaseMessage(id: string, input: {
    text: string;
    directory: string;
    sourceId: string;
    aggregate?: ProgressPhaseAggregate;
  }): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.updateActive(id, input);
  }

  recordSuccessfulRunContentUpdate(id: string): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.recordSuccessfulRunContentUpdate(id);
  }

  finalizeProgressPhaseMessage(
    input: {
      id: string;
      state: Exclude<ProgressPhaseState, "active">;
      failureReason?: import("../shared/types.js").ProgressFailureReason | null;
      deliveryState?: import("../shared/types.js").ProgressPhaseDeliveryState;
    }
  ): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.finalize(input);
  }

  finalizeActiveProgressPhaseMessageForTurn(
    codexThreadId: string,
    turnId: string,
    state: Exclude<ProgressPhaseState, "active">
  ): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.finalizeActiveByTurn(codexThreadId, turnId, state);
  }

  markProgressPhaseMessageDeliveryState(input: {
    id: string;
    deliveryState: import("../shared/types.js").ProgressPhaseDeliveryState;
    correctionMessageId?: string | null;
  }): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.markDeliveryState(input);
  }

  updateFinalProgressPhaseMessageState(input: {
    id: string;
    state: Exclude<ProgressPhaseState, "active">;
    failureReason?: import("../shared/types.js").ProgressFailureReason | null;
  }): ProgressPhaseMessageRecord | null {
    return this.progressPhaseMessageRepository.updateFinalState(input);
  }

  promotePendingSessionOwner(sessionId: string, expectedTurnId?: string | null): SessionLeaseRecord | null {
    return this.sessionBindingRepository.promotePending(sessionId, expectedTurnId);
  }

  setSessionOwnerTurn(sessionId: string, sourceId: string, turnId: string): boolean {
    return this.sessionBindingRepository.setOwnerTurn(sessionId, sourceId, turnId);
  }

  clearSessionOwnerTurn(sessionId: string, turnId: string): boolean {
    return this.sessionBindingRepository.clearOwnerTurn(sessionId, turnId);
  }

  async addMessage(input: {
    sessionId: string;
    role: MessageRecord["role"];
    text: string;
    codexTurnId?: string | null;
    telegramMessageId?: string | null;
    createdAt?: number;
  }): Promise<MessageRecord> {
    return this.messageRepository.add(input);
  }

  async hasTelegramMessage(sessionId: string, telegramMessageId: string): Promise<boolean> {
    return this.messageRepository.hasTelegramMessage(sessionId, telegramMessageId);
  }

  async listRecentMessages(sessionId: string, limit: number): Promise<MessageRecord[]> {
    return this.messageRepository.listRecent(sessionId, limit);
  }

  async listLatestMessageTimes(sessionIds: string[]): Promise<Map<string, number>> {
    return this.messageRepository.listLatestTimes(sessionIds);
  }

  async createOrReplacePendingDecision(input: {
    sessionId: string;
    telegramChatId: string;
    approvalId: string;
    kind: string | null;
    title: string;
    summary: string | null;
    requiresUserInput: boolean;
  }): Promise<DecisionRecord> {
    return this.decisionRepository.createOrReplacePending(input);
  }

  async listPendingDecisions(sessionId: string): Promise<DecisionRecord[]> {
    return this.decisionRepository.listPending(sessionId);
  }

  async listOpenDecisions(sessionId: string): Promise<DecisionRecord[]> {
    return this.decisionRepository.listOpen(sessionId);
  }

  async getAwaitingInputDecisionForChat(telegramChatId: string): Promise<DecisionRecord | null> {
    return this.decisionRepository.getAwaitingInputForChat(telegramChatId);
  }

  async getAwaitingInputDecisionForSession(sessionId: string): Promise<DecisionRecord | null> {
    return this.decisionRepository.getAwaitingInputForSession(sessionId);
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    return this.decisionRepository.get(decisionId);
  }

  async getDecisionByApprovalId(approvalId: string): Promise<DecisionRecord | null> {
    return this.decisionRepository.getByApprovalId(approvalId);
  }

  async attachDecisionMessage(decisionId: string, telegramMessageId: string): Promise<void> {
    return this.decisionRepository.attachMessage(decisionId, telegramMessageId);
  }

  async updateDecisionMessageTarget(
    decisionId: string,
    telegramChatId: string,
    telegramMessageId: string
  ): Promise<void> {
    return this.decisionRepository.updateMessageTarget(decisionId, telegramChatId, telegramMessageId);
  }

  async resolveDecision(
    decisionId: string,
    state:
      | "awaitingInput"
      | "approved"
      | "approvedForSession"
      | "rejected"
      | "cancelled"
      | "stale"
  ): Promise<DecisionRecord | null> {
    return this.decisionRepository.resolve(decisionId, state);
  }

}
