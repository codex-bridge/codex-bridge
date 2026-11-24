/** Isolated browser fixture: memory DB + fake runtime; never imports production startup/config. */
import { WebServer } from "../../src/web/server.js";
import { BridgeStore } from "../../src/store/index.js";
import { SessionBindingService } from "../../src/bridge/sessions/binding.js";
import { SessionAccessService } from "../../src/bridge/sessions/access.js";
import type { WebBridgeApi } from "../../src/web/bridge-api.js";
import type { WebMessageDelivery } from "../../src/web/transport.js";
import type { MessageSpec } from "../../src/bridge/messages/types.js";
import { WebDirectoryRegistry } from "../../src/bridge/sessions/directory-registry.js";
import { AssistantReplyService } from "../../src/bridge/interactions/assistant-replies.js";
import { extractAssistantMessage } from "../../src/codex/assistant-message.js";
import { createTranscriptMessageSpec } from "../../src/bridge/renderers/thread-history.js";
import { USER_INPUT_METHOD, validateUserInputAnswers, type UserInputPrompt } from "../../src/shared/user-input.js";
import { presentWebDecision } from "../../src/web/decisions.js";
import { NotificationNoticeService } from "../../src/bridge/notifications/notices.js";
import { McpStartupTracker } from "../../src/bridge/status/mcp-startup.js";
import { fixtureProgressService } from "./progress-service.js";
import { extractProgressEvent } from "../../src/codex/notification-events.js";
import type { AppServerNotification } from "../../src/codex/client.js";

const store = new BridgeStore(":memory:");
await store.ensureChat("web:local");
for (let index = 0; index < Number(process.env.WEB_FIXTURE_CATALOG_SIZE ?? 0); index++) {
  store.registerWebDirectory(`/fixture/project-${String(index).padStart(3, "0")}`);
}
const sessions = await Promise.all(["demo-a", "demo-b"].map((threadId) => store.upsertDiscoveredSession({
  telegramChatId: "web:local", codexThreadId: threadId, pathKey: "/fixture/workbench" })));
store.claimSession(sessions[1]!.id, "slack:fixture");
const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map([["demo-b", "running-fixture-turn"]]),
  getSessionDirectory: (session) => session.currentCwd ?? session.pathKey, notify: async () => {} });
const access = new SessionAccessService(store);
const replies = new AssistantReplyService(id => store.getSessionLease(id)?.version);
const directories = new WebDirectoryRegistry(store);
const listeners = new Set<(delivery: WebMessageDelivery) => void>();
const cards = new Map<string, MessageSpec>();
const nativePrompt: UserInputPrompt = { isBlocking: true, questions: [
  { id: "direction", header: "Direction", question: "Which direction should the fixture take?", isOther: true, isSecret: false,
    options: [{ label: "Go", description: "Continue the synthetic task." }, { label: "Next", description: "Discuss the next steps." }] },
  { id: "notes", header: "Notes", question: "Any notes for the fixture?", isOther: true, isSecret: false, options: null }
] };
let sequence = 0;
const activities = fixtureProgressService(store, (id, spec, edit) => {
  const session = sessions.find(s => s.id === spec.session?.id)!;
  publish(session.codexThreadId, id, spec, edit ? "edit" : "send");
});
const notices = new NotificationNoticeService({
  appendWorkflowMessage: (_session, operation) => operation(), store, mcpStartup: new McpStartupTracker(),
  resolveNotificationSession: thread => store.getSessionByThreadId(thread), getSessionDirectory: s => s.pathKey,
  sendLongSpec: async (_source, spec) => {
    const session = sessions.find(s => s.id === spec.session?.id)!;
    publish(session.codexThreadId, `notice-${sequence++}`, spec);
  } });
function publish(threadId: string, messageId: string, message: MessageSpec, operation: "send" | "edit" = "send") {
  const session = sessions.find((item) => item.codexThreadId === threadId)!;
  const lease = store.getSessionLease(session.id)!;
  for (const listener of listeners) listener({ event: { operation, threadId, sessionId: session.id,
    leaseVersion: lease.version, messageId, message }, isCurrent: () => store.getSessionBindingById(store.getSessionLease(session.id)?.ownerBindingId ?? "")?.sourceId === "web:local" });
}
const history = new Map(sessions.map((session) => [session.codexThreadId, Array.from({ length: 5 }, (_, i) => ({
  role: i % 2 ? "user" as const : "assistant" as const, text: `Recent message ${i + 1}` }))]));
const api: WebBridgeApi = {
  readServiceNotices: () => notices.snapshot(),
  listCatalog: async () => ({ directories: [...new Set([...sessions.map((session) => session.pathKey), ...store.listWebDirectories()])].sort(), sessions: sessions.map((session, index) => {
    const lease = store.getSessionLease(session.id);
    const source = (id: string | null) => id ? store.getSessionBindingById(id)?.sourceId ?? null : null;
    return { threadId: session.codexThreadId, sessionId: session.id,
      name: index < 2 ? index ? "Pending handoff demo" : "Conversation demo" : session.displayName,
      directory: session.currentCwd ?? session.pathKey, archived: false, provider: "fixture", updatedAt: 0, connection: "unknown" as const,
      ownership: lease ? { state: lease.state, ownerSourceId: source(lease.ownerBindingId), pendingSourceId: source(lease.pendingBindingId), version: lease.version } : null };
  }) }),
  registerDirectory: (path, check) => directories.register(path, check),
  createSession: async (directory, _requestId, check) => {
    check();
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "web:local", codexThreadId: `created-${sequence++}`, pathKey: directory, displayName: "New session"
    });
    sessions.push(session);
    history.set(session.codexThreadId, []);
    const result = await binding.request("web:local", session.id, undefined, check, { select: false });
    if (!result.outcome?.owned) throw new Error("Fixture session ownership failed.");
    return { threadId: session.codexThreadId, sessionId: session.id, leaseVersion: result.outcome.lease.version };
  },
  requestBinding: async (threadId, version, check) => binding.request("web:local", sessions.find((item) => item.codexThreadId === threadId)!.id, version, check),
  cancelBinding: async (threadId, version, check) => binding.cancel("web:local", sessions.find((item) => item.codexThreadId === threadId)!.id, version, check),
  subscribeBinding: (listener) => binding.subscribe(listener),
  subscribeMessages: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  readHistory: async (threadId, version, check) => {
    const owned = await access.requireOwned(threadId, "web:local", version, check);
    return { history: { threadId, sessionId: owned.session.id, leaseVersion: owned.leaseVersion,
      messages: history.get(threadId)!.slice(-5) }, assertCurrent: owned.assertCurrent };
  },
  readDecisions: async (threadId, version, check) => {
    const owned = await access.requireOwned(threadId, "web:local", version, check);
    return { snapshot: { threadId, sessionId: owned.session.id, leaseVersion: owned.leaseVersion,
      decisions: [...cards.values()].filter((card) => ["pending", "awaitingInput"].includes(card.decision!.state)) }, assertCurrent: owned.assertCurrent };
  },
  readQueue: async (threadId, version, check) => {
    const owned = await access.requireOwned(threadId, "web:local", version, check);
    return { threadId, sessionId: owned.session.id, leaseVersion: owned.leaseVersion, running: false, entries: [] };
  },
  sendText: async (input, check) => {
    const owned = await access.requireOwned(input.threadId, "web:local", input.leaseVersion, check); owned.assertCurrent();
    await notices.flushPending(owned.session, "web:local", owned.assertCurrent);
    if (input.replyToken) {
      input = { ...input, text: replies.resolve(input.replyToken, owned.session.id, "web:local").text };
      replies.consume(input.replyToken!, owned.session.id, "web:local");
    }
    history.get(input.threadId)!.push({ role: "user", text: input.text });
    if (input.text === "activities") {
      const threadId = input.threadId, turnId = `fixture-activity-turn-${sequence++}`;
      const observations: AppServerNotification[] = [
        { method: "turn/plan/updated", params: { threadId, turnId, plan: [{ step: "Inspect the fixture", status: "completed" }, { step: "Review the result", status: "inProgress" }] } },
        { method: "hook/started", params: { threadId, turnId, run: { id: "fixture-hook", eventName: "preCompact", status: "running" } } },
        { method: "item/started", params: { threadId, turnId, item: { id: "fixture-wait", type: "sleep", durationMs: 100 } } },
        { method: "hook/completed", params: { threadId, turnId, run: { id: "fixture-hook", eventName: "preCompact", status: "completed", statusMessage: "Fixture hook finished" } } },
        { method: "item/completed", params: { threadId, turnId, item: { id: "fixture-wait", type: "sleep", durationMs: 100 } } },
        { method: "item/completed", params: { threadId, turnId, item: { id: "fixture-view", type: "imageView", path: "/fixture/workbench/image.png" } } },
        { method: "item/completed", params: { threadId, turnId, item: { id: "fixture-dynamic", type: "dynamicToolCall", namespace: "fixture", tool: "inspect", status: "completed", success: true } } },
        { method: "item/autoApprovalReview/completed", params: { threadId, turnId, reviewId: "fixture-auto", review: { status: "approved", rationale: "Fixture operation is read-only" } } },
        { method: "item/completed", params: { threadId, turnId, item: { id: "fixture-review", type: "exitedReviewMode", review: "The fixture review found no remaining issues." } } }
      ];
      for (const notification of observations) await activities.sendProgressMessage(owned.session, extractProgressEvent(notification)!, turnId);
      await activities.clearProgressMessageForThread(threadId, { turnId });
    } else if (input.text === "service-warning") {
      await notices.handleWarning({ kind: "configWarning", threadId: null, message: "The fixture configuration contains an unsupported option.",
        details: "Remove the deprecated setting.", path: "/fixture/config.toml" });
    } else if (input.text === "mcp-failed" || input.text === "mcp-ready") {
      const failed = input.text === "mcp-failed";
      await notices.handleMcpStartup({ threadId: null, source: "startup", name: "fixture-tools", status: failed ? "failed" : "ready",
        error: failed ? "Fixture MCP could not connect." : null, failureReason: failed ? "reauthenticationRequired" : null });
    } else if (input.text === "thread-warning") {
      await notices.handleWarning({ kind: "guardianWarning", threadId: input.threadId, message: "Fixture guardian review unavailable.", details: null, path: null });
    } else if (input.text === "native-question") {
      const row = await store.createOrReplacePendingDecision({ sessionId: owned.session.id, telegramChatId: "web:local",
        approvalId: "fixture-native", kind: USER_INPUT_METHOD, title: "Answer questions", summary: "Fixture questions", requiresUserInput: true });
      const pending = await store.resolveDecision(row.id, "awaitingInput");
      const card = presentWebDecision(owned.session, { ...pending!, userInput: nativePrompt }, true, true);
      cards.set(row.id, card); publish(input.threadId, `decision-${row.id}`, card);
    } else if (input.text === "questions") {
      const presented = extractAssistantMessage({ type: "agentMessage", id: `question-${sequence++}`, delivery: "async",
        text: "Which next step?\n- Go\n- Next\n\nWhich level of detail?\n- Brief\n- Detailed\n\nAny other notes?",
        questions: [{ title: "Which next step?", options: ["Go", "Next"] },
          { title: "Which level of detail?", options: ["Brief", "Detailed"] }, { title: "Any other notes?", options: null }] })!;
      const message = { role: "assistant" as const, ...presented };
      history.get(input.threadId)!.push(message);
      const spec = createTranscriptMessageSpec({ directory: "/fixture/workbench", ...message });
      spec.actions = replies.createActions(owned.session, message);
      publish(input.threadId, presented.sourceItemId!, spec);
    } else if (input.text === "approval") {
      for (const [id, inputRequired] of [["command", false], ["mcp", true]] as const) {
        const card: MessageSpec = { kind: "decision", title: inputRequired ? "MCP input" : "Run approval", actions: [],
          body: [{ type: "text", text: inputRequired ? "Enter the value field." : "Request to run a test command." }],
          decision: { id, state: "pending", requiresUserInput: inputRequired, requestedFields: inputRequired ? ["value"] : [],
            availableActions: ["accept", "decline", "cancel"], inputAllowed: false } };
        cards.set(id, card); publish(input.threadId, `decision-${id}`, card);
      }
    } else {
      const text = "**Received** · isolated runtime\n\n- Preserve the original order\n- Treat leading / as plain text\n\n| Item | Status |\n| --- | --- |\n| SSE | Connected |\n\n```ts\nconst value = 1;\n```\n\n<script>alert('unsafe')</script>\n\n[Safe link](https://example.com)";
      history.get(input.threadId)!.push({ role: "assistant", text });
      const id = `reply-${sequence++}`;
      publish(input.threadId, id, { kind: "codex", title: "Codex", body: [{ type: "markdown", text }], actions: [] });
      const run = `run-${sequence++}`;
      publish(input.threadId, run, { kind: "progress", title: "Run", body: [{ type: "text", text: "Run ×1 · Succeeded ×1" }], actions: [] });
      setTimeout(() => publish(input.threadId, run, { kind: "progress", title: "Run", body: [{ type: "text", text: "Run ×2 · Succeeded ×2" }], actions: [] }, "edit"), 100);
    }
    return { accepted: true, requestId: input.requestId };
  },
  actDecision: async (input, check) => {
    const owned = await access.requireOwned(input.threadId, "web:local", input.leaseVersion, check); owned.assertCurrent();
    const card = cards.get(input.decisionId)!;
    const native = card.decision!.interaction === "user-input";
    if (native && input.action === "submit") validateUserInputAnswers(nativePrompt, input.content);
    const state = native ? input.action === "submit" ? "answered" : "cancelled"
      : input.action === "accept" && card.decision!.requiresUserInput ? "awaitingInput" : input.action === "decline" ? "rejected" : input.action === "cancel" ? "cancelled" : "approved";
    const next: MessageSpec = native
      ? presentWebDecision(owned.session, (await store.resolveDecision(input.decisionId, state))!, true, false)
      : { ...card, decision: { ...card.decision!, state, inputAllowed: state === "awaitingInput",
        availableActions: state === "awaitingInput" ? ["decline", "cancel"] : [] } };
    cards.set(input.decisionId, next); publish(input.threadId, `decision-${input.decisionId}`, next, "edit");
    return { accepted: true, decisionId: input.decisionId, state };
  }
};
const fixtureHost = process.env.WEB_FIXTURE_HOST?.trim() || "127.0.0.1";
const server = new WebServer({ host: fixtureHost, port: Number(process.env.WEB_FIXTURE_PORT ?? 0),
  staticRoot: process.env.WEB_FIXTURE_STATIC_ROOT }, api);
const address = await server.start();
console.log(`Isolated workbench fixture: http://${fixtureHost}:${address.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.stop().finally(() => { store.close(); process.exit(0); }); });
