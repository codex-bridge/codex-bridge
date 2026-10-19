import { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { MessageRecord, SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";

type RecentMessage = Pick<MessageRecord, "role" | "text">;

export type SessionReaderDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  isRuntimeConnected: () => boolean;
  recoverExternalSession: (session: SessionRecord) => Promise<number | null>;
  getSessionDirectory: (session: SessionRecord) => string;
  readDisplayPathFromRollout: (rolloutPath: string) => Promise<string | null>;
  pickDirectory: (...values: Array<string | null | undefined>) => string | null;
  readRecentMessagesFromRollout: (rolloutPath: string) => Promise<RecentMessage[]>;
};

export class SessionReader {
  constructor(private readonly deps: SessionReaderDependencies) {}

  async resumeSession(session: SessionRecord, telegramChatId: string): Promise<{
    session: SessionRecord;
    recentMessages: RecentMessage[];
  }> {
    let currentSession = session;
    let recentMessages: RecentMessage[];
    let recentMessagesSource: "turns" | "resume" | "rollout" | "database";
    if (!this.deps.isRuntimeConnected()) {
      recentMessages = await this.deps.store.listRecentMessages(currentSession.id, 5);
      logger.info("bridge.session.activate.disconnected_runtime", {
        chatId: telegramChatId,
        sessionId: currentSession.id,
        threadId: currentSession.codexThreadId
      });
      return { session: currentSession, recentMessages };
    }

    try {
      const resume = await this.deps.codexClient.resumeThread(
        currentSession.codexThreadId,
        this.deps.getSessionDirectory(currentSession)
      );
      const rolloutDisplayPath = await this.deps.readDisplayPathFromRollout(currentSession.pathKey);
      const preferredDisplayName =
        rolloutDisplayPath ?? resume.displayPath ?? currentSession.displayName;
      const resolvedCurrentCwd =
        this.deps.pickDirectory(resume.displayPath, rolloutDisplayPath, currentSession.currentCwd) ?? null;
      if (resolvedCurrentCwd !== currentSession.currentCwd) {
        currentSession = await this.deps.store.updateSessionCurrentCwd(currentSession.id, resolvedCurrentCwd);
      }
      if (preferredDisplayName && !currentSession.displayName) {
        currentSession = await this.deps.store.updateSessionDisplayName(currentSession.id, preferredDisplayName);
      }
      try {
        recentMessages = (await this.deps.codexClient.listRecentThreadMessages(currentSession.codexThreadId, 5))
          .map(({ role, text }) => ({ role, text }));
        recentMessagesSource = "turns";
      } catch (error) {
        logger.warn("bridge.session.turn_history_failed", {
          chatId: telegramChatId,
          sessionId: currentSession.id,
          threadId: currentSession.codexThreadId,
          error: error instanceof Error ? error.message : String(error)
        });
        const resumed = resume.messages.filter((message) => message.role === "user" || message.role === "assistant");
        if (resumed.length > 0) {
          recentMessages = resumed.slice(-5);
          recentMessagesSource = "resume";
        } else {
          recentMessages = await this.deps.readRecentMessagesFromRollout(currentSession.pathKey);
          recentMessagesSource = "rollout";
          if (recentMessages.length === 0) {
            recentMessages = await this.deps.store.listRecentMessages(currentSession.id, 5);
            recentMessagesSource = "database";
          }
        }
      }
      await this.deps.store.touchSession(currentSession.id);
      currentSession = (await this.deps.store.getSessionById(currentSession.id)) as SessionRecord;
      logger.info("bridge.session.resume_ready", {
        chatId: telegramChatId,
        sessionId: currentSession.id,
        threadId: currentSession.codexThreadId,
        displayPath: resume.displayPath,
        historySource: recentMessagesSource,
        historyCount: recentMessages.length
      });
    } catch (error) {
      logger.error("bridge.session.resume_failed", {
        chatId: telegramChatId,
        sessionId: currentSession.id,
        threadId: currentSession.codexThreadId,
        pathKey: currentSession.pathKey,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    return { session: currentSession, recentMessages };
  }

  async readSessionTranscript(session: SessionRecord): Promise<{
    session: SessionRecord;
    recentMessages: RecentMessage[];
  }> {
    let recentMessages: RecentMessage[];
    if (!this.deps.isRuntimeConnected()) {
      return {
        session,
        recentMessages: await this.deps.store.listRecentMessages(session.id, 5)
      };
    }

    try {
      recentMessages = (await this.deps.codexClient.listRecentThreadMessages(session.codexThreadId, 5))
        .map(({ role, text }) => ({ role, text }));
    } catch (error) {
      logger.warn("bridge.session.refresh_turn_history_failed", {
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: error instanceof Error ? error.message : String(error)
      });
      recentMessages = await this.deps.readRecentMessagesFromRollout(session.pathKey);
      if (recentMessages.length === 0) {
        recentMessages = await this.deps.store.listRecentMessages(session.id, 5);
      }
    }
    return { session, recentMessages };
  }

  async reconcileExternalSessionLease(session: SessionRecord): Promise<boolean> {
    return (await this.deps.recoverExternalSession(session)) !== null;
  }
}
