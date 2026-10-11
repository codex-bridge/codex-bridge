import type { AppServerProgressFileChange } from "../../codex/client.js";
import type { ProgressFailureReason, ProgressPhaseKind } from "../../shared/types.js";

export type ProgressNotificationEvent = {
  threadId: string;
  itemId?: string;
  label: string;
  toolName: string | null;
  action: string | null;
  target: string | null;
  input: string | null;
  changes: AppServerProgressFileChange[] | null;
  failed: boolean;
  text: string;
  completed?: boolean;
};

export type NewProgressPhaseKind = Exclude<ProgressPhaseKind, "other">;

export type NormalizedPhaseEvent = {
  kind: NewProgressPhaseKind;
  event: ProgressNotificationEvent;
  operation: string | null;
  failureReason: ProgressFailureReason | null;
};

export function normalizeProgressEvent(event: ProgressNotificationEvent): NormalizedPhaseEvent | null {
  const kind = phaseKindFor(event);
  if (!kind) return null;
  return {
    kind,
    event,
    operation: kind === "called" ? safeOperationName(event.toolName) : null,
    failureReason: event.failed ? normalizeFailureReason(event.text) : null
  };
}

export function normalizeFailureReason(raw: string): ProgressFailureReason {
  const value = raw.toLowerCase();
  if (/timed? ?out|timeout|deadline exceeded/.test(value)) return "timeout";
  if (/permission denied|not permitted|unauthorized|forbidden/.test(value)) return "permission_denied";
  if (/not found|no such file|does not exist/.test(value)) return "not_found";
  if (/cancelled|canceled|aborted/.test(value)) return "cancelled";
  if (/connection lost|unavailable|disconnected|econn|network/.test(value)) return "unavailable";
  return "other_failure";
}

function phaseKindFor(event: ProgressNotificationEvent): NewProgressPhaseKind | null {
  if (event.changes?.length || event.label === "Edited") return "edited";
  if (event.label === "Run") return "run";
  if (event.label === "Called" || event.label.startsWith("Called ")) return "called";
  if (event.label === "Explored") return "explored";
  if (event.label === "System") return "system";
  return null;
}

function safeOperationName(toolName: string | null): string | null {
  if (!toolName) return null;
  const mcpMatch = toolName.match(/^mcp__([^_]+)__([A-Za-z0-9_:-]+)$/);
  const normalized = mcpMatch ? `${mcpMatch[1]}.${mcpMatch[2]}` : toolName;
  // A qualified tool identifier is safe to retain in a durable summary. Reject
  // command-like and free-form values that the App Server may expose as a name.
  return /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_:-]*)+$/.test(normalized)
    ? normalized
    : null;
}
