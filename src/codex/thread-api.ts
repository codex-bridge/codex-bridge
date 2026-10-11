import {
  extractContextLeftPercent,
  extractContextMaxTokens,
  extractContextUsedTokens
} from "./notification-events.js";
import { asRecord, extractMessageText, firstString } from "./protocol-utils.js";
import { normalizeFullThreadTurnsPage, type ThreadHistoryEntry, type ThreadHistoryTurn } from "./thread-history.js";
import { logger } from "../logging/logger.js";
import type { AppServerHistoryMessage, AppServerThreadStatus } from "./client.js";

export type ThreadApiDependencies = {
  connect: () => Promise<void>;
  getObservedThreadSettings: (threadId: string) => AppServerThreadStatus | undefined;
  isUnknownMethodError: (error: unknown, method: string) => boolean;
  rememberThreadSettings: (threadId: string, result: unknown) => void;
  request: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
  requestKnownMethod: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

export type ThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";

export class CodexThreadApi {
  constructor(private readonly deps: ThreadApiDependencies) {}

  async resumeThread(threadId: string, cwd?: string, assertCurrent?: () => void, timeoutMs?: number): Promise<{
    displayPath: string | null;
    messages: Array<{ role: "user" | "assistant" | "system"; text: string }>;
  }> {
    await this.deps.connect();
    logger.info("codex.thread.resume", { threadId, cwd });
    const params: Record<string, unknown> = { threadId };
    if (cwd) {
      params.cwd = cwd;
    }
    assertCurrent?.();
    const result = await this.deps.request("thread/resume", params, { timeoutMs });
    this.deps.rememberThreadSettings(threadId, result);
    const displayPath = extractResumeDisplayPath(result);
    const messages = extractResumeMessages(result);
    logger.info("codex.thread.resume.result", { threadId, displayPath, messageCount: messages.length });
    return { displayPath, messages };
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeStatus> {
    await this.deps.connect();
    logger.info("codex.thread.unsubscribe", { threadId });
    const result = asRecord(await this.deps.requestKnownMethod("thread/unsubscribe", { threadId }));
    const status = firstString(result?.status);
    if (status !== "notLoaded" && status !== "notSubscribed" && status !== "unsubscribed") {
      throw new Error("thread/unsubscribe returned an invalid status.");
    }
    logger.info("codex.thread.unsubscribe.result", { threadId, status });
    return status;
  }

  async listRecentThreadMessages(threadId: string, maxMessages = 5): Promise<AppServerHistoryMessage[]> {
    await this.deps.connect();
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
      throw new Error("maxMessages must be an integer between 1 and 100.");
    }

    const turns: AppServerHistoryMessage[][] = [];
    const seenCursors = new Set<string>();
    const seenItems = new Set<string>();
    let cursor: string | null = null;
    let messageCount = 0;
    let pageCount = 0;

    while (pageCount < 20 && messageCount < maxMessages) {
      const page = extractThreadTurnsPage(await this.deps.requestKnownMethod(
        "thread/turns/list",
        { threadId, cursor, limit: 10, sortDirection: "desc", itemsView: "summary" },
        { timeoutMs: 8_000 }
      ));
      pageCount += 1;
      for (const messages of page.turns) {
        for (const message of messages) {
          const key = `${message.turnId}\u0000${message.itemId}`;
          if (seenItems.has(key)) {
            throw new Error("Thread turns pagination returned a repeated item.");
          }
          seenItems.add(key);
        }
      }
      turns.push(...page.turns);
      messageCount += page.turns.reduce((count, messages) => count + messages.length, 0);

      if (!page.nextCursor) {
        cursor = null;
        break;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Thread turns pagination returned a repeated cursor.");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (cursor && messageCount < maxMessages) {
      throw new Error("Thread turns pagination did not terminate.");
    }

    const messages = turns.reverse().flat().slice(-maxMessages);
    logger.info("codex.thread.turns.history", { threadId, pageCount, messageCount: messages.length });
    return messages;
  }

  async listRecentThreadHistory(threadId: string, maxTurns = 2): Promise<ThreadHistoryEntry[]> {
    await this.deps.connect();
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) {
      throw new Error("maxTurns must be an integer between 1 and 20.");
    }

    const turns: ThreadHistoryTurn[] = [];
    const seenCursors = new Set<string>();
    const seenTurns = new Set<string>();
    const seenItems = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;

    while (pageCount < 20 && turns.length < maxTurns) {
      const page = normalizeFullThreadTurnsPage(await this.deps.requestKnownMethod(
        "thread/turns/list",
        { threadId, cursor, limit: Math.min(10, maxTurns - turns.length), sortDirection: "desc", itemsView: "full" },
        { timeoutMs: 8_000 }
      ), threadId);
      pageCount += 1;
      for (const turn of page.turns) {
        if (seenTurns.has(turn.turnId)) {
          throw new Error("Thread turns pagination returned a repeated turn.");
        }
        seenTurns.add(turn.turnId);
        for (const itemId of turn.itemIds) {
          const key = `${turn.turnId}\u0000${itemId}`;
          if (seenItems.has(key)) {
            throw new Error("Thread turns pagination returned a repeated item.");
          }
          seenItems.add(key);
        }
      }
      turns.push(...page.turns);

      if (!page.nextCursor) {
        cursor = null;
        break;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Thread turns pagination returned a repeated cursor.");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (cursor && turns.length < maxTurns) {
      throw new Error("Thread turns pagination did not terminate.");
    }

    const entries = turns.slice(0, maxTurns).reverse().flatMap((turn) => turn.entries);
    logger.info("codex.thread.turns.full_history", {
      threadId,
      pageCount,
      turnCount: Math.min(turns.length, maxTurns),
      entryCount: entries.length
    });
    return entries;
  }

  async readThreadStatus(
    threadId: string,
    cwd?: string,
    options?: { readOnly?: boolean; timeoutMs?: number }
  ): Promise<AppServerThreadStatus> {
    await this.deps.connect();
    logger.info("codex.thread.status", { threadId, cwd });

    let result: unknown;
    try {
      result = await this.deps.request("thread/read", { threadId }, { timeoutMs: options?.timeoutMs });
    } catch (error) {
      if (options?.readOnly || !this.deps.isUnknownMethodError(error, "thread/read")) {
        throw error;
      }
      const params: Record<string, unknown> = { threadId };
      if (cwd) {
        params.cwd = cwd;
      }
      result = await this.deps.request("thread/resume", params);
    }

    const status = extractThreadStatus(result, threadId);
    const observed = this.deps.getObservedThreadSettings(threadId);
    return observed
      ? {
          ...status,
          model: observed.model,
          reasoningEffort: observed.reasoningEffort,
          modelProvider: observed.modelProvider ?? status.modelProvider,
          serviceTier: status.serviceTierKnown ? status.serviceTier : observed.serviceTier,
          serviceTierKnown: status.serviceTierKnown || observed.serviceTierKnown
        }
      : status;
  }
}

export function extractThreadStatus(value: unknown, fallbackThreadId: string): AppServerThreadStatus {
  const result = asRecord(value);
  const thread = asRecord(result?.thread);
  const sandbox = asRecord(result?.sandbox) ?? asRecord(thread?.sandbox);
  const tokenUsage =
    asRecord(result?.tokenUsage) ??
    asRecord(thread?.tokenUsage) ??
    asRecord(result?.contextWindow) ??
    asRecord(thread?.contextWindow);
  const rawActivity: string | null = firstString(
    asRecord(result?.status)?.type,
    asRecord(result?.status)?.state,
    asRecord(thread?.status)?.type,
    asRecord(thread?.status)?.state,
    asRecord(thread?.status)?.status
  ) ?? null;
  const normalizedActivity = rawActivity?.toLowerCase().replace(/[-_]/g, "") ?? null;
  const activity: AppServerThreadStatus["activity"] = normalizedActivity &&
    ["active", "running", "inprogress", "working", "busy"].includes(normalizedActivity)
    ? "running"
    : normalizedActivity && ["notloaded", "idle", "completed", "ready", "inactive"].includes(normalizedActivity)
      ? "idle"
      : "unknown";

  return {
    threadId: firstString(result?.threadId, thread?.id) ?? fallbackThreadId,
    cwd: firstString(result?.cwd, result?.workingDirectory, thread?.cwd, thread?.workingDirectory) ?? null,
    threadName: firstString(result?.name, thread?.name, result?.title, thread?.title) ?? null,
    model: firstString(result?.model, thread?.model) ?? null,
    modelProvider: firstString(result?.modelProvider, thread?.modelProvider) ?? null,
    serviceTier: firstString(result?.serviceTier, thread?.serviceTier) ?? null,
    serviceTierKnown: result?.serviceTier !== undefined || thread?.serviceTier !== undefined,
    approvalPolicy: firstString(result?.approvalPolicy, thread?.approvalPolicy) ?? null,
    sandboxMode: firstString(sandbox?.type) ?? null,
    reasoningEffort: firstString(result?.reasoningEffort, thread?.reasoningEffort) ?? null,
    activity,
    activityType: rawActivity,
    contextLeftPercent: extractContextLeftPercent(result, thread, tokenUsage),
    contextUsedTokens: extractContextUsedTokens(result, thread, tokenUsage),
    contextMaxTokens: extractContextMaxTokens(result, thread, tokenUsage)
  };
}

function extractResumeDisplayPath(value: unknown): string | null {
  const seen = new Set<unknown>();
  function walk(node: unknown): string | null {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return null;
    }
    seen.add(node);
    const record = asRecord(node);
    if (record) {
      const direct = firstString(record.cwd, record.workingDirectory);
      if (direct && !direct.includes("/.codex/sessions/")) {
        return direct;
      }
      for (const value of Object.values(record)) {
        const found = walk(value);
        if (found) {
          return found;
        }
      }
      return null;
    }
    if (Array.isArray(node)) {
      for (const value of node) {
        const found = walk(value);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }
  return walk(value);
}

function extractResumeMessages(value: unknown): Array<{
  role: "user" | "assistant" | "system";
  text: string;
}> {
  const result = asRecord(value);
  const initialMessages = Array.isArray(result?.initialMessages) ? result.initialMessages : [];
  return initialMessages
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const payload = asRecord(item.payload);
      const role = firstString(
        payload?.role,
        item.role,
        payload?.type === "user_message" ? "user" : undefined,
        payload?.type === "assistant_message" ? "assistant" : undefined
      );
      const text = extractMessageText(payload ?? item);
      if (!text || role === "developer") {
        return null;
      }
      return {
        role: role === "user" || role === "assistant" || role === "system"
          ? role
          : payload?.type === "user_message" ? "user" : "system",
        text
      };
    })
    .filter(
      (item): item is { role: "user" | "assistant" | "system"; text: string } =>
        Boolean(item && (item.role === "user" || item.role === "assistant"))
    );
}

function extractThreadTurnsPage(value: unknown): {
  turns: AppServerHistoryMessage[][];
  nextCursor: string | null;
} {
  const result = asRecord(value);
  if (!result || !Array.isArray(result.data)) {
    throw new Error("Invalid thread turns page.");
  }
  if (result.nextCursor !== null && typeof result.nextCursor !== "string") {
    throw new Error("Invalid thread turns cursor.");
  }
  const turns = result.data.map((value) => {
    const turn = asRecord(value);
    const turnId = firstString(turn?.id);
    if (!turnId || !Array.isArray(turn?.items)) {
      throw new Error("Invalid thread turn entry.");
    }
    return turn.items.flatMap((value): AppServerHistoryMessage[] => {
      const item = asRecord(value);
      const itemId = firstString(item?.id);
      if (!item || !itemId) {
        throw new Error("Invalid thread item entry.");
      }
      const role = item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : null;
      if (!role) {
        return [];
      }
      const text = extractMessageText(item);
      return text ? [{ role, text, turnId, itemId }] : [];
    });
  });
  return {
    turns,
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null
  };
}
