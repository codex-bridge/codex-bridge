import { spawn } from "node:child_process";
import { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import { RuntimeController, type RuntimeState } from "./controller.js";
import { helpAction, messageAction } from "../messages/actions.js";
import { createMessage, messageContextForSession } from "../messages/factory.js";
import type { MessageSpec, SessionContext } from "../messages/types.js";

export type RuntimeCommandDependencies = {
  runtime: RuntimeController;
  codexClient: CodexAppServerClient;
  requestRestart: () => void;
  getActiveSessionContext: (chatId: string) => Promise<SessionContext | undefined>;
  attachCodexListeners: () => void;
  detachCodexListeners: () => void;
  discoverSessions: () => Promise<void>;
  clearDisconnectedState: () => Promise<void>;
  getSeedChatIds: () => string[];
  ensureSeedChats: (chatIds: string[]) => Promise<void>;
  listSessionsForPolling: () => Promise<number>;
  reconcileRecoveredTurnState: () => Promise<void>;
};

export class RuntimeCommandService {
  constructor(private readonly deps: RuntimeCommandDependencies) {}

  async restart(chatId: string): Promise<MessageSpec> {
    const message = await this.createStatusSpec("Restart requested.\nThe bot should be back in a few seconds.", chatId);
    this.deps.requestRestart();
    return message;
  }

  async bootstrap(): Promise<void> {
    const seedChatIds = this.deps.getSeedChatIds();
    logger.info("bridge.bootstrap.start", {
      seedChatCount: seedChatIds.length,
      connectOnBootstrap: true
    });
    await this.deps.ensureSeedChats(seedChatIds);
    this.transition("connecting");
    try {
      await this.deps.codexClient.connect();
      this.deps.attachCodexListeners();
      this.transition("connected");
    } catch (error) {
      this.transition("failed");
      throw error;
    }
    logger.info("bridge.bootstrap.discovery_skipped", {
      reason: "lazy_session_discovery"
    });

    const sessionCount = await this.deps.listSessionsForPolling();
    logger.info("bridge.bootstrap.sessions_ready", { count: sessionCount });
    await this.deps.reconcileRecoveredTurnState();
    logger.info("bridge.bootstrap.active_turns_reconciled");
    logger.info("bridge.bootstrap.complete");
  }

  async disconnect(chatId: string): Promise<MessageSpec> {
    if (this.deps.runtime.isTransitioning()) {
      return this.createStatusSpec(`Codex runtime is ${this.deps.runtime.state}.`, chatId);
    }
    if (!this.deps.runtime.isConnected()) {
      return this.createStatusSpec("Codex runtime is already disconnected.", chatId);
    }

    this.transition("disconnecting");
    this.deps.detachCodexListeners();
    try {
      await this.deps.codexClient.close();
      this.transition("disconnected");
    } catch (error) {
      this.transition("failed");
      throw error;
    }
    await this.deps.clearDisconnectedState();
    logger.info("bridge.runtime.disconnected");
    return this.createStatusSpec("Codex runtime disconnected.\nThe bot will stay online, but it will not talk to Codex until /bot_connect.", chatId);
  }

  async connect(chatId: string): Promise<MessageSpec> {
    if (this.deps.runtime.isTransitioning()) {
      return this.createStatusSpec(`Codex runtime is ${this.deps.runtime.state}.`, chatId);
    }
    if (this.deps.runtime.isConnected()) {
      return this.createStatusSpec("Codex runtime is already connected.", chatId);
    }

    this.transition("connecting");
    try {
      await this.deps.codexClient.connect();
      this.deps.attachCodexListeners();
      this.transition("connected");
    } catch (error) {
      this.transition("failed");
      throw error;
    }
    await this.deps.discoverSessions();
    await this.deps.reconcileRecoveredTurnState();
    logger.info("bridge.runtime.connected");
    return this.createStatusSpec("Codex runtime connected.", chatId);
  }

  private transition(next: RuntimeState): void {
    const previous = this.deps.runtime.state;
    this.deps.runtime.transition(next);
    logger.info("bridge.runtime.state_changed", { previous, next });
  }

  private async createStatusSpec(body: string, chatId: string): Promise<MessageSpec> {
    return createMessage({
      kind: "system",
      titleLabel: "Codex",
      ...messageContextForSession(await this.deps.getActiveSessionContext(chatId)),
      body: [{ type: "text", text: body }],
      actions: this.deps.runtime.isTransitioning()
        ? [helpAction()]
        : [
            messageAction(
              this.deps.runtime.isConnected() ? "bot-disconnect" : "bot-connect",
              this.deps.runtime.isConnected() ? "Disconnect" : "Connect",
              this.deps.runtime.isConnected() ? "quick:bot_disconnect" : "quick:bot_connect",
              "Bot"
            ),
            helpAction()
          ]
    });
  }
}

export function requestServiceRestart(pm2AppName: string): void {
  logger.info("bridge.service.restart_requested", { appName: pm2AppName });
  const child = spawn("sh", [
    "-c",
    "sleep 2; pm2 startOrRestart ecosystem.config.cjs --only \"$PM2_RESTART_APP_NAME\" --update-env"
  ], {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, PM2_RESTART_APP_NAME: pm2AppName },
    stdio: "ignore"
  });
  child.unref();
}
