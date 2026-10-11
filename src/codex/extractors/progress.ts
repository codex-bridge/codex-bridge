import type { AppServerProgressEvent, AppServerProgressFileChange } from "../client.js";
import { classifyItemKind } from "../item-kind.js";
import { asRecord, extractMessageText, firstString } from "../protocol-utils.js";

function stringifyProgressValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function extractProgressText(item: Record<string, unknown>): string | null {
  const payload = asRecord(item.payload);
  const kind = classifyItemKind(item.type);
  const query = firstString(item.query, payload?.query);
  const action = firstString(item.action, payload?.action);
  const webSearchText = kind === "webSearch" && query
    ? `${action ? `${action}: ` : ""}${query}`
    : null;
  return (
    extractMessageText(item) ??
    stringifyProgressValue(item.summary) ??
    stringifyProgressValue(item.output) ??
    stringifyProgressValue(item.result) ??
    stringifyProgressValue(item.data) ??
    stringifyProgressValue(item.stdout) ??
    stringifyProgressValue(item.stderr) ??
    stringifyProgressValue(payload?.stdout) ??
    stringifyProgressValue(payload?.stderr) ??
    webSearchText
  );
}

export function extractProgressToolName(item: Record<string, unknown>): string | null {
  const payload = asRecord(item.payload);
  const server = firstString(item.server, payload?.server);
  const tool = firstString(item.tool, payload?.tool);
  if (server && tool) {
    return `${server}.${tool}`;
  }
  const explicit = normalizeProgressToolName(firstString(
    item.toolName,
    item.functionName,
    item.serverToolName,
    payload?.toolName,
    payload?.functionName,
    payload?.serverToolName,
    item.command,
    payload?.command,
    item.name,
    payload?.name,
    item.title,
    payload?.title
  ));
  return explicit && (explicit.startsWith("mcp__") || !isInternalProgressType(explicit))
    ? explicit
    : inferProgressToolType(item);
}

export function extractProgressInput(item: Record<string, unknown>): string | null {
  const input = extractProgressInputRecord(item);
  return input ? summarizeProgressInput(input) : null;
}

function extractProgressInputRecord(item: Record<string, unknown>): Record<string, unknown> | null {
  const payload = asRecord(item.payload);
  const structuredInput = (
    asRecord(item.input) ??
    asRecord(item.arguments) ??
    asRecord(item.params) ??
    asRecord(payload?.input) ??
    asRecord(payload?.arguments) ??
    asRecord(payload?.params)
  );
  if (structuredInput) {
    return structuredInput;
  }

  const cwd = firstString(item.cwd, payload?.cwd);
  if (!cwd) {
    const query = firstString(item.query, payload?.query);
    if (!query) {
      return null;
    }
    const action = firstString(item.action, payload?.action);
    return action ? { action, query } : { query };
  }
  return { cwd };
}

function inferProgressToolType(item: Record<string, unknown>): string | null {
  const input = extractProgressInputRecord(item);
  const kind = classifyItemKind(item.type);
  if (kind === "mcp") return "mcp";
  if (kind === "command") return "shell";
  if (kind === "fileChange") return "file_change";
  if (kind === "webSearch") return "web_search";
  if (kind === "image") return "image";
  if (input) {
    const keys = new Set(Object.keys(input));
    if (
      keys.has("url") ||
      (keys.has("width") && keys.has("height")) ||
      (keys.has("x") && keys.has("y")) ||
      keys.has("target") ||
      keys.has("selector")
    ) {
      return "browser";
    }
  }
  return null;
}

function normalizeProgressToolName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const calledMatch = trimmed.match(/^Called\s*(?:·|:)?\s*(\S[\s\S]*)$/i);
  return calledMatch?.[1]?.trim() || trimmed;
}

export function extractProgressAction(item: Record<string, unknown>): string | null {
  const input = extractProgressInputRecord(item);
  const kind = classifyItemKind(item.type);
  if (kind === "command") return "run";
  if (kind === "fileChange" || (kind === "tool" && extractProgressToolName(item) === "apply_patch")) return "write";
  if (kind === "mcp") return "call";
  if (kind === "webSearch") return "search";
  if (kind === "image") return "generate";
  if (input) {
    const keys = new Set(Object.keys(input));
    if (keys.has("url")) {
      return "navigate";
    }
    if (keys.has("width") && keys.has("height")) {
      return "resize";
    }
    if (keys.has("x") && keys.has("y")) {
      return "click";
    }
    if (keys.has("target") || keys.has("selector")) {
      return "act";
    }
  }
  return null;
}

export function extractProgressTarget(item: Record<string, unknown>): string | null {
  const input = extractProgressInputRecord(item);
  if (!input) {
    return null;
  }
  return firstString(
    input.memory_name,
    input.command,
    input.path,
    input.url,
    input.query,
    input.element,
    input.selector,
    input.target
  ) ?? null;
}

function summarizeProgressInput(input: Record<string, unknown>): string | null {
  const semanticKeys = [
    "element",
    "memory_name",
    "command",
    "path",
    "url",
    "query",
    "action",
    "selector",
    "cwd",
    "name",
    "text",
    "key",
    "index",
    "part",
    "filter",
    "depth",
    "time",
    "width",
    "height",
    "x",
    "y",
    "static"
  ];
  const parts: string[] = [];
  for (const key of semanticKeys) {
    const value = stringifyProgressInputScalar(input[key]);
    if (value) {
      parts.push(`${key}=${truncateProgressSummary(value, 72)}`);
    }
  }
  if (parts.length === 0) {
    const target = stringifyProgressInputScalar(input.target);
    if (target) {
      parts.push(`target=${truncateProgressSummary(target, 72)}`);
    }
  }
  if (parts.length === 0) {
    const presentKeys = Object.keys(input).slice(0, 4);
    if (presentKeys.length === 0) {
      return null;
    }
    parts.push(`keys=${presentKeys.join(",")}`);
  }
  return truncateProgressSummary(parts.join(" "), 120);
}

function stringifyProgressInputScalar(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function truncateProgressSummary(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

export function extractProgressChanges(item: Record<string, unknown>): AppServerProgressFileChange[] | null {
  const payload = asRecord(item.payload);
  const changes = asRecord(item.changes) ?? asRecord(payload?.changes);

  const entries: AppServerProgressFileChange[] = [];
  if (changes) {
    for (const [path, value] of Object.entries(changes)) {
      entries.push(formatProgressFileChange(path, value));
    }
  }

  const arrayChanges = Array.isArray(item.changes)
    ? item.changes
    : Array.isArray(payload?.changes)
      ? payload.changes
      : Array.isArray(item.files)
        ? item.files
        : Array.isArray(payload?.files)
          ? payload.files
          : null;
  if (arrayChanges) {
    for (const value of arrayChanges) {
      const record = asRecord(value);
      const path = firstString(record?.path, record?.file, record?.filePath, record?.file_path);
      if (path) {
        entries.push(formatProgressFileChange(path, value));
      }
    }
  }

  const singlePath = firstString(
    item.path,
    item.file,
    item.filePath,
    item.file_path,
    payload?.path,
    payload?.file,
    payload?.filePath,
    payload?.file_path
  );
  if (singlePath) {
    entries.push(formatProgressFileChange(singlePath, item));
  }

  return entries.length > 0 ? entries : null;
}

function formatProgressFileChange(path: string, value: unknown): AppServerProgressFileChange {
  const record = asRecord(value);
  const payload = asRecord(record?.payload);
  const type = firstString(
    asRecord(record?.kind)?.type, record?.kind, record?.type,
    asRecord(payload?.kind)?.type, payload?.kind, payload?.type
  ) ?? null;
  // Empty content is meaningful for adding/deleting an empty file.
  const diffPreview = [
    record?.unified_diff,
    record?.unifiedDiff,
    record?.diff,
    record?.patch,
    payload?.unified_diff,
    payload?.unifiedDiff,
    payload?.diff,
    payload?.patch,
    ...(type === "add" || type === "delete" ? [record?.content, payload?.content] : [])
  ].find((candidate): candidate is string => typeof candidate === "string");
  // Only unified-diff deltas can supply counts; arbitrary output is not code.
  const diff = diffPreview ?? firstString(
    record?.delta,
    record?.textDelta,
    payload?.delta,
    payload?.textDelta
  );
  const counts = (type === "add" || type === "delete")
    ? {
        added: type === "add" && diffPreview !== undefined ? countContentLines(diffPreview) : 0,
        removed: type === "delete" && diffPreview !== undefined ? countContentLines(diffPreview) : 0,
        lineStatsAvailable: diffPreview !== undefined
      }
    : countUnifiedDiffLines(diff);
  return {
    path,
    type,
    ...counts,
    ...(diffPreview !== undefined ? { diffPreview } : {})
  };
}

function countContentLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function countUnifiedDiffLines(diff: string | undefined): { added: number; removed: number; lineStatsAvailable: boolean } {
  if (!diff) {
    return { added: 0, removed: 0, lineStatsAvailable: false };
  }

  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed, lineStatsAvailable: inHunk };
}

export function progressItemFailed(item: Record<string, unknown>): boolean {
  const payload = asRecord(item.payload);
  const status = firstString(item.status, payload?.status)?.toLowerCase();
  return item.success === false || payload?.success === false || status === "failed" || status === "error" || status === "declined";
}

function isInternalProgressType(value: string): boolean {
  return /^(mcp|server|tool|function|command|patch|edit)/i.test(value.replace(/[_\s-]/g, ""));
}

export function extractProgressLabel(item: Record<string, unknown>): string {
  const kind = classifyItemKind(item.type);
  const toolName = extractProgressToolName(item);
  if (kind === "command") return "Run";
  if (kind === "fileChange" || (kind === "tool" && toolName === "apply_patch")) return "Edited";
  if (kind === "webSearch") return "Explored";
  if (kind === "mcp" || kind === "tool" || kind === "image" || toolName?.startsWith("mcp__")) return "Called";
  return toolName ? `Called ${toolName}` : "Progress";
}

export function isProgressItem(item: Record<string, unknown>): boolean {
  const kind = classifyItemKind(item.type);
  const toolName = extractProgressToolName(item);
  return Boolean(
    kind === "command" || kind === "fileChange" || kind === "mcp" || kind === "tool" ||
      kind === "webSearch" || kind === "image" ||
      (firstString(item.server) && firstString(item.tool)) ||
      toolName?.startsWith("mcp__") ||
      (kind === "unknown" && !firstString(item.type) && firstString(item.command))
  );
}

export function extractProgressEventFromItem(input: {
  action?: string | null;
  fallback?: Record<string, unknown> | null;
  item: Record<string, unknown>;
  label?: string;
  fallbackText?: string;
  fileMutation?: boolean;
  requireProgressItem?: boolean;
  threadId: string;
  toolName?: string | null;
}): AppServerProgressEvent | null {
  const { fallback, item, threadId } = input;
  const progressItem = isProgressItem(item);
  if (classifyItemKind(item.type) === "agentMessage" ||
      (input.requireProgressItem !== false && !progressItem)) {
    return null;
  }
  const kind = classifyItemKind(item.type);
  const toolName = extractProgressToolName(item);
  const fileMutation = input.fileMutation === true ||
    kind === "fileChange" ||
    (kind === "tool" && toolName === "apply_patch");
  const changes = fileMutation
    ? extractProgressChanges(item) ?? (fallback ? extractProgressChanges(fallback) : null)
    : null;
  const text = extractProgressText(item) ??
    (fallback ? extractProgressText(fallback) : null) ??
    (changes ? "File changes updated." : null) ??
    (progressItem ? (input.fallbackText ?? "Tool call observed.") : null);
  if (!text) {
    return null;
  }
  return {
    threadId,
    label: input.label ?? extractProgressLabel(item),
    toolName: input.toolName === undefined ? extractProgressToolName(item) : input.toolName,
    action: input.action === undefined ? extractProgressAction(item) : input.action,
    target: extractProgressTarget(item) ?? (fallback ? extractProgressTarget(fallback) : null),
    input: extractProgressInput(item) ?? (fallback ? extractProgressInput(fallback) : null),
    changes,
    failed: progressItemFailed(item),
    text
  };
}
