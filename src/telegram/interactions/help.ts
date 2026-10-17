import { helpMenuActions } from "../../bridge/messages/actions.js";
import { createMessage, messageContextForSession } from "../../bridge/messages/factory.js";
import type { ActionSpec, MessageSpec, SessionContext } from "../../bridge/messages/types.js";

const telegramHelpLines = [
  "/session_new - create session in current directory",
  "/sessions - session menu",
  "/goal [objective] - show or set active goal",
  "/goals - unfinished goals",
  "/section_rename <name> - rename section",
  "/go - send go",
  "/next - send next",
  "/queue <message> - queue input after the active run",
  "/interrupt - interrupt active run",
  "/codex_status - status",
  "/codex_status_full - full status",
  "/compact - compact session",
  "/bot_disconnect - disconnect runtime",
  "/bot_connect - reconnect runtime",
  "/bot_restart - restart bridge",
  "/help - help"
];

export function createTelegramHelpMessage(
  session?: SessionContext,
  actions: ActionSpec[] = helpMenuActions()
): MessageSpec {
  return createMessage({
    kind: "menu",
    titleLabel: "Help",
    ...messageContextForSession(session),
    body: telegramHelpLines.map((text) => ({ type: "text" as const, text })),
    actions
  });
}
