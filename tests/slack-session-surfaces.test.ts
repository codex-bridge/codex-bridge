import assert from "node:assert/strict";
import test from "node:test";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import { BridgeService, SessionActivationError } from "../src/bridge/service.js";
import type { BridgeSessionMenuPort, BridgeSessionMutationPort, BridgeSlackSessionWorkflowPort } from "../src/bridge/contracts.js";
import { handleSessionAction } from "../src/bridge/interactions/handlers/sessions.js";
import type { SessionInteractionAction } from "../src/bridge/interactions/action.js";
import type { InteractionContext } from "../src/bridge/interactions/types.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { renderCurrentSessionMenuSection, renderSessionStatus, type CurrentSessionSnapshot } from "../src/bridge/sessions/state-presentation.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import { BridgeStore } from "../src/store/index.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { resolveSlackInteractionContext } from "../src/slack/interactions/context.js";
import { deliverSlackInteraction } from "../src/slack/interactions/responder.js";
import { handleSlackSessionWorkflow } from "../src/slack/interactions/session-workflow.js";
import { readSlackSurface } from "../src/slack/surfaces.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { testConfig } from "./bridge-test-config.js";
import { logger } from "../src/logging/logger.js";

logger.configureOutput({ console: "none", file: false });
const root = "slack:T:C";
const thread = "slack:T:C:1";
type Payload = { ts?: string; thread_ts?: string; blocks?: KnownBlock[]; text?: string };

function fixture() {
  const edits: Payload[] = [];
  const posts: Payload[] = [];
  const state = { parentBlocks: undefined as KnownBlock[] | undefined };
  const transport = new SlackMessageTransport({
    conversations: { history: async () => ({ ok: true, messages: [{ ts: "1", blocks: state.parentBlocks }] }) },
    chat: {
      update: async (input: Payload) => { edits.push(input); return { ok: true }; },
      postMessage: async (input: Payload) => {
        posts.push(input); return { ok: true, channel: "C", ts: "3", message: { thread_ts: input.thread_ts } };
      }
    }
  } as unknown as WebClient);
  return { transport, edits, posts, state };
}

const menu = createMessage({ scope: "global", kind: "menu", surface: "session-selector", titleLabel: "Sessions",
  actions: [{ id: "previous", label: "Previous", callback: "session-page:0" }] });

for (const [name, messageTs, threadTs, marked] of [
  ["root menu without replies", "1", null, true],
  ["root menu with replies", "1", "1", true],
  ["legacy unmarked root menu with replies", "1", "1", false],
  ["child selector", "2", "1", true]
] as const) {
  test(`${name}: pagination edits the selector instead of posting a reply`, async () => {
    const f = fixture();
    const context = resolveSlackInteractionContext(root, "session-page:1", {
      channelId: "C", teamId: "T", containerType: "message", messageTs, threadTs,
      surface: marked ? readSlackSurface(renderSlackMessageSpec(root, menu, null)) : undefined
    })!;
    const pages: number[] = [];
    const service = { renderSessionMenu: async (_chatId: string, page: number) => { pages.push(page); return menu; } } as
      BridgeSessionMenuPort & BridgeSessionMutationPort;
    await deliverSlackInteraction(f.transport, context,
      await handleSessionAction(service, context, { type: "session.menu.page", page: 1 }));
    assert.deepEqual(pages, [1]);
    assert.deepEqual(f.posts, []);
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0]!.ts, messageTs);
    assert.equal(readSlackSurface(f.edits[0]!.blocks), "session-selector");
  });
}

test("surface metadata, not title/body or parent position, identifies a status card", async () => {
  const f = fixture();
  const status = createMessage({ scope: "global", kind: "system", titleLabel: "Sessions", surface: "session-status",
    body: [{ type: "text", text: "Choose a directory." }] });
  const context = resolveSlackInteractionContext(root, "session-page:0", {
    channelId: "C", teamId: "T", containerType: "message", messageTs: "1", threadTs: "1",
    surface: readSlackSurface(renderSlackMessageSpec(thread, status, null))
  })!;
  await deliverSlackInteraction(f.transport, context, { mode: "edit", target: "surface", message: menu });
  assert.deepEqual(f.edits, []);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.thread_ts, "1");
  assert.equal(readSlackSurface(f.posts[0]!.blocks), "session-selector");
  const unmarked = renderSlackMessageSpec(thread,
    createMessage({ scope: "global", kind: "system", body: [{ type: "text", text: "Session ID 1\nBinding Bound here" }] }), null);
  assert.equal(readSlackSurface(unmarked), undefined);
});

for (const staleSurfaceId of [root, thread]) {
  test(`late selector edit cannot overwrite the current parent status (${staleSurfaceId})`, async () => {
    const f = fixture();
    f.state.parentBlocks = renderSlackMessageSpec(thread, renderSessionStatus({
      session: { id: "selected", directory: "/project" }, thread: "1", binding: "bound", actions: []
    }), null);
    // The old callback still claims to come from a selector; current Slack state wins.
    const context: InteractionContext = { platform: "slack", conversationId: staleSurfaceId, surfaceId: staleSurfaceId,
      sourceMessageId: "1", sourceSurface: "session-selector" };
    await deliverSlackInteraction(f.transport, context, { mode: "edit", target: "surface", message: menu });
    assert.deepEqual(f.edits, []);
    assert.deepEqual(f.posts, []);
    assert.equal(readSlackSurface(f.state.parentBlocks), "session-status");
  });
}

const navigationActions: SessionInteractionAction[] = [
  { type: "session.directory.open", directoryHash: "directory", page: 0 },
  { type: "session.directory.page", directoryHash: "directory", page: 1 },
  { type: "session.menu.refresh" }, { type: "session.archived.open" },
  { type: "session.archived.page", page: 1 }, { type: "session.menu.page", page: 1 }
];
const mutationActions: SessionInteractionAction[] = [
  { type: "session.handoff", sessionId: "selected" }, { type: "session.archive", sessionId: "selected" },
  { type: "session.delete.request", sessionId: "selected" }, { type: "session.delete.confirm", sessionId: "selected" },
  { type: "session.release", sessionId: "selected", owner: "bridge" },
  { type: "session.release", sessionId: "selected", owner: "codex" },
  { type: "session.create", directoryHash: "directory" }, { type: "session.unarchive", sessionId: "selected" }
];

test("handlers declare selector navigation separately from action results, retaining Telegram's edit policy", async () => {
  const result = createMessage({ scope: "global", kind: "system", body: [{ type: "text", text: "Result" }] });
  const service = {
    renderSessionMenu: async () => menu, renderSessionSectionMenu: async () => menu, renderArchivedSessionMenu: async () => menu,
    requestSessionHandoff: async () => result, archiveSession: async () => result, requestDeleteSession: async () => result,
    deleteSession: async () => result, releaseBridgeSessionLock: async () => result, releaseCodexSession: async () => result,
    requestCreateSessionFromDirectorySelector: async () => result, unarchiveSession: async () => result
  } as BridgeSessionMenuPort & BridgeSessionMutationPort;
  const context: InteractionContext = { platform: "slack", conversationId: thread, surfaceId: thread, sourceMessageId: "2" };
  const f = fixture();
  for (const action of navigationActions) {
    const delivery = await handleSessionAction(service, context, action);
    assert.equal(delivery.mode, "edit");
    assert.equal(delivery.message.surface, "session-selector");
  }
  for (const action of mutationActions) {
    const delivery = await handleSessionAction(service, context, action);
    assert.equal(delivery.mode, "send");
    assert.equal(delivery.message.surface, "action-result");
    await deliverSlackInteraction(f.transport, context, delivery);
    assert.equal((await handleSessionAction(service, { ...context, platform: "telegram" }, action)).mode, "edit");
  }
  assert.deepEqual(f.edits, []);
  assert.equal(f.posts.length, mutationActions.length);
  assert.ok(f.posts.every((post) => post.thread_ts === "1" && readSlackSurface(post.blocks) === "action-result"));
});

test("session state has separate pure menu/status renderers", () => {
  for (const [binding, label] of [
    ["external", "In use outside Bridge"], ["bound", "Bound here"], ["pending", "Waiting for handoff"],
    ["other", "In use in another conversation"], ["unbound", "Not bound"]
  ] as const) {
    const snapshot: CurrentSessionSnapshot = { session: { id: "selected", directory: "/project" }, thread: "1", binding,
      actions: [{ id: "handoff", label: "Use this session next", callback: "handoff" }] };
    const current = renderCurrentSessionMenuSection(snapshot)!.messageSpec;
    const status = renderSessionStatus(snapshot);
    assert.deepEqual(current.body, [{ type: "field", label: "Directory", value: "/project" }, ...status.body]);
    assert.equal(status.title, "Codex · /project");
    assert.ok(status.body.some((part) => part.type === "field" && part.label === "Binding" && part.value === label));
    assert.deepEqual(status.actions, []);
    assert.equal(current.actions.length, 1);
    assert.equal(status.surface, "session-status");
    assert.deepEqual(snapshot.actions, current.actions);
  }
  assert.equal(renderCurrentSessionMenuSection(null), null);
  assert.deepEqual(renderSessionStatus(null).body, [{ type: "text", text: "No session selected." }]);
});

test("binding then paginating a child selector preserves parent status and selection", async (t) => {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const service = new BridgeService(testConfig(":memory:"), store, {} as CodexAppServerClient);
  const f = fixture();
  service.registerMessageTransport(f.transport);
  const other = "slack:T:C:other";
  const target = await store.upsertDiscoveredSession({ telegramChatId: other, codexThreadId: "target", pathKey: "/target" });
  // This target is visible here before the explicit transfer.
  await store.upsertDiscoveredSession({ telegramChatId: thread, codexThreadId: "target", pathKey: "/target" });
  store.claimSession(target.id, other);
  await store.selectSession(other, target.id);
  for (let index = 0; index < 9; index++) {
    await store.upsertDiscoveredSession({ telegramChatId: thread, codexThreadId: `thread-${index}`, pathKey: `/project-${index}` });
  }
  const selector = await service.renderSessionMenu(thread, 0);
  const context = resolveSlackInteractionContext(thread, `session-handoff:${target.id}`, {
    channelId: "C", teamId: "T", containerType: "message", messageTs: "2", threadTs: "1",
    surface: readSlackSurface(renderSlackMessageSpec(thread, selector, null))
  })!;
  await deliverSlackInteraction(f.transport, context,
    await handleSessionAction(service, context, { type: "session.handoff", sessionId: target.id }));
  const parentEdits = f.edits.filter((edit) => edit.ts === "1");
  assert.ok(parentEdits.length > 0);
  assert.equal(readSlackSurface(parentEdits.at(-1)!.blocks), "session-status");
  assert.match(parentEdits.at(-1)!.text!, /Bound here/);
  assert.equal((await store.getActiveSession(thread))!.id, target.id);
  assert.equal(store.getSessionLease(target.id)!.ownerBindingId, store.getSessionBinding(target.id, thread)!.id);
  const postsBefore = f.posts.length;
  await deliverSlackInteraction(f.transport, context,
    await handleSessionAction(service, context, { type: "session.menu.page", page: 1 }));
  assert.equal(f.posts.length, postsBefore);
  assert.equal(f.edits.at(-1)!.ts, "2");
  assert.equal(readSlackSurface(f.edits.at(-1)!.blocks), "session-selector");
  assert.ok(f.edits.at(-1)!.text!.includes("Bound here"));
  assert.equal(f.edits.filter((edit) => edit.ts === "1").length, parentEdits.length);
  assert.equal((await store.getActiveSession(thread))!.id, target.id);
});

test("failed selection replies separately without replacing a selector", async () => {
  const f = fixture();
  const error = createMessage({ scope: "global", kind: "error", body: [{ type: "text", text: "In use outside Bridge" }] });
  const service = { activateSessionFromSelector: async () => { throw new SessionActivationError(error); } } as
    unknown as BridgeSlackSessionWorkflowPort;
  await handleSlackSessionWorkflow({ action: "session:selected", service, transport: f.transport,
    context: { platform: "slack", conversationId: thread, surfaceId: thread, sourceMessageId: "2", sourceSurface: "session-selector" },
    messageBlocks: null, messageText: null });
  assert.deepEqual(f.edits, []);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.thread_ts, "1");
  assert.equal(readSlackSurface(f.posts[0]!.blocks), "action-result");
});

test("successful child selection keeps its selector and sends its receipt separately", async () => {
  const f = fixture();
  const transcripts: string[] = [];
  const service = {
    activateSessionFromSelector: async () => ({ session: { id: "selected" }, recentMessages: [] }),
    getSessionArchiveCallback: async () => null, getSessionDeleteCallback: async () => null,
    getSessionReleaseBridgeCallback: async () => null,
    renderSelectedSessionSpec: async () => createMessage({ scope: "global", kind: "system", body: [{ type: "text", text: "Session selected" }] }),
    postSessionSwitchTranscript: async (chatId: string) => { transcripts.push(chatId); }
  } as unknown as BridgeSlackSessionWorkflowPort;
  await handleSlackSessionWorkflow({ action: "session:selected", service, transport: f.transport,
    context: { platform: "slack", conversationId: thread, surfaceId: thread, sourceMessageId: "2", sourceSurface: "session-selector" },
    messageBlocks: null, messageText: null });
  assert.deepEqual(f.edits, []);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.thread_ts, "1");
  assert.equal(readSlackSurface(f.posts[0]!.blocks), "action-result");
  assert.deepEqual(transcripts, [thread]);
});

test("unavailable root selector skips editing without recreating it or sending a fallback", async () => {
  const calls: string[] = [];
  const transport = new SlackMessageTransport({
    conversations: { history: async () => ({ ok: true, messages: [] }) },
    chat: {
      update: async () => { calls.push("edit"); return { ok: true }; },
      postMessage: async () => { calls.push("send"); return { ok: true }; }
    }
  } as unknown as WebClient);
  await deliverSlackInteraction(transport, { platform: "slack", conversationId: root, surfaceId: root, sourceMessageId: "1" },
    { mode: "edit", target: "surface", message: menu });
  assert.deepEqual(calls, []);
});
