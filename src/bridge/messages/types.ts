import type { DecisionAction, DecisionRecord } from "../../shared/types.js";

export type DecisionContext = {
  id: string;
  state: DecisionRecord["state"];
  requiresUserInput: boolean;
  requestedFields: string[];
  availableActions: DecisionAction[];
  inputAllowed: boolean;
  unavailableReason?: "original_request_inactive" | "runtime_disconnected";
};

export type MessageKind =
  | "codex"
  | "progress"
  | "failed"
  | "called"
  | "edited"
  | "working"
  | "actions"
  | "mcp"
  | "decision"
  | "decision-batch"
  | "system"
  | "error"
  | "stream-error"
  | "compact-started"
  | "compact-completed"
  | "version-update"
  | "queue"
  | "subagent"
  | "refresh"
  | "menu"
  | "user";

export type SessionContext = {
  id: string | null;
  directory: string;
};

export type MessageBodyPart =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string }
  | { type: "field"; label: string; value: string }
  | { type: "heading"; text: string };

export type ActionSpec = {
  id: string;
  label: string;
  callback: string;
  execution?:
    | { type: "send-text"; text: string }
    | { type: "session-tool"; tool: "help" | "status" | "compact" | "interrupt"; full?: boolean };
  style?: "default" | "primary" | "danger";
  group?: string;
  sameRowAsPrevious?: boolean;
};

export type DeliverySpec = {
  mode: "send" | "edit" | "replace" | "delete";
  purpose?: string;
};

export type MessageSpec = {
  kind: MessageKind;
  title: string;
  session?: SessionContext;
  body: MessageBodyPart[];
  actions: ActionSpec[];
  delivery?: DeliverySpec;
  decision?: DecisionContext;
};
