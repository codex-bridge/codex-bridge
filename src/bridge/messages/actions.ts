import type { ActionSpec } from "./types.js";

export function actionRow(...actions: ActionSpec[]): ActionSpec[] {
  return actions.map((action, index) => index === 0
    ? action
    : { ...action, sameRowAsPrevious: true });
}

export function messageAction(
  id: string,
  label: string,
  callback: string,
  group?: string
): ActionSpec {
  return { id, label, callback, ...(group ? { group } : {}) };
}

export function userTextAction(
  id: string,
  label: string,
  callback: string,
  text: string,
  group?: string
): ActionSpec {
  return { ...messageAction(id, label, callback, group), execution: { type: "send-text", text } };
}

export function sessionToolAction(
  id: string,
  label: string,
  callback: string,
  tool: Extract<NonNullable<ActionSpec["execution"]>, { type: "session-tool" }>["tool"],
  group?: string
): ActionSpec {
  return { ...messageAction(id, label, callback, group), execution: { type: "session-tool", tool } };
}

export function helpAction(callback = "quick:help"): ActionSpec {
  return sessionToolAction("help", "Help", callback, "help");
}

export function sessionAction(callback = "quick:sessions"): ActionSpec {
  return { id: "session", label: "Session", callback };
}

export function refreshAction(callback: string): ActionSpec {
  return { id: "refresh", label: "Refresh", callback };
}

export function archiveAction(callback: string, group?: string): ActionSpec {
  return { id: "archive", label: "Archive", callback, ...(group ? { group } : {}) };
}

export function deleteAction(callback: string, group?: string): ActionSpec {
  return { id: "delete", label: "Delete", callback, style: "danger", ...(group ? { group } : {}) };
}

export function interruptAction(callback: string): ActionSpec {
  return { ...sessionToolAction("interrupt", "Interrupt", callback, "interrupt"), style: "danger" };
}

export function goalsAction(): ActionSpec {
  return messageAction("goals", "Goals", "goal-page:0", "Goal");
}

export function currentGoalAction(): ActionSpec {
  return messageAction("current", "Current goal", "goal:current", "Goals");
}

export function statusViewAction(full: boolean): ActionSpec {
  return full
    ? { ...sessionToolAction("status", "Status", "status:view:basic", "status"),
        execution: { type: "session-tool", tool: "status", full: false } }
    : { ...sessionToolAction("status-full", "Status full", "status:view:full", "status"),
        execution: { type: "session-tool", tool: "status", full: true } };
}

export type HelpMenuActionState = {
  hasActiveSession?: boolean;
  hasActiveTurn?: boolean;
  runtimeConnected?: boolean;
};

export function helpMenuActions(options?: HelpMenuActionState): ActionSpec[] {
  const actions: ActionSpec[] = [
    ...actionRow(
      messageAction("session", "Session", "quick:sessions", "Session"),
      sessionToolAction("status", "Status", "quick:status", "status", "Session")
    )
  ];
  if (options?.runtimeConnected && options.hasActiveSession) {
    if (options.hasActiveTurn) {
      actions.push(...actionRow(
        messageAction("goal", "Goal", "quick:goal", "Run"),
        messageAction("queue", "Queue", "quick:queue", "Run"),
        sessionToolAction("interrupt", "Interrupt", "quick:interrupt", "interrupt", "Run")
      ));
    } else {
      actions.push(...actionRow(
        messageAction("goal", "Goal", "quick:goal", "Run"),
        sessionToolAction("compact", "Compact", "quick:compact", "compact", "Run")
      ));
    }
  }
  if (options?.runtimeConnected === true) {
    actions.push(...actionRow(
      messageAction("bot-disconnect", "Disconnect", "quick:bot_disconnect", "Bot"),
      messageAction("bot-restart", "Restart", "quick:bot_restart", "Bot")
    ));
  } else if (options?.runtimeConnected === false) {
    actions.push(...actionRow(
      messageAction("bot-connect", "Connect", "quick:bot_connect", "Bot"),
      messageAction("bot-restart", "Restart", "quick:bot_restart", "Bot")
    ));
  } else {
    actions.push(messageAction("bot-restart", "Restart", "quick:bot_restart", "Bot"));
  }
  return actions;
}
