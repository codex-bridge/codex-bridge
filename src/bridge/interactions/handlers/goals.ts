import type { BridgeGoalPort } from "../../contracts.js";
import type { GoalInteractionAction } from "../action.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";

export async function handleGoalAction(
  service: BridgeGoalPort,
  context: InteractionContext,
  action: GoalInteractionAction
): Promise<InteractionDelivery> {
  const chatId = context.conversationId;
  let message;
  switch (action.type) {
    case "goal.navigate":
      message = action.view === "current"
        ? await service.renderActiveGoal(chatId)
        : await service.renderGoalsMenu(chatId, action.page);
      return action.delivery === "send"
        ? { mode: "send", target: "conversation", message }
        : { mode: "edit", target: "surface", message };
    case "goal.view":
      message = await service.renderSelectedGoal(chatId, action.goalId);
      break;
    case "goal.set-status":
      message = await service.updateGoalStatus(chatId, action.goalId, action.status);
      break;
    case "goal.clear.request":
      message = action.goalId
        ? await service.requestClearGoal(chatId, action.goalId)
        : await service.requestClearActiveGoal(chatId);
      break;
    case "goal.clear.confirm":
      message = action.goalId
        ? await service.clearGoal(chatId, action.goalId)
        : await service.clearActiveGoal(chatId);
      break;
    case "goal.clear.cancel":
      message = await service.renderActiveGoal(chatId);
      break;
    case "goal.active.set-status":
      message = await service.updateActiveGoalStatus(chatId, action.status);
      break;
  }
  return { mode: "edit", target: "surface", message };
}
