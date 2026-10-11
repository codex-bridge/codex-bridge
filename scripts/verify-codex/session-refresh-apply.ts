import { CodexThreadMetadataCache } from "../../src/codex/thread-metadata-cache.js";
import type { CodexAppServerClient } from "../../src/codex/client.js";
import { pickDirectory } from "../../src/bridge/sessions/menu-formatters.js";
import { RolloutReader } from "../../src/bridge/sessions/rollout-reader.js";
import { SessionDiscoveryService } from "../../src/bridge/sessions/discovery.js";
import type { SessionRecord } from "../../src/shared/types.js";
import { BridgeStore } from "../../src/store/index.js";

type SessionState = Pick<SessionRecord, "codexThreadId" | "codexArchivedAt" | "discoveryMissingCount">;

function indexSessions(sessions: SessionState[]): Map<string, SessionState> {
  return new Map(sessions.map((session) => [session.codexThreadId, session]));
}

export type SessionRefreshApplyResult = {
  mode: "sandbox" | "production";
  created: string[];
  archived: string[];
  restored: string[];
  deleted: string[];
  missingCountChanged: string[];
};

export async function applySessionRefresh(
  client: CodexAppServerClient,
  store: BridgeStore,
  sourceId: string,
  mode: "sandbox" | "production"
): Promise<SessionRefreshApplyResult> {
  const before = await store.listKnownSessions(sourceId, { includeArchived: true });
  const reader = new RolloutReader();
  const discovery = new SessionDiscoveryService({
    store,
    codexClient: client,
    threadMetadataCache: new CodexThreadMetadataCache(),
    getDiscoveryChatIds: () => [],
    pickDirectory,
    resolveSessionActivityAt: (rolloutPath, fallbackTimestamp) =>
      reader.resolveSessionActivityAt(rolloutPath, fallbackTimestamp),
    readDisplayPathFromRollout: (rolloutPath) => reader.readDisplayPath(rolloutPath),
    readThreadStatus: (threadId, cwd, options) => client.readThreadStatus(threadId, cwd, options),
    onSessionsChanged: () => undefined,
    onSessionDeleted: () => undefined
  });
  await discovery.refreshSessionsForChat(sourceId, { includeUnknownThreads: true });
  const after = await store.listKnownSessions(sourceId, { includeArchived: true });
  const beforeByThread = indexSessions(before);
  const afterByThread = indexSessions(after);

  return {
    mode,
    created: after.filter((session) => !beforeByThread.has(session.codexThreadId)).map((session) => session.codexThreadId),
    archived: after.filter((session) => {
      const previous = beforeByThread.get(session.codexThreadId);
      return previous?.codexArchivedAt === null && session.codexArchivedAt !== null;
    }).map((session) => session.codexThreadId),
    restored: after.filter((session) => {
      const previous = beforeByThread.get(session.codexThreadId);
      return previous?.codexArchivedAt !== null && session.codexArchivedAt === null;
    }).map((session) => session.codexThreadId),
    deleted: before.filter((session) => !afterByThread.has(session.codexThreadId)).map((session) => session.codexThreadId),
    missingCountChanged: after.filter((session) =>
      beforeByThread.get(session.codexThreadId)?.discoveryMissingCount !== session.discoveryMissingCount
    ).map((session) => session.codexThreadId)
  };
}
