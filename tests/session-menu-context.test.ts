import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { SessionMenuService } from "../src/bridge/sessions/menu.js";
import { SessionMenuSnapshotCache } from "../src/bridge/sessions/menu-snapshots.js";
import type { CurrentSessionSnapshot } from "../src/bridge/sessions/state-presentation.js";

test("historical directories remain scoped, ordered and paginated while archived sessions stay out of section menus", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const oldest = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "oldest", pathKey: "/work/old", latestActivityAt: 100
    });
    const newest = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "newest", pathKey: "/work/new", latestActivityAt: 300
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "active", pathKey: "/work/old", latestActivityAt: 200
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "other-chat", codexThreadId: "private", pathKey: "/private", codexArchivedAt: 1
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "wrong-provider", pathKey: "/wrong-provider", codexArchivedAt: 1
    });
    await store.markSessionCodexArchived(oldest.id);
    await store.markSessionCodexArchived(newest.id);
    const menu = new SessionMenuService({
      store, sessionsPageSize: 1, snapshots: new SessionMenuSnapshotCache(),
      getSessionSelectorChatId: (chat) => chat, refreshSessionsForChat: async () => {},
      getSessionDirectory: (session) => session.currentCwd ?? session.pathKey,
      sortSessionsByMenuActivity: (sessions, activityTimes) => [...sessions]
        .sort((a, b) => activityTimes.get(b.id)! - activityTimes.get(a.id)!),
      hashDirectoryKey: (directory) => directory,
      formatDirectoryMenuLabel: (group) => group.directoryKey,
      formatSectionMenuLabel: async (entry) => entry.session.codexThreadId,
      getSessionProvider: (threadId) => ({ provider: threadId === "wrong-provider" ? "openai" : "custom", known: true }),
      readEffectiveProvider: async () => "custom", readEffectiveProviderLabel: async () => "Codex",
      getCurrentSessionSnapshot: async () => null
    });
    for (const [page, directory] of [[0, "/work/new"], [1, "/work/old"]] as const) {
      const result = await menu.renderSessionMenu("chat", page, { reuseSnapshot: page > 0 });
      assert.deepEqual(result.actions.filter((action) => action.callback.startsWith("session-dir:"))
        .map((action) => action.label), [directory]);
    }
    const empty = await menu.getDirectoryGroup("chat", "/work/new");
    assert.equal(empty?.sectionCount, 0);
    assert.equal(empty?.activityAt, 300);
    assert.equal(await menu.getDirectoryGroup("chat", "/private"), null);
    assert.equal(await menu.getDirectoryGroup("chat", "/wrong-provider"), null);
    const emptySections = await menu.renderSessionSectionMenu("chat", "/work/new");
    assert.ok(emptySections.actions.some((action) => action.callback === "session-new:/work/new"));
    assert.ok(!emptySections.actions.some((action) => action.callback.startsWith("section:")));
    const mixedSections = await menu.renderSessionSectionMenu("chat", "/work/old");
    assert.deepEqual(mixedSections.actions.filter((action) => action.callback.startsWith("section:"))
      .map((action) => action.label), ["active"]);
    assert.equal((await menu.getDirectoryGroup("chat", "/work/old"))?.sectionCount, 1);
  } finally { store.close(); }
});

test("cross-directory selectors remain global and archived entries retain their own directories across pages", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const active = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "active", pathKey: "/work/current"
    });
    const archived = await Promise.all(["alpha", "beta"].map((name) => store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: name, pathKey: `/work/${name}`,
      displayName: "Same title", codexArchivedAt: 1
    })));
    let current: CurrentSessionSnapshot | null = {
      session: { id: active.id, directory: "/work/current" }, thread: "active", binding: "bound", actions: []
    };
    const menu = new SessionMenuService({
      store, sessionsPageSize: 1, snapshots: new SessionMenuSnapshotCache(),
      getSessionSelectorChatId: (chat) => chat, refreshSessionsForChat: async () => {},
      getSessionDirectory: (session) => session.currentCwd ?? session.pathKey,
      sortSessionsByMenuActivity: (sessions) => [...sessions].sort((a, b) => a.pathKey.localeCompare(b.pathKey)),
      hashDirectoryKey: (directory) => directory,
      formatDirectoryMenuLabel: (group) => group.directoryKey,
      formatSectionMenuLabel: async (entry) => entry.session.displayName ?? "Session",
      getSessionProvider: () => ({ provider: null, known: false }),
      readEffectiveProvider: async () => null, readEffectiveProviderLabel: async () => "Codex",
      getCurrentSessionSnapshot: async () => current
    });
    const root = await menu.renderSessionMenu("chat");
    assert.equal(root.title, "Sessions");
    assert.equal(root.session, undefined);
    assert.deepEqual(root.body[0], { type: "heading", text: "Current session · /work/current" });
    const directory = await menu.renderSessionSectionMenu("chat", "/work/current");
    assert.equal(directory.title, "Sections · /work/current");
    assert.equal(directory.session, undefined, "directory navigation does not claim a specific session");
    const expired = await menu.renderSessionSectionMenu("chat", "missing");
    assert.equal(expired.title, "Sessions");
    for (const page of [0, 1]) {
      const result = await menu.renderArchivedSessionMenu("chat", page);
      assert.equal(result.title, "Archived sessions");
      assert.equal(result.session, undefined);
      assert.deepEqual(result.body, [
        { type: "heading", text: "Current session · /work/current" },
        { type: "text", text: "Choose a session to restore." },
        { type: "text", text: `${page + 1}. Same title\n/work/${page === 0 ? "alpha" : "beta"}` }
      ]);
      assert.ok(result.actions.some((action) => action.callback === `session-unarchive:${archived[page]!.id}`));
      assert.ok(result.actions.some((action) => action.callback === `session-archived-page:${1 - page}`));
    }
    current = null;
    const noSelection = await menu.renderArchivedSessionMenu("chat");
    assert.equal(noSelection.title, "Archived sessions");
    assert.deepEqual(noSelection.body, [
      { type: "text", text: "Choose a session to restore." },
      { type: "text", text: "1. Same title\n/work/alpha" }
    ]);
    assert.deepEqual((await menu.renderSessionMenu("chat")).body, []);
    await Promise.all(archived.map((session) => store.markSessionCodexUnarchived(session.id)));
    const empty = await menu.renderArchivedSessionMenu("chat");
    assert.equal(empty.title, "Archived sessions");
    assert.deepEqual(empty.body, [{ type: "text", text: "No archived sessions are available." }]);
    current = { session: { id: active.id, directory: "/work/current" }, thread: "active", binding: "bound", actions: [] };
    const emptyWithSelection = await menu.renderArchivedSessionMenu("chat");
    assert.deepEqual(emptyWithSelection.body, [
      { type: "heading", text: "Current session · /work/current" },
      { type: "text", text: "No archived sessions are available." }
    ]);
  } finally { store.close(); }
});
