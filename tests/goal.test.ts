import assert from "node:assert/strict";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import type { AppConfig } from "../src/config/index.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import { BridgeStore } from "../src/store/index.js";
import { GoalService } from "../src/bridge/goals/service.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { presentWebMessage } from "../src/web/message-presentation.js";

const goal = {
  threadId: "thread-1",
  objective: "Finish goal support",
  status: "active" as const,
  tokenBudget: 10_000,
  tokensUsed: 1_250,
  timeUsedSeconds: 75,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100
};

test("Codex goal methods preserve native goal fields", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    requestKnownMethod: async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "thread/goal/get") return { goal };
      if (method === "thread/goal/set") return { goal: { ...goal, status: "paused" } };
      return { cleared: true };
    }
  });

  assert.deepEqual(await client.readThreadGoal("thread-1"), goal);
  assert.equal((await client.updateThreadGoal("thread-1", { status: "paused" })).status, "paused");
  assert.equal(await client.clearThreadGoal("thread-1"), true);
  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get", "thread/goal/set", "thread/goal/clear"
  ]);
});

test("goal menu manages the active session and lists unfinished goals", async () => {
  const store = new BridgeStore(":memory:");
  let current = { ...goal };
  const client = {
    readThreadGoal: async (threadId: string) => threadId === "thread-1" ? current : null,
    updateThreadGoal: async (_threadId: string, patch: { status?: typeof current.status }) => {
      current = { ...current, ...patch };
      return current;
    },
    clearThreadGoal: async () => true
  } as unknown as CodexAppServerClient;
  const service = new BridgeService({
    codexPermissionMode: "auto-review"
  } as AppConfig, store, client);
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "thread-1", pathKey: "/project", currentCwd: "/project"
    });
    await store.setActiveSession("chat", session.id);
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";

    const menu = await service.renderActiveGoal("chat");
    assert.match(renderLegacyMessage(menu), /Finish goal support/);
    assert.match(renderLegacyMessage(menu), /^Codex · \/project/m);
    assert.doesNotMatch(renderLegacyMessage(menu), /^Goals?$/m);
    assert.deepEqual(menu.actions.map((action) => action.label), [
      "Pause", "Complete", "Clear", "Goals", "Help"
    ]);
    assert.equal(menu.session?.id, session.codexThreadId);
    assert.deepEqual(menu.actions.map((action) => action.id), [
      "pause", "complete", "clear", "goals", "help"
    ]);
    assert.equal(menu.actions.find((action) => action.id === "goals")?.callback, "goal-page:0");
    const confirmation = await service.requestClearActiveGoal("chat");
    assert.match(renderLegacyMessage(confirmation), /removes the saved goal/);
    assert.deepEqual(confirmation.actions.map((action) => action.label), ["Clear", "Cancel"]);
    assert.equal(confirmation.kind, "decision");
    assert.equal(confirmation.actions[0]?.style, "danger");
    const goals = await service.renderGoalsMenu("chat");
    assert.match(renderLegacyMessage(goals), /1 unfinished goal/);
    assert.match(renderLegacyMessage(goals), /1\. Finish goal support\n\/project/);
    assert.equal(goals.title, "Goals");
    assert.ok(goals.actions.some((action) => action.callback === `goal:view:${session.id}`));
    assert.equal(goals.actions.find((action) => action.id === "current")?.callback, "goal:current");
    const goalButton = goals.actions.find((action) => action.label.includes("project"));
    assert.match(goalButton?.label ?? "", /1 · active · .*project/);
    assert.ok(Buffer.byteLength(goalButton?.callback ?? "") <= 64);
    assert.match(renderLegacyMessage(await service.renderSelectedGoal("chat", session.id)), /Finish goal support/);
    assert.equal(renderLegacyMessage(await service.updateActiveGoalStatus("chat", "paused")).includes("paused"), true);
  } finally {
    store.close();
  }
});

test("Goals lists show each session directory even when session names match and none is selected", async () => {
  const store = new BridgeStore(":memory:");
  const client = {
    readThreadGoal: async (threadId: string) => ({
      ...goal, threadId,
      objective: threadId === "thread-older" ? "Fix first project" : "Fix second project",
      status: threadId === "thread-complete" ? "complete" : "active",
      updatedAt: threadId === "thread-older" ? 100 : 200
    })
  } as unknown as CodexAppServerClient;
  const service = new BridgeService({ codexPermissionMode: "auto-review" } as AppConfig, store, client);
  try {
    const older = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "thread-older", displayName: "Same session name",
      pathKey: "/original/alpha", currentCwd: "/workspace/alpha/api"
    });
    const newer = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "thread-newer", displayName: "Same session name",
      pathKey: "/original/beta", currentCwd: "/workspace/beta/web"
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "thread-complete", displayName: "Same session name",
      pathKey: "/workspace/done", currentCwd: "/workspace/done"
    });
    (service as unknown as { runtimeState: "connected" }).runtimeState = "connected";
    assert.equal(await store.getActiveSession("chat"), null);

    const menu = await service.renderGoalsMenu("chat");
    assert.equal(menu.title, "Goals");
    assert.equal(menu.session, undefined);
    assert.deepEqual(menu.body, [{ type: "text", text: [
      "2 unfinished goals.",
      "", "1. Fix second project", ".../beta/web",
      "", "2. Fix first project", ".../alpha/api"
    ].join("\n") }]);
    assert.deepEqual(menu.actions.filter((action) => action.id.startsWith("goal-")).map((action) => ({
      label: action.label, callback: action.callback
    })), [
      { label: "1 · active · Same session name", callback: `goal:view:${newer.id}` },
      { label: "2 · active · Same session name", callback: `goal:view:${older.id}` }
    ]);
    assert.ok(!menu.actions.some((action) => action.id === "current"));
  } finally {
    store.close();
  }
});

test("goal navigation remains available in empty and unavailable states", async () => {
  const store = new BridgeStore(":memory:");
  const client = {
    readThreadGoal: async () => null,
    updateThreadGoal: async () => null,
    clearThreadGoal: async () => false
  } as unknown as CodexAppServerClient;
  const service = new BridgeService({
    codexPermissionMode: "auto-review"
  } as AppConfig, store, client);
  try {
    const statusWithoutSession = await service.statusActiveSessionMessage("chat");
    assert.deepEqual(statusWithoutSession.actions.map((action) => action.id), ["session", "help"]);

    const noSession = await service.renderActiveGoal("chat");
    assert.deepEqual(noSession.actions.map((action) => action.id), ["session", "help"]);

    const unavailable = await service.renderSelectedGoal("chat", "missing");
    assert.deepEqual(unavailable.actions.map((action) => action.id), ["goals", "help"]);
    assert.equal(unavailable.actions[0]?.callback, "goal-page:0");

    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "thread-empty", pathKey: "/project", currentCwd: "/project"
    });
    await store.setActiveSession("chat", session.id);
    const empty = await service.renderActiveGoal("chat");
    assert.deepEqual(empty.actions.map((action) => action.id), ["goals", "help"]);

    const cleared = await service.clearActiveGoal("chat");
    assert.deepEqual(cleared.actions.map((action) => action.id), ["goals", "help"]);

    const goals = await service.renderGoalsMenu("chat");
    assert.deepEqual(goals.body[0], { type: "heading", text: "Current session · /project" });
    assert.deepEqual(goals.actions.map((action) => action.id), ["refresh", "current", "help"]);
    await store.clearActiveSession("chat");
    const goalsWithoutActiveSession = await service.renderGoalsMenu("chat");
    assert.deepEqual(goalsWithoutActiveSession.body, [{ type: "text", text: "No unfinished goals were found in known sessions." }]);
    assert.deepEqual(goalsWithoutActiveSession.actions.map((action) => action.id), ["refresh", "help"]);
  } finally {
    store.close();
  }
});

for (const chatId of ["123", "slack:T:C", "slack:T:C:1"]) {
  test(`Goals separates the initiating selection from cross-directory entries on every page (${chatId})`, async () => {
    const store = new BridgeStore(":memory:");
    try {
      const current = await store.upsertDiscoveredSession({
        telegramChatId: chatId, codexThreadId: "current", pathKey: "/work/stale", currentCwd: "/workspace/context/current"
      });
      const other = await store.upsertDiscoveredSession({
        telegramChatId: "catalog", codexThreadId: "catalog-selected", pathKey: "/work/other-selection"
      });
      await store.setActiveSession(chatId, current.id);
      await store.setActiveSession("catalog", other.id);
      const targets = await Promise.all(["alpha", "beta"].map((name) => store.upsertDiscoveredSession({
        telegramChatId: "catalog", codexThreadId: name, pathKey: `/work/${name}`, displayName: "Same name"
      })));
      const goals = new GoalService({
        store, codexClient: {} as CodexAppServerClient, sessionsPageSize: 1,
        getSessionSelectorChatId: () => "catalog",
        getSessionDirectory: (session) => session.currentCwd ?? session.pathKey,
        getSessionTitle: (session) => session.displayName ?? session.pathKey,
        readSessionGoal: async (session) => ({ goal: ["alpha", "beta"].includes(session.codexThreadId)
          ? { ...goal, threadId: session.codexThreadId, objective: `Fix ${session.codexThreadId}`, updatedAt: session.codexThreadId === "alpha" ? 200 : 100 }
          : null, error: null }),
        formatGoalStatus: (status) => status, formatGoalStatusLines: () => [], formatShortError: (message) => message
      });
      for (const [page, name] of ["alpha", "beta"].entries()) {
        const menu = await goals.renderGoalsMenu(chatId, page);
        assert.equal(menu.title, "Goals");
        assert.equal(menu.session, undefined);
        assert.deepEqual(menu.body, [
          { type: "heading", text: "Current session · .../context/current" },
          { type: "text", text: `2 unfinished goals.\n\n${page + 1}. Fix ${name}\n/work/${name}` }
        ]);
        assert.ok(menu.actions.some((action) => action.callback === `goal:view:${targets[page]!.id}`));
        assert.ok(menu.actions.some((action) => action.callback === `goal-page:${1 - page}`));
        const slack = renderSlackMessageSpec(chatId, menu, null)[0];
        assert.equal(slack?.type, "markdown");
        if (slack?.type !== "markdown") assert.fail("Expected a Slack markdown block");
        assert.equal(slack.text.replaceAll("\\", ""), `**Goals**\n**Current session · .../context/current**\n2 unfinished goals.\n\n${page + 1}. Fix ${name}\n/work/${name}`);
        assert.match(renderTelegramMessageSpec(menu).html, /^<b>Goals<\/b>\n<b>Current session · \.\.\.\/context\/current<\/b>\n/);
        assert.deepEqual(presentWebMessage(menu).body, menu.body);
      }
      await store.clearActiveSession(chatId);
      const noSelection = await goals.renderGoalsMenu(chatId);
      assert.equal(noSelection.title, "Goals");
      assert.equal(noSelection.body.length, 1);
      assert.equal(noSelection.body[0]?.type, "text");
      assert.equal(noSelection.actions.some((action) => action.id === "current"), false);
      assert.equal((await store.getActiveSession("catalog"))?.id, other.id);
    } finally { store.close(); }
  });
}

test("goal failures retain Goals and Help navigation", async () => {
  const store = new BridgeStore(":memory:");
  const client = {
    readThreadGoal: async () => { throw new Error("read failed"); },
    updateThreadGoal: async () => { throw new Error("update failed"); },
    clearThreadGoal: async () => { throw new Error("clear failed"); }
  } as unknown as CodexAppServerClient;
  const service = new BridgeService({
    codexPermissionMode: "auto-review"
  } as AppConfig, store, client);
  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "chat", codexThreadId: "thread-failing", pathKey: "/project", currentCwd: "/project"
    });
    await store.setActiveSession("chat", session.id);

    const readFailed = await service.renderActiveGoal("chat");
    assert.deepEqual(readFailed.actions.map((action) => action.id), ["goals", "help"]);

    const updateFailed = await service.setActiveGoalObjective("chat", "New goal");
    assert.deepEqual(updateFailed.actions.map((action) => action.id), ["goals", "help"]);

    const clearFailed = await service.clearActiveGoal("chat");
    assert.deepEqual(clearFailed.actions.map((action) => action.id), ["goals", "help"]);
  } finally {
    store.close();
  }
});
