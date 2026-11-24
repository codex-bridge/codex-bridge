import {
  parseCoreInteractionAction,
  type CoreInteractionAction
} from "../../bridge/interactions/action.js";
import type { InteractionContext } from "../../bridge/interactions/types.js";
import { handleCoreInteraction } from "../../bridge/interactions/router.js";
import type { BridgeTelegramInteractionPort } from "../../bridge/contracts.js";
import { handleTelegramApproval } from "./approvals.js";
import { deliverTelegramInteraction, type TelegramInteractionResponder } from "./responder.js";
import { handleTelegramSessionWorkflow } from "./session-workflow.js";
import { handleTelegramTurnWorkflow } from "./turn-workflow.js";
import { sendTelegramInteractionNotice } from "./feedback.js";

function isSharedTelegramAction(action: CoreInteractionAction): boolean {
  return action.type !== "help" &&
    action.type !== "approval.resolve" &&
    action.type !== "approval.batch.resolve" &&
    action.type !== "approval.invalid";
}

export async function dispatchTelegramInteraction(input: {
  action: string;
  callbackId: string;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeTelegramInteractionPort;
}): Promise<void> {
  if (input.action === "noop") {
    return;
  }
  if (await handleTelegramTurnWorkflow(input)) return;
  if (await handleTelegramSessionWorkflow(input)) return;
  if (await handleTelegramApproval(input)) return;

  const action = parseCoreInteractionAction(input.action);
  if (!action || !isSharedTelegramAction(action)) {
    await sendTelegramInteractionNotice(input.service, input.responder, input.context.conversationId, "Unknown action.");
    return;
  }

  const delivery = await handleCoreInteraction(input.service, input.context, action);
  await deliverTelegramInteraction(input.context, delivery, input.responder);
}
