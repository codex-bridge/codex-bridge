import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";

type SlackChat = { channelId: string; threadTs: string | null } | null;

export type SessionRecoveryDependencies = {
  store: BridgeStore;
  parseSlackChatId: (chatId: string) => SlackChat;
};

export class SessionRecoveryService {
  constructor(private readonly deps: SessionRecoveryDependencies) {}

  async recoverSlackDmActiveSession(chatId: string): Promise<SessionRecord | null> {
    const slackChat = this.deps.parseSlackChatId(chatId);
    if (!slackChat || !slackChat.channelId.startsWith("D") || slackChat.threadTs) {
      return null;
    }

    const legacySession = await this.deps.store.getLatestActiveSessionForChatPrefix(`${chatId}:`);
    if (!legacySession) {
      return null;
    }

    const existingSession = await this.deps.store.getSessionByChatAndThreadId(
      chatId,
      legacySession.codexThreadId
    );
    const session =
      existingSession ??
      (await this.deps.store.upsertDiscoveredSession({
        telegramChatId: chatId,
        codexThreadId: legacySession.codexThreadId,
        pathKey: legacySession.pathKey,
        currentCwd: legacySession.currentCwd,
        displayName: legacySession.displayName,
        latestActivityAt: legacySession.latestActivityAt,
        createdAt: legacySession.createdAt
      }));
    const activeSession = await this.deps.store.setActiveSession(chatId, session.id);
    logger.info("bridge.slack_dm.active_session_recovered", {
      chatId,
      legacyChatId: legacySession.telegramChatId,
      sessionId: activeSession.id,
      threadId: activeSession.codexThreadId
    });
    return activeSession;
  }

}
