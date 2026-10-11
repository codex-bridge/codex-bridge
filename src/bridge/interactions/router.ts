import { parseCoreInteractionAction, type CoreInteractionAction } from "./action.js";
import type { InteractionContext, InteractionDelivery } from "./types.js";
import { handleApprovalAction } from "./handlers/approvals.js";
import { handleGoalAction } from "./handlers/goals.js";
import { handleHelpAction } from "./handlers/help.js";
import { handleRuntimeAction } from "./handlers/runtime.js";
import { handleOpenSessionsAction, handleSessionAction } from "./handlers/sessions.js";
import { handleStatusAction } from "./handlers/status.js";
import { handleTurnAction } from "./handlers/turns.js";
import type { BridgeCoreInteractionPort } from "../contracts.js";

export async function handleCoreInteraction(
  service: BridgeCoreInteractionPort,
  context: InteractionContext,
  action: CoreInteractionAction
): Promise<InteractionDelivery> {
  switch (action.type) {
      case "help": return handleHelpAction(service, context);
      case "sessions.open": return handleOpenSessionsAction(service, context);
      case "runtime.connect":
      case "runtime.disconnect":
      return handleRuntimeAction(service, context, action);
    case "session.handoff":
    case "session.archive":
    case "session.delete.request":
    case "session.delete.confirm":
    case "session.release":
    case "session.directory.open":
    case "session.directory.page":
    case "session.create":
    case "session.menu.refresh":
    case "session.archived.open":
    case "session.archived.page":
    case "session.unarchive":
    case "session.menu.page":
      return handleSessionAction(service, context, action);
    case "goal.navigate":
    case "goal.view":
    case "goal.set-status":
    case "goal.clear.request":
    case "goal.clear.confirm":
    case "goal.clear.cancel":
    case "goal.active.set-status":
      return handleGoalAction(service, context, action);
    case "status.view":
      return handleStatusAction(service, context, action);
    case "turn.interrupt":
    case "turn.compact":
    case "runtime.restart":
    case "queue.cancel":
      return handleTurnAction(service, context, action);
    case "approval.resolve":
    case "approval.batch.resolve":
    case "approval.invalid":
      return handleApprovalAction(service, context, action);
  }
}

export async function routeCoreInteraction(
  service: BridgeCoreInteractionPort,
  context: InteractionContext,
  value: string
): Promise<InteractionDelivery | null> {
  const action = parseCoreInteractionAction(value);
  return action ? handleCoreInteraction(service, context, action) : null;
}
