import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogGroups } from "../web/src/lib/catalog-view.js";
import type { Catalog, SessionEntry } from "../web/src/lib/protocol.js";

function session(threadId: string, directory: string, updatedAt: number | null, archived = false,
  name = threadId, connection: SessionEntry["connection"] = "inactive"): SessionEntry {
  return { threadId, sessionId: `session-${threadId}`, name, directory, archived, updatedAt,
    provider: "test", connection, ownership: null };
}

test("active catalog groups every Bridge-confirmed open project before other directories", () => {
  const catalog: Catalog = {
    directories: ["/empty-b", "/old", "/current", "/new", "/empty-a"],
    sessions: [
      session("current-old", "/current", 1),
      session("new-old", "/new", 10, false, "new-old", "active"),
      session("new-new", "/new", 30, false, "new-new", "active"),
      session("old", "/old", 20, false, "old", "active"),
      session("archived", "/archive-only", 100, true)
    ]
  };

  const groups = buildCatalogGroups(catalog, { mode: "active", query: "" });
  assert.deepEqual(groups.map((group) => group.directory), ["/new", "/old", "/current", "/empty-a", "/empty-b"]);
  assert.deepEqual(groups.map((group) => group.open), [true, true, false, false, false]);
  assert.deepEqual(groups[0]?.sessions.map((entry) => entry.threadId), ["new-new", "new-old"]);
});

test("archived catalog excludes active and empty directories and uses stable recent-first ordering", () => {
  const catalog: Catalog = {
    directories: ["/registered-empty", "/active"],
    sessions: [
      session("active", "/active", 500),
      session("z-null", "/archive-old", null, true, "z"),
      session("a-null", "/archive-old", null, true, "a"),
      session("archived-new", "/archive-new", 200, true),
      session("archived-old", "/archive-old", 100, true)
    ]
  };

  const groups = buildCatalogGroups(catalog, { mode: "archived", query: "" });
  assert.deepEqual(groups.map((group) => group.directory), ["/archive-new", "/archive-old"]);
  assert.deepEqual(groups[1]?.sessions.map((entry) => entry.threadId), ["archived-old", "a-null", "z-null"]);
});

test("active navigation keeps archive-only directories empty and searchable without exposing archived sessions", () => {
  const catalog: Catalog = {
    directories: ["/archive-only"],
    sessions: [session("archived", "/archive-only", 100, true)]
  };
  assert.deepEqual(buildCatalogGroups(catalog, { mode: "active", query: "" }), [
    { directory: "/archive-only", sessions: [], open: false }
  ]);
  assert.deepEqual(buildCatalogGroups(catalog, { mode: "active", query: "/archive-only" })
    .map((group) => group.directory), ["/archive-only"]);
  assert.deepEqual(buildCatalogGroups(catalog, { mode: "archived", query: "" })
    .flatMap((group) => group.sessions.map((entry) => entry.threadId)), ["archived"]);
});

test("catalog search stays inside the selected lifecycle view and matches directory, name or thread ID", () => {
  const catalog: Catalog = {
    directories: ["/work", "/empty"],
    sessions: [
      session("active-id", "/work", 10, false, "Current task"),
      session("archived-id", "/archive", 20, true, "Old task")
    ]
  };

  assert.deepEqual(buildCatalogGroups(catalog, { mode: "active", query: "old" }), []);
  assert.deepEqual(buildCatalogGroups(catalog, { mode: "archived", query: "old" })
    .flatMap((group) => group.sessions.map((entry) => entry.threadId)), ["archived-id"]);
  assert.deepEqual(buildCatalogGroups(catalog, { mode: "active", query: "/empty" })
    .map((group) => group.directory), ["/empty"]);
});
