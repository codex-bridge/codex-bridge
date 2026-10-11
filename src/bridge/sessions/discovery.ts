import { CodexAppServerClient } from "../../codex/client.js";
import { CodexThreadMetadataCache } from "../../codex/thread-metadata-cache.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { probeSessionDiscoverability, type ReadThreadStatus } from "./discovery-probe.js";

export type SessionDiscoveryDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  threadMetadataCache: CodexThreadMetadataCache;
  getDiscoveryChatIds: () => string[];
  pickDirectory: (...values: Array<string | null | undefined>) => string | null;
  resolveSessionActivityAt: (rolloutPath: string, fallbackTimestamp: number | null) => Promise<number>;
  readDisplayPathFromRollout: (rolloutPath: string) => Promise<string | null>;
  readThreadStatus?: ReadThreadStatus;
  onSessionsChanged: () => void;
  onSessionDeleted: (session: SessionRecord) => void;
};

export class SessionDiscoveryService {
  private static readonly missingConfirmationCount = 2;
  private static readonly missingGraceMs = 24 * 60 * 60 * 1_000;

  constructor(private readonly deps: SessionDiscoveryDependencies) {}

  async discoverSessionsForAllowedChats(): Promise<void> {
    for (const telegramChatId of this.deps.getDiscoveryChatIds()) {
      await this.refreshSessionsForChat(telegramChatId);
    }
  }

  async refreshSessionsForChat(
    telegramChatId: string,
    options?: { includeUnknownThreads?: boolean }
  ): Promise<void> {
    try {
      logger.info("bridge.discovery.start", { chatId: telegramChatId });
      const threads = await this.deps.codexClient.listThreadsForCwd();
      const archivedThreads = typeof this.deps.codexClient.listArchivedThreadsForCwd === "function"
        ? await this.deps.codexClient.listArchivedThreadsForCwd()
        : [];
      logger.info("bridge.discovery.result", {
        chatId: telegramChatId,
        count: threads.length,
        archivedCount: archivedThreads.length
      });
      this.deps.threadMetadataCache.replace([...threads, ...archivedThreads]);
      const existingSessions = await this.deps.store.listKnownSessions(telegramChatId, {
        includeArchived: true
      });
      const activeThreadIds = new Set(threads.map((thread) => thread.threadId));
      const archivedByThreadId = new Map(archivedThreads.map((thread) => [thread.threadId, thread]));
      const existingByThreadId = new Map(existingSessions.map((session) => [session.codexThreadId, session]));
      const canCreateMissingSessions = Boolean(options?.includeUnknownThreads) || existingSessions.length === 0;
      if (threads.length === 0) logger.warn("bridge.discovery.empty", { chatId: telegramChatId });

      for (const thread of threads) {
        const existingSession = existingByThreadId.get(thread.threadId) ?? null;
        if (!existingSession && !canCreateMissingSessions) {
          logger.info("bridge.discovery.session_skipped", {
            chatId: telegramChatId,
            threadId: thread.threadId,
            reason: "not_known_to_bridge"
          });
          continue;
        }
        const pathKey = thread.currentCwd ?? thread.pathKey ?? `thread:${thread.threadId}`;
        const rolloutPath = thread.rolloutPath ?? thread.pathKey ?? pathKey;
        const currentCwd = this.deps.pickDirectory(thread.currentCwd, pathKey) ?? null;
        const latestActivityAt = await this.deps.resolveSessionActivityAt(rolloutPath, thread.updatedAt);
        const displayName =
          thread.name ??
          existingSession?.displayName ??
          (await this.deps.readDisplayPathFromRollout(rolloutPath)) ??
          currentCwd ??
          thread.preview ??
          null;
        await this.deps.store.upsertDiscoveredSession({
          telegramChatId,
          codexThreadId: thread.threadId,
          pathKey,
          currentCwd,
          displayName,
          latestActivityAt,
          createdAt: thread.createdAt,
          codexArchivedAt: thread.archivedAt
        });
        logger.info("bridge.discovery.session_upserted", {
          chatId: telegramChatId,
          pathKey,
          latestActivityAt,
          displayName,
          threadId: thread.threadId,
          name: thread.name
        });
      }

      const canSyncArchiveState = typeof this.deps.codexClient.listArchivedThreadsForCwd === "function";
      if (canSyncArchiveState) {
        for (const session of existingSessions) {
          const archivedThread = archivedByThreadId.get(session.codexThreadId);
          if (archivedThread && session.codexArchivedAt === null) {
            await this.deps.store.markSessionCodexArchived(session.id, archivedThread.archivedAt ?? Date.now());
            this.deps.onSessionsChanged();
            logger.info("bridge.discovery.session_archived", {
              chatId: telegramChatId,
              sessionId: session.id,
              threadId: session.codexThreadId
            });
            continue;
          }
          if (activeThreadIds.has(session.codexThreadId) && session.codexArchivedAt !== null) {
            const restored = await this.deps.store.markSessionCodexUnarchived(session.id);
            this.deps.store.ensureSessionBinding(restored.id, telegramChatId);
            this.deps.onSessionsChanged();
            logger.info("bridge.discovery.session_unarchived", {
              chatId: telegramChatId,
              sessionId: session.id,
              threadId: session.codexThreadId
            });
            continue;
          }
          if (!activeThreadIds.has(session.codexThreadId) && !archivedThread) {
            await this.probeMissingDiscoveredSession(session, telegramChatId);
          }
        }
      } else if (existingSessions.length > 0) {
        logger.warn("bridge.discovery.archive_sync_skipped", {
          chatId: telegramChatId,
          reason: "archived_inventory_unavailable"
        });
      }
    } catch (error) {
      logger.error("bridge.discovery.failed", {
        chatId: telegramChatId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async probeMissingDiscoveredSession(session: SessionRecord, telegramChatId: string): Promise<void> {
    const readThreadStatus = this.deps.readThreadStatus;
    if (!readThreadStatus) {
      logger.warn("bridge.discovery.session_missing_probe_unavailable", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId
      });
      return;
    }

    const probe = await probeSessionDiscoverability(readThreadStatus, session);
    if (probe.state === "readable") {
      await this.deps.store.clearSessionDiscoveryMissing(session.id);
      logger.info("bridge.discovery.session_not_listed_but_readable", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId
      });
      return;
    }
    if (probe.state === "indeterminate") {
      logger.warn("bridge.discovery.session_missing_probe_failed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: probe.error
      });
      return;
    }

    const marked = await this.deps.store.markSessionDiscoveryMissing(session.id);
    const eligibleForCleanup = marked.discoveryMissingCount >= SessionDiscoveryService.missingConfirmationCount
      && marked.discoveryMissingSince !== null
      && Date.now() - marked.discoveryMissingSince >= SessionDiscoveryService.missingGraceMs;
    if (!eligibleForCleanup) {
      logger.info("bridge.discovery.session_missing_confirmed", {
        chatId: telegramChatId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        missingCount: marked.discoveryMissingCount,
        missingSince: marked.discoveryMissingSince
      });
      return;
    }
    await this.cleanupMissingDiscoveredSession(marked, telegramChatId);
  }

  private async cleanupMissingDiscoveredSession(session: SessionRecord, telegramChatId: string): Promise<void> {
    const deleted = await this.deps.store.deleteSession(session.id);
    if (!deleted) return;
    this.deps.onSessionDeleted(session);
    logger.info("bridge.discovery.session_deleted", {
      chatId: telegramChatId,
      sessionId: session.id,
      threadId: session.codexThreadId,
      reason: "absent_from_active_and_archived"
    });
  }
}
