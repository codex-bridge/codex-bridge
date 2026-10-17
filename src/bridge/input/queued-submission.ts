import { CodexAppServerClient } from "../../codex/client.js";
import { markManagedAttachmentPathsStatus } from "./attachment-files.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { createMessage, messageContextForSession } from "../messages/factory.js";
import { actionRow, helpAction, sessionAction } from "../messages/actions.js";
import type { MessageSpec } from "../messages/types.js";
import { SessionOwnershipService } from "../sessions/ownership.js";
import type { StatusRuntimeState } from "../status/runtime-state.js";

export type QueuedSubmissionDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  sessionOwnershipService: SessionOwnershipService;
  statusRuntimeState: Pick<StatusRuntimeState, "resetEditThrottle" | "getLabel">;
  ensureChatAllowed: (chatId: string) => Promise<void>;
  getSessionDirectory: (session: SessionRecord) => string;
  setSessionStatus: (session: SessionRecord, label: string) => Promise<void>;
  rememberNotificationSessionId: (threadId: string, sessionId: string) => void;
};

export type QueuedSubmissionCancellation = {
  cancelled: boolean;
  message: MessageSpec;
};

export class QueuedSubmissionService {
  constructor(private readonly deps: QueuedSubmissionDependencies) {}

  async reconcileStartedSubmission(threadId: string): Promise<void> {
    const pending = await this.deps.store.listPendingQueuedSubmissions(threadId);
    const candidate = pending.find((row) => row.state === "queued" || row.state === "submitting");
    if (!candidate) return;
    const serverQueue = await this.deps.codexClient.listQueuedSubmissions(threadId).catch(() => null);
    if (!serverQueue || serverQueue.some((row) => row.clientUserMessageId === candidate.clientUserMessageId)) return;
    const started = await this.deps.store.startNextQueuedSubmission(threadId);
    if (!started) return;
    this.deps.rememberNotificationSessionId(threadId, started.sessionId);
    await markManagedAttachmentPathsStatus(started.attachmentPaths, "sent-to-codex");
  }

  async cancel(chatId: string, id: string): Promise<MessageSpec> {
    return (await this.cancelWithOutcome(chatId, id)).message;
  }

  async cancelWithOutcome(chatId: string, id: string): Promise<QueuedSubmissionCancellation> {
    await this.deps.ensureChatAllowed(chatId);
    const row = await this.deps.store.getQueuedSubmission(id);
    const resultSpec = (text: string, session?: SessionRecord): MessageSpec => createMessage({
      kind: "queue",
      ...messageContextForSession(session ? { id: session.id, directory: this.deps.getSessionDirectory(session) } : null),
      body: [{ type: "text", text }],
      actions: actionRow(helpAction(), sessionAction())
    });
    if (!row || row.telegramChatId !== chatId) {
      return { cancelled: false, message: resultSpec("Queued message is unavailable.") };
    }
    if (row.state !== "queued" || !row.codexQueueId) {
      return { cancelled: false, message: resultSpec(`Queued message is already ${row.state}.`) };
    }
    const session = await this.deps.store.getSessionById(row.sessionId);
    if (session) {
      const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (ownershipPrompt) return { cancelled: false, message: ownershipPrompt };
    }
    const deleted = await this.deps.codexClient.deleteQueuedSubmission(row.codexThreadId, row.codexQueueId);
    if (!deleted) {
      return { cancelled: false,
        message: resultSpec("The queued message could not be cancelled because it may already be starting.", session ?? undefined) };
    }
    await this.deps.store.updateQueuedSubmission(id, { state: "cancelled" });
    await markManagedAttachmentPathsStatus(row.attachmentPaths, "failed");
    if (session) {
      this.deps.statusRuntimeState.resetEditThrottle(session.id);
      await this.deps.setSessionStatus(session, this.deps.statusRuntimeState.getLabel(session.id) ?? "Working");
    }
    return { cancelled: true, message: resultSpec("Queued message cancelled.", session ?? undefined) };
  }
}
