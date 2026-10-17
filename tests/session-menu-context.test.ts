import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { SessionMenuService } from "../src/bridge/sessions/menu.js";
import { SessionMenuSnapshotCache } from "../src/bridge/sessions/menu-snapshots.js";

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
      getCurrentSessionSnapshot: async () => ({
        session: { id: active.id, directory: "/work/current" }, thread: "active", binding: "bound", actions: []
      })
    });
    const root = await menu.renderSessionMenu("chat");
    assert.equal(root.title, "Sessions");
    assert.equal(root.session, undefined);
    assert.ok(root.body.some((part) => part.type === "field" && part.label === "Directory" && part.value === "/work/current"));
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
        { type: "text", text: "Choose a session to restore." },
        { type: "text", text: `${page + 1}. Same title\n/work/${page === 0 ? "alpha" : "beta"}` }
      ]);
      assert.ok(result.actions.some((action) => action.callback === `session-unarchive:${archived[page]!.id}`));
      assert.ok(result.actions.some((action) => action.callback === `session-archived-page:${1 - page}`));
    }
  } finally { store.close(); }
});
