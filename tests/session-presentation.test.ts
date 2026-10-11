import assert from "node:assert/strict";
import test from "node:test";

import { CodexThreadMetadataCache } from "../src/codex/thread-metadata-cache.js";
import type { SessionRecord } from "../src/shared/types.js";
import {
  SessionPresentationService,
  type SessionPresentationDependencies
} from "../src/bridge/sessions/presentation.js";

function session(): SessionRecord {
  return {
    id: "session-1",
    telegramChatId: "chat-1",
    codexThreadId: "thread-1",
    pathKey: "/old/project",
    currentCwd: "/old/project",
    displayName: "Old name",
    batchDecisionMessageId: null,
    codexArchivedAt: null,
    latestActivityAt: Date.UTC(2026, 0, 1),
    createdAt: Date.UTC(2026, 0, 1),
    discoveryMissingSince: null,
    discoveryMissingCount: 0,
    lastDiscoveredAt: Date.UTC(2026, 0, 1)
  };
}

test("session presentation uses fresh Codex metadata for directories, titles, and menu labels", async () => {
  const metadata = new CodexThreadMetadataCache();
  metadata.replace([{
    threadId: "thread-1",
    modelProvider: "openai",
    modelProviderKnown: true,
    updatedAt: Date.UTC(2026, 0, 2),
    createdAt: Date.UTC(2026, 0, 1),
    name: "Fresh name",
    preview: null,
    pathKey: "/new/project",
    currentCwd: "/new/project",
    archivedAt: null
  }]);
  let goalReads = 0;
  const client = {
    getObservedThreadProvider: () => "codex-lb",
    readThreadGoal: async () => {
      goalReads += 1;
      return {
        status: "paused" as const,
        objective: "Verify presentation",
        tokensUsed: 1200,
        tokenBudget: null,
        timeUsedSeconds: 61,
        updatedAt: 1_767_312_000
      };
    }
  } as SessionPresentationDependencies["codexClient"];
  const presentation = new SessionPresentationService({
    codexClient: client,
    threadMetadataCache: metadata,
    isRuntimeConnected: () => true
  });

  assert.equal(presentation.getSessionDirectory(session()), "/new/project");
  assert.equal(presentation.getSessionTitle(session()), "Fresh name");
  const label = await presentation.formatSectionMenuLabel({
    session: session(),
    activityAt: Date.UTC(2026, 0, 2)
  }, "openai");
  assert.match(label, /^codex-lb · Fresh name · u Jan02 08:00 · c Jan01$/);
  assert.equal(goalReads, 0);
});

test("session presentation reports a disconnected runtime without calling Codex", async () => {
  let goalReads = 0;
  const presentation = new SessionPresentationService({
    codexClient: {
      getObservedThreadProvider: () => null,
      readThreadGoal: async () => {
        goalReads += 1;
        return null;
      }
    },
    threadMetadataCache: new CodexThreadMetadataCache(),
    isRuntimeConnected: () => false
  });

  const result = await presentation.readSessionGoal(session());
  assert.deepEqual(result, { goal: null, error: "runtime disconnected" });
  assert.equal(goalReads, 0);
  assert.deepEqual(presentation.formatGoalStatusLines(result), ["**Status** unavailable: runtime disconnected"]);
});
