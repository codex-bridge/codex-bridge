import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import {
  buildThreadHistoryReplay,
  createTranscriptMessageSpec,
  renderThreadHistoryEntry
} from "../src/bridge/renderers/thread-history.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import { normalizeFullThreadTurnsPage } from "../src/codex/thread-history.js";
import type { AppConfig } from "../src/config/index.js";
import { BridgeStore } from "../src/store/index.js";

function testConfig(databasePath = ":memory:"): AppConfig {
  return {
    telegramBotToken: "test",
    telegramAllowedChatIds: null,
    slackEnabled: false,
    slackBotToken: null,
    slackAppToken: null,
    slackSigningSecret: null,
    slackSocketClientPingTimeoutMs: 15_000,
    slackSocketServerPingTimeoutMs: 45_000,
    bridgeCallbackSecret: null,
    slackAllowedChannelIds: null,
    bridgeDbFile: databasePath,
    codexTransport: "stdio",
    codexAppServerCommand: "codex",
    codexAppServerArgs: ["app-server"],
    codexAppServerWsUrl: null,
    codexModel: null,
    codexEffort: "medium",
    codexSummary: "auto",
    codexApprovalPolicy: "on-request",
    codexSandboxMode: "workspaceWrite",
    codexWritableRoots: [],
    codexNetworkAccess: false,
    codexPermissionMode: "auto-review",
    codexPersonality: "pragmatic",
    codexServiceName: "codex-bridge",
    codexSkillExtraRoots: [],
    codexAutoCompactOnIncompatibleHistory: false
  };
}

test("thread turn history paginates newest-first and returns messages chronologically", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const pages = [
    {
      data: [
        { id: "turn-3", items: [
          { type: "userMessage", id: "u3", content: [{ type: "text", text: "question 3" }] },
          { type: "agentMessage", id: "a3", text: "answer 3" }
        ] },
        { id: "turn-2", items: [
          { type: "userMessage", id: "u2", content: [{ type: "text", text: "question 2" }] },
          { type: "agentMessage", id: "a2", text: "answer 2" }
        ] }
      ],
      nextCursor: "older"
    },
    {
      data: [{ id: "turn-1", items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "question 1" }] },
        { type: "reasoning", id: "r1", summary: ["hidden"] },
        { type: "agentMessage", id: "a1", text: "answer 1" }
      ] }],
      nextCursor: null
    }
  ];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async (_method: string, params: Record<string, unknown>) => {
      calls.push(params);
      return pages[calls.length - 1];
    }
  });

  const messages = await client.listRecentThreadMessages("thread", 5);
  assert.deepEqual(calls, [
    { threadId: "thread", cursor: null, limit: 10, sortDirection: "desc", itemsView: "summary" },
    { threadId: "thread", cursor: "older", limit: 10, sortDirection: "desc", itemsView: "summary" }
  ]);
  assert.deepEqual(messages.map(({ role, text, turnId, itemId }) => ({ role, text, turnId, itemId })), [
    { role: "assistant", text: "answer 1", turnId: "turn-1", itemId: "a1" },
    { role: "user", text: "question 2", turnId: "turn-2", itemId: "u2" },
    { role: "assistant", text: "answer 2", turnId: "turn-2", itemId: "a2" },
    { role: "user", text: "question 3", turnId: "turn-3", itemId: "u3" },
    { role: "assistant", text: "answer 3", turnId: "turn-3", itemId: "a3" }
  ]);
});

test("thread turn history rejects a repeated cursor instead of returning partial history", async () => {
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async () => ({ data: [], nextCursor: "same" })
  });
  await assert.rejects(
    client.listRecentThreadMessages("thread", 5),
    /repeated cursor/
  );
});

test("thread turn history rejects incomplete pages and repeated items", async () => {
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async () => ({ data: [] })
  });
  await assert.rejects(client.listRecentThreadMessages("thread", 5), /Invalid thread turns cursor/);

  let page = 0;
  client.requestKnownMethod = async () => ({
    data: [{ id: "turn", items: [
      { type: "agentMessage", id: "same", text: "answer" }
    ] }],
    nextCursor: page++ === 0 ? "older" : null
  });
  await assert.rejects(client.listRecentThreadMessages("thread", 5), /repeated item/);
});

test("full thread turns normalize visible history without reasoning or approval state", () => {
  const page = normalizeFullThreadTurnsPage({
    data: [{
      id: "turn-1",
      status: "completed",
      startedAt: 100,
      completedAt: 170,
      durationMs: 70_250,
      error: null,
      items: [
        { type: "userMessage", id: "user-1", content: [{ type: "text", text: "Please inspect" }] },
        { type: "reasoning", id: "reasoning-1", summary: ["must stay hidden"] },
        {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "serena",
          tool: "read_memory",
          arguments: { memory_name: "project" },
          result: { ok: true },
          status: "completed"
        },
        {
          type: "fileChange",
          id: "edit-1",
          changes: [{ path: "/Users/example/workspace/src/project/src/index.ts", diff: "@@\n-old\n+new\n+next" }],
          status: "completed"
        },
        { type: "contextCompaction", id: "compact-1" },
        { type: "plan", id: "plan-1", text: "must stay hidden" },
        { type: "commandExecution", id: "approval-1", status: "inProgress", command: "pending" },
        { type: "commandExecution", id: "command-1", status: "completed", output: "done" },
        { type: "agentMessage", id: "agent-1", text: "Inspection complete." }
      ]
    }],
    nextCursor: null
  }, "thread-1");

  assert.deepEqual(page.turns[0]?.itemIds, [
    "user-1",
    "reasoning-1",
    "mcp-1",
    "edit-1",
    "compact-1",
    "plan-1",
    "approval-1",
    "command-1",
    "agent-1"
  ]);
  assert.deepEqual(page.turns[0]?.entries.map((entry) => entry.kind), [
    "message",
    "progress",
    "progress",
    "compaction",
    "message",
    "turn"
  ]);
  assert.equal(page.turns[0]?.entries.some((entry) =>
    "text" in entry && entry.text.includes("must stay hidden")
  ), false);
  const progress = page.turns[0]?.entries.find((entry) => entry.kind === "progress");
  assert.equal(progress?.kind === "progress" ? progress.event.threadId : null, "thread-1");
});

test("full thread history renderer matches live summaries and keeps server duration authoritative", () => {
  const page = normalizeFullThreadTurnsPage({
    data: [{
      id: "turn-1",
      status: "completed",
      durationMs: 70_250,
      items: [
        {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "serena",
          tool: "read_memory",
          arguments: { memory_name: "project" },
          result: { ok: true },
          status: "completed"
        },
        {
          type: "fileChange",
          id: "edit-1",
          changes: [{ path: "/Users/example/workspace/src/project/src/index.ts", diff: "@@\n-old\n+new\n+next" }],
          status: "completed"
        },
        { type: "contextCompaction", id: "compact-1" }
      ]
    }, {
      id: "turn-2",
      status: "interrupted",
      items: []
    }],
    nextCursor: null
  }, "thread-1");
  const rendered = page.turns.flatMap((turn) => turn.entries).map((entry) =>
    renderThreadHistoryEntry({ directory: "/Users/example/workspace/src/project", entry })
  );

  assert.deepEqual(rendered, [
    "Called · .../src/project\nserena.read_memory\nmemory_name=project",
    "Edited · .../src/project\nsrc/index.ts (+2 -1)",
    "Compact completed · .../src/project",
    "System · .../src/project\nTurn completed\nElapsed 1m 10s",
    "System · .../src/project\nTurn interrupted"
  ]);
  assert.equal(rendered.some((text) => text.includes("Elapsed 0s")), false);
});

test("full thread history keeps explored items visible", () => {
  const page = normalizeFullThreadTurnsPage({
    data: [{
      id: "turn-1",
      status: "completed",
      items: [{
        type: "webSearch",
        id: "search-1",
        action: "search",
        query: "Codex app-server"
      }]
    }],
    nextCursor: null
  }, "thread-1");

  assert.deepEqual(
    page.turns[0]?.entries.map((entry) => entry.kind),
    ["progress", "turn"]
  );
  assert.equal(
    page.turns[0]?.entries[0]?.kind === "progress"
      ? renderThreadHistoryEntry({ directory: "/Users/example/workspace/src/project", entry: page.turns[0].entries[0] })
      : "",
    "Explored · .../src/project\nCodex app-server\nquery=Codex app-server action=search"
  );
});

test("full thread turns reject malformed status and timing fields", () => {
  assert.throws(() => normalizeFullThreadTurnsPage({
    data: [{ id: "turn", status: "unknown", items: [] }],
    nextCursor: null
  }, "thread"), /Invalid thread turn status/);
  assert.throws(() => normalizeFullThreadTurnsPage({
    data: [{ id: "turn", status: "failed", durationMs: "10", items: [] }],
    nextCursor: null
  }, "thread"), /Invalid thread turn durationMs/);
});

test("full thread history paginates turns and returns the latest turns chronologically", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const pages = [{
    data: [{
      id: "turn-2",
      status: "completed",
      durationMs: 2_000,
      items: [{ type: "agentMessage", id: "a2", text: "answer 2" }]
    }],
    nextCursor: "older"
  }, {
    data: [{
      id: "turn-1",
      status: "interrupted",
      items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "question 1" }] },
        { type: "reasoning", id: "r1", summary: ["hidden"] }
      ]
    }],
    nextCursor: null
  }];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async (_method: string, params: Record<string, unknown>) => {
      calls.push(params);
      return pages[calls.length - 1];
    }
  });

  const entries = await client.listRecentThreadHistory("thread", 2);
  assert.deepEqual(calls, [
    { threadId: "thread", cursor: null, limit: 2, sortDirection: "desc", itemsView: "full" },
    { threadId: "thread", cursor: "older", limit: 1, sortDirection: "desc", itemsView: "full" }
  ]);
  assert.deepEqual(entries.map((entry) =>
    entry.kind === "message" ? `${entry.turnId}:${entry.role}` : `${entry.turnId}:${entry.kind}`
  ), [
    "turn-1:user",
    "turn-1:turn",
    "turn-2:assistant",
    "turn-2:turn"
  ]);
});

test("full thread replay collapses adjacent calls and enforces explicit output limits", () => {
  const page = normalizeFullThreadTurnsPage({
    data: [{
      id: "turn",
      status: "completed",
      items: [
        { type: "mcpToolCall", id: "m1", server: "one", tool: "first", result: "done" },
        { type: "mcpToolCall", id: "m2", server: "two", tool: "second", result: "done" },
        { type: "agentMessage", id: "a1", text: "x".repeat(500) }
      ]
    }],
    nextCursor: null
  }, "thread");
  const entries = page.turns.flatMap((turn) => turn.entries);

  const collapsed = buildThreadHistoryReplay({
    directory: "/Users/example/workspace/src/project",
    entries
  });
  assert.equal(collapsed.truncated, false);
  assert.equal(collapsed.blocks.some((block) => block.text.includes("one.first")), false);
  assert.equal(collapsed.blocks.some((block) => block.text.includes("two.second")), true);
  const progressBlock = collapsed.blocks.find((block) => block.entry?.kind === "progress");
  assert.ok(progressBlock?.messageSpec);

  const limited = buildThreadHistoryReplay({
    directory: "/Users/example/workspace/src/project",
    entries,
    maxBlocks: 3,
    maxChars: 240
  });
  assert.equal(limited.truncated, true);
  assert.ok(limited.blocks.length <= 3);
  assert.ok(limited.blocks.reduce((sum, block) => sum + block.text.length, 0) <= 240);
  assert.match(limited.blocks[0]?.text ?? "", /History truncated/);
  assert.equal(limited.blocks[0]?.messageSpec?.kind, "system");
});

test("transcript message specs preserve role and session marker semantics", () => {
  const user = createTranscriptMessageSpec({
    directory: "/Users/example/workspace/src/project",
    role: "user",
    text: "question"
  });
  const assistant = createTranscriptMessageSpec({
    directory: "/Users/example/workspace/src/project",
    role: "assistant",
    text: "**answer**"
  });

  assert.equal(user.title, "User · .../src/project");
  assert.equal(user.body[0]?.type, "text");
  assert.equal(assistant.title, "Codex · .../src/project");
  assert.equal(assistant.body[0]?.type, "markdown");
});

test("session activation replays only the five latest conversation messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-turn-history-"));
  const rolloutPath = join(directory, "rollout.jsonl");
  await writeFile(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { cwd: directory, model_provider: "openai" }
  })}\n`);
  const store = new BridgeStore(":memory:");
  const messages = [
    { role: "user" as const, text: "old question", turnId: "turn-1", itemId: "u1" },
    { role: "assistant" as const, text: "old answer", turnId: "turn-1", itemId: "a1" },
    { role: "user" as const, text: "question 2", turnId: "turn-2", itemId: "u2" },
    { role: "assistant" as const, text: "answer 2", turnId: "turn-2", itemId: "a2" },
    { role: "user" as const, text: "turn question", turnId: "turn-3", itemId: "u3" },
    { role: "assistant" as const, text: "turn answer", turnId: "turn-3", itemId: "a3" }
  ];
  const client = {
    resumeThread: async () => ({
      displayPath: directory,
      messages: [{ role: "assistant" as const, text: "resume fallback" }]
    }),
    listRecentThreadHistory: async () => { throw new Error("full history must not be requested"); },
    listRecentThreadMessages: async () => messages.slice(-5)
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(), store, client);
  const sent: string[] = [];
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return { message_id: String(sent.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => {}
  });
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread",
      pathKey: rolloutPath,
      currentCwd: directory
    });
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
    const activated = await service.activateSession("chat", session.id);
    assert.deepEqual(activated.recentMessages, [
      { role: "assistant", text: "old answer" },
      { role: "user", text: "question 2" },
      { role: "assistant", text: "answer 2" },
      { role: "user", text: "turn question" },
      { role: "assistant", text: "turn answer" }
    ]);
    assert.deepEqual(await store.listRecentMessages(session.id, 5), []);
    await service.postSessionSwitchTranscript("chat", activated.session, activated.recentMessages);
    assert.equal(sent.length, 8);
    assert.deepEqual(sent.slice(1, 6).map((text) => text.split("\n").slice(1).join("\n")), [
      "old answer", "question 2", "answer 2", "turn question", "turn answer"
    ]);
    assert.ok(sent.every((text) => !text.includes("Turn completed") && !text.includes("Called ·")));
    assert.match(sent[6] ?? "", /^Provider · /);
    assert.match(sent[7] ?? "", /^Actions · /);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session activation uses summary history instead of resume fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-full-summary-fallback-"));
  const rolloutPath = join(directory, "rollout.jsonl");
  await writeFile(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { cwd: directory, model_provider: "openai" }
  })}\n`);
  const store = new BridgeStore(":memory:");
  const client = {
    resumeThread: async () => ({
      displayPath: directory,
      messages: [{ role: "assistant" as const, text: "resume must stay hidden" }]
    }),
    listRecentThreadMessages: async () => [
      { role: "user" as const, text: "summary question", turnId: "turn", itemId: "user" },
      { role: "assistant" as const, text: "summary answer", turnId: "turn", itemId: "assistant" }
    ]
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(), store, client);
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread",
      pathKey: rolloutPath,
      currentCwd: directory
    });
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
    const activated = await service.activateSession("chat", session.id);
    assert.deepEqual(activated.recentMessages, [
      { role: "user", text: "summary question" },
      { role: "assistant", text: "summary answer" }
    ]);
    assert.equal(activated.recentMessages.some((message) => message.text.includes("resume")), false);
    assert.deepEqual(await store.listRecentMessages(session.id, 5), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("session activation falls back as one source and explicit empty history stays empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-turn-fallback-"));
  const rolloutPath = join(directory, "rollout.jsonl");
  await writeFile(rolloutPath, `${JSON.stringify({
    type: "session_meta",
    payload: { cwd: directory, model_provider: "openai" }
  })}\n`);
  const store = new BridgeStore(":memory:");
  let useEmptyHistory = false;
  const client = {
    resumeThread: async () => ({
      displayPath: directory,
      messages: [{ role: "assistant" as const, text: "resume fallback" }]
    }),
    listRecentThreadMessages: async () => {
      if (useEmptyHistory) return [];
      throw new Error("summary unsupported");
    }
  } as unknown as CodexAppServerClient;
  const service = new BridgeService(testConfig(), store, client);
  const sent: string[] = [];
  service.registerMessageTransport({
    name: "test",
    canHandle: () => true,
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return { message_id: String(sent.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => {}
  });
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat",
      codexThreadId: "thread",
      pathKey: rolloutPath,
      currentCwd: directory
    });
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
    const fallback = await service.activateSession("chat", session.id);
    assert.deepEqual(fallback.recentMessages, [{ role: "assistant", text: "resume fallback" }]);
    assert.deepEqual(await store.listRecentMessages(session.id, 5), []);

    useEmptyHistory = true;
    const empty = await service.activateSession("chat", session.id);
    assert.deepEqual(empty.recentMessages, []);
    await service.postSessionSwitchTranscript("chat", empty.session, empty.recentMessages);
    assert.ok(sent.some((text) => text.includes("No recent messages")));
    assert.ok(sent.every((text) => !text.includes("resume fallback")));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
