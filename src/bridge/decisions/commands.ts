import { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { DecisionAction, DecisionRecord, SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { helpAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";
import type { BridgeMessageOptions } from "../transport.js";
import { SessionOwnershipService } from "../sessions/ownership.js";
import {
  buildAwaitingMcpPrompt,
  describeBatchAction,
  getDecisionRequestedFields,
  getExecpolicyAmendment,
  getRequestedPermissions,
  validateDecisionInput,
  describeDecision,
  isBatchableDecision
} from "./formatters.js";
import type { DecisionDeliveryService } from "./delivery.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";

export type DecisionOperationGuard = { sessionId: string; threadId: string; assertCurrent: () => void };

type BatchDecisionAction = Extract<DecisionAction, "accept" | "decline" | "cancel">;

export type DecisionCommandDependencies = {
  store: BridgeStore;
  codexClient: Pick<CodexAppServerClient, "resolveApproval">;
  sessionOwnershipService: Pick<SessionOwnershipService, "getSessionOwnershipPrompt">;
  decisionDelivery: Pick<
    DecisionDeliveryService,
    "clearDecisionMessageActions" | "syncBatchDecisionMessage" | "syncBatchDecisionMessageForSessionId"
  >;
  createMcpInputPromptSpec: (session: SessionRecord, decision: DecisionRecord) => MessageSpec;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec, options?: BridgeMessageOptions) => Promise<void>;
};

export class DecisionCommandService {
  private readonly operations = new KeyedQueue();
  constructor(private readonly deps: DecisionCommandDependencies) {}

  async handle(decisionId: string, action: DecisionAction, sourceId?: string, guard?: DecisionOperationGuard): Promise<{ ok: boolean; message: string }> {
    return this.operations.run(decisionId, () => this.handleCurrent(decisionId, action, sourceId, guard));
  }

  private async handleCurrent(
    decisionId: string,
    action: DecisionAction,
    sourceId?: string,
    guard?: DecisionOperationGuard
  ): Promise<{ ok: boolean; message: string }> {
    // COMPATIBILITY(MESSAGE_FACTORY): decision results remain string-based for legacy command handlers.
    const decision = await this.deps.store.getDecision(decisionId);
    guard?.assertCurrent();
    if (decision && guard && decision.sessionId !== guard.sessionId) return { ok: false, message: "This decision does not belong to this session." };
    if (!decision) {
      logger.warn("bridge.decision.missing", { decisionId });
      return { ok: false, message: "This decision no longer exists." };
    }

    if (decision.state !== "pending" && !(guard && decision.state === "awaitingInput")) {
      await this.deps.decisionDelivery.clearDecisionMessageActions(decision);
      logger.warn("bridge.decision.inactive", { decisionId, state: decision.state });
      return { ok: false, message: "This decision button is no longer active." };
    }

    const decisionSession = await this.deps.store.getSessionById(decision.sessionId);
    const decisionSourceId = sourceId ?? decision.telegramChatId;
    guard?.assertCurrent();
    if (guard && (!decisionSession || decisionSession.codexArchivedAt !== null || decisionSession.codexThreadId !== guard.threadId)) {
      return { ok: false, message: "This request's session changed. Refresh its state." };
    }
    if (guard && !describeDecision(decision).availableActions.includes(action)) return { ok: false, message: "This action is unavailable for this request." };
    if (!guard && decisionSession) {
      const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(
        decisionSession,
        decisionSourceId
      );
      if (ownershipPrompt) {
        return { ok: false, message: renderLegacyMessage(ownershipPrompt) };
      }
    }

    const activeSession = guard ? decisionSession : await this.deps.store.getActiveSession(decisionSourceId);
    guard?.assertCurrent();
    if (!activeSession || activeSession.id !== decision.sessionId) {
      const staleDecision = await this.deps.store.resolveDecision(decision.id, "stale");
      await this.deps.decisionDelivery.clearDecisionMessageActions(staleDecision ?? decision);
      logger.warn("bridge.decision.wrong_session", {
        decisionId,
        activeSessionId: activeSession?.id ?? null,
        decisionSessionId: decision.sessionId
      });
      return { ok: false, message: "This is not the active session. The button is now invalid." };
    }

    if (decision.kind === "mcpServer/elicitation/request" && action === "accept") {
      if (decision.requiresUserInput) {
        guard?.assertCurrent();
        const awaitingDecision = await this.deps.store.resolveDecision(decision.id, "awaitingInput");
        await this.deps.decisionDelivery.clearDecisionMessageActions(awaitingDecision ?? decision);
        await this.deps.decisionDelivery.syncBatchDecisionMessageForSessionId(decision.sessionId);
        // Native clients enter the input state on the original card. The chat-only
        // prompt would create a second card and can target a previous chat source.
        if (guard) return { ok: true, message: "Awaiting MCP JSON input." };
        const promptSpec = decisionSession
          ? this.deps.createMcpInputPromptSpec(decisionSession, decision)
          : createMessage({
              kind: "mcp",
              scope: "global",
              titleLabel: "MCP Input Required",
              body: [{ type: "text", text: buildAwaitingMcpPrompt(decision) }],
              actions: [helpAction()]
            });
        logger.info("bridge.elicitation.awaiting_input", {
          decisionId: decision.id,
          approvalId: decision.approvalId,
          chatId: decision.telegramChatId,
          fields: getDecisionRequestedFields(decision)
        });
        await this.deps.sendLongSpec(decision.telegramChatId, promptSpec,
          { unavailableThreadNotice: { kind: "action-required" } });
        return { ok: true, message: "Awaiting MCP JSON input." };
      }

      guard?.assertCurrent();
      await this.deps.codexClient.resolveApproval(decision.approvalId, action, decision.kind);
      const approvedDecision = await this.deps.store.resolveDecision(decision.id, "approved");
      await this.deps.decisionDelivery.clearDecisionMessageActions(approvedDecision ?? decision);
      await this.deps.decisionDelivery.syncBatchDecisionMessageForSessionId(decision.sessionId);
      logger.info("bridge.elicitation.approved_without_input", {
        decisionId: decision.id,
        approvalId: decision.approvalId
      });
      return { ok: true, message: "Approved." };
    }

    const execpolicyAmendment = getExecpolicyAmendment(decision);
    const permissions = getRequestedPermissions(decision);
    const effectiveAction =
      action === "acceptForSession" && execpolicyAmendment
        ? "acceptWithExecpolicyAmendment"
        : action;
    guard?.assertCurrent();
    await this.deps.codexClient.resolveApproval(
      decision.approvalId,
      effectiveAction,
      decision.kind,
      execpolicyAmendment ? { execpolicyAmendment } : permissions ? { permissions } : undefined
    );
    const nextState =
      action === "accept"
        ? "approved"
        : action === "acceptForSession" || action === "acceptWithExecpolicyAmendment"
          ? "approvedForSession"
          : action === "cancel"
            ? "cancelled"
            : "rejected";
    const resolvedDecision = await this.deps.store.resolveDecision(decision.id, nextState);
    await this.deps.decisionDelivery.clearDecisionMessageActions(resolvedDecision ?? decision);
    await this.deps.decisionDelivery.syncBatchDecisionMessageForSessionId(decision.sessionId);
    logger.info("bridge.decision.resolved", {
      decisionId,
      approvalId: decision.approvalId,
      action,
      effectiveAction
    });
    return {
      ok: true,
      message:
        action === "accept"
          ? "Approved for this request."
          : action === "acceptForSession" || action === "acceptWithExecpolicyAmendment"
            ? execpolicyAmendment
              ? "Allowed matching command for this session."
              : "Approved for this session."
            : action === "cancel"
              ? "Cancelled."
              : "Declined."
    };
  }

  async submitInput(decisionId: string, content: unknown, guard: DecisionOperationGuard): Promise<{ ok: boolean; message: string }> {
    return this.operations.run(decisionId, async () => {
      const decision = await this.deps.store.getDecision(decisionId);
      guard.assertCurrent();
      if (!decision || decision.sessionId !== guard.sessionId || !describeDecision(decision).inputAllowed) {
        return { ok: false, message: "This request is not awaiting structured input." };
      }
      const session = await this.deps.store.getSessionById(guard.sessionId);
      guard.assertCurrent();
      if (!session || session.codexArchivedAt !== null || session.codexThreadId !== guard.threadId) {
        return { ok: false, message: "This request's session changed. Refresh its state." };
      }
      let input: Record<string, unknown>;
      try { input = validateDecisionInput(decision, content); }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Invalid input." }; }
      guard.assertCurrent();
      await this.deps.codexClient.resolveApproval(decision.approvalId, "accept", decision.kind, input);
      const resolved = await this.deps.store.resolveDecision(decision.id, "approved");
      await this.deps.decisionDelivery.clearDecisionMessageActions(resolved ?? decision);
      await this.deps.decisionDelivery.syncBatchDecisionMessageForSessionId(decision.sessionId);
      return { ok: true, message: "Submitted the MCP response." };
    });
  }

  async handleBatch(
    sessionId: string,
    action: BatchDecisionAction,
    sourceId?: string,
    expectedLeaseVersion?: number
  ): Promise<{ ok: boolean; message: string }> {
    // COMPATIBILITY(MESSAGE_FACTORY): batch decision results remain string-based for legacy command handlers.
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) {
      return { ok: false, message: "This session no longer exists." };
    }

    const decisionSourceId = sourceId ?? session.telegramChatId;
    const lease = this.deps.store.getSessionLease(session.id);
    if (expectedLeaseVersion !== undefined && lease?.version !== expectedLeaseVersion) {
      return { ok: false, message: "This batch action is stale. Refresh the session state first." };
    }

    const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, decisionSourceId);
    if (ownershipPrompt) {
      return { ok: false, message: renderLegacyMessage(ownershipPrompt) };
    }
    const activeSession = await this.deps.store.getActiveSession(decisionSourceId);
    if (!activeSession || activeSession.id !== session.id) {
      await this.deps.decisionDelivery.syncBatchDecisionMessage(session);
      return { ok: false, message: "This is not the active session. The batch button is now invalid." };
    }

    const batchable = (await this.deps.store.listPendingDecisions(session.id))
      .filter((decision) => isBatchableDecision(decision))
      .sort((left, right) => left.createdAt - right.createdAt);
    if (batchable.length === 0) {
      await this.deps.decisionDelivery.syncBatchDecisionMessage(session);
      return { ok: false, message: "No batchable pending approvals remain." };
    }

    let processed = 0;
    for (const decision of batchable) {
      try {
        await this.deps.codexClient.resolveApproval(decision.approvalId, action, decision.kind);
        const resolvedDecision = await this.deps.store.resolveDecision(
          decision.id,
          action === "accept" ? "approved" : action === "cancel" ? "cancelled" : "rejected"
        );
        await this.deps.decisionDelivery.clearDecisionMessageActions(resolvedDecision ?? decision);
        processed += 1;
      } catch (error) {
        logger.warn("bridge.decision.batch_partial_failure", {
          sessionId: session.id,
          decisionId: decision.id,
          approvalId: decision.approvalId,
          action,
          processed,
          total: batchable.length,
          error: error instanceof Error ? error.message : String(error)
        });
        await this.deps.decisionDelivery.syncBatchDecisionMessage(session);
        const remaining = batchable.length - processed;
        return {
          ok: false,
          message:
            processed > 0
              ? `${describeBatchAction(action, processed)} Stopped on 1 failed request. ${remaining} remain pending.`
              : "The first pending request failed, so the batch was not applied."
        };
      }
    }

    await this.deps.decisionDelivery.syncBatchDecisionMessage(session);
    logger.info("bridge.decision.batch_resolved", {
      sessionId: session.id,
      action,
      count: processed
    });
    return { ok: true, message: describeBatchAction(action, processed) };
  }
}
