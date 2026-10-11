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

function isSharedTelegramAction(action: CoreInteractionAction): boolean {
  return action.type !== "help" &&
    action.type !== "approval.resolve" &&
    action.type !== "approval.batch.resolve" &&
    action.type !== "approval.invalid";
}

export async function dispatchTelegramInteraction(input: {
  action: string;
  acknowledge: (text?: string) => Promise<void>;
  callbackId: string;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeTelegramInteractionPort;
}): Promise<void> {
  if (input.action === "noop") {
    await input.acknowledge();
    return;
  }
  if (await handleTelegramTurnWorkflow(input)) return;
  if (await handleTelegramSessionWorkflow(input)) return;
  if (await handleTelegramApproval(input)) return;

  const action = parseCoreInteractionAction(input.action);
  if (!action || !isSharedTelegramAction(action)) {
    await input.acknowledge("Unknown action.");
    return;
  }

  await input.acknowledge(action.type === "turn.interrupt" ? "Interrupting..." : undefined);
  const delivery = await handleCoreInteraction(input.service, input.context, action);
  await deliverTelegramInteraction(input.context, delivery, input.responder);
}
