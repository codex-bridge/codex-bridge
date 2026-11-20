import type { AppServerNotification, AppServerProgressEvent } from "./client.js";
import { asRecord, firstString } from "./protocol-utils.js";

type Summary = { parts: Map<number, string>; terminal: boolean; emitted: string };
type TurnSummaries = { turnId: string; items: Map<string, Summary> };

/** Tracks only public summary fields for an explicitly routed live turn. */
export class ReasoningSummaryTracker {
  private readonly threads = new Map<string, TurnSummaries>();

  reset(threadId?: string, turnId?: string): void {
    if (threadId) {
      if (!turnId || this.threads.get(threadId)?.turnId === turnId) this.threads.delete(threadId);
    }
    else this.threads.clear();
  }

  observe(notification: AppServerNotification, activeTurnId: string | undefined): AppServerProgressEvent | null {
    const p = asRecord(notification.params), threadId = firstString(p?.threadId), turnId = firstString(p?.turnId);
    if (!threadId || !turnId || turnId !== activeTurnId) return null;
    const item = asRecord(p?.item);
    const delta = notification.method === "item/reasoning/summaryTextDelta";
    const partAdded = notification.method === "item/reasoning/summaryPartAdded";
    const snapshot = (notification.method === "item/started" || notification.method === "item/completed") && item?.type === "reasoning";
    if (!delta && !partAdded && !snapshot) return null;
    const itemId = firstString(snapshot ? item?.id : p?.itemId);
    if (!itemId) return null;
    const index = p?.summaryIndex;
    if (!snapshot && (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)) return null;
    if (delta && typeof p?.delta !== "string") return null;

    let turn = this.threads.get(threadId);
    if (turn?.turnId !== turnId) {
      turn = { turnId, items: new Map() };
      this.threads.set(threadId, turn);
    }
    let summary = turn.items.get(itemId);
    if (summary?.terminal) return null;
    if (!summary) {
      summary = { parts: new Map(), terminal: false, emitted: "" };
      turn.items.set(itemId, summary);
    }
    if (delta) summary.parts.set(index as number, (summary.parts.get(index as number) ?? "") + p!.delta);
    if (snapshot && Array.isArray(item?.summary) && item.summary.every(part => typeof part === "string") && item.summary.length) {
      summary.parts = new Map(item.summary.map((text: string, index: number) => [index, text]));
    }
    summary.terminal = snapshot && notification.method === "item/completed";
    const lines = [...summary.parts].sort(([a], [b]) => a - b).map(([, text]) => text);
    if (!lines.some(line => line.trim())) return null;
    const fingerprint = JSON.stringify([lines, summary.terminal]);
    if (fingerprint === summary.emitted) return null;
    summary.emitted = fingerprint;
    return { threadId, turnId, itemId, label: "Thinking", toolName: null, action: null, target: null,
      input: null, changes: null, failed: false, completed: summary.terminal, text: lines.join("\n"),
      activity: { key: `reasoning:${itemId}`, kind: "thinking", name: "Thinking", status: "", lines,
        terminal: summary.terminal } };
  }
}
