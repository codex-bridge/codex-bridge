import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerClient } from "../src/codex/client.js";
import { CodexThreadListApi } from "../src/codex/thread-list-api.js";
import { BridgeStore } from "../src/store/index.js";

test("Codex thread listing requests active and archived inventories explicitly", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = new CodexThreadListApi({
    connect: async () => undefined,
    request: async (_method, params) => {
      calls.push(params as Record<string, unknown>);
      return {
        data: [{
          id: calls.length === 1 ? "thread-active" : "thread-archived",
          cwd: "/workspace/project",
          path: "/Users/test/.codex/sessions/2026/09/rollout-2026-09-20T00-00-00-thread.jsonl",
          updatedAt: 1_789_200_000,
          createdAt: 1_789_100_000
        }],
        nextCursor: null
      };
    },
    requestKnownMethod: async () => undefined
  });

  const active = await client.listThreadsForCwd();
  const archived = await client.listArchivedThreadsForCwd();
  await client.listThreadsForCwd("/workspace/project", { modelProviders: ["codex-lb"] });

  assert.equal(calls[0]?.archived, false);
  assert.equal(calls[1]?.archived, true);
  assert.equal(active[0]?.pathKey, "/workspace/project");
  assert.equal(active[0]?.currentCwd, "/workspace/project");
  assert.equal(
    active[0]?.rolloutPath,
    "/Users/test/.codex/sessions/2026/09/rollout-2026-09-20T00-00-00-thread.jsonl"
  );
  assert.equal(active[0]?.archivedAt, null);
  assert.ok((archived[0]?.archivedAt ?? 0) > 0);
  assert.deepEqual(calls[2], {
    cursor: null,
    limit: 50,
    sortKey: "updated_at",
    cwd: "/workspace/project",
    archived: false,
    modelProviders: ["codex-lb"],
    sourceKinds: ["appServer", "cli", "vscode"]
  });
});

test("Codex thread metadata methods use native RPCs", async () => {
  const calls: unknown[] = [];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async (...args: unknown[]) => {
      calls.push(args);
      return {};
    }
  });

  await client.archiveThread("thread-1");
  await client.unarchiveThread("thread-1");
  await client.deleteThread("thread-1");
  await client.setThreadName("thread-1", "Renamed thread");

  assert.deepEqual(calls, [
    ["thread/archive", { threadId: "thread-1" }],
    ["thread/unarchive", { threadId: "thread-1" }],
    ["thread/delete", { threadId: "thread-1" }],
    ["thread/name/set", { threadId: "thread-1", name: "Renamed thread" }]
  ]);
});

test("archived Codex sessions are hidden and can be restored without deleting Bridge data", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread-1",
      pathKey: "/workspace/project",
      currentCwd: "/workspace/project"
    });
    await store.setActiveSession("chat", session.id);

    const archived = await store.markSessionCodexArchived(session.id, 123);
    assert.equal(archived.codexArchivedAt, 123);
    assert.equal(await store.getActiveSession("chat"), null);
    assert.deepEqual(await store.listKnownSessions("chat"), []);
    assert.equal((await store.listKnownSessions("chat", { includeArchived: true }))[0]?.id, session.id);

    const restored = await store.markSessionCodexUnarchived(session.id);
    assert.equal(restored.codexArchivedAt, null);
    assert.deepEqual(await store.listKnownSessions("chat"), []);
    await store.selectSession("chat", session.id);
    assert.equal((await store.listKnownSessions("chat"))[0]?.id, session.id);
    assert.equal((await store.getSessionById(session.id))?.pathKey, "/workspace/project");
  } finally {
    store.close();
  }
});
