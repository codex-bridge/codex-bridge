import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogActions } from "../web/src/lib/catalog-actions.ts";
import type { SessionEntry } from "../web/src/lib/protocol.ts";

const session: SessionEntry = { threadId: "target", sessionId: "session-target", directory: "/project",
  name: "Original", archived: false, updatedAt: null, provider: null, connection: "unknown", ownership: null };

test("catalog actions defer to their original controller with unchanged targets and receipts", async () => {
  const calls: unknown[][] = [];
  const receipt = { directory: "/confirmed", existing: true };
  const refreshed = Promise.resolve();
  const added = Promise.resolve(receipt);
  const created = Promise.resolve("new-thread");
  const managed = Promise.resolve(true);
  const controller = {
    refresh() { assert.equal(this, controller); calls.push(["refresh"]); return refreshed; },
    select(id: string) { assert.equal(this, controller); calls.push(["select", id]); },
    addDirectory(path: string) { assert.equal(this, controller); calls.push(["directory", path]); return added; },
    createSession(directory: string) { assert.equal(this, controller); calls.push(["create", directory]); return created; },
    manageSession(entry: SessionEntry, action: string, name?: string) {
      assert.equal(this, controller); calls.push(["manage", entry, action, name]); return managed;
    }
  };
  const actions = createCatalogActions(controller);
  assert.deepEqual(calls, []);
  assert.equal(actions.refresh(), refreshed);
  actions.select("another-thread");
  assert.equal(actions.addDirectory("/requested"), added);
  assert.equal(actions.createSession("/new-project"), created);
  for (const action of ["rename", "archive", "restore", "release"] as const) {
    assert.equal(actions.manageSession(session, action, action === "rename" ? "Renamed" : undefined), managed);
  }
  assert.deepEqual(calls, [["refresh"], ["select", "another-thread"], ["directory", "/requested"],
    ["create", "/new-project"], ...["rename", "archive", "restore", "release"].map((action) =>
      ["manage", session, action, action === "rename" ? "Renamed" : undefined])]);
  assert.equal(await added, receipt);
});

test("catalog actions preserve refusals and do not convert an unknown failure into a retry", async () => {
  const error = new Error("Operation outcome unknown");
  let attempts = 0;
  const actions = createCatalogActions({
    refresh: async () => {}, select: () => {}, addDirectory: async () => null, createSession: async () => null,
    manageSession: async () => { attempts++; if (attempts === 1) throw error; return false; }
  });
  assert.equal(await actions.addDirectory("/project"), null);
  assert.equal(await actions.createSession("/project"), null);
  await assert.rejects(actions.manageSession(session, "release"), (caught) => caught === error);
  assert.equal(attempts, 1);
  assert.equal(await actions.manageSession(session, "archive"), false);
  assert.equal(attempts, 2);
});
