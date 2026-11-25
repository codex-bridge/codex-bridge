import { CodexAppServerClient, type AppServerInteractionRequest } from "../../codex/client.js";
import { USER_INPUT_METHOD } from "../../shared/user-input.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { createMessage } from "../messages/factory.js";
import { actionRow, helpAction, sessionAction } from "../messages/actions.js";
import { SubagentTracker } from "./subagent-tracker.js";
import { canDeliverSession } from "./delivery-target.js";
import type { WorkflowAppend } from "../progress/workflow-sequence.js";
import type { WorkingUpdate } from "../status/working-window.js";

const SUPPORTED_MCP_ELICITATION_MODES = new Set([
  "form",
  "openai/form",
  "openaiForm",
  "url"
]);

export type EarlyApproval = {
  request: AppServerInteractionRequest;
  timer: ReturnType<typeof setTimeout>;
};

export type NotificationApprovalDependencies = {
  appendWorkflowMessage: WorkflowAppend;
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  subagents: SubagentTracker;
  earlyApprovals: Map<string, EarlyApproval>;
  resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
  getSessionDirectory: (session: SessionRecord) => string;
  cancelGoShortcut: (threadId: string) => void;
  setSessionStatus: (session: SessionRecord, label: string, update?: WorkingUpdate) => Promise<void>;
  sendDecisionMessage: (session: SessionRecord, decision: Awaited<ReturnType<BridgeStore["createOrReplacePendingDecision"]>>) => Promise<void>;
  syncBatchDecisionMessage: (session: SessionRecord) => Promise<void>;
  sendLongSpec: (chatId: string, messageSpec: ReturnType<typeof createMessage>) => Promise<void>;
};

export class NotificationApprovalService {
  constructor(private readonly deps: NotificationApprovalDependencies) {}

  async handleApprovalRequest(request: AppServerInteractionRequest): Promise<void> {
    const child = this.deps.subagents.route(request.threadId, request.turnId);
    const session = child
      ? await this.deps.store.getSessionById(child.sessionId)
      : await this.deps.resolveNotificationSession(request.threadId);
    if (typeof this.deps.codexClient.isApprovalPending === "function" && !this.deps.codexClient.isApprovalPending(request.requestId)) return;
    if (!session) {
      if (!child && this.deps.subagents.route(request.threadId, request.turnId)) {
        return this.handleApprovalRequest(request);
      }
      if (!this.deps.earlyApprovals.has(request.requestId) && this.deps.earlyApprovals.size < 128) {
        const timer = setTimeout(() => {
          this.deps.earlyApprovals.delete(request.requestId);
          void (request.method === USER_INPUT_METHOD ? this.deps.codexClient.rejectUserInput(request.requestId)
            : this.deps.codexClient.resolveApproval(request.requestId, "cancel", request.method))
            .catch((error) => logger.warn("bridge.approval.unmapped_cancel_failed", { error: String(error) }));
        }, 10_000);
        timer.unref();
        this.deps.earlyApprovals.set(request.requestId, { request, timer });
      } else if (!this.deps.earlyApprovals.has(request.requestId)) {
        if (request.method === USER_INPUT_METHOD) await this.deps.codexClient.rejectUserInput(request.requestId);
        else await this.deps.codexClient.resolveApproval(request.requestId, "cancel", request.method);
      }
      logger.warn("bridge.approval.unmapped_thread", {
        requestId: request.requestId,
        threadId: request.threadId
      });
      return;
    }

    logger.info("bridge.approval.received", {
      requestId: request.requestId,
      sessionId: session.id,
      threadId: request.threadId,
      method: request.method,
      requiresUserInput: request.requiresUserInput
    });
    this.deps.cancelGoShortcut(request.threadId);

    if (
      request.method === "mcpServer/elicitation/request" &&
      !SUPPORTED_MCP_ELICITATION_MODES.has(request.elicitationMode ?? "")
    ) {
      await this.deps.codexClient.resolveApproval(request.requestId, "cancel", request.method);
      logger.warn("bridge.approval.unsupported_elicitation_cancelled", {
        requestId: request.requestId,
        sessionId: session.id,
        threadId: request.threadId,
        mode: request.elicitationMode ?? "missing"
      });
      await this.deps.appendWorkflowMessage(session, () => this.deps.sendLongSpec(session.telegramChatId, createMessage({
        kind: "system",
        session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
        body: [{
          type: "text",
          text: request.elicitationMode === "openai/userVerification"
            ? "Verification must be completed in Codex App."
            : "This MCP request cannot be completed in Bridge. Continue in Codex App."
        }]
      })), { turnId: child?.parentTurnId ?? request.turnId ?? undefined });
      return;
    }

    if (request.method === "mcpServer/elicitation/request" && !request.requiresUserInput) {
      try {
        await this.deps.codexClient.resolveApproval(request.requestId, "accept", request.method);
        logger.info("bridge.approval.auto_accepted", {
          requestId: request.requestId,
          sessionId: session.id,
          threadId: request.threadId,
          method: request.method,
          title: request.title
        });
      } catch (error) {
        logger.warn("bridge.approval.auto_accept_failed", {
          requestId: request.requestId,
          sessionId: session.id,
          threadId: request.threadId,
          method: request.method,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      return;
    }

    let decision = await this.deps.store.createOrReplacePendingDecision({
      sessionId: session.id,
      telegramChatId: session.telegramChatId,
      approvalId: request.requestId,
      kind: request.method,
      commandApprovalKind: request.commandApprovalKind,
      availableDecisions: request.availableDecisions,
      title: child ? `${child.name}: ${request.title}` : request.title,
      summary: request.summary,
      requiresUserInput: request.requiresUserInput
    });

    if (request.method === USER_INPUT_METHOD) decision = await this.deps.store.resolveDecision(decision.id, "awaitingInput") ?? decision;

    if (await canDeliverSession(this.deps.store, session)) {
      await this.deps.setSessionStatus(session, request.method === USER_INPUT_METHOD ? "Waiting for answers" : "Waiting for approval", { immediate: true });
      const deliver = async () => {
        await this.deps.sendDecisionMessage(session, decision);
        await this.deps.syncBatchDecisionMessage(session);
      };
      if (!decision.telegramMessageId || decision.telegramChatId !== session.telegramChatId) {
        await this.deps.appendWorkflowMessage(session, deliver, { turnId: child?.parentTurnId ?? request.turnId ?? undefined });
      } else await deliver();
    } else {
      const messageSpec = createMessage({
        kind: "decision",
        session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
        body: [
          { type: "text", text: "This session has a new pending decision. Switch back to it before taking action." },
          { type: "text", text: "Use /sessions to open the menu." }
        ],
        actions: actionRow(sessionAction(), helpAction())
      });
      await this.deps.appendWorkflowMessage(session, () => this.deps.sendLongSpec(session.telegramChatId, messageSpec),
        { turnId: child?.parentTurnId ?? request.turnId ?? undefined });
    }
  }
}
