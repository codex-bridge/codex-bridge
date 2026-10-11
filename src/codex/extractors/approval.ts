import { asRecord, firstString } from "../protocol-utils.js";

function extractFilesystemPathLike(value: unknown, seen = new Set<unknown>()): string | null {
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    return looksLikeFilesystemPath(trimmed) ? trimmed : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFilesystemPathLike(item, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const directCandidates = [
    record.path,
    record.root,
    record.cwd,
    record.workdir,
    record.grantRoot,
    record.target,
    record.directory,
    record.workingDirectory
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && looksLikeFilesystemPath(candidate.trim())) {
      return candidate.trim();
    }
  }

  for (const nested of Object.values(record)) {
    const found = extractFilesystemPathLike(nested, seen);
    if (found) {
      return found;
    }
  }

  return null;
}

function looksLikeFilesystemPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const direct = firstString(
    record.message,
    record.error,
    record.details,
    asRecord(record.error)?.message,
    asRecord(record.error)?.details
  );
  if (direct) {
    return direct;
  }

  try {
    return JSON.stringify(record);
  } catch {
    return null;
  }
}

export function buildApprovalTitle(method: string, params: Record<string, unknown>): string {
  if (method === "mcpServer/elicitation/request") {
    return firstString(params.message, params.prompt, params.title) ?? "MCP input required";
  }

  if (method === "item/fileChange/requestApproval") {
    return "File change approval required";
  }

  if (method === "item/permissions/requestApproval") {
    return "Additional permissions required";
  }

  const network = asRecord(params.networkApprovalContext);
  if (network) {
    const host = firstString(network.host) ?? "unknown-host";
    const protocol = firstString(network.protocol) ?? "network";
    return `Network access approval required: ${protocol}://${host}`;
  }

  const command = params.command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return `Command execution approval required: ${(command as string[]).join(" ")}`;
  }

  return "Command execution approval required";
}

export function buildApprovalSummary(method: string, params: Record<string, unknown>): string | null {
  if (method === "mcpServer/elicitation/request") {
    const fieldNames = extractRequestedFieldNames(params);
    const toolName = extractMcpToolName(params);
    const parts = [
      firstString(params.description, params.detail),
      toolName ? `tool: ${toolName}` : undefined,
      fieldNames.length > 0 ? `fields: ${fieldNames.join(", ")}` : undefined,
      firstString(params.url) ? `url: ${firstString(params.url)}` : undefined
    ].filter((value): value is string => Boolean(value));

    return parts.length > 0 ? parts.join("\n") : null;
  }

  const reason =
    firstString(params.reason) ??
    extractErrorMessage(params.reason) ??
    extractErrorMessage(params.details) ??
    extractErrorMessage(params.context);
  const cwd = extractFilesystemPathLike(params.cwd) ?? extractFilesystemPathLike(params.workdir);
  const grantRoot = extractFilesystemPathLike(params.grantRoot);
  const execpolicyAmendment = Array.isArray(params.proposedExecpolicyAmendment)
    ? params.proposedExecpolicyAmendment.filter((part): part is string => typeof part === "string")
    : null;
  const permissions = asRecord(params.permissions);
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
        .map((decision) => {
          if (typeof decision === "string") {
            return decision;
          }
          const record = asRecord(decision);
          return record ? Object.keys(record).join(",") : null;
        })
        .filter((decision): decision is string => Boolean(decision))
    : [];
  const command = Array.isArray(params.command)
    ? params.command.filter((part): part is string => typeof part === "string").join(" ")
    : firstString(params.command, params.cmd);

  const parts = [
    reason,
    command ? `command: ${command}` : undefined,
    cwd ? `cwd: ${cwd}` : undefined,
    grantRoot && method === "item/fileChange/requestApproval" ? `grantRoot: ${grantRoot}` : undefined,
    method === "item/permissions/requestApproval" && permissions
      ? `permissions: ${JSON.stringify(permissions)}`
      : undefined,
    execpolicyAmendment && execpolicyAmendment.length > 0
      ? `execpolicyAmendment: ${JSON.stringify(execpolicyAmendment)}`
      : undefined,
    availableDecisions.length > 0 ? `availableDecisions: ${availableDecisions.join(", ")}` : undefined
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join("\n") : null;
}

function extractMcpToolName(params: Record<string, unknown>): string | null {
  const text = firstString(params.message, params.prompt, params.title);
  if (!text) {
    return null;
  }

  const quoted = text.match(/tool\s+"([^"]+)"/i);
  if (quoted?.[1]) {
    return quoted[1];
  }

  const singleQuoted = text.match(/tool\s+'([^']+)'/i);
  if (singleQuoted?.[1]) {
    return singleQuoted[1];
  }

  return null;
}

function inferMcpFieldNamesFromToolName(toolName: string | null): string[] {
  switch (toolName) {
    case "write_memory":
      return ["memory_name", "content"];
    case "read_memory":
    case "delete_memory":
      return ["memory_name"];
    case "rename_memory":
      return ["old_name", "new_name"];
    case "edit_memory":
      return ["memory_name", "needle", "repl", "mode"];
    default:
      return [];
  }
}

export function extractRequestedFieldNames(value: unknown): string[] {
  const seen = new Set<unknown>();
  const collected = new Set<string>();

  function pushField(value: unknown): void {
    if (typeof value === "string" && value.trim()) {
      collected.add(value.trim());
    }
  }

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    const record = asRecord(node);
    if (!record) {
      if (Array.isArray(node)) {
        for (const child of node) {
          walk(child);
        }
      }
      return;
    }

    const properties = asRecord(record.properties);
    if (properties) {
      for (const key of Object.keys(properties)) {
        pushField(key);
      }
      for (const child of Object.values(properties)) {
        walk(child);
      }
    }

    if (Array.isArray(record.required)) {
      for (const key of record.required) {
        pushField(key);
      }
    }

    if (Array.isArray(record.enum) && typeof record.name === "string") {
      pushField(record.name);
    }

    for (const child of Object.values(record)) {
      walk(child);
    }
  }

  walk(value);
  const inferred = inferMcpFieldNamesFromToolName(
    asRecord(value) ? extractMcpToolName(asRecord(value) as Record<string, unknown>) : null
  );
  for (const field of inferred) {
    collected.add(field);
  }

  return [...collected];
}

export function mcpRequestRequiresUserInput(params: Record<string, unknown>): boolean {
  const meta = asRecord(params._meta);
  if (firstString(meta?.codex_approval_kind) === "mcp_tool_call") {
    return false;
  }

  const toolParams = asRecord(meta?.tool_params);
  if (toolParams && Object.keys(toolParams).length > 0) {
    return false;
  }

  const requestedSchema = asRecord(params.requestedSchema);
  const properties = asRecord(requestedSchema?.properties);
  if (properties && Object.keys(properties).length > 0) {
    return true;
  }

  return extractRequestedFieldNames(params).length > 0;
}
