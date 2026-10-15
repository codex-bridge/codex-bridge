import { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import type { MessageSpec } from "../messages/types.js";
import { SessionOwnershipService } from "./ownership.js";

export type SessionStopDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  inFlightTurnIdByThread: Map<string, string>;
  sessionOwnershipService: SessionOwnershipService;
  isRuntimeConnected: () => boolean;
  createSessionCommandResultSpec: (session: SessionRecord | null, kind: MessageSpec["kind"], text: string) => MessageSpec;
  clearTypingState: (sessionId: string) => void;
  setSessionStatus: (session: SessionRecord, label: string) => Promise<void>;
};

export class SessionStopService {
  constructor(private readonly deps: SessionStopDependencies) {}

  async stop(chatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(chatId);
    if (!this.deps.isRuntimeConnected()) {
      return this.deps.createSessionCommandResultSpec(session, "error", "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    }

    if (!session) {
      return this.deps.createSessionCommandResultSpec(null, "system", "No active session to stop.");
    }
    return this.stopSession(session, chatId);
  }

  async stopSession(session: SessionRecord, sourceId: string): Promise<MessageSpec> {
    if (!this.deps.isRuntimeConnected()) {
      return this.deps.createSessionCommandResultSpec(session, "error", "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    }
    const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, sourceId);
    if (ownershipPrompt) return ownershipPrompt;

    const turnId = this.deps.inFlightTurnIdByThread.get(session.codexThreadId) ?? null;
    if (!turnId) {
      return this.deps.createSessionCommandResultSpec(session, "system", "No in-flight turn to stop.");
    }

    try {
      await this.deps.codexClient.interruptThread(session.codexThreadId, turnId);
      this.deps.clearTypingState(session.id);
      await this.deps.setSessionStatus(session, "Interrupted");
      logger.info("bridge.session.stop_requested", {
        chatId: sourceId,
        sessionId: session.id,
        threadId: session.codexThreadId
      });
      return this.deps.createSessionCommandResultSpec(session, "system", "Stop requested.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("bridge.session.stop_failed", {
        chatId: sourceId,
        sessionId: session.id,
        threadId: session.codexThreadId,
        error: message
      });
      this.deps.clearTypingState(session.id);
      if (message.includes("timed out")) {
        await this.deps.setSessionStatus(session, "Interrupt timeout");
        return this.deps.createSessionCommandResultSpec(session, "error", "Interrupt request timed out.\nThe Codex backend did not acknowledge within 5s, so the run may still continue.");
      }
      await this.deps.setSessionStatus(session, "Interrupt failed");
      return this.deps.createSessionCommandResultSpec(session, "error", `Interrupt failed.\n${message}`);
    }
  }
}
