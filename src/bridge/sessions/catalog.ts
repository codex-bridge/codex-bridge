import type { CodexAppServerClient } from "../../codex/client.js";
import type { BridgeStore } from "../../store/index.js";
import type { SessionLeaseState, SessionRecord } from "../../shared/types.js";

export type SessionCatalogEntry = {
  threadId: string;
  sessionId: string | null;
  name: string | null;
  directory: string;
  archived: boolean;
  updatedAt: number | null;
  provider: string | null;
  connection: "active" | "inactive" | "unknown";
  capabilities: { releaseToCodex: boolean };
  ownership: { state: SessionLeaseState; ownerSourceId: string | null; pendingSourceId: string | null; version: number } | null;
};

export type SessionCatalog = {
  directories: string[];
  sessions: SessionCatalogEntry[];
};

/** Metadata only: never discovers bindings, resumes threads, or reads transcripts. */
export class SessionCatalogService {
  constructor(private readonly deps: {
    store: BridgeStore;
    codexClient: Pick<CodexAppServerClient, "listThreadsForCwd" | "listArchivedThreadsForCwd">;
    getSessionDirectory: (session: SessionRecord) => string;
    readEffectiveProvider: (directory: string) => Promise<string | null>;
    readLoadedThreadIds?: () => Promise<ReadonlySet<string> | null>;
    canReleaseToCodex?: (sessionId: string) => Promise<boolean>;
  }) {}

  async registration(threadId: string): Promise<{ threadId: string; directory: string; pathKey: string; name: string | null } | null> {
    const thread = (await this.deps.codexClient.listThreadsForCwd()).find((entry) => entry.threadId === threadId);
    if (!thread || thread.archivedAt !== null) return null;
    const known = await this.deps.store.getSessionByThreadId(threadId);
    const directory = thread.currentCwd ?? (known ? this.deps.getSessionDirectory(known) : null);
    if (!directory) return null;
    const provider = await this.deps.readEffectiveProvider(directory);
    if (provider && thread.modelProviderKnown && thread.modelProvider && provider !== thread.modelProvider) return null;
    return { threadId, directory, pathKey: thread.pathKey ?? known?.pathKey ?? directory, name: thread.name };
  }

  async archivedRegistration(threadId: string): Promise<{ threadId: string; directory: string; pathKey: string; name: string | null } | null> {
    const thread = (await this.deps.codexClient.listArchivedThreadsForCwd()).find((entry) => entry.threadId === threadId);
    if (!thread) return null;
    const known = await this.deps.store.getSessionByThreadId(threadId);
    const directory = thread.currentCwd ?? (known ? this.deps.getSessionDirectory(known) : null);
    if (!directory) return null;
    const provider = await this.deps.readEffectiveProvider(directory);
    if (provider && thread.modelProviderKnown && thread.modelProvider && provider !== thread.modelProvider) return null;
    return { threadId, directory, pathKey: thread.pathKey ?? known?.pathKey ?? directory, name: thread.name };
  }

  async list(): Promise<SessionCatalog> {
    const registeredDirectories = this.deps.store.listWebDirectories();
    const [active, archived, known, loadedThreadIds] = await Promise.all([
      this.deps.codexClient.listThreadsForCwd(),
      this.deps.codexClient.listArchivedThreadsForCwd(),
      this.deps.store.listSessionsForPolling({ includeArchived: true }),
      this.deps.readLoadedThreadIds?.() ?? null
    ]);
    const byThread = new Map(known.map((session) => [session.codexThreadId, session]));
    const threads = new Map(active.map((thread) => [thread.threadId, { thread, archived: false }]));
    // A thread that moved while the two lists were being read occurs only once.
    for (const thread of archived) threads.set(thread.threadId, { thread, archived: true });
    const entries = [...threads.values()].flatMap(({ thread, archived }) => {
      const session = byThread.get(thread.threadId);
      const directory = thread.currentCwd ?? (session ? this.deps.getSessionDirectory(session) : null);
      if (!directory) return [];
      return [{ thread, session, directory, archived }];
    });
    const directories = [...new Set(entries.map((entry) => entry.directory))].sort();
    const providers = new Map(await Promise.all(directories.map(async (directory) =>
      [directory, await this.deps.readEffectiveProvider(directory)] as const)));
    const sessions = (await Promise.all(entries.map(async ({ thread, session, directory, archived }): Promise<SessionCatalogEntry | null> => {
      const effectiveProvider = providers.get(directory);
      if (effectiveProvider && thread.modelProviderKnown && thread.modelProvider && effectiveProvider !== thread.modelProvider) return null;
      const lease = session ? this.deps.store.getSessionLease(session.id) : null;
      const source = (id: string | null): string | null => id ? this.deps.store.getSessionBindingById(id)?.sourceId ?? null : null;
      return {
        threadId: thread.threadId, sessionId: session?.id ?? null,
        name: thread.name ?? session?.displayName ?? null, directory, archived,
        updatedAt: thread.updatedAt, provider: thread.modelProviderKnown ? thread.modelProvider : null,
        connection: loadedThreadIds === null ? "unknown" : loadedThreadIds.has(thread.threadId) ? "active" : "inactive",
        capabilities: { releaseToCodex: !archived && !!session &&
          await (this.deps.canReleaseToCodex?.(session.id) ?? Promise.resolve(false)) },
        ownership: lease ? {
          state: lease.state, ownerSourceId: source(lease.ownerBindingId),
          pendingSourceId: source(lease.pendingBindingId), version: lease.version
        } : null
      };
    }))).filter((entry): entry is SessionCatalogEntry => entry !== null);
    // Keep directory navigation independent of archive visibility and incomplete
    // upstream inventories. Native metadata still wins for known threads.
    const historicalDirectories = known.filter((session) => !threads.has(session.codexThreadId))
      .map((session) => this.deps.getSessionDirectory(session));
    return { directories: [...new Set([...registeredDirectories, ...historicalDirectories,
      ...sessions.map((session) => session.directory)])].sort(), sessions };
  }
}
