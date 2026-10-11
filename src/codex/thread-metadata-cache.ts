import type { ListedCodexThread } from "./thread-list-api.js";

export type CachedThreadProvider = {
  provider: string | null;
  known: boolean;
};

export class CodexThreadMetadataCache {
  private readonly entries = new Map<string, ListedCodexThread>();
  private expiresAt = 0;

  constructor(
    private readonly ttlMs = 60_000,
    private readonly clock: () => number = Date.now
  ) {}

  replace(threads: ListedCodexThread[]): void {
    this.entries.clear();
    for (const thread of threads) {
      if (thread.threadId) this.entries.set(thread.threadId, thread);
    }
    this.expiresAt = this.clock() + this.ttlMs;
  }

  get(threadId: string): ListedCodexThread | null {
    if (this.expiresAt <= this.clock()) {
      this.clear();
      return null;
    }
    return this.entries.get(threadId) ?? null;
  }

  getProvider(threadId: string): CachedThreadProvider {
    const entry = this.get(threadId);
    if (!entry) return { provider: null, known: false };
    const provider = entry.modelProvider ?? null;
    return {
      provider,
      known: entry.modelProviderKnown ?? typeof entry.modelProvider === "string"
    };
  }

  setName(threadId: string, name: string | null): void {
    const entry = this.get(threadId);
    if (!entry) return;
    this.entries.set(threadId, { ...entry, name });
  }

  clear(): void {
    this.entries.clear();
    this.expiresAt = 0;
  }
}
