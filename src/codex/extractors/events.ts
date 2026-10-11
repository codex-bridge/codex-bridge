import type { AppServerNotification } from "../client.js";
import { asRecord, firstString } from "../protocol-utils.js";
import { classifyItemKind } from "../item-kind.js";

export function extractAgentText(item: unknown): string | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }

  const direct = firstString(record.text, record.review);
  return direct ?? null;
}

export function extractStatusActivity(
  notification: AppServerNotification
): "contextCompaction" | null {
  if (notification.method !== "item/started") return null;
  const params = asRecord(notification.params);
  const item = asRecord(params?.item);
  return classifyItemKind(item?.type) === "contextCompaction" ? "contextCompaction" : null;
}

export function extractStatusLabel(notification: AppServerNotification): string | null {
  if (
    notification.method === "item/reasoning/summaryTextDelta" ||
    notification.method === "item/reasoning/summaryPartAdded"
  ) {
    return "Thinking";
  }

  if (notification.method !== "item/started") {
    return null;
  }

  const params = asRecord(notification.params);
  const item = asRecord(params?.item);
  if (!item) {
    return null;
  }

  const kind = classifyItemKind(item.type);
  const toolName = firstString(
    item.toolName,
    item.functionName,
    item.serverToolName,
    item.command,
    item.title,
    item.name,
    asRecord(item.payload)?.toolName,
    asRecord(item.payload)?.functionName,
    asRecord(item.payload)?.serverToolName,
    asRecord(item.payload)?.title,
    asRecord(item.payload)?.name
  );

  if (kind === "contextCompaction") {
    return "Compacting";
  }

  if (kind === "reasoning") {
    return "Thinking";
  }

  if (kind === "command") {
    return "Running command";
  }

  if (kind === "fileChange" || (kind === "tool" && toolName === "apply_patch")) {
    return "Editing files";
  }

  if (toolName) {
    return `Using ${toolName}`;
  }

  if (kind === "mcp") {
    return "Calling MCP";
  }

  if (kind === "webSearch") {
    return "Searching";
  }

  return null;
}

export function extractStatusDetail(notification: AppServerNotification): {
  text: string | null;
  mode: "replace" | "append" | null;
} {
  const params = asRecord(notification.params);
  const item = asRecord(params?.item);
  const payload = asRecord(item?.payload);
  const delta = firstString(
    params?.delta,
    params?.textDelta,
    params?.summaryTextDelta,
    params?.contentDelta,
    item?.delta,
    item?.textDelta,
    item?.summaryTextDelta,
    item?.contentDelta
  );
  if (notification.method === "item/reasoning/summaryTextDelta") {
    return { text: delta?.trim() ?? null, mode: "append" };
  }

  const text = firstString(
    params?.text,
    params?.summary,
    params?.content,
    item?.text,
    item?.summary,
    item?.content
  );
  if (notification.method === "item/reasoning/summaryPartAdded") {
    return { text: text?.trim() ?? null, mode: "replace" };
  }

  if (notification.method === "item/started") {
    const toolName = firstString(
      item?.toolName,
      item?.functionName,
      item?.serverToolName,
      item?.command,
      item?.title,
      item?.name,
      payload?.toolName,
      payload?.functionName,
      payload?.serverToolName,
      payload?.command,
      payload?.title,
      payload?.name
    );
    return { text: toolName?.trim() ?? null, mode: "replace" };
  }

  return { text: null, mode: null };
}

export function extractErrorMessage(value: unknown): string | null {
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

export function extractNotificationThreadId(notification: AppServerNotification): string | null {
  const params = asRecord(notification.params);
  const msg = asRecord(params?.msg);
  return (
    firstString(
      params?.conversationId,
      params?.threadId,
      params?.sessionId,
      msg?.thread_id,
      msg?.conversationId,
      msg?.threadId
    ) ?? null
  );
}

export function extractThreadCompactedEvent(notification: AppServerNotification): {
  threadId: string;
} | null {
  if (notification.method === "thread/compacted") {
    const threadId = extractNotificationThreadId(notification);
    return threadId ? { threadId } : null;
  }

  if (notification.method !== "item/completed") {
    return null;
  }

  const params = asRecord(notification.params);
  const item = asRecord(params?.item);
  const itemType = firstString(item?.type)?.toLowerCase();
  if (itemType !== "contextcompaction") {
    return null;
  }

  const threadId = firstString(
    params?.threadId,
    params?.conversationId,
    params?.sessionId,
    item?.threadId,
    item?.conversationId,
    item?.sessionId
  );
  return threadId ? { threadId } : null;
}
