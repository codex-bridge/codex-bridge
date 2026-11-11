import type { DecisionAction } from "./types.js";

export type ApprovalConstraints = {
  commandApprovalKind?: string | null;
  /** null/absent means unspecified; an empty array allows no decisions. */
  availableDecisions?: readonly string[] | null;
};

/** Protocol constraints shared by presentation, command handlers and RPC responses. */
export function getApprovalPolicy(method: string | null, constraints: ApprovalConstraints) {
  const command = method === "item/commandExecution/requestApproval";
  const human = command && constraints.commandApprovalKind === "humanCommand";
  const mcp = method === "mcpServer/elicitation/request";
  let actions: DecisionAction[] = mcp || human ? ["accept", "decline", "cancel"]
    : command || method === "item/fileChange/requestApproval"
      ? ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "decline", "cancel"]
      : method === "item/permissions/requestApproval" ? ["accept", "acceptForSession", "decline", "cancel"] : [];
  // Unknown command kinds cannot inherit approval rights from ordinary commands.
  if (command && constraints.commandApprovalKind &&
    !["command", "humanCommand", "writeStdin"].includes(constraints.commandApprovalKind)) actions = [];
  if (constraints.availableDecisions != null) {
    actions = actions.filter((action) => constraints.availableDecisions!.includes(action));
  }
  return { actions, requiresHumanApproval: human, batchable: !human && actions.length > 0 };
}
