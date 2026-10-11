import { asRecord, firstString } from "./protocol-utils.js";
import {
  extractAccountStatus,
  extractAccountUsageStatus,
  extractLoadedThreads,
  extractMcpServerStatus,
  extractModelCatalog,
  extractSkillsCatalog,
  extractWorkspaceMessagesStatus
} from "./catalog-extractors.js";
import type {
  AppServerAccountStatus,
  AppServerAccountUsageStatus,
  AppServerLoadedThreadsSnapshot,
  AppServerLoadedThreadsStatus,
  AppServerMcpServerStatus,
  AppServerModelCatalog,
  AppServerRateLimitsStatus,
  AppServerSkillsCatalog,
  AppServerWorkspaceMessagesStatus
} from "./client.js";
import {
  extractRateLimitsStatus,
  extractRateLimitsStatusFromErrorMessage
} from "./rate-limit-extractors.js";
import { logger } from "../logging/logger.js";

type CatalogClientDependencies = {
  connect: () => Promise<void>;
  request: (method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
  requestKnownMethod: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

export class CodexCatalogApi {
  constructor(private readonly deps: CatalogClientDependencies) {}

  async readAccountStatus(): Promise<AppServerAccountStatus | null> {
    await this.deps.connect();
    logger.info("codex.account.status");
    try {
      return extractAccountStatus(await this.deps.request("account/read", {}));
    } catch (error) {
      logger.warn("codex.account.status_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async readRateLimitsStatus(): Promise<AppServerRateLimitsStatus | null> {
    await this.deps.connect();
    logger.info("codex.account.rate_limits");
    try {
      return extractRateLimitsStatus(await this.deps.request("account/rateLimits/read", {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = extractRateLimitsStatusFromErrorMessage(message);
      if (fallback) {
        logger.warn("codex.account.rate_limits_fallback_from_error_body", { planType: fallback.planType });
        return fallback;
      }
      logger.warn("codex.account.rate_limits_failed", { error: message });
      return null;
    }
  }

  async readAccountUsageStatus(): Promise<AppServerAccountUsageStatus | null> {
    await this.deps.connect();
    logger.info("codex.account.usage");
    try {
      return extractAccountUsageStatus(await this.deps.requestKnownMethod("account/usage/read", {}, { timeoutMs: 5_000 }));
    } catch (error) {
      logger.warn("codex.account.usage_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async readWorkspaceMessagesStatus(): Promise<AppServerWorkspaceMessagesStatus | null> {
    await this.deps.connect();
    logger.info("codex.account.workspace_messages");
    try {
      return extractWorkspaceMessagesStatus(await this.deps.requestKnownMethod("account/workspaceMessages/read", {}, { timeoutMs: 5_000 }));
    } catch (error) {
      logger.warn("codex.account.workspace_messages_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async readModelCatalog(): Promise<AppServerModelCatalog | null> {
    await this.deps.connect();
    logger.info("codex.model.catalog");
    try {
      const data: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = asRecord(await this.deps.requestKnownMethod(
          "model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) }, { timeoutMs: 5_000 }
        ));
        if (!Array.isArray(result?.data)) throw new Error("Invalid model catalog page");
        data.push(...result.data);
        cursor = firstString(result.nextCursor) ?? undefined;
        if (cursor) {
          if (cursors.has(cursor) || cursors.size >= 100) throw new Error("Model catalog pagination did not terminate");
          cursors.add(cursor);
        }
      } while (cursor);
      return extractModelCatalog({ data });
    } catch (error) {
      logger.warn("codex.model.catalog_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async startCompactThread(threadId: string): Promise<void> {
    await this.deps.connect();
    logger.info("codex.thread.compact.start", { threadId });
    await this.deps.requestKnownMethod("thread/compact/start", { threadId });
  }

  async readSkillsCatalog(): Promise<AppServerSkillsCatalog | null> {
    await this.deps.connect();
    logger.info("codex.skills.catalog");
    try {
      return extractSkillsCatalog(await this.deps.requestKnownMethod("skills/list", {}, { timeoutMs: 5_000 }));
    } catch (error) {
      logger.warn("codex.skills.catalog_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async readMcpServerStatus(): Promise<AppServerMcpServerStatus | null> {
    await this.deps.connect();
    logger.info("codex.mcp.status");
    try {
      return extractMcpServerStatus(await this.deps.requestKnownMethod("mcpServerStatus/list", {}, { timeoutMs: 3_000 }));
    } catch (error) {
      logger.warn("codex.mcp.status_failed", { error: error instanceof Error ? error.message : String(error) });
      return { total: 0, running: 0, failed: 0, unknown: 0, error: error instanceof Error ? error.message : String(error), servers: [] };
    }
  }

  async readLoadedThreadsStatus(threadId: string): Promise<AppServerLoadedThreadsStatus | null> {
    const loaded = await this.readLoadedThreads();
    return loaded ? { total: loaded.total, activeLoaded: loaded.threadIds.includes(threadId) } : null;
  }

  async readLoadedThreads(): Promise<AppServerLoadedThreadsSnapshot | null> {
    await this.deps.connect();
    logger.info("codex.thread.loaded.list");
    try {
      return extractLoadedThreads(await this.deps.requestKnownMethod("thread/loaded/list", {}, { timeoutMs: 3_000 }));
    } catch (error) {
      logger.warn("codex.thread.loaded.list_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}
