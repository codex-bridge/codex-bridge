import type { BridgeChatPort, BridgeDecisionPort } from "../../contracts.js";
import { helpAction } from "../../messages/actions.js";
import { createMessage, messageContextForSession } from "../../messages/factory.js";
import type { ApprovalInteractionAction } from "../action.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";

export async function handleApprovalAction(
  service: BridgeChatPort & BridgeDecisionPort,
  context: InteractionContext,
  action: ApprovalInteractionAction
): Promise<InteractionDelivery> {
  const chatId = context.conversationId;
  let text: string;
  if (action.type === "approval.invalid") {
    text = "Invalid decision action.";
  } else if (action.type === "approval.resolve") {
    text = (await service.handleDecision(action.decisionId, action.decision, chatId)).message;
  } else {
    text = (await service.handleBatchDecision(
      action.sessionId,
      action.decision,
      chatId,
      action.expectedLeaseVersion
    )).message;
  }
  return {
    mode: "send",
    target: "conversation",
    message: createMessage({
      kind: "system",
      titleLabel: "Codex",
      ...messageContextForSession(await service.getActiveSessionContext(chatId)),
      body: [{ type: "text", text }],
      actions: [helpAction()]
    })
  };
}
