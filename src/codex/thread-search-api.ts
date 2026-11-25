import type { AppServerNotification } from "./client.js";
import type { JsonRpcId } from "./app-server-connection.js";
import { asRecord, firstString } from "./protocol-utils.js";

export type ThreadSearchResult = { threadId: string; name: string | null; directory: string | null;
  archived: boolean; snippet: string; modelProvider: string | null };
export type ThreadSearchPage = { data: ThreadSearchResult[]; nextCursor: string | null };
export type ThreadSearchOptions = { archived?: boolean; cursor?: string; limit?: number; signal?: AbortSignal;
  onPartial?: (results: ThreadSearchResult[]) => void; stream?: boolean };

export class CodexThreadSearchApi {
  constructor(private readonly deps: {
    connect: () => Promise<void>;
    request: (method: string, params: unknown, options?: { timeoutMs?: number; onRequestId?: (id: JsonRpcId) => void }) => Promise<unknown>;
    onNotification: (listener: (event: AppServerNotification) => void) => () => void;
  }) {}

  async search(query: string, options: ThreadSearchOptions = {}): Promise<ThreadSearchPage> {
    const searchTerm = query.trim();
    if (!searchTerm || Buffer.byteLength(searchTerm, "utf8") > 65_536) throw new Error("Search must contain 1–65,536 UTF-8 bytes.");
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error("Search limit must be between 1 and 100.");
    options.signal?.throwIfAborted();
    const method = options.stream === false ? "thread/search" : "thread/search/stream";
    await this.deps.connect();
    options.signal?.throwIfAborted();
    let id: JsonRpcId | undefined, finished = false, cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      if (id === undefined || finished || cancellation) return;
      cancellation = this.deps.request(method === "thread/search" ? "thread/search/cancel" : "thread/search/stream/cancel", { requestId: id }, { timeoutMs: 5000 }).catch(() => undefined);
    };
    const unsubscribe = this.deps.onNotification(event => {
      const params = asRecord(event.params);
      if (!finished && !options.signal?.aborted && id !== undefined && event.method === "thread/search/partial" && params && params.requestId === id && Array.isArray(params.data)) {
        options.onPartial?.(parseSearchRows(params.data, options.archived === true));
      }
    });
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = asRecord(await this.deps.request(method, {
        searchTerm, archived: options.archived === true, limit: options.limit ?? 50,
        cursor: options.cursor ?? null, sortKey: "updated_at", sourceKinds: ["appServer", "cli", "vscode"]
      }, { timeoutMs: 30_000, onRequestId: value => { id = value; } }));
      options.signal?.throwIfAborted();
      if (!Array.isArray(result?.data)) throw new Error("Invalid search response.");
      return { data: parseSearchRows(result.data, options.archived === true), nextCursor: firstString(result.nextCursor) ?? null };
    } catch (error) {
      // A timeout must not leave the upstream search subprocess running.
      cancel();
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      finished = true;
      unsubscribe();
      options.signal?.removeEventListener("abort", cancel);
      await cancellation;
    }
  }
}

function parseSearchRows(data: unknown[], archived: boolean): ThreadSearchResult[] {
  return data.flatMap(value => {
    const row = asRecord(value), thread = asRecord(row?.thread), threadId = firstString(thread?.id);
    if (!threadId) return [];
    return [{ threadId, name: firstString(thread?.name) ?? null, directory: firstString(thread?.cwd) ?? null,
      modelProvider: firstString(thread?.modelProvider) ?? null, archived, snippet: firstString(row?.snippet) ?? "" }];
  });
}
