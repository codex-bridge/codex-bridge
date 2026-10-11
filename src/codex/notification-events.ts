import {
  extractAgentText,
  extractErrorMessage,
  extractNotificationThreadId,
  extractStatusActivity,
  extractStatusDetail,
  extractStatusLabel,
  extractThreadCompactedEvent as extractCompactedThread
} from "./extractors/events.js";
import { extractProgressEventFromItem } from "./extractors/progress.js";
import { asRecord, firstString } from "./protocol-utils.js";
import { extractRateLimitsStatus } from "./rate-limit-extractors.js";
import type {
  AppServerErrorEvent,
  AppServerMcpStartupStatusEvent,
  AppServerNotification,
  AppServerProgressEvent,
  AppServerRateLimitsStatus,
  AppServerStatusUpdate,
  AppServerTokenUsageEvent,
  AppServerTurnLifecycleEvent
} from "./client.js";

export type AppServerModelRuntimeEvent = {
  threadId: string;
  kind: "rerouted" | "verified";
  fromModel: string | null;
  toModel: string | null;
  reason: string | null;
  verifications: string[];
};

const FILE_CHANGE_PROGRESS_METHODS = new Set([
  // COMPATIBILITY(MESSAGE_FACTORY): keep deprecated outputDelta for older Codex servers until they are no longer supported.
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated"
]);

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

export function extractContextUsedTokens(
  result: Record<string, unknown> | null,
  thread: Record<string, unknown> | null,
  tokenUsage: Record<string, unknown> | null
): number | null {
  return firstNumber(
    result?.contextUsedTokens,
    result?.usedTokens,
    thread?.contextUsedTokens,
    thread?.usedTokens,
    tokenUsage?.usedTokens,
    tokenUsage?.used,
    tokenUsage?.inputTokens,
    tokenUsage?.contextUsed
  );
}

export function extractContextMaxTokens(
  result: Record<string, unknown> | null,
  thread: Record<string, unknown> | null,
  tokenUsage: Record<string, unknown> | null
): number | null {
  return firstNumber(
    result?.contextMaxTokens,
    result?.maxTokens,
    thread?.contextMaxTokens,
    thread?.maxTokens,
    tokenUsage?.maxTokens,
    tokenUsage?.limit,
    tokenUsage?.contextLimit
  );
}

export function extractContextLeftPercent(
  result: Record<string, unknown> | null,
  thread: Record<string, unknown> | null,
  tokenUsage: Record<string, unknown> | null
): number | null {
  const explicit = firstNumber(
    result?.contextLeftPercent,
    result?.remainingPercent,
    thread?.contextLeftPercent,
    thread?.remainingPercent,
    tokenUsage?.leftPercent,
    tokenUsage?.remainingPercent
  );
  if (explicit !== null) {
    return explicit;
  }

  const used = extractContextUsedTokens(result, thread, tokenUsage);
  const max = extractContextMaxTokens(result, thread, tokenUsage);
  if (used === null || max === null || max <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, ((max - used) / max) * 100));
}

export function extractCompletedAgentMessage(notification: AppServerNotification): {
  threadId: string;
  text: string;
} | null {
  if (notification.method !== "item/completed") {
    return null;
  }

  const params = asRecord(notification.params);
  const item = asRecord(params?.item);
  if (!item || firstString(item.type) !== "agentMessage") {
    return null;
  }

  const threadId = firstString(params?.threadId);
  const text = extractAgentText(item);
  if (!threadId || !text) {
    return null;
  }

  return { threadId, text };
}

export function extractModelRuntimeEvent(notification: AppServerNotification): AppServerModelRuntimeEvent | null {
  if (notification.method !== "model/rerouted" && notification.method !== "model/verification") {
    return null;
  }
  const params = asRecord(notification.params);
  const threadId = firstString(params?.threadId);
  if (!threadId) return null;
  return notification.method === "model/rerouted"
    ? {
        threadId,
        kind: "rerouted",
        fromModel: firstString(params?.fromModel) ?? null,
        toModel: firstString(params?.toModel) ?? null,
        reason: firstString(params?.reason) ?? null,
        verifications: []
      }
    : {
        threadId,
        kind: "verified",
        fromModel: null,
        toModel: null,
        reason: null,
        verifications: Array.isArray(params?.verifications)
          ? params.verifications.filter((value): value is string => typeof value === "string")
          : []
      };
}

export function extractProgressEvent(notification: AppServerNotification): AppServerProgressEvent | null {
  const isFileChangeProgress = FILE_CHANGE_PROGRESS_METHODS.has(notification.method);
  if (
    notification.method !== "item/started" &&
    notification.method !== "item/completed" &&
    !isFileChangeProgress
  ) {
    return null;
  }

  const params = asRecord(notification.params);
  const item = asRecord(params?.item) ?? (isFileChangeProgress ? params : null);
  if (!item || firstString(item.type) === "agentMessage") {
    return null;
  }

  const threadId = firstString(params?.threadId, params?.conversationId, params?.sessionId);
  if (!threadId) {
    return null;
  }
  const turnId = firstString(params?.turnId, item.turnId, asRecord(item.payload)?.turnId);
  const itemId = firstString(item.id, params?.itemId, item.itemId);
  const event = extractProgressEventFromItem({
    action: isFileChangeProgress ? "write" : undefined,
    fallback: params,
    item,
    label: isFileChangeProgress ? "Edited" : undefined,
    fallbackText: notification.method === "item/started"
      ? "Tool call started."
      : isFileChangeProgress
        ? "File changes updated."
        : undefined,
    fileMutation: isFileChangeProgress,
    requireProgressItem: !isFileChangeProgress,
    threadId,
    toolName: isFileChangeProgress ? null : undefined
  });
  return event
    ? { ...event, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}), completed: notification.method === "item/completed" }
    : null;
}

export function extractStatusUpdate(notification: AppServerNotification): AppServerStatusUpdate | null {
  const threadId = extractNotificationThreadId(notification);
  if (!threadId) {
    return null;
  }

  if (
    notification.method === "codex/event/task_started" ||
    notification.method === "turn/started" ||
    notification.method === "item/started" ||
    notification.method === "item/reasoning/summaryPartAdded" ||
    notification.method === "item/reasoning/summaryTextDelta" ||
    notification.method === "item/agentMessage/delta" ||
    notification.method === "item/agentMessage/contentDelta"
  ) {
    const detail = extractStatusDetail(notification);
    const activity = extractStatusActivity(notification);
    return {
      threadId,
      kind: "running",
      ...(activity ? { activity } : {}),
      label: extractStatusLabel(notification),
      detail: detail.text,
      detailMode: detail.mode
    };
  }

  if (notification.method === "turn/completed") {
    return {
      threadId,
      kind: "clear",
      label: null,
      detail: null,
      detailMode: null
    };
  }

  return null;
}

export function extractTurnLifecycleEvent(
  notification: AppServerNotification
): AppServerTurnLifecycleEvent | null {
  if (notification.method !== "turn/started" && notification.method !== "turn/completed") {
    return null;
  }

  const params = asRecord(notification.params);
  const threadId = firstString(params?.threadId);
  const turn = asRecord(params?.turn);
  const turnId = firstString(turn?.id);
  if (!threadId || !turnId) {
    return null;
  }

  // Terminal errors carry a public message; never stringify the full error payload.
  const error = firstString(asRecord(turn?.error)?.message)?.trim();

  return {
    threadId,
    turnId,
    kind: notification.method === "turn/started" ? "started" : "completed",
    ...(notification.method === "turn/completed" ? {
      terminalState: normalizeTurnTerminalState(firstString(turn?.status) ?? null),
      ...(error ? { error } : {})
    } : {})
  };
}

function normalizeTurnTerminalState(status: string | null): "completed" | "failed" | "interrupted" {
  switch (status?.toLowerCase()) {
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
      return "completed";
    case "failed":
    case "error":
    case "errored":
      return "failed";
    default:
      return "interrupted";
  }
}

export function extractResolvedRequestId(notification: AppServerNotification): string | null {
  if (notification.method !== "serverRequest/resolved") {
    return null;
  }

  const params = asRecord(notification.params);
  return firstString(params?.requestId) ?? null;
}

export function extractRateLimitsEvent(
  notification: AppServerNotification
): AppServerRateLimitsStatus | null {
  return notification.method === "account/rateLimits/updated"
    ? extractRateLimitsStatus(notification.params)
    : null;
}

export function extractMcpStartupStatusEvent(
  notification: AppServerNotification
): AppServerMcpStartupStatusEvent | null {
  if (
    notification.method !== "mcpServer/startupStatus/updated" &&
    notification.method !== "mcpServer/oauthLogin/completed"
  ) {
    return null;
  }

  const params = asRecord(notification.params);
  if (notification.method === "mcpServer/oauthLogin/completed") {
    const name = firstString(params?.name);
    if (!name) return null;
    return {
      name,
      status: params?.success === true ? "ready" : "error",
      error: params?.success === true ? null : firstString(params?.error) ?? "OAuth login failed"
    };
  }
  const server = asRecord(params?.server) ?? asRecord(params?.mcpServer) ?? params;
  const name = firstString(server?.name, server?.id, server?.serverName, server?.command) ?? null;
  if (!name) {
    return null;
  }

  return {
    name,
    status: firstString(server?.status, server?.state, server?.phase) ?? null,
    error: extractErrorMessage(server?.error) ?? firstString(server?.errorMessage, server?.message) ?? null
  };
}

export function extractTokenUsageEvent(
  notification: AppServerNotification
): AppServerTokenUsageEvent | null {
  if (notification.method !== "thread/tokenUsage/updated") {
    return null;
  }

  const threadId = extractNotificationThreadId(notification);
  if (!threadId) {
    return null;
  }

  const params = asRecord(notification.params);
  const tokenUsage = asRecord(params?.tokenUsage) ?? params;
  return {
    threadId,
    usedTokens: extractContextUsedTokens(params, null, tokenUsage),
    maxTokens: extractContextMaxTokens(params, null, tokenUsage),
    leftPercent: extractContextLeftPercent(params, null, tokenUsage)
  };
}

export function extractErrorEvent(notification: AppServerNotification): AppServerErrorEvent | null {
  if (
    notification.method !== "codex/event/stream_error" &&
    notification.method !== "codex/event/error" &&
    notification.method !== "error"
  ) {
    return null;
  }

  const params = asRecord(notification.params);
  const threadId = extractNotificationThreadId(notification);
  if (!threadId) {
    return null;
  }

  return {
    threadId,
    ...(firstString(params?.turnId) ? { turnId: firstString(params?.turnId) } : {}),
    stage: notification.method === "codex/event/stream_error" ? "stream" : "error",
    message:
      extractErrorMessage(params?.error) ??
      extractErrorMessage(params?.details) ??
      extractErrorMessage(params?.msg) ??
      extractErrorMessage(params) ??
      "Unknown error",
    retrying: params?.willRetry === true
  };
}

export function extractThreadCompactedEvent(notification: AppServerNotification): { threadId: string } | null {
  return extractCompactedThread(notification);
}
