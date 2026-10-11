import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { actionRow, helpAction, sessionAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import type { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { formatSessionMarker } from "../../shared/session-tag.js";
import { BridgeStore } from "../../store/index.js";
import { formatNewSessionDisplayName } from "./menu-formatters.js";
import type { SessionDiscoveryService } from "./discovery.js";
import type { SessionMenuService } from "./menu.js";
import type { SessionActivationResult, SessionActivationService } from "./activation.js";
import type { SessionOwnershipService } from "./ownership.js";

export type SessionCreationDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  sessionMenuService: Pick<SessionMenuService, "getDirectoryGroup">;
  sessionDiscoveryService: Pick<SessionDiscoveryService, "refreshSessionsForChat">;
  sessionOwnershipService: Pick<SessionOwnershipService, "getSessionOwnershipPrompt">;
  sessionActivationService: Pick<SessionActivationService, "activateSession">;
  clearBatchDecisionMessage: (session: SessionRecord) => Promise<void>;
  ensureChatAllowed: (chatId: string) => Promise<void>;
  isRuntimeConnected: () => boolean;
  getSessionSelectorChatId: (chatId: string) => string;
  getSessionDirectory: (session: SessionRecord) => string;
  expandHomeDirectory: (value: string) => string;
  normalizeDirectoryCandidate: (value: string) => string;
};

export class SessionCreationService {
  constructor(private readonly deps: SessionCreationDependencies) {}

  async requestCreateSessionForCurrentDirectory(telegramChatId: string): Promise<MessageSpec> {
    await this.deps.ensureChatAllowed(telegramChatId);
    if (!this.deps.isRuntimeConnected()) {
      return this.createSessionCreationSpec("error", "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    }

    const activeSession = await this.deps.store.getActiveSession(telegramChatId);
    if (!activeSession) {
      return this.createSessionCreationSpec("error", [
        "No active session directory.",
        "Use sessions to choose a project first."
      ].join("\n"));
    }

    const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(activeSession, telegramChatId);
    if (ownershipPrompt) return ownershipPrompt;

    return this.createSessionForDirectoryOnly(
      telegramChatId,
      this.deps.getSessionDirectory(activeSession)
    );
  }

  async requestCreateSessionFromDirectorySelector(
    telegramChatId: string,
    directoryHash: string
  ): Promise<MessageSpec> {
    await this.deps.ensureChatAllowed(telegramChatId);
    if (!this.deps.isRuntimeConnected()) {
      return this.createSessionCreationSpec("error", "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    }

    const group = await this.deps.sessionMenuService.getDirectoryGroup(
      this.deps.getSessionSelectorChatId(telegramChatId),
      directoryHash
    );
    if (!group) {
      return this.createSessionCreationSpec("error", [
        "Session directory menu expired.",
        "Use sessions to open a fresh menu."
      ].join("\n"));
    }

    return this.createSessionForDirectoryOnly(telegramChatId, group.directoryKey);
  }

  async activateOrCreateSessionForDirectory(
    telegramChatId: string,
    directoryInput: string
  ): Promise<SessionActivationResult & { created: boolean }> {
    await this.deps.ensureChatAllowed(telegramChatId);
    if (!this.deps.isRuntimeConnected()) {
      throw new Error("Codex runtime is disconnected. Use /bot_connect to reconnect.");
    }

    const directory = await this.resolveRequestedDirectory(directoryInput);
    await this.deps.sessionDiscoveryService.refreshSessionsForChat(telegramChatId, { includeUnknownThreads: true });
    const existingSession = await this.findLatestSessionForDirectory(telegramChatId, directory);
    if (existingSession) {
      const result = await this.deps.sessionActivationService.activateSession(
        telegramChatId,
        existingSession.id
      );
      return { ...result, created: false };
    }

    const previousActiveSession = await this.deps.store.getActiveSession(telegramChatId);
    const thread = await this.deps.codexClient.startThread(directory);
    const session = await this.deps.store.upsertDiscoveredSession({
      telegramChatId,
      codexThreadId: thread.threadId,
      pathKey: directory,
      currentCwd: directory,
      displayName: directory,
      latestActivityAt: Date.now()
    });
    const activeSession = await this.deps.store.setActiveSession(telegramChatId, session.id);
    if (previousActiveSession && previousActiveSession.id !== activeSession.id) {
      await this.deps.clearBatchDecisionMessage(previousActiveSession);
    }
    await this.deps.store.touchSession(activeSession.id);
    logger.info("bridge.session.created_for_directory", {
      chatId: telegramChatId,
      sessionId: activeSession.id,
      threadId: activeSession.codexThreadId,
      directory
    });
    return {
      session: activeSession,
      recentMessages: [],
      created: true
    };
  }

  /** Creates and records a session for an explicit source without changing chat navigation state. */
  async createSessionForDirectory(
    sourceId: string,
    directoryInput: string,
    assertCurrent: () => void = () => {}
  ): Promise<SessionRecord> {
    await this.deps.ensureChatAllowed(sourceId);
    if (!this.deps.isRuntimeConnected()) {
      throw new Error("Codex runtime is disconnected.");
    }
    const directory = await this.resolveRequestedDirectory(directoryInput);
    assertCurrent();
    const displayName = formatNewSessionDisplayName(directory);
    const thread = await this.deps.codexClient.startThread(directory);
    // The upstream mutation has completed. Always finish local reconciliation;
    // a revoked caller may discover the result later instead of retrying it.
    const session = await this.deps.store.upsertDiscoveredSession({
      telegramChatId: sourceId,
      codexThreadId: thread.threadId,
      pathKey: directory,
      currentCwd: directory,
      displayName,
      latestActivityAt: Date.now()
    });
    logger.info("bridge.session.created_for_directory", {
      chatId: sourceId,
      sessionId: session.id,
      threadId: session.codexThreadId,
      directory,
      switchedToActive: false
    });
    return session;
  }

  private async createSessionForDirectoryOnly(
    telegramChatId: string,
    directory: string
  ): Promise<MessageSpec> {
    const previousActiveSession = await this.deps.store.getActiveSession(telegramChatId);
    const displayName = formatNewSessionDisplayName(directory);
    const thread = await this.deps.codexClient.startThread(directory);
    const session = await this.deps.store.upsertDiscoveredSession({
      telegramChatId,
      codexThreadId: thread.threadId,
      pathKey: directory,
      currentCwd: directory,
      displayName,
      latestActivityAt: Date.now()
    });
    const activeSession = await this.deps.store.setActiveSession(telegramChatId, session.id);
    if (previousActiveSession && previousActiveSession.id !== activeSession.id) {
      await this.deps.clearBatchDecisionMessage(previousActiveSession);
    }
    await this.deps.store.touchSession(activeSession.id);

    logger.info("bridge.session.created_for_directory", {
      chatId: telegramChatId,
      sessionId: activeSession.id,
      threadId: activeSession.codexThreadId,
      directory,
      switchedToActive: true
    });

    return createMessage({
      kind: "system",
      titleLabel: "Session created",
      session: {
        id: activeSession.codexThreadId,
        directory
      },
      body: [
        { type: "field", label: "Path", value: formatSessionMarker(directory) },
        { type: "field", label: "Name", value: displayName },
        { type: "text", text: "Switched to the new active session." }
      ],
      actions: actionRow(helpAction(), sessionAction())
    });
  }

  private createSessionCreationSpec(kind: MessageSpec["kind"], text: string): MessageSpec {
    return createMessage({
      kind,
      body: [{ type: "text", text }],
      actions: actionRow(helpAction(), sessionAction())
    });
  }

  private async resolveRequestedDirectory(directoryInput: string): Promise<string> {
    const trimmed = directoryInput.trim();
    if (!trimmed) {
      throw new Error("Directory is required.");
    }

    const expanded = this.deps.expandHomeDirectory(trimmed);
    const directory = resolve(expanded);
    const stats = await stat(directory).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Directory is not accessible: ${directory}\n${message}`);
    });
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${directory}`);
    }
    return directory;
  }

  private async findLatestSessionForDirectory(
    telegramChatId: string,
    directory: string
  ): Promise<SessionRecord | null> {
    const sessions = await this.deps.store.listKnownSessions(telegramChatId);
    return (
      sessions.find((session) => {
        const candidates = [
          this.deps.getSessionDirectory(session),
          session.currentCwd,
          session.pathKey,
          session.displayName
        ];
        return candidates.some((candidate) => {
          if (!candidate) {
            return false;
          }
          return this.deps.normalizeDirectoryCandidate(candidate) === directory;
        });
      }) ?? null
    );
  }
}
