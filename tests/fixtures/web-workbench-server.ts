/** Isolated browser fixture: memory DB + fake runtime; never imports production startup/config. */
import { WebServer } from "../../src/web/server.js";
import { BridgeStore } from "../../src/store/index.js";
import { SessionBindingService } from "../../src/bridge/sessions/binding.js";
import { SessionAccessService } from "../../src/bridge/sessions/access.js";
import type { WebBridgeApi } from "../../src/web/bridge-api.js";
import type { WebMessageDelivery } from "../../src/web/transport.js";
import type { MessageSpec } from "../../src/bridge/messages/types.js";
import { WebDirectoryRegistry } from "../../src/bridge/sessions/directory-registry.js";

const store = new BridgeStore(":memory:");
await store.ensureChat("web:local");
const sessions = await Promise.all(["demo-a", "demo-b"].map((threadId) => store.upsertDiscoveredSession({
  telegramChatId: "web:local", codexThreadId: threadId, pathKey: "/fixture/workbench" })));
store.claimSession(sessions[1]!.id, "slack:fixture");
const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map([["demo-b", "running-fixture-turn"]]),
  getSessionDirectory: () => "/fixture/workbench", notify: async () => {} });
const access = new SessionAccessService(store);
const directories = new WebDirectoryRegistry(store);
const listeners = new Set<(delivery: WebMessageDelivery) => void>();
const cards = new Map<string, MessageSpec>();
let sequence = 0;
function publish(threadId: string, messageId: string, message: MessageSpec, operation: "send" | "edit" = "send") {
  const session = sessions.find((item) => item.codexThreadId === threadId)!;
  const lease = store.getSessionLease(session.id)!;
  for (const listener of listeners) listener({ event: { operation, threadId, sessionId: session.id,
    leaseVersion: lease.version, messageId, message }, isCurrent: () => store.getSessionBindingById(store.getSessionLease(session.id)?.ownerBindingId ?? "")?.sourceId === "web:local" });
}
const history = new Map(sessions.map((session) => [session.codexThreadId, Array.from({ length: 5 }, (_, i) => ({
  role: i % 2 ? "user" as const : "assistant" as const, text: `Recent message ${i + 1}` }))]));
const api: WebBridgeApi = {
  listCatalog: async () => ({ directories: [...new Set(["/fixture/workbench", ...store.listWebDirectories()])].sort(), sessions: sessions.map((session, index) => {
    const lease = store.getSessionLease(session.id);
    const source = (id: string | null) => id ? store.getSessionBindingById(id)?.sourceId ?? null : null;
    return { threadId: session.codexThreadId, sessionId: session.id, name: index ? "Pending handoff demo" : "Conversation demo",
      directory: "/fixture/workbench", archived: false, provider: "fixture", updatedAt: 0, connection: "unknown" as const,
      ownership: lease ? { state: lease.state, ownerSourceId: source(lease.ownerBindingId), pendingSourceId: source(lease.pendingBindingId), version: lease.version } : null };
  }) }),
  registerDirectory: (path, check) => directories.register(path, check),
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
  sendText: async (input, check) => {
    const owned = await access.requireOwned(input.threadId, "web:local", input.leaseVersion, check); owned.assertCurrent();
    history.get(input.threadId)!.push({ role: "user", text: input.text });
    if (input.text === "approval") {
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
      publish(input.threadId, run, { kind: "progress", title: "Run", body: [{ type: "text", text: "Run ×1 · Reported successes ×0 · Reported failures ×0 · Unreported ×1" }], actions: [] });
      setTimeout(() => publish(input.threadId, run, { kind: "progress", title: "Run", body: [{ type: "text", text: "Run ×2 · Reported successes ×1 · Reported failures ×0 · Unreported ×1" }], actions: [] }, "edit"), 100);
    }
    return { accepted: true, requestId: input.requestId };
  },
  actDecision: async (input, check) => {
    const owned = await access.requireOwned(input.threadId, "web:local", input.leaseVersion, check); owned.assertCurrent();
    const card = cards.get(input.decisionId)!;
    const state = input.action === "accept" && card.decision!.requiresUserInput ? "awaitingInput" : input.action === "decline" ? "rejected" : input.action === "cancel" ? "cancelled" : "approved";
    const next: MessageSpec = { ...card, decision: { ...card.decision!, state, inputAllowed: state === "awaitingInput",
      availableActions: state === "awaitingInput" ? ["decline", "cancel"] : [] } };
    cards.set(input.decisionId, next); publish(input.threadId, `decision-${input.decisionId}`, next, "edit");
    return { accepted: true, decisionId: input.decisionId, state };
  }
};
const fixtureHost = process.env.WEB_FIXTURE_HOST?.trim() || "127.0.0.1";
const server = new WebServer({ host: fixtureHost, port: 0 }, api);
const address = await server.start();
console.log(`Isolated workbench fixture: http://${fixtureHost}:${address.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.stop().finally(() => { store.close(); process.exit(0); }); });
