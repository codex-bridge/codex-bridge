import type { DecisionAction, DecisionRecord, SessionRecord } from "../shared/types.js";
import type { BridgeStore } from "../store/index.js";
import { WEB_SOURCE_ID } from "../shared/source-address.js";
import type { SessionAccessService } from "../bridge/sessions/access.js";
import type { DecisionCommandService } from "../bridge/decisions/commands.js";
import { createDecisionMessageSpec } from "../bridge/decisions/formatters.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { presentWebMessage, type WebMessageSpec } from "./message-presentation.js";

export class WebDecisionError extends Error {
  constructor(readonly reason: "inactive" | "invalid_action" | "disconnected" | "unavailable") {
    super({ inactive: "This request is no longer active. Refresh its state.",
      invalid_action: "This action is unavailable for this request.", disconnected: "Codex runtime is disconnected.",
      unavailable: "Decision is unavailable for this session." }[reason]);
  }
}

export type WebDecisionInput = { threadId: string; leaseVersion?: number; decisionId: string } &
  ({ action: DecisionAction; content?: never } | { action: "submit"; content: Record<string, unknown> });
export type WebDecisionReceipt = { accepted: boolean; decisionId: string; state: DecisionRecord["state"] | null;
  message?: string; assertCurrent?: () => void };
export type WebDecisionSnapshot = { threadId: string; sessionId: string; leaseVersion: number; decisions: WebMessageSpec[] };

export function presentWebDecision(session: SessionRecord, decision: DecisionRecord, connected: boolean, active: boolean): MessageSpec {
  const expired = connected && !active && (decision.state === "pending" || decision.state === "awaitingInput");
  const message = createDecisionMessageSpec(session, expired ? { ...decision, state: "stale" } : decision, []);
  if (!connected || expired) {
    message.decision!.availableActions = [];
    message.decision!.inputAllowed = false;
    message.decision!.unavailableReason = expired ? "original_request_inactive" : "runtime_disconnected";
    message.body.push({ type: "field", label: "Reason", value: expired
      ? "The original Codex request is no longer active." : "Codex runtime is disconnected. Refresh after reconnecting." });
  }
  return message;
}

/** Explicit session actions; never chat selection, callbacks, claims or a reconnect. */
export class WebDecisionService {
  constructor(private readonly deps: {
    access: SessionAccessService;
    store: Pick<BridgeStore, "listOpenDecisions" | "getDecision">;
    commands: Pick<DecisionCommandService, "handle" | "submitInput">;
    isRuntimeConnected: () => boolean;
    isApprovalPending: (approvalId: string) => boolean;
    runDispatch: <T>(session: SessionRecord, operation: () => Promise<T>) => Promise<T>;
  }) {}

  async read(threadId: string, version: number | undefined, assertRequestCurrent: () => void): Promise<{
    snapshot: WebDecisionSnapshot; assertCurrent: () => void
  }> {
    const access = await this.deps.access.requireOwned(threadId, WEB_SOURCE_ID, version, assertRequestCurrent);
    const decisions = await this.deps.store.listOpenDecisions(access.session.id);
    access.assertCurrent();
    const current = await this.deps.access.requireOwned(threadId, WEB_SOURCE_ID, access.leaseVersion, assertRequestCurrent);
    if (current.session.id !== access.session.id) throw new WebDecisionError("unavailable");
    access.assertCurrent();
    const messages = decisions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((decision) => presentWebMessage(presentWebDecision(access.session, decision,
        this.deps.isRuntimeConnected(), this.deps.isApprovalPending(decision.approvalId))));
    return { snapshot: { threadId, sessionId: access.session.id, leaseVersion: access.leaseVersion, decisions: messages },
      assertCurrent: access.assertCurrent };
  }

  async act(input: WebDecisionInput, assertRequestCurrent: () => void): Promise<WebDecisionReceipt> {
    const access = await this.deps.access.requireOwned(input.threadId, WEB_SOURCE_ID, input.leaseVersion, assertRequestCurrent);
    return this.deps.runDispatch(access.session, async () => {
      access.assertCurrent();
      const decision = await this.deps.store.getDecision(input.decisionId);
      access.assertCurrent();
      if (!decision || decision.sessionId !== access.session.id) throw new WebDecisionError("unavailable");
      const assertCurrent = (): void => {
        access.assertCurrent();
        if (!this.deps.isRuntimeConnected()) throw new WebDecisionError("disconnected");
        if (!this.deps.isApprovalPending(decision.approvalId)) throw new WebDecisionError("inactive");
      };
      assertCurrent();
      const controls = presentWebDecision(access.session, decision, true, true).decision!;
      if (input.action === "submit" ? !controls.inputAllowed : !controls.availableActions.includes(input.action)) {
        throw new WebDecisionError("invalid_action");
      }
      const guard = { sessionId: access.session.id, threadId: input.threadId, assertCurrent };
      const result = input.action === "submit"
        ? await this.deps.commands.submitInput(decision.id, input.content, guard)
        : await this.deps.commands.handle(decision.id, input.action, WEB_SOURCE_ID, guard);
      const current = await this.deps.store.getDecision(decision.id);
      // After answering, finish bookkeeping even if the window is replaced. Only a minimal receipt is returned.
      if (result.ok) return { accepted: true, decisionId: decision.id, state: current?.state ?? null };
      access.assertCurrent();
      return { accepted: false, decisionId: decision.id, state: current?.state ?? null,
        message: result.message, assertCurrent: access.assertCurrent };
    });
  }
}
