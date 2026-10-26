import assert from "node:assert/strict";
import test from "node:test";
import { File } from "node:buffer";
import { createConversationActions } from "../web/src/lib/conversation-actions.ts";
import type { WebActionSpec } from "../web/src/lib/protocol.ts";

test("conversation adapters preserve this, exact arguments and original completion promises", async () => {
  const calls: unknown[][] = [];
  const completion = Promise.resolve();
  const controller = {
    actMessage(action: WebActionSpec) { assert.equal(this, controller); calls.push(["message", action]); return completion; },
    actDecision(id: string, action: string, content?: Record<string, unknown>) {
      assert.equal(this, controller); calls.push(["decision", id, action, content]); return completion;
    },
    setDraft(text: string) { assert.equal(this, controller); calls.push(["draft", text]); },
    addAttachments(files: File[]) { assert.equal(this, controller); calls.push(["images", files]); },
    removeAttachment(index: number) { assert.equal(this, controller); calls.push(["remove", index]); },
    send() { assert.equal(this, controller); calls.push(["send"]); return completion; },
    queueDraft() { assert.equal(this, controller); calls.push(["queue"]); return completion; },
    cancelQueued(id: string) { assert.equal(this, controller); calls.push(["cancel", id]); return completion; }
  };
  const actions = createConversationActions(controller);
  assert.deepEqual(calls, []);
  const go: WebActionSpec = { id: "go", label: "Go", execution: { type: "send-text", text: "go" } };
  const input = { value: "user input", nested: { preserve: true } };
  const images = [new File(["image bytes"], "test.png", { type: "image/png" })];
  assert.equal(actions.timeline.actMessage(go), completion);
  assert.equal(actions.timeline.actDecision("approval-a", "accept"), completion);
  assert.equal(actions.timeline.actDecision("input-a", "submit", input), completion);
  actions.composer.setDraft("keep\nthis draft");
  actions.composer.addAttachments(images);
  actions.composer.removeAttachment(2);
  assert.equal(actions.composer.send(), completion);
  assert.equal(actions.composer.queueDraft(), completion);
  assert.equal(actions.cancelQueued("queue-a"), completion);
  assert.deepEqual(calls, [["message", go], ["decision", "approval-a", "accept", undefined],
    ["decision", "input-a", "submit", input], ["draft", "keep\nthis draft"], ["images", images],
    ["remove", 2], ["send"], ["queue"], ["cancel", "queue-a"]]);
  assert.equal(calls[0]![1], go);
  assert.equal(calls[2]![3], input);
  assert.equal(calls[4]![1], images);
  await completion;
});

test("conversation adapters do not swallow an unknown outcome or retry any operation", async () => {
  const failure = new Error("Outcome unknown");
  let attempts = 0;
  const reject = async () => { attempts++; throw failure; };
  const actions = createConversationActions({ actMessage: reject, actDecision: reject, send: reject,
    queueDraft: reject, cancelQueued: reject, setDraft: () => {}, addAttachments: () => {}, removeAttachment: () => {} });
  const operations = [() => actions.timeline.actMessage({ id: "next", label: "Next",
    execution: { type: "send-text", text: "next" } }), () => actions.timeline.actDecision("a", "decline"),
  () => actions.composer.send(), () => actions.composer.queueDraft(), () => actions.cancelQueued("q")];
  for (const [index, operation] of operations.entries()) {
    await assert.rejects(operation(), (error) => error === failure);
    assert.equal(attempts, index + 1);
  }
});

test("conversation adapters read the controller at invocation instead of capturing a session or draft", async () => {
  let selected = "first", draft = "first draft";
  const sent: string[][] = [];
  const actions = createConversationActions({ actMessage: async () => {}, actDecision: async () => {},
    setDraft: (text) => { draft = text; }, addAttachments: () => {}, removeAttachment: () => {},
    send: async () => { sent.push([selected, draft]); }, queueDraft: async () => {}, cancelQueued: async () => {} });
  selected = "second";
  actions.composer.setDraft("second draft");
  await actions.composer.send();
  assert.deepEqual(sent, [["second", "second draft"]]);
});
