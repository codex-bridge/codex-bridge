import { asRecord, firstString } from "./protocol-utils.js";

export type RealtimeHistoryOptions = { cursor?: string; limit?: number; snapshotEnd?: number; sessionId?: string;
  eventId?: string; requiredThroughPosition?: number; fromObservedAtMs?: number; toObservedAtMs?: number };
export type RealtimeHistoryEntry = { position: number; id: string; sessionId: string; type: string; observedAtMs: number | null;
  role: string | null; text: string | null; turnId: string | null };
export type RealtimeHistoryPage = { data: RealtimeHistoryEntry[]; nextCursor: string | null; snapshotEnd: number;
  projectedThroughItemIndex: number; coverage: "unsupported" | "pending" | "ready" };

export class CodexRealtimeHistoryApi {
  constructor(private readonly deps: { connect: () => Promise<void>;
    request: (method: string, params: unknown, options?: {timeoutMs?: number}) => Promise<unknown> }) {}

  async read(threadId: string, options: RealtimeHistoryOptions = {}): Promise<RealtimeHistoryPage> {
    if (!threadId.trim()) throw new Error("Thread ID is required.");
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error("History limit must be between 1 and 100.");
    await this.deps.connect();
    const response = asRecord(await this.deps.request("thread/realtime/list", { ...options, threadId, limit: options.limit ?? 50 }, { timeoutMs: 5000 }));
    if (!response || !Array.isArray(response.data) || !["unsupported", "pending", "ready"].includes(String(response.coverage)) ||
      !Number.isSafeInteger(response.snapshotEnd) || !Number.isSafeInteger(response.projectedThroughItemIndex)) throw new Error("Invalid realtime history response.");
    return { data: response.data.flatMap(value => {
      const row = asRecord(value), item = asRecord(row?.item);
      const id = firstString(item?.id), sessionId = firstString(item?.realtimeSessionId), type = firstString(item?.type);
      if (!id || !sessionId || !type || !Number.isSafeInteger(row?.position)) return [];
      // Only the public transcript leaves this boundary; frame/audio and internal handoff payloads do not.
      return [{ position: row!.position as number, id, sessionId, type,
        observedAtMs: typeof item?.observedAtMs === "number" ? item.observedAtMs : null,
        role: firstString(item?.role) ?? null, text: type === "transcriptSegment" ? firstString(item?.text) ?? "" : null,
        turnId: firstString(item?.turnId) ?? null }];
    }), nextCursor: firstString(response.nextCursor) ?? null, snapshotEnd: response.snapshotEnd as number,
      projectedThroughItemIndex: response.projectedThroughItemIndex as number, coverage: response.coverage as RealtimeHistoryPage["coverage"] };
  }
}
