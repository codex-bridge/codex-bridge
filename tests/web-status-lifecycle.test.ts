import assert from "node:assert/strict";
import test from "node:test";
import { StatusLifecycleService } from "../src/bridge/status/lifecycle.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { SessionRecord } from "../src/shared/types.js";
import { presentWebMessage } from "../src/web/message-presentation.js";
import { LocalTimelineCache } from "../web/src/lib/cache.ts";
import { messageAppearance } from "../web/src/lib/message-appearance.ts";
import { applyMessage, dialogueText, isDialogue, restoreHistory, type TimelineItem } from "../web/src/lib/timeline.ts";

const session: SessionRecord = { id: "session", telegramChatId: "web:local", codexThreadId: "thread",
  pathKey: "/project", currentCwd: "/project", displayName: "Project", batchDecisionMessageId: null,
  codexArchivedAt: null, latestActivityAt: 0, createdAt: 0, discoveryMissingSince: null,
  discoveryMissingCount: 0, lastDiscoveredAt: 0 };

function harness() {
  const sent: MessageSpec[] = [], edited: MessageSpec[] = [];
  const lifecycle = new StatusLifecycleService({
    store: { countPendingQueuedSubmissions: async () => 2, getSessionById: async () => session },
    statusMessageBySession: new Map(), statusStartedAtBySession: new Map(), statusLabelBySession: new Map(),
    statusDetailBySession: new Map(), statusLastEditAtBySession: new Map(), statusOpBySession: new Map(),
    sendMessageSpec: async (_chatId, spec) => { sent.push(spec); return { message_id: "status" }; },
    editMessageSpec: async (_chatId, id, spec) => { assert.equal(id, "status"); edited.push(spec); return true; },
    getSessionDirectory: () => "/project", isCompactStatusUpdate: () => false,
    notifyCompactStarted: async () => {}, clearTypingState: () => {}, sendTypingOnce: async () => {}
  });
  return { lifecycle, sent, edited };
}

test("production lifecycle projects every status phase as activity, not assistant dialogue", async () => {
  const { lifecycle, sent, edited } = harness();
  await lifecycle.setSessionStatus(session, "Working");
  await lifecycle.setSessionStatus(session, "Thinking", { detail: "Reviewing", detailMode: "replace" });
  await lifecycle.clearSessionStatus(session);
  await lifecycle.setSessionStatus(session, "Recovering");
  await lifecycle.clearAllSessionStatusMessages();
  for (const spec of [...sent, ...edited]) {
    assert.equal(spec.kind, "working");
    assert.equal(spec.title, "Codex · /project");
    const web = presentWebMessage(spec);
    assert.deepEqual(messageAppearance(web), { appearance: "activity", tone: "default" });
    assert.equal(isDialogue(web), false);
  }
  assert.deepEqual(sent[0]!.actions.map(action => action.callback), ["quick:queue", "quick:interrupt"]);
  assert.match(dialogueText(presentWebMessage(sent[0]!)), /Queued: 2/);
  assert.match(dialogueText(presentWebMessage(edited[0]!)), /Reviewing/);
  assert.deepEqual(edited[1]!.actions, []);
  assert.match(dialogueText(presentWebMessage(edited[1]!)), /Working · Done/);
  assert.match(dialogueText(presentWebMessage(edited[2]!)), /Runtime connection closed/);
  // Identical text from a real reply remains dialogue: no content heuristics.
  assert.equal(isDialogue({ ...presentWebMessage(sent[0]!), kind: "codex" }), true);
});

test("production status edits survive cache/history restoration without duplicating repeated turns", async () => {
  const { lifecycle, sent, edited } = harness();
  await lifecycle.setSessionStatus(session, "Thinking");
  await lifecycle.clearSessionStatus(session);
  const dialogue = (id: string, kind: "user" | "codex", text: string): TimelineItem => ({ id, origin: "live",
    message: { kind, title: "", body: [{ type: "text", text }], actions: [] } });
  const first = [dialogue("u1", "user", "hello"), dialogue("a1", "codex", "reply"), dialogue("u2", "user", "hello")];
  const event = { threadId: "thread", sessionId: "session", leaseVersion: 1, messageId: "status" };
  let items = applyMessage(first, { ...event, operation: "send", message: presentWebMessage(sent[0]!) });
  items.push(dialogue("a2", "codex", "reply"));
  items = applyMessage(items, { ...event, operation: "edit", message: presentWebMessage(edited[0]!) });
  const data = new Map<string, string>();
  const cache = new LocalTimelineCache({ getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } });
  const history = { threadId: "thread", sessionId: "session", leaseVersion: 1,
    messages: [{ role: "user" as const, text: "hello" }, { role: "assistant" as const, text: "reply" },
      { role: "user" as const, text: "hello" }, { role: "assistant" as const, text: "reply" }] };
  for (let refresh = 0; refresh < 3; refresh++) {
    cache.save("thread", "session", items);
    items = restoreHistory(cache.load("thread", "session"), history);
    assert.deepEqual(items.map(item => item.id), ["u1", "a1", "u2", "status", "a2"]);
    assert.deepEqual(items.filter(item => isDialogue(item.message)).map(item => dialogueText(item.message)),
      ["hello", "reply", "hello", "reply"]);
    assert.deepEqual(items[3]!.message.actions, []);
    assert.match(dialogueText(items[3]!.message), /Working · Done/);
  }
});
