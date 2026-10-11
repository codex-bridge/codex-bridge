import type { WebActionSpec, WebMessageSpec } from "../../../src/web/message-presentation";
export type MessageSpec = WebMessageSpec;
export type { WebActionSpec };
export type Grant = { windowId: string; token: string };
export type SessionEntry = {
  threadId: string; sessionId: string | null; name: string | null; directory: string;
  archived: boolean; updatedAt: number | null; provider: string | null; connection: "active" | "inactive" | "unknown";
  capabilities?: { releaseToCodex: boolean };
  ownership: { state: string; ownerSourceId: string | null; pendingSourceId: string | null; version: number } | null;
};
export type Catalog = { directories: string[]; sessions: SessionEntry[] };
export type DirectoryReceipt = { directory: string; existing: boolean };
export type History = { threadId: string; sessionId: string; leaseVersion: number; messages: Array<{ role: "user" | "assistant"; text: string }> };
export type Decisions = { threadId: string; sessionId: string; leaseVersion: number; decisions: MessageSpec[] };
export type MessageEvent = { operation: "send" | "edit" | "delete" | "clear-actions"; sessionId: string;
  threadId: string; leaseVersion: number; messageId: string; message?: MessageSpec };
export type SessionBindingEvent = {
  kind: "requested" | "replaced" | "acquired" | "transferred" | "cancelled";
  sourceId: string; otherSourceId: string | null; sessionId: string; threadId: string;
  directory: string; leaseVersion: number;
};
export type StreamEvent = { name: string; data: unknown };
export type BindingReason = "claimed" | "already_owned" | "owned_by_other" | "unavailable" | "stale" | "cancelled" | "not_pending";
export type BindingReceipt = { owned?: boolean; pending?: boolean; cancelled?: boolean; reason: BindingReason;
  replacedSourceId?: string | null; leaseVersion?: number | null };
export type SendReceipt = { accepted: boolean; requestId: string; prompt?: MessageSpec };
export type DecisionReceipt = { accepted: boolean; decisionId: string; state: string | null; message?: string };
export type SessionCreateReceipt = { threadId: string; sessionId: string; leaseVersion: number };
export type OperationReceipt = { ok: boolean; message: MessageSpec };
export type SessionTool = "help" | "status" | "compact" | "interrupt";
export type QueueEntry = { id: string; summary: string; state: "submitting" | "queued" | "unknown"; createdAt: number };
export type QueueSnapshot = { threadId: string; sessionId: string; leaseVersion: number; running: boolean; entries: QueueEntry[] };
export function isOwned(entry: SessionEntry | undefined): boolean {
  return !!entry && !entry.archived && entry.ownership?.ownerSourceId === "web:local" &&
    ["active", "handoff_pending"].includes(entry.ownership.state);
}
