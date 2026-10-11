import { parseApprovalInteractionAction } from "../../bridge/interactions/action.js";
import type { InteractionContext } from "../../bridge/interactions/types.js";
import type { BridgeDecisionPort } from "../../bridge/contracts.js";
import type { TelegramInteractionResponder } from "./responder.js";

export async function handleTelegramApproval(input: {
  action: string;
  acknowledge: (text?: string) => Promise<void>;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeDecisionPort;
}): Promise<boolean> {
  const action = parseApprovalInteractionAction(input.action);
  if (!action) return false;
  if (action.type === "approval.invalid") {
    await input.acknowledge("Invalid decision action.");
    return true;
  }

  if (action.type === "approval.resolve") {
    const result = await input.service.handleDecision(
      action.decisionId,
      action.decision,
      input.context.conversationId
    );
    await input.acknowledge(result.message);
    if (result.ok) await input.responder.clearActions();
    return true;
  }

  const result = await input.service.handleBatchDecision(
    action.sessionId,
    action.decision,
    input.context.conversationId,
    action.expectedLeaseVersion
  );
  await input.acknowledge(result.message);
  return true;
}
