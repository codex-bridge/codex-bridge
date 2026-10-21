import { helpMenuActions } from "../../bridge/messages/actions.js";
import { createMessage, messageContextForSession } from "../../bridge/messages/factory.js";
import type { ActionSpec, MessageSpec, SessionContext } from "../../bridge/messages/types.js";

export function createTelegramHelpMessage(
  session?: SessionContext,
  actions: ActionSpec[] = helpMenuActions()
): MessageSpec {
  return createMessage({
    kind: "menu",
    titleLabel: "Help",
    ...messageContextForSession(session),
    actions
  });
}
