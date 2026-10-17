import { formatSessionMarker } from "../../shared/session-tag.js";
import type { DecisionAction, DecisionRecord, SessionRecord } from "../../shared/types.js";
import { createMessage } from "../messages/factory.js";
import type { ActionSpec, DecisionContext, MessageSpec, SessionContext } from "../messages/types.js";
import { pickDirectory } from "../sessions/menu-formatters.js";

export type ParsedDecisionSummary = {
  command: string | null;
  reason: string | null;
  cwd: string | null;
  grantRoot: string | null;
  execpolicyAmendment: string[] | null;
  permissions: Record<string, unknown> | null;
};

export function createDecisionMessageSpec(
  session: SessionRecord,
  decision: DecisionRecord,
  actions: ActionSpec[]
): MessageSpec {
  const { command, reason, cwd, grantRoot, permissions } = parseDecisionSummary(decision.summary);
  const directory = formatSessionMarker(
    pickDirectory(cwd, session.currentCwd, session.displayName, session.pathKey) ?? session.pathKey
  );
  if (decision.kind === "mcpServer/elicitation/request") {
    const fields = decision.requiresUserInput ? getDecisionRequestedFields(decision) : [];
    return { ...createMessage({
      kind: "decision",
      titleLabel: decisionTerminalLabel(decision) ?? (decision.requiresUserInput ? "MCP Input Required" : "MCP Approval Required"),
      session: { id: session.id, directory: directory },
      body: [
        { type: "text", text: truncateDecisionText(decision.title, 400) },
        { type: "field", label: "Reason", value: truncateDecisionText(
          reason ?? (decision.requiresUserInput
            ? "MCP tool needs structured input before Codex can continue."
            : "MCP tool requires explicit approval before Codex can continue."),
          700
        ) },
        ...(fields.length > 0 ? [{ type: "field" as const, label: "Expected fields", value: fields.join(", ") }] : []),
        ...decisionTerminalStatus(decision),
        { type: "field", label: "Directory", value: directory }
      ],
      actions
    }), decision: describeDecision(decision) };
  }

  const isCommandApproval = decision.kind === "item/commandExecution/requestApproval";
  const isFileChangeApproval = decision.kind === "item/fileChange/requestApproval";
  const isPermissionsApproval = decision.kind === "item/permissions/requestApproval";
  const displayReason = reason ?? inferDecisionReason({ kind: decision.kind ?? "", command, grantRoot, cwd });
  return { ...createMessage({
    kind: "decision",
    titleLabel: decisionTerminalLabel(decision) ?? (isCommandApproval
      ? "Command Approval Required"
      : isPermissionsApproval
        ? "Additional Permissions Required"
        : "Pending Decision"),
    session: { id: session.id, directory },
    body: [
      command
        ? { type: "code" as const, text: renderApprovalCommandPreview(command) }
        : { type: "text" as const, text: truncateDecisionText(decision.title, 400) },
      ...(displayReason ? [{ type: "field" as const, label: "Reason", value: truncateDecisionText(displayReason, 500) }] : []),
      ...(isFileChangeApproval && grantRoot
        ? [{ type: "field" as const, label: "Target", value: formatSessionMarker(grantRoot) }]
        : []),
      ...(isPermissionsApproval && permissions
        ? [{ type: "field" as const, label: "Access", value: formatPermissionSummary(permissions) }]
        : []),
      ...decisionTerminalStatus(decision),
      { type: "field", label: "Directory", value: directory }
    ],
    actions
  }), decision: describeDecision(decision) };
}

/** Semantic controls for native clients, never chat callbacks or raw RPC identities. */
export function describeDecision(decision: DecisionRecord): DecisionContext {
  const open = decision.state === "pending" || decision.state === "awaitingInput";
  const mcp = decision.kind === "mcpServer/elicitation/request";
  const supported = mcp || ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(decision.kind ?? "");
  let availableActions: DecisionAction[] = !open || !supported ? [] : decision.state === "awaitingInput"
    ? (mcp ? ["decline", "cancel"] : []) : mcp ? ["accept", "decline", "cancel"]
      : ["accept", "acceptForSession", "decline", "cancel"];
  const declared = decision.summary?.split("\n").find((line) => line.startsWith("availableDecisions: "));
  if (declared && !mcp) {
    const supportedActions = declared.slice("availableDecisions: ".length).split(",").map((value) => value.trim());
    availableActions = availableActions.filter((action) => supportedActions.includes(action) ||
      (action === "acceptForSession" && !!getExecpolicyAmendment(decision) && supportedActions.includes("acceptWithExecpolicyAmendment")));
  }
  return { id: decision.id, state: decision.state, requiresUserInput: decision.requiresUserInput,
    requestedFields: mcp && decision.requiresUserInput ? getDecisionRequestedFields(decision) : [], availableActions,
    inputAllowed: mcp && decision.requiresUserInput && decision.state === "awaitingInput" };
}

/** The existing MCP form validation shared by chat input and explicit Web submissions. */
export function validateDecisionInput(decision: DecisionRecord, content: unknown): Record<string, unknown> {
  if (!content || Array.isArray(content) || typeof content !== "object") throw new Error("JSON input must be an object.");
  const missing = getDecisionRequestedFields(decision).filter((field) => !Object.hasOwn(content, field));
  if (missing.length) throw new Error(`Missing fields: ${missing.join(", ")}`);
  return content as Record<string, unknown>;
}

function decisionTerminalLabel(decision: DecisionRecord): string | null {
  switch (decision.state) {
    case "approved": return "Approved";
    case "approvedForSession": return "Approved for Session";
    case "rejected": return "Declined";
    case "cancelled": return "Cancelled";
    case "stale": return "Expired";
    case "awaitingInput": return "Awaiting MCP Input";
    default: return null;
  }
}

function decisionTerminalStatus(decision: DecisionRecord): Array<{ type: "field"; label: string; value: string }> {
  const label = decisionTerminalLabel(decision);
  return label ? [{ type: "field", label: "Status", value: label }] : [];
}

export function createBatchDecisionMessageSpec(session: SessionContext, count: number, actions: ActionSpec[]): MessageSpec {
  return createMessage({
    kind: "decision-batch",
    session,
    body: [{ type: "text", text: `${count} pending approvals` }],
    actions
  });
}

export function renderApprovalCommandPreview(command: string): string {
  return truncateDecisionText(command.replace(/\s+/g, " ").trim(), 900);
}

export function truncateDecisionText(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function parseDecisionSummary(summary: string | null): ParsedDecisionSummary {
  if (!summary) {
    return { command: null, reason: null, cwd: null, grantRoot: null, execpolicyAmendment: null, permissions: null };
  }
  const lines = summary.split("\n").map((line) => line.trim()).filter(Boolean);
  let command: string | null = null;
  let cwd: string | null = null;
  let grantRoot: string | null = null;
  let execpolicyAmendment: string[] | null = null;
  let permissions: Record<string, unknown> | null = null;
  const reasons: string[] = [];
  for (const line of lines) {
    if (line.startsWith("command: ")) {
      command = line.slice("command: ".length).trim();
    } else if (line.startsWith("cwd: ")) {
      cwd = line.slice("cwd: ".length).trim();
    } else if (line.startsWith("grantRoot: ")) {
      grantRoot = line.slice("grantRoot: ".length).trim();
    } else if (line.startsWith("execpolicyAmendment: ")) {
      try {
        const parsed = JSON.parse(line.slice("execpolicyAmendment: ".length).trim()) as unknown;
        execpolicyAmendment = Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
          ? parsed
          : null;
      } catch {
        execpolicyAmendment = null;
      }
    } else if (line.startsWith("permissions: ")) {
      try {
        const parsed = JSON.parse(line.slice("permissions: ".length).trim()) as unknown;
        permissions = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        permissions = null;
      }
    } else if (!line.startsWith("availableDecisions: ")) {
      reasons.push(line);
    }
  }
  return {
    command,
    cwd,
    grantRoot,
    execpolicyAmendment,
    permissions,
    reason: reasons.length > 0 ? reasons.join(" ") : null
  };
}

export function getRequestedPermissions(decision: DecisionRecord): Record<string, unknown> | null {
  return parseDecisionSummary(decision.summary).permissions;
}

function formatPermissionSummary(permissions: Record<string, unknown>): string {
  const labels: string[] = [];
  if (permissions.network) labels.push("network");
  if (permissions.fileSystem) labels.push("file system");
  return labels.length > 0 ? labels.join(", ") : "requested access";
}

export function getExecpolicyAmendment(decision: DecisionRecord): string[] | null {
  return parseDecisionSummary(decision.summary).execpolicyAmendment;
}

export function inferDecisionReason(input: {
  kind: string;
  command: string | null;
  grantRoot: string | null;
  cwd: string | null;
}): string | null {
  if (input.kind === "item/fileChange/requestApproval") {
    return input.grantRoot
      ? "File edit targets a path outside the current workspace permission boundary."
      : "File edit requires approval before Codex can continue.";
  }
  if (input.kind === "item/commandExecution/requestApproval") {
    const command = input.command?.toLowerCase() ?? "";
    if (/\b(curl|wget|npm|pnpm|yarn|uv|pip|brew|docker|kubectl|gh)\b/.test(command)) {
      return "Command may need network, external services, or access outside the sandbox.";
    }
    return input.cwd
      ? "Command execution requires approval under the active permission policy."
      : "Command execution requires approval before Codex can continue.";
  }
  return null;
}

export function parseRequestedFields(summary: string | null): string[] {
  if (!summary) return [];
  const line = summary.split("\n").map((value) => value.trim()).find((value) => value.startsWith("fields: "));
  return line
    ? line.slice("fields: ".length).split(",").map((value) => value.trim()).filter(Boolean)
    : [];
}

export function getDecisionRequestedFields(decision: DecisionRecord): string[] {
  const explicit = parseRequestedFields(decision.summary);
  if (explicit.length > 0) return explicit;
  switch (extractMcpToolName(decision.title, decision.summary)) {
    case "write_memory": return ["memory_name", "content"];
    case "read_memory":
    case "delete_memory": return ["memory_name"];
    case "rename_memory": return ["old_name", "new_name"];
    case "edit_memory": return ["memory_name", "needle", "repl", "mode"];
    default: return [];
  }
}

export function extractMcpToolName(title: string, summary: string | null): string | null {
  const source = [title, summary ?? ""].join("\n");
  return source.match(/tool\s+"([^"]+)"/i)?.[1] ?? source.match(/tool\s+'([^']+)'/i)?.[1] ?? null;
}

export function buildMcpJsonExample(decision: DecisionRecord): string | null {
  const fields = getDecisionRequestedFields(decision);
  if (fields.length === 0) return null;
  return JSON.stringify(Object.fromEntries(fields.map((field) => [
    field,
    field === "content" ? "..." : field === "mode" ? "literal" : field
  ])), null, 2);
}

export function buildAwaitingMcpPrompt(decision: DecisionRecord): string {
  const fields = getDecisionRequestedFields(decision);
  const example = buildMcpJsonExample(decision);
  if (fields.length > 0 && example) {
    return `Reply with a JSON object containing: ${fields.join(", ")}\n\n${example}`;
  }
  return example
    ? `Reply with a JSON object for the MCP response.\n\n${example}`
    : "Reply with a JSON object for the MCP response.";
}

export function isBatchableDecision(decision: DecisionRecord): boolean {
  return decision.state === "pending" && !decision.requiresUserInput;
}

export function describeBatchAction(
  action: Extract<DecisionAction, "accept" | "decline" | "cancel">,
  count: number
): string {
  const suffix = count === 1 ? "" : "s";
  if (action === "accept") return `Approved ${count} pending approval${suffix}.`;
  if (action === "cancel") return `Cancelled ${count} pending approval${suffix}.`;
  return `Declined ${count} pending approval${suffix}.`;
}
