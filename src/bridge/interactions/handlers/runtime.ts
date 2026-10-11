import type { BridgeRuntimePort } from "../../contracts.js";
import type { PrimaryInteractionAction } from "../action.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";

type RuntimeAction = Extract<PrimaryInteractionAction, { type: "runtime.connect" | "runtime.disconnect" }>;

export async function handleRuntimeAction(
  service: Pick<BridgeRuntimePort, "connectBotRuntimeMessage" | "disconnectBotRuntimeMessage">,
  context: InteractionContext,
  action: RuntimeAction
): Promise<InteractionDelivery> {
  const message = action.type === "runtime.connect"
    ? await service.connectBotRuntimeMessage(context.conversationId)
    : await service.disconnectBotRuntimeMessage(context.conversationId);
  return { mode: "edit", target: "surface", message };
}
