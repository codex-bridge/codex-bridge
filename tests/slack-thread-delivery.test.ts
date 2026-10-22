import assert from "node:assert/strict";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { MessageDeliveryService } from "../src/bridge/messages/sender.js";
import { KeyedQueue } from "../src/shared/keyed-queue.js";
import { logger } from "../src/logging/logger.js";
import type { BridgeMessageOptions } from "../src/bridge/transport.js";
import { deliverSlackInteraction } from "../src/slack/interactions/responder.js";
import { handleSlackSessionWorkflow } from "../src/slack/interactions/session-workflow.js";
import type { BridgeSlackSessionWorkflowPort } from "../src/bridge/contracts.js";

logger.configureOutput({ console: "none", file: false });
const chatId = "slack:T:C:1.0001";
const management: BridgeMessageOptions = {
  unavailableThreadNotice: { kind: "management", text: "Session was transferred to another conversation." }
};
const actionRequired: BridgeMessageOptions = { unavailableThreadNotice: { kind: "action-required" } };

function fixture() {
  const posts: Array<{ channel: string; thread_ts?: string; text: string; blocks?: unknown[] }> = [];
  const deletes: Array<{ channel: string; ts: string }> = [];
  const edits: Array<{ channel: string; ts: string }> = [];
  const reads: Array<Record<string, unknown>> = [];
  const behavior = {
    parent: "available" as "available" | "missing" | "unknown" | "denied" | "tombstone",
    response: "thread" as "thread" | "root" | "unknown" | "other-channel" | "no-id",
    postError: null as unknown,
    deleteFails: false
  };
  const client = {
    conversations: { history: async (input: Record<string, unknown>) => {
      reads.push(input);
      if (behavior.parent === "denied") throw { data: { error: "missing_scope" } };
      if (behavior.parent === "unknown") return { ok: false };
      return { ok: true, messages: behavior.parent === "missing" ? []
        : [{ ts: "1.0001", ...(behavior.parent === "tombstone" ? { subtype: "tombstone" } : {}) }] };
    } },
    chat: {
      postMessage: async (input: typeof posts[number]) => {
        posts.push(input);
        if (behavior.postError) {
          const error = behavior.postError;
          behavior.postError = null;
          throw error;
        }
        if (behavior.response === "unknown") return { ts: "2.0001" };
        return { ts: behavior.response === "no-id" ? undefined : "2.0001",
          channel: behavior.response === "other-channel" ? "OTHER" : input.channel,
          message: { ...(behavior.response === "root" || !input.thread_ts ? {} : { thread_ts: input.thread_ts }) } };
      },
      delete: async (input: typeof deletes[number]) => {
        deletes.push(input);
        if (behavior.deleteFails) throw new Error("cant_delete_message");
        return { ok: true };
      },
      update: async (input: typeof edits[number]) => { edits.push(input); return { ok: true }; }
    }
  } as unknown as WebClient;
  return { transport: new SlackMessageTransport(client), behavior, posts, deletes, reads, edits };
}

test("a verified parent receives content and controls in the intended thread", async () => {
  const f = fixture();
  const sent = await f.transport.sendMessageSpec(chatId, createMessage({ scope: "global", kind: "decision",
    body: [{ type: "text", text: "PRIVATE REQUEST" }],
    actions: [{ id: "approve", label: "Approve", callback: "decision:secret:a" }] }), actionRequired);
  assert.deepEqual(sent, { message_id: "2.0001" });
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]?.thread_ts, "1.0001");
  assert.match(JSON.stringify(f.posts), /PRIVATE REQUEST/);
  assert.match(JSON.stringify(f.posts), /actions/);
  assert.deepEqual(f.reads, [{ channel: "C", oldest: "1.0001", latest: "1.0001", inclusive: true, limit: 1 }]);
  assert.deepEqual(f.deletes, []);
});

for (const kind of ["user", "codex", "progress", "edited", "error", "system", "refresh", "decision"] as const) {
  test(`missing parent cannot forward ${kind} content by default`, async () => {
    const f = fixture(); f.behavior.parent = "missing";
    const sent = await f.transport.sendMessageSpec(chatId, createMessage({ scope: "global", kind,
      body: [{ type: "text", text: "PRIVATE CONTENT" }] }));
    assert.equal(sent, null);
    assert.deepEqual(f.posts, []);
  });
}

test("missing parent permits a separately authored management notice only", async () => {
  const f = fixture(); f.behavior.parent = "missing";
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE ORIGINAL", management), null);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]?.thread_ts, undefined);
  assert.match(f.posts[0]!.text, /Original Slack thread 1.0001 is unavailable/);
  assert.match(f.posts[0]!.text, /Session was transferred/);
  assert.doesNotMatch(JSON.stringify(f.posts), /PRIVATE ORIGINAL|actions|callback/);
});

test("approval and input fallback carries no title, details or original controls", async () => {
  const f = fixture(); f.behavior.parent = "missing";
  const sent = await f.transport.sendMessageSpec(chatId, createMessage({ kind: "decision", titleLabel: "PRIVATE TITLE",
    session: { id: "PRIVATE SESSION", directory: "/PRIVATE/PATH" },
    body: [{ type: "text", text: "PRIVATE PAYLOAD" }],
    actions: [{ id: "approve", label: "Approve", callback: "decision:PRIVATE:a" }] }), actionRequired);
  assert.equal(sent, null);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0]!.text, /needs approval or input/);
  assert.match(f.posts[0]!.text, /Rebind/);
  assert.doesNotMatch(JSON.stringify(f.posts), /PRIVATE|actions|callback/);
});

for (const parent of ["unknown", "denied"] as const) {
  test(`unverified parent (${parent}) does not send original content or fallback`, async () => {
    const f = fixture(); f.behavior.parent = parent;
    assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
    assert.deepEqual(f.posts, []);
  });
}

test("a tombstone parent is unavailable", async () => {
  const f = fixture(); f.behavior.parent = "tombstone";
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE"), null);
  assert.deepEqual(f.posts, []);
});

test("parent-deletion race retracts the exact root message without resending original content", async () => {
  const f = fixture(); f.behavior.response = "root";
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE"), null);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.deletes, [{ channel: "C", ts: "2.0001" }]);
});

test("after confirmed retraction only a safe management notice may follow", async () => {
  const f = fixture(); f.behavior.response = "root";
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
  assert.equal(f.posts.length, 2);
  assert.match(f.posts[0]!.text, /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(f.posts[1]), /PRIVATE|actions/);
  assert.equal(f.posts[1]?.thread_ts, undefined);
  assert.deepEqual(f.deletes, [{ channel: "C", ts: "2.0001" }]);
});

test("failed retraction is logged and does not duplicate or degrade the original", async (t) => {
  const f = fixture(); f.behavior.response = "root"; f.behavior.deleteFails = true;
  const events: string[] = [];
  const warn = logger.warn; logger.warn = (event) => { events.push(event); };
  t.after(() => { logger.warn = warn; });
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
  assert.equal(f.posts.length, 1);
  assert.ok(events.includes("slack.message.misroute_retract_failed"));
});

test("unknown response location is not treated as successful thread delivery", async () => {
  const f = fixture(); f.behavior.response = "unknown";
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.deletes, [{ channel: "C", ts: "2.0001" }]);
});

test("wrong response channel is retracted using the actual channel", async () => {
  const f = fixture(); f.behavior.response = "other-channel";
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.deletes, [{ channel: "OTHER", ts: "2.0001" }]);
});

test("missing response ID is not claimed as successful or automatically repeated", async () => {
  const f = fixture(); f.behavior.response = "no-id";
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.deletes, []);
});

test("uncertain write outcome does not cause fallback or automatic resending", async () => {
  const f = fixture(); f.behavior.postError = new Error("timeout");
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.deletes, []);
});

test("definite thread_not_found rejection can produce a separate safe notice", async () => {
  const f = fixture();
  // Fail only the attempted thread send; root notice succeeds.
  f.behavior.postError = { data: { error: "thread_not_found" } };
  assert.equal(await f.transport.sendMessage(chatId, "PRIVATE", management), null);
  assert.equal(f.posts.length, 2);
  assert.doesNotMatch(f.posts[1]!.text, /PRIVATE/);
});

test("send logs distinguish intended and actual thread locations", async (t) => {
  const f = fixture(); f.behavior.response = "root";
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const info = logger.info; logger.info = (event, details) => { events.push({ event, details }); };
  t.after(() => { logger.info = info; });
  await f.transport.sendMessage(chatId, "PRIVATE");
  const sent = events.find((entry) => entry.event === "slack.message.send")?.details;
  assert.equal(sent?.threadTs, "1.0001");
  assert.equal(sent?.actualThreadTs, null);
  assert.equal(sent?.destinationVerified, false);
  assert.equal(sent?.responseDestinationKnown, true);
});

test("intentional root notifications do not require a thread parent", async () => {
  const f = fixture(); f.behavior.parent = "denied";
  assert.deepEqual(await f.transport.sendMessage("slack:T:C", "Root service notice"), { message_id: "2.0001" });
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.deletes, []);
});

test("an unavailable thread edit is skipped without recreating a parent or sending to root", async () => {
  const f = fixture(); f.behavior.parent = "missing";
  assert.equal(await f.transport.editMessageText(chatId, "2.0001", "PRIVATE", management), false);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.edits, []);
});

test("split messages stop after fallback and do not associate a root notice ID with the original", async () => {
  const f = fixture(); f.behavior.parent = "missing";
  const sender = new MessageDeliveryService({ maxLength: 4000, queue: new KeyedQueue(), getEnvelopeTitle: async () => "unused" });
  sender.registerTransport(f.transport);
  const sent = await sender.sendSpecAndGetLastMessage(chatId, createMessage({ scope: "global", kind: "decision",
    body: [{ type: "text", text: "PRIVATE ".repeat(10000) }] }), actionRequired);
  assert.equal(sent, null);
  assert.equal(f.posts.length, 1);
  assert.doesNotMatch(JSON.stringify(f.posts), /PRIVATE/);
});

test("explicit status cards are protected, while selectors at the same position remain editable", async () => {
  const f = fixture();
  const message = createMessage({ scope: "global", kind: "system", body: [{ type: "text", text: "Binding result" }] });
  const context = { platform: "slack" as const, conversationId: chatId, surfaceId: "slack:T:C", sourceMessageId: "1.0001",
    sourceSurface: "session-status" as const };
  await deliverSlackInteraction(f.transport, context, { mode: "edit", target: "surface", message });
  assert.deepEqual(f.edits, []);
  assert.equal(f.posts[0]?.thread_ts, "1.0001");
  await deliverSlackInteraction(f.transport, { ...context, sourceSurface: "session-selector", surfaceId: chatId, sourceMessageId: "1.0001" },
    { mode: "edit", target: "surface", message });
  assert.equal(f.edits[0]?.ts, "1.0001");
  await deliverSlackInteraction(f.transport, { ...context, sourceSurface: "session-selector", surfaceId: chatId, sourceMessageId: "2.0001" },
    { mode: "edit", target: "surface", message });
  assert.equal(f.edits[1]?.ts, "2.0001");
});

test("successful root selection never overwrites its state-maintained parent card", async () => {
  const f = fixture();
  const transcripts: string[] = [];
  const service = {
    activateSessionFromSelector: async () => ({ session: { id: "selected" }, recentMessages: [] }),
    renderSelectedSessionSpec: async () => { throw new Error("Do not replace the current parent state"); },
    postSessionSwitchTranscript: async (source: string) => { transcripts.push(source); }
  } as unknown as BridgeSlackSessionWorkflowPort;
  assert.equal(await handleSlackSessionWorkflow({ action: "session:selected", service, transport: f.transport,
    context: { platform: "slack", conversationId: chatId, surfaceId: "slack:T:C", sourceMessageId: "1.0001" },
    messageBlocks: null, messageText: null }), true);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.posts, []);
  assert.deepEqual(transcripts, [chatId]);
});
