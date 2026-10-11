import type { AppServerTokenUsageEvent } from "../../codex/client.js";
export type TokenUsage = { usedTokens: number | null; maxTokens: number | null; leftPercent: number | null };
export class TokenUsageTracker {
  private readonly usage = new Map<string, TokenUsage>();
  remember(value: AppServerTokenUsageEvent): void { this.usage.set(value.threadId, { usedTokens: value.usedTokens, maxTokens: value.maxTokens, leftPercent: value.leftPercent }); }
  get(threadId: string): TokenUsage | null { return this.usage.get(threadId) ?? null; }
  clear(): void { this.usage.clear(); }
  formatCompactUsage(threadId: string): string {
    const used = this.get(threadId)?.usedTokens;
    return typeof used === "number" && Number.isFinite(used) ? ` (${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(used)} used)` : "";
  }
}
