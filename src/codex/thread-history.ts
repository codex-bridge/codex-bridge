import type { AppServerProgressEvent } from "./client.js";
import { extractProgressEventFromItem } from "./extractors/progress.js";
import { asRecord, extractMessageText, firstString } from "./protocol-utils.js";

export type ThreadHistoryTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type ThreadHistoryEntry =
  | {
      kind: "message";
      itemId: string;
      role: "user" | "assistant";
      text: string;
      turnId: string;
    }
  | {
      event: AppServerProgressEvent;
      itemId: string;
      kind: "progress";
      turnId: string;
    }
  | {
      itemId: string;
      kind: "compaction";
      turnId: string;
    }
  | {
      completedAt: number | null;
      durationMs: number | null;
      error: string | null;
      kind: "turn";
      startedAt: number | null;
      status: ThreadHistoryTurnStatus;
      turnId: string;
    };

export type ThreadHistoryTurn = {
  entries: ThreadHistoryEntry[];
  itemIds: string[];
  turnId: string;
};

export type ThreadHistoryTurnsPage = {
  nextCursor: string | null;
  turns: ThreadHistoryTurn[];
};

const TURN_STATUSES = new Set<ThreadHistoryTurnStatus>([
  "completed",
  "interrupted",
  "failed",
  "inProgress"
]);

function optionalFiniteNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid thread turn ${field}.`);
  }
  return value;
}

function extractTurnError(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  const error = asRecord(value);
  if (!error) {
    throw new Error("Invalid thread turn error.");
  }
  return firstString(error.message, error.code) ?? null;
}

export function normalizeFullThreadTurnsPage(
  value: unknown,
  threadId: string
): ThreadHistoryTurnsPage {
  const result = asRecord(value);
  if (!result || !Array.isArray(result.data)) {
    throw new Error("Invalid thread turns page.");
  }
  if (result.nextCursor !== null && typeof result.nextCursor !== "string") {
    throw new Error("Invalid thread turns cursor.");
  }

  const turns = result.data.map((value): ThreadHistoryTurn => {
    const turn = asRecord(value);
    const turnId = firstString(turn?.id);
    const status = firstString(turn?.status);
    if (!turnId || !turn || !Array.isArray(turn.items)) {
      throw new Error("Invalid thread turn entry.");
    }
    if (!status || !TURN_STATUSES.has(status as ThreadHistoryTurnStatus)) {
      throw new Error("Invalid thread turn status.");
    }

    const entries: ThreadHistoryEntry[] = [];
    const itemIds: string[] = [];
    for (const value of turn.items) {
      const item = asRecord(value);
      const itemId = firstString(item?.id);
      if (!item || !itemId) {
        throw new Error("Invalid thread item entry.");
      }
      itemIds.push(itemId);

      if (item.type === "userMessage" || item.type === "agentMessage") {
        const text = extractMessageText(item);
        if (text) {
          entries.push({
            kind: "message",
            itemId,
            role: item.type === "userMessage" ? "user" : "assistant",
            text,
            turnId
          });
        }
        continue;
      }
      if (item.type === "contextCompaction") {
        entries.push({ kind: "compaction", itemId, turnId });
        continue;
      }

      const event = extractProgressEventFromItem({ item, threadId });
      if (event && (
        event.changes?.length ||
        event.label.startsWith("Called") ||
        event.label === "Edited" ||
        event.label === "Explored"
      )) {
        entries.push({ event, itemId, kind: "progress", turnId });
      }
    }

    entries.push({
      completedAt: optionalFiniteNumber(turn.completedAt, "completedAt"),
      durationMs: optionalFiniteNumber(turn.durationMs, "durationMs"),
      error: extractTurnError(turn.error),
      kind: "turn",
      startedAt: optionalFiniteNumber(turn.startedAt, "startedAt"),
      status: status as ThreadHistoryTurnStatus,
      turnId
    });
    return { entries, itemIds, turnId };
  });

  return {
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
    turns
  };
}
