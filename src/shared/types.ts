export type DecisionAction =
  | "accept"
  | "acceptForSession"
  | "acceptWithExecpolicyAmendment"
  | "decline"
  | "cancel";

export interface SessionRecord {
  id: string;
  telegramChatId: string;
  codexThreadId: string;
  pathKey: string;
  currentCwd: string | null;
  displayName: string | null;
  batchDecisionMessageId: string | null;
  codexArchivedAt: number | null;
  latestActivityAt: number;
  createdAt: number;
  discoveryMissingSince: number | null;
  discoveryMissingCount: number;
  lastDiscoveredAt: number;
}

export type SessionLeaseState =
  | "unbound"
  | "active"
  | "handoff_pending"
  | "releasing"
  | "external_unknown"
  | "archived"
  | "deleted";

export type TurnRouteState = "active" | "completed" | "failed" | "interrupted";

// `other` and `completed` are retained only for rows written by releases before
// the phase-lifecycle model. New phases must never use either value.
export type ProgressPhaseKind = "run" | "called" | "edited" | "explored" | "system" | "other";
export type ProgressPhaseState =
  | "active"
  | "phase_complete"
  | "step_failed"
  | "failed"
  | "interrupted"
  | "completed";
export type ProgressFailureReason =
  | "timeout"
  | "permission_denied"
  | "not_found"
  | "unavailable"
  | "cancelled"
  | "other_failure";
export type ProgressPhaseDeliveryState = "synced" | "pending_finalization" | "correction_sent" | "unavailable";

export interface ProgressPhaseOperationGroup {
  name: string;
  count: number;
  // Only explicit failed tool events carry this flag; legacy groups are unknown.
  failed?: boolean;
}

export interface ProgressPhaseAggregate {
  eventCount: number;
  operations: ProgressPhaseOperationGroup[];
  files: Record<string, { added: number; removed: number; lineStatsAvailable?: boolean }>;
  // Absent on legacy phases: their per-file totals cannot reconstruct edit order.
  fileEdits?: ProgressPhaseFileEdit[];
  run: { updates: number; succeeded: number; failed: number };
  explored: Record<string, number>;
}

export interface ProgressPhaseFileEdit {
  itemId: string;
  status: "pending" | "completed" | "failed";
  files: Array<{ path: string; added: number; removed: number; lineStatsAvailable: boolean }>;
}

export interface SessionBindingRecord {
  id: string;
  sessionId: string;
  platform: "telegram" | "slack" | "web";
  botKey: string;
  sourceId: string;
  channelId: string | null;
  threadId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionLeaseRecord {
  sessionId: string;
  state: SessionLeaseState;
  ownerBindingId: string | null;
  pendingBindingId: string | null;
  ownerTurnId: string | null;
  version: number;
  updatedAt: number;
}

export interface TurnRouteRecord {
  turnId: string;
  sessionId: string;
  codexThreadId: string;
  bindingId: string | null;
  sourceId: string;
  state: TurnRouteState;
  createdAt: number;
  updatedAt: number;
}

export interface ProgressPhaseMessageRecord {
  id: string;
  sessionId: string;
  codexThreadId: string;
  turnId: string;
  phaseSeq: number;
  phaseKind: ProgressPhaseKind;
  sourceId: string;
  platformMessageId: string;
  directory: string;
  text: string;
  aggregate: ProgressPhaseAggregate;
  updateCount: number;
  state: ProgressPhaseState;
  failureReason: ProgressFailureReason | null;
  deliveryState: ProgressPhaseDeliveryState;
  correctionMessageId: string | null;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  codexTurnId: string | null;
  telegramMessageId: string | null;
  createdAt: number;
}

export interface DecisionRecord {
  id: string;
  sessionId: string;
  telegramChatId: string;
  approvalId: string;
  kind: string | null;
  title: string;
  summary: string | null;
  requiresUserInput: boolean;
  state:
    | "pending"
    | "awaitingInput"
    | "approved"
    | "approvedForSession"
    | "rejected"
    | "cancelled"
    | "stale";
  telegramMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NormalizedCodexEvent {
  id: string;
  type: string;
  createdAt: number;
  text?: string;
  approval?: {
    approvalId: string;
    kind: string | null;
    title: string;
    summary: string | null;
  };
  raw: unknown;
}
