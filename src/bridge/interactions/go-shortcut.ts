import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { actionRow, helpAction, userTextAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import type { BridgeMessageOperations } from "../messages/operations.js";
import type { LastAssistantMessage } from "../runtime-state.js";

export type GoShortcutServiceDependencies = {
  store: Pick<BridgeStore, "listPendingDecisions" | "getAwaitingInputDecisionForSession" | "getActiveSession">;
  messageOperations: Pick<BridgeMessageOperations, "sendMessageSpec">;
  pendingByThread: Map<string, ReturnType<typeof setTimeout>>;
  lastAssistantMessageByThread: Pick<Map<string, LastAssistantMessage>, "delete">;
  getSessionDirectory: (session: SessionRecord) => string;
  delayMs?: number;
};

export class GoShortcutService {
  private readonly delayMs: number;

  constructor(private readonly deps: GoShortcutServiceDependencies) {
    this.delayMs = deps.delayMs ?? 500;
  }

  schedule(session: SessionRecord): void {
    this.cancel(session.codexThreadId);
    const timeout = setTimeout(() => {
      void this.flush(session).catch((error) => {
        logger.warn("bridge.go_shortcut.failed", {
          sessionId: session.id,
          threadId: session.codexThreadId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.delayMs);
    this.deps.pendingByThread.set(session.codexThreadId, timeout);
  }

  cancel(threadId: string): void {
    const timeout = this.deps.pendingByThread.get(threadId);
    if (!timeout) {
      return;
    }
    clearTimeout(timeout);
    this.deps.pendingByThread.delete(threadId);
  }

  async flush(session: SessionRecord): Promise<void> {
    this.deps.pendingByThread.delete(session.codexThreadId);
    await this.maybeSend(session);
    this.deps.lastAssistantMessageByThread.delete(session.codexThreadId);
  }

  async sendAfterTranscript(session: SessionRecord, chatId: string): Promise<void> {
    const active = await this.deps.store.getActiveSession(chatId);
    if (active?.id !== session.id) return;
    this.cancel(session.codexThreadId);
    await this.maybeSend(session, chatId);
  }

  private async maybeSend(session: SessionRecord, chatId = session.telegramChatId): Promise<void> {
    const pendingDecisions = await this.deps.store.listPendingDecisions(session.id);
    const awaitingInput = await this.deps.store.getAwaitingInputDecisionForSession(session.id);
    if (pendingDecisions.length > 0 || awaitingInput) {
      return;
    }

    const messageSpec: MessageSpec = createMessage({
      kind: "actions",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      actions: actionRow(
        userTextAction("go", "Go", "quick:go", "go"),
        userTextAction("next", "Next", "quick:next", "next"),
        helpAction()
      )
    });
    await this.deps.messageOperations.sendMessageSpec(chatId, messageSpec, {
      disable_notification: true
    });
  }
}
