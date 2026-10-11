import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applySessionRefresh } from "../scripts/verify-codex/session-refresh-apply.js";
import { verifySessionRefresh } from "../scripts/verify-codex/scenarios/session-refresh.js";
import { BridgeStore } from "../src/store/index.js";

test("session-refresh verification retains readable sessions omitted by thread/list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-refresh-verification-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "listed-thread",
      pathKey: directory,
      currentCwd: directory,
      displayName: "listed"
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "readable-thread",
      pathKey: directory,
      currentCwd: directory,
      displayName: "readable"
    });
    const report = await verifySessionRefresh({
      listThreadsForCwd: async () => [{ threadId: "listed-thread" }],
      listArchivedThreadsForCwd: async () => [],
      readThreadStatus: async (threadId: string) => {
        assert.equal(threadId, "readable-thread");
        return { threadId };
      }
    } as never, {
      scenario: "session-refresh",
      cwd: directory,
      threadId: null,
      sourceId: "slack:T:C",
      refreshApplyMode: "none",
      refreshRepeatCount: 1,
      provider: null,
      json: false,
      verbose: false,
      maxSamples: 5
    }, store);

    assert.equal(report.ok, true);
    assert.deepEqual(report.data, {
      source: "slack:T:C",
      knownSessions: 2,
      active: 1,
      archived: 0,
      readableUnlisted: 1,
      missing: [],
      indeterminate: [],
      stateMismatches: []
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session-refresh apply reconciles archived sessions through production discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-refresh-apply-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  try {
    await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "archived-thread",
      pathKey: directory,
      currentCwd: directory,
      displayName: "archive me"
    });
    const client = {
      listThreadsForCwd: async () => [],
      listArchivedThreadsForCwd: async () => [{
        threadId: "archived-thread",
        pathKey: directory,
        currentCwd: directory,
        updatedAt: null,
        createdAt: null,
        name: null,
        preview: null,
        archivedAt: Date.now()
      }],
      readThreadStatus: async () => {
        throw new Error("thread/read should not run for an archived thread");
      }
    } as never;
    const result = await applySessionRefresh(client, store, "slack:T:C", "sandbox");

    assert.deepEqual(result, {
      mode: "sandbox",
      created: [],
      archived: ["archived-thread"],
      restored: [],
      deleted: [],
      missingCountChanged: []
    });
    assert.ok((await store.getSessionByThreadId("archived-thread"))?.codexArchivedAt);
    assert.deepEqual(await applySessionRefresh(client, store, "slack:T:C", "sandbox"), {
      mode: "sandbox",
      created: [],
      archived: [],
      restored: [],
      deleted: [],
      missingCountChanged: []
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session-refresh apply restores archived sessions and tracks definitive absence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-refresh-reconcile-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  try {
    const restored = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "restored-thread",
      pathKey: directory,
      currentCwd: directory,
      displayName: "restore me"
    });
    await store.markSessionCodexArchived(restored.id);
    await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "missing-thread",
      pathKey: directory,
      currentCwd: directory,
      displayName: "missing"
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "slack:T:C",
      codexThreadId: "transient-thread",
      pathKey: directory,
      currentCwd: directory,
      displayName: "temporary failure"
    });
    const result = await applySessionRefresh({
      listThreadsForCwd: async () => [{
        threadId: "restored-thread",
        pathKey: directory,
        currentCwd: directory,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        name: "restored",
        preview: null,
        archivedAt: null
      }],
      listArchivedThreadsForCwd: async () => [],
      readThreadStatus: async (threadId: string) => {
        if (threadId === "missing-thread") throw new Error("thread not found");
        throw new Error("upstream unavailable");
      }
    } as never, store, "slack:T:C", "sandbox");

    assert.deepEqual(result, {
      mode: "sandbox",
      created: [],
      archived: [],
      restored: ["restored-thread"],
      deleted: [],
      missingCountChanged: ["missing-thread"]
    });
    assert.equal((await store.getSessionByThreadId("restored-thread"))?.codexArchivedAt, null);
    assert.equal((await store.getSessionByThreadId("missing-thread"))?.discoveryMissingCount, 1);
    assert.equal((await store.getSessionByThreadId("transient-thread"))?.discoveryMissingCount, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
