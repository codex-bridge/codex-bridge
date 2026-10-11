import type { KnownBlock } from "@slack/types";

import type { BridgeSlackInteractionPort } from "../../bridge/contracts.js";
import type { InteractionContext } from "../../bridge/interactions/types.js";
import { routeCoreInteraction } from "../../bridge/interactions/router.js";
import { helpAction } from "../../bridge/messages/actions.js";
import { createMessage } from "../../bridge/messages/factory.js";
import type { SlackMessageTransport } from "../transport.js";
import { deliverSlackInteraction } from "./responder.js";
import { handleSlackSessionWorkflow } from "./session-workflow.js";
import { handleSlackTurnWorkflow } from "./turn-workflow.js";

export async function dispatchSlackInteraction(input: {
  action: string;
  context: InteractionContext;
  messageBlocks: KnownBlock[] | null;
  messageText: string | null;
  openQueueModal: (triggerId: string, chatId: string) => Promise<void>;
  service: BridgeSlackInteractionPort;
  transport: SlackMessageTransport;
}): Promise<void> {
  const { action, context, service, transport } = input;
  if (!action || action === "noop") return;

  const delivery = await routeCoreInteraction(service, context, action);
  if (delivery) {
    await deliverSlackInteraction(transport, context, delivery);
    return;
  }
  if (await handleSlackSessionWorkflow(input)) return;
  if (await handleSlackTurnWorkflow(input)) return;

  await transport.sendMessageSpec(context.conversationId, createMessage({
    kind: "system",
    titleLabel: "Codex",
    session: await service.getActiveSessionContext(context.conversationId),
    body: [{ type: "text", text: "Unknown action." }],
    actions: [helpAction()]
  }));
}
