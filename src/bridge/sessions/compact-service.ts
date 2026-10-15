import type { AppServerStatusUpdate, CodexAppServerClient } from "../../codex/client.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { createMessage } from "../messages/factory.js";
import { helpAction } from "../messages/actions.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";
import type { BridgeMessageOptions } from "../transport.js";
import type { SessionOwnershipService } from "./ownership.js";

export type CompactEventSource = "manual" | "bridge-auto" | "runtime";

type CompactEventState = {
  completedAt: number | null;
  completedNotified: boolean;
  source: CompactEventSource;
  startedAt: number;
  startedNotified: boolean;
};

type RecoveryState = {
  originalText: string;
  phase: "compacting" | "retrying";
};

type CompactStore = Pick<BridgeStore, "getActiveSession">;
type CompactClient = Pick<CodexAppServerClient, "sendTurn" | "startCompactThread" | "resumeThread">;

export type CompactServiceDependencies = {
  store: CompactStore;
  codexClient: CompactClient;
  isRuntimeConnected: () => boolean;
  getLastUserInput: (sessionId: string) => string | undefined;
  getSessionDirectory: (session: SessionRecord) => string;
  formatCompactTokenCount: (threadId: string) => string;
  isMissingRuntimeThreadError: (error: unknown) => boolean;
  resumeThread: (threadId: string, cwd?: string) => Promise<{ displayPath: string | null; messages: unknown[] }>;
  rememberNotificationSession: (session: SessionRecord) => void;
  setSessionStatus: (session: SessionRecord, label: string) => Promise<void>;
  sendSystemErrorMessage: (session: SessionRecord, stage: "stream" | "error", message: string) => Promise<void>;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec, options?: Omit<BridgeMessageOptions, "messageSpec">) => Promise<void>;
};

export type SessionCompactDependencies = {
  store: Pick<BridgeStore, "getActiveSession">;
  compactService: CompactService;
  sessionOwnershipService: SessionOwnershipService;
};

export class CompactService {
  private readonly compactEventsByThread = new Map<string, CompactEventState>();
  private readonly sessionRecovery = new Map<string, RecoveryState>();

  constructor(private readonly deps: CompactServiceDependencies) {}

  async compactActiveSession(telegramChatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!this.deps.isRuntimeConnected()) return this.errorResult(session, "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    if (!session) return this.errorResult(null, "No active session to compact.");
    return this.compactSession(session);
  }

  async compactSession(session: SessionRecord): Promise<MessageSpec> {
    if (!this.deps.isRuntimeConnected()) return this.errorResult(session, "Codex runtime is disconnected.\nUse /bot_connect to reconnect.");
    this.deps.rememberNotificationSession(session);
    await this.deps.setSessionStatus(session, "Compacting");

    const threadId = session.codexThreadId;
    const currentCwd = this.deps.getSessionDirectory(session);
    let resumeWarning: string | null = null;
    try {
      await this.deps.resumeThread(threadId, currentCwd);
    } catch (resumeErr) {
      if (this.deps.isMissingRuntimeThreadError(resumeErr)) {
        const resumeMessage = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        this.compactEventsByThread.delete(threadId);
        await this.deps.setSessionStatus(session, "Compact failed");
        return this.errorResult(session, `Compact failed.\n${resumeMessage}`);
      }
      resumeWarning = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
    }

    try {
      await this.deps.codexClient.startCompactThread(threadId);
      this.markCompactStarted(session, "manual");
      return this.startedResult(session, "manual");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (resumeWarning || this.deps.isMissingRuntimeThreadError(error)) {
        const fallbackReason = resumeWarning
          ? `\nResume warning: ${resumeWarning}`
          : "";
        this.compactEventsByThread.delete(threadId);
        await this.deps.setSessionStatus(session, "Compact failed");
        return this.errorResult(session, `Compact failed.\n${message}${fallbackReason}`);
      }
      this.compactEventsByThread.delete(session.codexThreadId);
      await this.deps.setSessionStatus(session, "Compact failed");
      return this.errorResult(session, `Compact failed.\n${message}`);
    }
  }

  markCompactStarted(session: SessionRecord, source: CompactEventSource): boolean {
    const existing = this.compactEventsByThread.get(session.codexThreadId);
    if (existing?.startedNotified && !existing.completedAt) return false;
    this.compactEventsByThread.set(session.codexThreadId, {
      completedAt: null,
      completedNotified: false,
      source,
      startedAt: Date.now(),
      startedNotified: true
    });
    return true;
  }

  async notifyCompactStarted(session: SessionRecord, source: CompactEventSource, options?: { reason?: string; next?: string }): Promise<void> {
    if (!this.markCompactStarted(session, source)) return;
    await this.deps.sendLongSpec(
      session.telegramChatId,
      this.startedSpec(session, source, options),
      {
        disable_notification: true
      }
    );
  }

  renderCompactStartedMessage(session: SessionRecord, source: CompactEventSource, options?: { reason?: string; next?: string }): string {
    // COMPATIBILITY(MESSAGE_FACTORY): keep the string compact renderer for legacy callers.
    return renderLegacyMessage(this.startedSpec(session, source, options));
  }

  async notifyCompactCompleted(session: SessionRecord, options?: { next?: string }): Promise<void> {
    const existing = this.compactEventsByThread.get(session.codexThreadId);
    if (existing?.completedNotified) return;
    this.compactEventsByThread.set(session.codexThreadId, {
      completedAt: Date.now(),
      completedNotified: true,
      source: existing?.source ?? "runtime",
      startedAt: existing?.startedAt ?? Date.now(),
      startedNotified: existing?.startedNotified ?? false
    });
    const messageSpec = createMessage({
      kind: "compact-completed",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: options?.next ? [{ type: "field", label: "Next", value: options.next }] : [],
      actions: [helpAction()]
    });
    await this.deps.sendLongSpec(session.telegramChatId, messageSpec, {
      disable_notification: true
    });
  }

  isCompactStatusUpdate(update: AppServerStatusUpdate): boolean {
    return update.activity === "contextCompaction" ||
      /\bcompact(?:ing|ed)?\b/.test(`${update.label ?? ""}\n${update.detail ?? ""}`.toLowerCase());
  }

  async handleIncompatibleHistoryError(session: SessionRecord, errorMessage: string): Promise<void> {
    const existingRecovery = this.sessionRecovery.get(session.id);
    if (existingRecovery?.phase === "retrying") {
      this.sessionRecovery.delete(session.id);
      await this.deps.sendSystemErrorMessage(session, "error", `Auto-compact retry failed.\n${errorMessage}`);
      return;
    }
    if (existingRecovery?.phase === "compacting") return;
    const originalText = this.deps.getLastUserInput(session.id);
    if (!originalText) {
      await this.deps.sendSystemErrorMessage(session, "error", errorMessage);
      return;
    }
    this.sessionRecovery.set(session.id, { originalText, phase: "compacting" });
    await this.deps.setSessionStatus(session, `Compacting${this.deps.formatCompactTokenCount(session.codexThreadId)}`);
    await this.notifyCompactStarted(session, "bridge-auto", {
      reason: "incompatible history",
      next: "retrying your last message once"
    });
    await this.deps.codexClient.sendTurn(session.codexThreadId, "compact", this.deps.getSessionDirectory(session));
  }

  async handleRecoveryTaskComplete(session: SessionRecord): Promise<boolean> {
    const recovery = this.sessionRecovery.get(session.id);
    if (!recovery || recovery.phase !== "compacting") {
      if (recovery?.phase === "retrying") this.sessionRecovery.delete(session.id);
      return false;
    }
    this.sessionRecovery.set(session.id, { originalText: recovery.originalText, phase: "retrying" });
    await this.deps.setSessionStatus(session, "Retrying");
    await this.notifyCompactCompleted(session, { next: "Retrying last message" });
    await this.deps.codexClient.sendTurn(session.codexThreadId, recovery.originalText, this.deps.getSessionDirectory(session));
    return true;
  }

  clearRetryingRecovery(sessionId: string): void {
    if (this.sessionRecovery.get(sessionId)?.phase === "retrying") this.sessionRecovery.delete(sessionId);
  }

  private startedResult(session: SessionRecord, source: CompactEventSource, prefix?: string): MessageSpec {
    return this.startedSpec(session, source, undefined, prefix);
  }

  private startedSpec(
    session: SessionRecord,
    source: CompactEventSource,
    options?: { reason?: string; next?: string },
    prefix?: string
  ): MessageSpec {
    return createMessage({
      kind: "compact-started",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        ...(prefix ? [{ type: "text" as const, text: prefix }] : []),
        { type: "text", text: `Triggered by ${source === "manual" ? "you" : source === "bridge-auto" ? "Bridge" : "Codex"}` },
        ...(options?.reason ? [{ type: "field" as const, label: "Reason", value: options.reason }] : []),
        ...(options?.next ? [{ type: "field" as const, label: "Next", value: options.next }] : [])
      ]
    });
  }

  private errorResult(session: SessionRecord | null, text: string): MessageSpec {
    return createMessage({
      kind: "error",
      session: session ? { id: session.id, directory: this.deps.getSessionDirectory(session) } : undefined,
      body: [{ type: "text", text }]
    });
  }
}

export class SessionCompactService {
  constructor(private readonly deps: SessionCompactDependencies) {}

  async compact(chatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(chatId);
    if (session) {
      const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (ownershipPrompt) return ownershipPrompt;
    }
    return this.deps.compactService.compactActiveSession(chatId);
  }
}
