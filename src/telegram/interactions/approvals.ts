import { parseApprovalInteractionAction } from "../../bridge/interactions/action.js";
import type { InteractionContext } from "../../bridge/interactions/types.js";
import type { BridgeChatPort, BridgeDecisionPort } from "../../bridge/contracts.js";
import type { TelegramInteractionResponder } from "./responder.js";
import { sendTelegramInteractionNotice } from "./feedback.js";

export async function handleTelegramApproval(input: {
  action: string;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeDecisionPort & Pick<BridgeChatPort, "getActiveSessionContext">;
}): Promise<boolean> {
  const action = parseApprovalInteractionAction(input.action);
  if (!action) return false;
  if (action.type === "approval.invalid") {
    await sendTelegramInteractionNotice(input.service, input.responder, input.context.conversationId, "Invalid decision action.");
    return true;
  }

  if (action.type === "approval.resolve") {
    const result = await input.service.handleDecision(
      action.decisionId,
      action.decision,
      input.context.conversationId
    );
    if (!result.ok) await sendTelegramInteractionNotice(input.service, input.responder, input.context.conversationId, result.message);
    if (result.ok) await input.responder.clearActions();
    return true;
  }

  const result = await input.service.handleBatchDecision(
    action.sessionId,
    action.decision,
    input.context.conversationId,
    action.expectedLeaseVersion
  );
  if (!result.ok) await sendTelegramInteractionNotice(input.service, input.responder, input.context.conversationId, result.message);
  return true;
}
