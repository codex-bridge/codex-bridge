import { asRecord, firstString } from "./protocol-utils.js";
import { logger } from "../logging/logger.js";

export type ListedCodexThread = {
  threadId: string;
  modelProvider: string | null;
  modelProviderKnown: boolean;
  updatedAt: number | null;
  createdAt: number | null;
  name: string | null;
  preview: string | null;
  rolloutPath?: string | null;
  pathKey: string | null;
  currentCwd: string | null;
  archivedAt: number | null;
};

export type ThreadListApiDependencies = {
  connect: () => Promise<void>;
  request: (method: string, params?: unknown) => Promise<unknown>;
  requestKnownMethod: (
    method: "thread/archive" | "thread/unarchive" | "thread/name/set" | "thread/delete",
    params?: unknown
  ) => Promise<unknown>;
};

export type ThreadListOptions = {
  archived?: boolean;
  modelProviders?: string[];
};

function extractConversationPathKey(item: Record<string, unknown>): string | null {
  return firstString(
    item.path,
    item.rolloutPath,
    item.sessionPath,
    asRecord(item.session)?.path,
    asRecord(item.session)?.rolloutPath
  ) ?? null;
}

function extractConversationCurrentCwd(item: Record<string, unknown>): string | null {
  return firstString(
    item.cwd,
    item.workingDirectory,
    asRecord(item.session)?.cwd,
    asRecord(item.session)?.workingDirectory
  ) ?? null;
}

function normalizeEpochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeEpochMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 1_000_000_000_000) return value;
  if (value >= 1_000_000_000) return value * 1000;
  return null;
}

function extractTimestampFromRolloutPath(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

export class CodexThreadListApi {
  constructor(private readonly deps: ThreadListApiDependencies) {}

  async listThreadsForCwd(
    cwd?: string,
    options: ThreadListOptions = {}
  ): Promise<ListedCodexThread[]> {
    await this.deps.connect();
    const archived = options.archived === true;
    const modelProviders = options.modelProviders?.map((provider) => provider.trim()).filter(Boolean) ?? [];
    logger.info("codex.thread.list", { cwd: cwd ?? null, archived, modelProviders });
    const rows: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    while (pageCount < 100) {
      const result = asRecord(await this.deps.request("thread/list", {
        cursor,
        limit: 50,
        sortKey: "updated_at",
        ...(cwd ? { cwd } : {}),
        archived,
        ...(modelProviders.length > 0 ? { modelProviders } : {}),
        sourceKinds: ["appServer", "cli", "vscode"]
      }));
      const pageRows = Array.isArray(result?.data) ? result.data : [];
      rows.push(...pageRows);
      pageCount += 1;
      const nextCursor = firstString(result?.nextCursor) ?? null;
      if (!nextCursor) {
        cursor = null;
        break;
      }
      if (seenCursors.has(nextCursor)) throw new Error("Thread list pagination returned a repeated cursor.");
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (cursor) throw new Error("Thread list pagination did not terminate.");

    const firstRow = rows.length > 0 ? asRecord(rows[0]) : null;
    logger.info("codex.thread.list.rows", {
      cwd: cwd ?? null,
      archived,
      count: rows.length,
      pageCount,
      firstRowKeys: firstRow ? Object.keys(firstRow) : []
    });
    const threads = rows
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item): ListedCodexThread => {
        const currentCwd = extractConversationCurrentCwd(item);
        const rolloutPath = extractConversationPathKey(item);
        const pathKey = currentCwd ?? rolloutPath;
        const rolloutTimestamp = extractTimestampFromRolloutPath(rolloutPath);
        const modelProviderValue = firstString(item.modelProvider, item.model_provider);
        return {
          threadId: firstString(item.id, item.threadId, item.conversationId) ?? "",
          modelProvider: modelProviderValue ?? null,
          modelProviderKnown: Object.prototype.hasOwnProperty.call(item, "modelProvider") ||
            Object.prototype.hasOwnProperty.call(item, "model_provider"),
          rolloutPath,
          pathKey,
          currentCwd,
          updatedAt: normalizeEpochMs(item.updatedAt) ?? normalizeEpochMs(item.updated_at) ?? normalizeEpochMs(item.lastUpdatedAt) ?? normalizeEpochMs(item.last_updated_at) ?? normalizeEpochMs(item.timestamp) ?? rolloutTimestamp,
          createdAt: normalizeEpochMs(item.createdAt) ?? normalizeEpochMs(item.created_at) ?? normalizeEpochMs(item.startedAt) ?? normalizeEpochMs(item.started_at) ?? rolloutTimestamp,
          name: firstString(item.name) ?? null,
          preview: firstString(item.preview) ?? null,
          archivedAt: normalizeEpochMs(item.archivedAt) ?? normalizeEpochMs(item.archived_at) ?? (archived ? Date.now() : null)
        };
      })
      .filter((item) => Boolean(item.threadId));
    logger.info("codex.thread.list.result", {
      cwd: cwd ?? null,
      archived,
      modelProviders,
      count: threads.length,
      pageCount
    });
    return threads;
  }

  async listArchivedThreadsForCwd(cwd?: string, options: Omit<ThreadListOptions, "archived"> = {}): Promise<ListedCodexThread[]> {
    return this.listThreadsForCwd(cwd, { ...options, archived: true });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.deps.connect();
    await this.deps.requestKnownMethod("thread/archive", { threadId });
    logger.info("codex.thread.archived", { threadId });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.deps.connect();
    await this.deps.requestKnownMethod("thread/unarchive", { threadId });
    logger.info("codex.thread.unarchived", { threadId });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.deps.connect();
    await this.deps.requestKnownMethod("thread/delete", { threadId });
    logger.info("codex.thread.deleted", { threadId });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.deps.connect();
    await this.deps.requestKnownMethod("thread/name/set", { threadId, name });
    logger.info("codex.thread.name_set", { threadId, name });
  }
}
