import type { AppServerErrorEvent, AppServerStatusUpdate } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { actionRow, interruptAction, messageAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";
import { formatStatusDetailPreview } from "../renderers/progress.js";
import { formatElapsed } from "./formatters.js";

type StatusEntry = { messageId: string; text: string };

export type StatusLifecycleDependencies = {
  store: Pick<BridgeStore, "countPendingQueuedSubmissions" | "getSessionById">;
  statusMessageBySession: Map<string, StatusEntry>;
  statusStartedAtBySession: Map<string, number>;
  statusLabelBySession: Map<string, string>;
  statusDetailBySession: Map<string, string>;
  statusLastEditAtBySession: Map<string, number>;
  statusOpBySession: Map<string, Promise<void>>;
  sendMessageSpec: (chatId: string, messageSpec: MessageSpec, options?: { disable_notification?: boolean }) => Promise<{ message_id: string } | null>;
  editMessageSpec: (chatId: string, messageId: string, messageSpec: MessageSpec) => Promise<boolean>;
  getSessionDirectory: (session: SessionRecord) => string;
  isCompactStatusUpdate: (update: AppServerStatusUpdate) => boolean;
  notifyCompactStarted: (session: SessionRecord, source: "runtime") => Promise<void>;
  clearTypingState: (sessionId: string) => void;
  sendTypingOnce: (session: SessionRecord) => Promise<void>;
};

export class StatusLifecycleService {
  constructor(private readonly deps: StatusLifecycleDependencies) {}

  async applyStatusUpdate(session: SessionRecord, update: AppServerStatusUpdate): Promise<void> {
    if (update.kind === "clear") {
      this.deps.clearTypingState(session.id);
      await this.clearSessionStatus(session);
      return;
    }

    if (this.deps.isCompactStatusUpdate(update)) {
      await this.deps.notifyCompactStarted(session, "runtime");
    }
    await this.setSessionStatus(session, update.label ?? "Working", update.label === "Thinking" ? update : undefined);
    await this.deps.sendTypingOnce(session);
  }

  async setSessionStatus(
    session: SessionRecord,
    label: string,
    update?: Pick<AppServerStatusUpdate, "detail" | "detailMode">
  ): Promise<void> {
    return this.runSessionStatusOp(session.id, async () => {
      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(session.id) ?? now;
      this.deps.statusStartedAtBySession.set(session.id, startedAt);

      const previousLabel = this.deps.statusLabelBySession.get(session.id);
      const labelChanged = previousLabel !== label;
      const previousDetail = this.deps.statusDetailBySession.get(session.id) ?? "";
      const detail = this.resolveStatusDetail(labelChanged ? "" : previousDetail, update);
      if (detail) this.deps.statusDetailBySession.set(session.id, detail);
      else this.deps.statusDetailBySession.delete(session.id);

      const detailChanged = detail !== previousDetail;
      const lastEditAt = this.deps.statusLastEditAtBySession.get(session.id) ?? 0;
      if (!labelChanged && (!detailChanged || now - lastEditAt < 5_000)) return;

      const queueCount = await this.deps.store.countPendingQueuedSubmissions(session.codexThreadId);
      const messageSpec = this.createSessionStatusMessageSpec(session, label, startedAt, now, detail, queueCount);
      const text = renderLegacyMessage(messageSpec);
      const existing = this.deps.statusMessageBySession.get(session.id);
      if (existing?.text === text) return;

      if (existing) {
        try {
          await this.deps.editMessageSpec(session.telegramChatId, existing.messageId, messageSpec);
          this.rememberStatus(session.id, existing.messageId, text, label, now);
          return;
        } catch (error) {
          logger.warn("bridge.status.edit_failed", {
            sessionId: session.id,
            messageId: existing.messageId,
            error: error instanceof Error ? error.message : String(error)
          });
          this.clearStatusState(session.id);
        }
      }

      const sent = await this.deps.sendMessageSpec(session.telegramChatId, messageSpec, { disable_notification: true });
      if (sent) this.rememberStatus(session.id, sent.message_id, text, label, now);
    });
  }

  async clearSessionStatus(session: SessionRecord): Promise<void> {
    return this.runSessionStatusOp(session.id, async () => {
      const existing = this.deps.statusMessageBySession.get(session.id);
      if (!existing) return;

      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(session.id) ?? now;
      try {
        await this.deps.editMessageSpec(
          session.telegramChatId,
          existing.messageId,
          this.createSessionStatusMessageSpec(session, "Done", startedAt, now, "", 0)
        );
      } catch (error) {
        logger.warn("bridge.status.finalize_failed", {
          sessionId: session.id,
          messageId: existing.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.clearStatusState(session.id);
      }
    });
  }

  async clearAllSessionStatusMessages(): Promise<void> {
    const entries = [...this.deps.statusMessageBySession.entries()];
    for (const [sessionId, status] of entries) {
      const session = await this.deps.store.getSessionById(sessionId);
      if (!session) {
        this.clearStatusState(sessionId);
        continue;
      }
      const now = Date.now();
      const startedAt = this.deps.statusStartedAtBySession.get(sessionId) ?? now;
      try {
        await this.deps.editMessageSpec(
          session.telegramChatId,
          status.messageId,
          this.createSessionStatusMessageSpec(session, "Interrupted", startedAt, now, "Runtime connection closed before this status finished.", 0)
        );
      } catch (error) {
        logger.warn("bridge.status.interrupt_finalize_failed", {
          sessionId,
          messageId: status.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.clearStatusState(sessionId);
      }
    }
  }

  formatRecoveryIssue(event: AppServerErrorEvent): string {
    return `Issue · ${this.summarizeRecoveryIssue(event)}`;
  }

  private createSessionStatusMessageSpec(
    session: SessionRecord,
    label: string,
    startedAt: number,
    now: number,
    detail: string,
    queueCount: number
  ): MessageSpec {
    const stage = label.trim() || "Working";
    return createMessage({
      kind: "working",
      titleLabel: "Codex",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        { type: "text", text: `Working · ${stage} · ${formatElapsed(now - startedAt)}` },
        ...(detail ? [{ type: "text" as const, text: detail }] : []),
        ...(queueCount > 0 ? [{ type: "text" as const, text: `Queued: ${queueCount}` }] : [])
      ],
      actions: label.trim() === "Done"
        ? []
        : actionRow(messageAction("queue", "Queue", "quick:queue"), interruptAction("quick:interrupt"))
    });
  }

  private resolveStatusDetail(previous: string, update?: Pick<AppServerStatusUpdate, "detail" | "detailMode">): string {
    if (!update?.detail) return previous;
    const raw = update.detailMode === "append" ? `${previous}${update.detail}` : update.detail;
    return formatStatusDetailPreview(raw);
  }

  private rememberStatus(sessionId: string, messageId: string, text: string, label: string, now: number): void {
    this.deps.statusMessageBySession.set(sessionId, { messageId, text });
    this.deps.statusLabelBySession.set(sessionId, label);
    this.deps.statusLastEditAtBySession.set(sessionId, now);
  }

  private clearStatusState(sessionId: string): void {
    this.deps.statusMessageBySession.delete(sessionId);
    this.deps.statusStartedAtBySession.delete(sessionId);
    this.deps.statusLabelBySession.delete(sessionId);
    this.deps.statusDetailBySession.delete(sessionId);
    this.deps.statusLastEditAtBySession.delete(sessionId);
  }

  private async runSessionStatusOp(sessionId: string, op: () => Promise<void>): Promise<void> {
    const previous = this.deps.statusOpBySession.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(op);
    this.deps.statusOpBySession.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.deps.statusOpBySession.get(sessionId) === next) this.deps.statusOpBySession.delete(sessionId);
    }
  }

  private summarizeRecoveryIssue(event: AppServerErrorEvent): string {
    const message = event.message.replace(/\s+/g, " ").trim();
    const reconnectMatch = message.match(/Reconnecting\.\.\.\s*(\d+\s*\/\s*\d+)/i);
    if (reconnectMatch) return `Reconnecting ${reconnectMatch[1]?.replace(/\s+/g, "")}`;
    if (/apply_patch verification failed/i.test(message)) return "apply_patch failed";
    if (/No such file or directory/i.test(message) || /Failed to read file to update/i.test(message)) return "file not found";
    if (event.stage === "stream") return "stream error";
    return formatStatusDetailPreview(message);
  }
}
