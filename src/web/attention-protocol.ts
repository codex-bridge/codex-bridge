/** Shared wire contract. Keep it independent of Bridge services and browser APIs. */
export type WebAttentionKind = "turn-ended" | "turn-failed" | "approval-required" | "input-required" | "binding-acquired";
export type WebAttentionEvent = {
  id: string;
  kind: WebAttentionKind;
  sessionId: string;
  threadId: string;
  directory: string;
  name: string | null;
  leaseVersion: number;
};
