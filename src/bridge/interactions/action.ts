import { parseSessionActionCallback } from "../sessions/action-callbacks.js";
import { parseBatchDecisionCallback } from "../decisions/action-callbacks.js";

export type PrimaryInteractionAction =
  | { type: "help" }
  | { type: "sessions.open" }
  | { type: "runtime.connect" }
  | { type: "runtime.disconnect" };

export type SessionInteractionAction =
  | { type: "session.handoff"; sessionId: string; expectedLeaseVersion?: number }
  | { type: "session.archive"; sessionId: string; expectedLeaseVersion?: number }
  | { type: "session.delete.request"; sessionId: string; expectedLeaseVersion?: number }
  | { type: "session.delete.confirm"; sessionId: string; expectedLeaseVersion?: number }
  | { type: "session.release"; owner: "bridge" | "codex"; sessionId: string; expectedLeaseVersion?: number }
  | { type: "session.directory.open"; directoryHash: string; page: number }
  | { type: "session.directory.page"; directoryHash: string; page: number }
  | { type: "session.create"; directoryHash: string }
  | { type: "session.menu.refresh" }
  | { type: "session.archived.open" }
  | { type: "session.archived.page"; page: number }
  | { type: "session.unarchive"; sessionId: string }
  | { type: "session.menu.page"; page: number };

export type GoalInteractionAction =
  | { type: "goal.navigate"; view: "current" | "list"; page: number; delivery: "send" | "edit" }
  | { type: "goal.view"; goalId: string }
  | { type: "goal.set-status"; goalId: string; status: "active" | "paused" | "complete" }
  | { type: "goal.clear.request"; goalId?: string }
  | { type: "goal.clear.confirm"; goalId?: string }
  | { type: "goal.clear.cancel" }
  | { type: "goal.active.set-status"; status: "active" | "paused" | "complete" };

export type StatusInteractionAction = {
  type: "status.view";
  full: boolean;
  delivery: "send" | "edit";
};

export type TurnInteractionAction =
  | { type: "turn.interrupt" }
  | { type: "turn.compact" }
  | { type: "runtime.restart" }
  | { type: "queue.cancel"; submissionId: string };

export type ApprovalInteractionAction =
  | {
      type: "approval.resolve";
      decisionId: string;
      decision: "accept" | "acceptForSession" | "decline" | "cancel";
    }
  | {
      type: "approval.batch.resolve";
      sessionId: string;
      decision: "accept" | "decline" | "cancel";
      expectedLeaseVersion?: number;
    }
  | { type: "approval.invalid" };

export type CoreInteractionAction =
  | PrimaryInteractionAction
  | SessionInteractionAction
  | GoalInteractionAction
  | StatusInteractionAction
  | TurnInteractionAction
  | ApprovalInteractionAction;

function parsePage(value: string | undefined): number {
  const page = Number.parseInt(value ?? "0", 10);
  return Number.isNaN(page) ? 0 : page;
}

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const version = Number(value);
  return Number.isFinite(version) ? version : undefined;
}

export function parsePrimaryInteractionAction(value: string): PrimaryInteractionAction | null {
  switch (value) {
    case "quick:help": return { type: "help" };
    case "quick:sessions": return { type: "sessions.open" };
    case "quick:bot_connect": return { type: "runtime.connect" };
    case "quick:bot_disconnect": return { type: "runtime.disconnect" };
    default: return null;
  }
}

export function parseSessionInteractionAction(value: string): SessionInteractionAction | null {
  const callback = parseSessionActionCallback(value);
  if (callback) {
    const { kind, sessionId, expectedLeaseVersion } = callback;
    switch (kind) {
      case "handoff": return { type: "session.handoff", sessionId, expectedLeaseVersion };
      case "archive": return { type: "session.archive", sessionId, expectedLeaseVersion };
      case "deleteConfirm": return { type: "session.delete.confirm", sessionId, expectedLeaseVersion };
      case "delete": return { type: "session.delete.request", sessionId, expectedLeaseVersion };
      case "releaseBridge": return { type: "session.release", owner: "bridge", sessionId, expectedLeaseVersion };
      case "releaseCodex": return { type: "session.release", owner: "codex", sessionId, expectedLeaseVersion };
      case "refresh": return null; // Platform workflows deliver refreshed history.
    }
  }
  if (value.startsWith("session-dir:")) {
    const [, directoryHash = "", page] = value.split(":");
    return { type: "session.directory.open", directoryHash, page: parsePage(page) };
  }
  if (value.startsWith("section-page:")) {
    const [, directoryHash = "", page] = value.split(":");
    return { type: "session.directory.page", directoryHash, page: parsePage(page) };
  }
  if (value.startsWith("session-new:")) {
    return { type: "session.create", directoryHash: value.slice("session-new:".length) };
  }
  if (value === "session-refresh") return { type: "session.menu.refresh" };
  if (value === "session-archived") return { type: "session.archived.open" };
  if (value.startsWith("session-archived-page:")) {
    return { type: "session.archived.page", page: parsePage(value.slice("session-archived-page:".length)) };
  }
  if (value.startsWith("session-unarchive:")) {
    return { type: "session.unarchive", sessionId: value.slice("session-unarchive:".length) };
  }
  if (value.startsWith("session-page:")) {
    return { type: "session.menu.page", page: parsePage(value.slice("session-page:".length)) };
  }
  return null;
}

function parseGoalStatus(value: string): "active" | "paused" | "complete" | null {
  if (value === "active" || value === "paused" || value === "complete") return value;
  return null;
}

export function parseGoalInteractionAction(value: string): GoalInteractionAction | null {
  const navigation = parseGoalNavigation(value);
  if (navigation) return { type: "goal.navigate", ...navigation };
  if (value.startsWith("goal:view:")) return { type: "goal.view", goalId: value.slice("goal:view:".length) };
  const setMatch = /^goal:set:([apc]):(.+)$/.exec(value);
  if (setMatch) {
    return {
      type: "goal.set-status",
      goalId: setMatch[2] ?? "",
      status: setMatch[1] === "a" ? "active" : setMatch[1] === "p" ? "paused" : "complete"
    };
  }
  if (value.startsWith("goal:ask:")) {
    return { type: "goal.clear.request", goalId: value.slice("goal:ask:".length) };
  }
  if (value.startsWith("goal:del:")) {
    return { type: "goal.clear.confirm", goalId: value.slice("goal:del:".length) };
  }
  if (value.startsWith("goal:status:")) {
    const status = parseGoalStatus(value.slice("goal:status:".length));
    return status ? { type: "goal.active.set-status", status } : null;
  }
  if (value === "goal:clear") return { type: "goal.clear.request" };
  if (value === "goal:clear:confirm") return { type: "goal.clear.confirm" };
  if (value === "goal:clear:cancel") return { type: "goal.clear.cancel" };
  return null;
}

export function parseStatusInteractionAction(value: string): StatusInteractionAction | null {
  const navigation = parseStatusNavigation(value);
  return navigation ? { type: "status.view", ...navigation } : null;
}

export function parseTurnInteractionAction(value: string): TurnInteractionAction | null {
  if (value === "quick:interrupt") return { type: "turn.interrupt" };
  if (value === "quick:compact") return { type: "turn.compact" };
  if (value === "quick:bot_restart") return { type: "runtime.restart" };
  if (value.startsWith("queue:cancel:")) {
    return { type: "queue.cancel", submissionId: value.slice("queue:cancel:".length) };
  }
  return null;
}

function parseDecision(value: string | undefined): "accept" | "acceptForSession" | "decline" | "cancel" | null {
  if (value === "a") return "accept";
  if (value === "s") return "acceptForSession";
  if (value === "d") return "decline";
  if (value === "c") return "cancel";
  return null;
}

export function parseApprovalInteractionAction(value: string): ApprovalInteractionAction | null {
  const batch = parseBatchDecisionCallback(value);
  if (batch) return { type: "approval.batch.resolve", ...batch };
  if (value.startsWith("decision-batch:")) {
    const [, sessionId, versionOrDecision, decisionValue] = value.split(":");
    const decision = parseDecision(decisionValue ?? versionOrDecision);
    if (!sessionId || !decision || decision === "acceptForSession") return { type: "approval.invalid" };
    return {
      type: "approval.batch.resolve",
      sessionId,
      decision,
      expectedLeaseVersion: decisionValue === undefined ? undefined : parseVersion(versionOrDecision)
    };
  }
  if (value.startsWith("decision:")) {
    const [, decisionId, decisionValue] = value.split(":");
    const decision = parseDecision(decisionValue);
    return decisionId && decision
      ? { type: "approval.resolve", decisionId, decision }
      : { type: "approval.invalid" };
  }
  return null;
}

export function parseCoreInteractionAction(value: string): CoreInteractionAction | null {
  return parsePrimaryInteractionAction(value) ??
    parseSessionInteractionAction(value) ??
    parseGoalInteractionAction(value) ??
    parseStatusInteractionAction(value) ??
    parseTurnInteractionAction(value) ??
    parseApprovalInteractionAction(value);
}
import { parseGoalNavigation, parseStatusNavigation } from "../messages/navigation.js";
