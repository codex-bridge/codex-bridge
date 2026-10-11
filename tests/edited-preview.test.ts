import assert from "node:assert/strict";
import test from "node:test";

import { extractProgressEvent } from "../src/codex/notification-events.js";
import { extractProgressChanges } from "../src/codex/extractors/progress.js";
import { createProgressMessageSpec, createProgressPhaseSummarySpec } from "../src/bridge/renderers/progress.js";
import { ProgressService } from "../src/bridge/progress/service.js";
import { truncateTemporaryMessageSpec } from "../src/bridge/messages/temporary.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { BridgeStore } from "../src/store/index.js";

const directory = "/workspace/project";

test("file line counts honor native add/delete bodies including empty files and trailing newlines", () => {
  for (const [text, lines] of [["", 0], ["a", 1], ["a\n", 1], ["a\n\n", 2], ["a\r\nb\r\n", 2], ["++raw\n--raw\n", 2]] as const) {
    for (const kind of ["add", "delete"] as const) {
      const change = extractProgressChanges({ changes: [{ path: "a.ts", kind: { type: kind }, diff: text }] })![0]!;
      assert.equal(change.type, kind);
      assert.equal(change.added, kind === "add" ? lines : 0);
      assert.equal(change.removed, kind === "delete" ? lines : 0);
      assert.equal(change.lineStatsAvailable, true);
    }
  }
  const legacy = extractProgressChanges({ changes: { "a.ts": { type: "add", content: "first\nsecond\n" } } })![0]!;
  assert.equal(legacy.added, 2);
});

test("only a recognizable unified diff supplies update counts; code beginning with plus/minus is not a header", () => {
  const update = extractProgressChanges({ changes: [{ path: "a.ts", kind: { type: "update", move_path: null },
    diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n---old\n+++new\n context"
  }] })![0]!;
  assert.deepEqual([update.added, update.removed, update.lineStatsAvailable], [1, 1, true]);
  for (const raw of ["", "package main\n", "Success. Updated file", "+not a structured diff"]) {
    const unknown = extractProgressChanges({ changes: [{ path: "a.ts", kind: { type: "update" }, diff: raw }] })![0]!;
    assert.equal(unknown.lineStatsAvailable, false);
  }
});

test("file lifecycle and patch updates preserve the operation identity and declined edits fail", () => {
  const start = patchEvent("@@\n+preview", "item/started");
  const update = extractProgressEvent({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", itemId: "edit-1", changes: [{ path: "a.ts", diff: "@@\n+preview" }]
  } });
  const declined = extractProgressEvent({ method: "item/completed", params: {
    threadId: "thread-1", item: { id: "edit-1", type: "fileChange", status: "declined", changes: [] }
  } });
  assert.equal(start.itemId, "edit-1");
  assert.equal(update?.itemId, "edit-1");
  assert.equal(declined?.itemId, "edit-1");
  assert.equal(declined?.failed, true);
});

function patchEvent(diff: string, method = "item/fileChange/patchUpdated", failed = false, itemId = "edit-1") {
  const event = extractProgressEvent({
    method,
    params: {
      threadId: "thread-1", turnId: "turn-1",
      item: { id: itemId, type: "fileChange", status: failed ? "failed" : "completed", changes: [
        { path: `${directory}/src/a.ts`, diff }
      ] }
    }
  });
  assert.ok(event);
  return event;
}

async function fixture() {
  const store = new BridgeStore(":memory:");
  const session = await store.upsertDiscoveredSession({
    telegramChatId: "chat-1", codexThreadId: "thread-1", pathKey: directory
  });
  const sent: MessageSpec[] = [];
  const edited: Array<{ id: string; spec: MessageSpec }> = [];
  const restart = () => new ProgressService({
    getSessionDirectory: () => directory,
    getInFlightTurnId: () => "turn-1",
    shouldSkipCalledProgress: () => false,
    getActiveProgressPhaseMessage: (thread, turn) => store.getActiveProgressPhaseMessage(thread, turn),
    getLatestProgressPhaseMessage: (thread, turn) => store.getLatestProgressPhaseMessage(thread, turn),
    getProgressPhaseMessageForFileEdit: (thread, turn, item) => store.getProgressPhaseMessageForFileEdit(thread, turn, item),
    updateFinalProgressPhaseAggregate: (id, aggregate) => store.updateFinalProgressPhaseAggregate(id, aggregate),
    listActiveProgressPhaseMessages: () => store.listActiveProgressPhaseMessages(),
    listPendingProgressPhaseFinalDelivery: () => store.listPendingProgressPhaseFinalDelivery(),
    createProgressPhaseMessage: (input) => store.createProgressPhaseMessage(input),
    updateActiveProgressPhaseMessage: (id, input) => store.updateActiveProgressPhaseMessage(id, input),
    recordSuccessfulRunContentUpdate: (id) => store.recordSuccessfulRunContentUpdate(id),
    finalizeProgressPhaseMessage: (input) => store.finalizeProgressPhaseMessage(input),
    updateFinalProgressPhaseMessageState: (input) => store.updateFinalProgressPhaseMessageState(input),
    markProgressPhaseMessageDeliveryState: (input) => store.markProgressPhaseMessageDeliveryState(input),
    editMessageSpec: async (_chat, id, spec) => { edited.push({ id, spec }); return true; },
    sendTemporaryMessageSpec: async (_chat, spec) => {
      sent.push(spec);
      return { messageId: String(sent.length), text: renderLegacyMessage(spec) };
    }
  });
  return { store, session, service: restart(), restart, sent, edited };
}

test("Edited shows each file's structured diff through native Slack/TG code rendering", () => {
  const event = extractProgressEvent({ method: "item/fileChange/patchUpdated", params: {
    threadId: "thread-1", changes: [
      { path: `${directory}/src/a.ts`, diff: "@@\n-oldA\n+<newA>" },
      { path: `${directory}/src/b.ts`, diff: "@@\n+newB" }
    ]
  } });
  assert.ok(event);
  const spec = createProgressMessageSpec({ directory, event, includeDiffPreview: true });
  assert.equal(spec.title, "Edited · /workspace/project");
  assert.deepEqual(spec.body, [
    { type: "text", text: "2 files (+2 -1)" },
    { type: "text", text: "src/a.ts (+1 -1)" },
    { type: "code", text: "@@\n-oldA\n+<newA>" },
    { type: "text", text: "src/b.ts (+1 -0)" },
    { type: "code", text: "@@\n+newB" }
  ]);
  const slack = renderSlackMessageSpec("slack:T:C", spec, null);
  assert.equal(slack.length, 1);
  assert.match(JSON.stringify(slack), /```/);
  assert.match(JSON.stringify(slack), /oldA/);
  const telegram = renderTelegramMessageSpec(spec);
  assert.match(telegram.markdown, /<pre><code>@@\n-oldA\n\+&lt;newA&gt;<\/code><\/pre>/);
  assert.match(telegram.html, /<code>@@\n-oldA\n\+&lt;newA&gt;<\/code>/);
  assert.equal(createProgressMessageSpec({ directory, event }).body.some((part) => part.type === "code"), false);
});

test("absent diff stays file-only and arbitrary output delta is not a diff preview", () => {
  const event = extractProgressEvent({ method: "item/fileChange/outputDelta", params: {
    threadId: "thread-1", path: `${directory}/image.png`, delta: "tool output, not code"
  } });
  assert.ok(event);
  assert.equal(event.changes?.[0]?.diffPreview, undefined);
  assert.equal(createProgressMessageSpec({ directory, event, includeDiffPreview: true }).body.some((part) => part.type === "code"), false);
  const binary = extractProgressEvent({ method: "item/started", params: {
    threadId: "thread-1", item: { type: "fileChange", changes: [{ path: `${directory}/image.png` }] }
  } });
  assert.ok(binary);
  assert.deepEqual(createProgressMessageSpec({ directory, event: binary, includeDiffPreview: true }).body, [
    { type: "text", text: "image.png" }
  ]);
});

test("long Unicode diff is capped at 800 body characters with no line limit", () => {
  const spec = truncateTemporaryMessageSpec(createProgressMessageSpec({
    directory, event: patchEvent(`@@\n-old\n+${"😀".repeat(1000)}`), includeDiffPreview: true
  }));
  const texts = spec.body.map((part) => part.type === "field" ? part.value : part.text);
  assert.equal(texts.reduce((count, text) => count + Array.from(text).length, 0), 800);
  assert.equal(spec.body.at(-1)?.type, "code");
  assert.match(texts.at(-1) ?? "", /…$/);
  const multiline = createProgressMessageSpec({ directory, event: patchEvent("@@\n+a\n+b\n+c\n+d\n+e"), includeDiffPreview: true });
  assert.deepEqual(truncateTemporaryMessageSpec(multiline), multiline);
});

test("truncation reserves the ellipsis when a preceding body part exactly fills the cap", () => {
  const spec: MessageSpec = { kind: "edited", title: "Edited", actions: [], body: [
    { type: "text", text: "x".repeat(800) }, { type: "code", text: "+next" }
  ] };
  const truncated = truncateTemporaryMessageSpec(spec);
  assert.deepEqual(truncated.body, [{ type: "text", text: `${"x".repeat(799)}…` }]);
});

test("same-count changed diff edits the same card; item completion does not freeze the phase", async () => {
  const { store, session, service, sent, edited } = await fixture();
  try {
    await service.sendProgressMessage(session, patchEvent("@@\n-old\n+alpha", "item/started"));
    await service.sendProgressMessage(session, patchEvent("@@\n-old\n+bravo"));
    await service.sendProgressMessage(session, patchEvent("@@\n-old\n+bravo", "item/completed"));
    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);
    assert.equal(edited[0]?.id, "1");
    assert.match(renderLegacyMessage(edited[0]!.spec), /\+bravo/);
    assert.equal(store.getActiveProgressPhaseMessage("thread-1", "turn-1")?.state, "active");
    assert.doesNotMatch(JSON.stringify(store.getActiveProgressPhaseMessage("thread-1", "turn-1")), /alpha|bravo|diffPreview/);

    const run = extractProgressEvent({ method: "item/started", params: {
      threadId: "thread-1", item: { type: "commandExecution", command: "yarn check" }
    } });
    assert.ok(run);
    await service.sendProgressMessage(session, run);
    assert.equal(sent.length, 2);
    const summary = edited.at(-1)!;
    assert.equal(summary.id, "1");
    assert.equal(summary.spec.title, "Edited · /workspace/project");
    assert.equal(renderLegacyMessage(summary.spec), "Edited · /workspace/project\nsrc/a.ts (+1 -1)");
    assert.doesNotMatch(renderLegacyMessage(summary.spec), /alpha|bravo|@@/);
    assert.equal(summary.spec.body.some((part) => part.type === "code"), false);
  } finally { store.close(); }
});

test("ordered edit rows preserve repeated files and distinct identical edits across restart", async () => {
  const { store, session, service, restart, sent, edited } = await fixture();
  try {
    await service.sendProgressMessage(session, patchEvent("@@\n+one", "item/started", false, "first"));
    await service.sendProgressMessage(session, patchEvent("@@\n+one", "item/completed", false, "first"));
    await service.sendProgressMessage(session, patchEvent("@@\n+one", "item/completed", false, "first"));
    // Identical visible content is still a separate modification when the operation ID differs.
    await service.sendProgressMessage(session, patchEvent("@@\n+one", "item/completed", false, "second"));
    assert.equal(edited.length, 0);
    assert.equal(sent.length, 1);
    const resumed = restart();
    await resumed.sendProgressMessage(session, patchEvent("@@\n+one", "item/completed", false, "second"));
    await resumed.sendProgressMessage(session, patchEvent("@@\n-old\n+new", "item/completed", false, "third"));
    await resumed.clearProgressMessageForThread("thread-1", { terminal: "completed", turnId: "turn-1" });
    const record = store.getLatestProgressPhaseMessage("thread-1", "turn-1")!;
    assert.deepEqual(record.aggregate.fileEdits?.map((edit) => edit.itemId), ["first", "second", "third"]);
    assert.equal(renderLegacyMessage(edited.at(-1)!.spec), [
      "Edited · /workspace/project", "src/a.ts (+1 -0)", "src/a.ts (+1 -0)", "src/a.ts (+1 -1)"
    ].join("\n"));
    assert.deepEqual(record.aggregate.files, {});
    assert.doesNotMatch(JSON.stringify(record.aggregate), /diffPreview|@@|one|old|new/);
  } finally { store.close(); }
});

test("new-file content counts as additions, and all files in an operation retain their order", async () => {
  const { store, session, service, edited } = await fixture();
  try {
    const event = extractProgressEvent({ method: "item/completed", params: {
      threadId: "thread-1", turnId: "turn-1", item: {
        id: "native-add", type: "fileChange", status: "completed", changes: [
          { path: `${directory}/main.go`, kind: { type: "add" }, diff: `${Array(93).fill("code").join("\n")}\n` },
          { path: `${directory}/b.ts`, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" },
          { path: `${directory}/c.ts`, kind: { type: "delete" }, diff: "first\nsecond\n" },
          { path: `${directory}/d.png`, kind: { type: "add" } }
        ]
      }
    } });
    assert.ok(event);
    await service.sendProgressMessage(session, event);
    await service.clearProgressMessageForThread("thread-1", { terminal: "completed", turnId: "turn-1" });
    assert.equal(renderLegacyMessage(edited.at(-1)!.spec), [
      "Edited · /workspace/project", "main.go (+93 -0)", "b.ts (+1 -1)", "c.ts (+0 -2)", "d.png"
    ].join("\n"));
  } finally { store.close(); }
});

test("unconfirmed edits retain their chronological slot but not successful counts", async () => {
  const { store, session, service, edited } = await fixture();
  try {
    await service.sendProgressMessage(session, patchEvent("@@\n+first", "item/started", false, "first"));
    await service.sendProgressMessage(session, patchEvent("@@\n+second", "item/started", false, "second"));
    await service.sendProgressMessage(session, patchEvent("@@\n+second", "item/completed", false, "second"));
    // A late preview for a completed item must not change its confirmed count.
    await service.sendProgressMessage(session, patchEvent("@@\n+second\n+stale", "item/fileChange/patchUpdated", false, "second"));
    await service.clearProgressMessageForThread("thread-1", { terminal: "interrupted", turnId: "turn-1" });
    assert.equal(renderLegacyMessage(edited.at(-1)!.spec), [
      "Edited · /workspace/project", "Interrupted", "src/a.ts · Unconfirmed", "src/a.ts (+1 -0)"
    ].join("\n"));
  } finally { store.close(); }
});

test("late completion updates the original Edited summary without reopening it, including after restart", async () => {
  const { store, session, service, restart, sent, edited } = await fixture();
  try {
    await service.sendProgressMessage(session, patchEvent("@@\n+code", "item/started"));
    const run = extractProgressEvent({ method: "item/started", params: {
      threadId: "thread-1", item: { id: "run-1", type: "commandExecution", command: "yarn check" }
    } });
    assert.ok(run);
    await service.sendProgressMessage(session, run);
    const running = store.getActiveProgressPhaseMessage("thread-1", "turn-1")!;
    assert.equal(running.phaseKind, "run");
    assert.match(renderLegacyMessage(edited.at(-1)!.spec), /Unconfirmed/);
    const resumed = restart();
    await resumed.sendProgressMessage(session, patchEvent("@@\n+code", "item/completed"));
    assert.equal(sent.length, 2);
    assert.equal(edited.at(-1)!.id, "1");
    assert.equal(renderLegacyMessage(edited.at(-1)!.spec), "Edited · /workspace/project\nsrc/a.ts (+1 -0)");
    assert.equal(store.getActiveProgressPhaseMessage("thread-1", "turn-1")?.id, running.id);
    const editCount = edited.length;
    await resumed.sendProgressMessage(session, patchEvent("@@\n+code", "item/completed"));
    assert.equal(edited.length, editCount);
    assert.equal(store.getProgressPhaseMessageForFileEdit("thread-1", "another-turn", "edit-1"), null);
  } finally { store.close(); }
});

test("duplicate failed completion does not create a second failed edit card", async () => {
  const { store, session, service, sent, edited } = await fixture();
  try {
    await service.sendProgressMessage(session, patchEvent("@@\n+code", "item/started"));
    await service.sendProgressMessage(session, patchEvent("@@\n+code", "item/completed", true));
    const summary = renderLegacyMessage(edited.at(-1)!.spec);
    assert.match(summary, /src\/a.ts · Failed/);
    assert.doesNotMatch(summary, /\(\+1 -0\)/);
    const editCount = edited.length;
    await service.sendProgressMessage(session, patchEvent("@@\n+code", "item/completed", true));
    assert.equal(sent.length, 1);
    assert.equal(edited.length, editCount);
  } finally { store.close(); }
});

test("a long final edit list truncates in one retained card without a three-file limit", async () => {
  const { store, session, service, sent, edited } = await fixture();
  try {
    for (let index = 0; index < 60; index += 1) {
      await service.sendProgressMessage(session, patchEvent("@@\n+code", "item/completed", false, `edit-${index}`));
    }
    await service.clearProgressMessageForThread("thread-1", { terminal: "completed", turnId: "turn-1" });
    assert.equal(sent.length, 1);
    const summary = edited.at(-1)!.spec;
    assert.ok(summary.body.length > 3);
    assert.equal(summary.body.reduce((sum, part) => sum + Array.from(part.type === "field" ? part.value : part.text).length, 0), 800);
    assert.match(renderLegacyMessage(summary), /…$/);
    assert.equal(store.getLatestProgressPhaseMessage("thread-1", "turn-1")?.aggregate.fileEdits?.length, 60);
  } finally { store.close(); }
});

test("unidentified edit notifications do not invent repeated operations", async () => {
  const { store, session, service, edited } = await fixture();
  try {
    const event = patchEvent("@@\n+code", "item/completed");
    delete event.itemId;
    await service.sendProgressMessage(session, event);
    await service.sendProgressMessage(session, event);
    await service.clearProgressMessageForThread("thread-1", { terminal: "completed", turnId: "turn-1" });
    assert.deepEqual(store.getLatestProgressPhaseMessage("thread-1", "turn-1")?.aggregate.fileEdits, []);
    assert.equal(renderLegacyMessage(edited.at(-1)!.spec), "Edited · /workspace/project\nFile edit details unavailable.");
  } finally { store.close(); }
});

test("legacy aggregates remain totals rather than being reinterpreted as ordered edits", async () => {
  const { store, session } = await fixture();
  try {
    const legacy = store.createProgressPhaseMessage({
      sessionId: session.id, codexThreadId: "thread-1", turnId: "turn-1", phaseKind: "edited",
      sourceId: "chat-1", platformMessageId: "legacy", directory, text: "",
      aggregate: {
        eventCount: 2, operations: [], files: { "a.ts": { added: 9, removed: 2, lineStatsAvailable: true } },
        run: { updates: 0, succeeded: 0, failed: 0 }, explored: {}
      }
    });
    const reread = store.getActiveProgressPhaseMessage("thread-1", "turn-1")!;
    assert.equal(reread.aggregate.fileEdits, undefined);
    const spec = createProgressPhaseSummarySpec({ directory, record: { ...legacy, state: "phase_complete" } });
    assert.equal(renderLegacyMessage(spec), "Edited · /workspace/project\n1 file (+9 -2).\na.ts");
  } finally { store.close(); }
});

test("diff changes beyond the displayed cap do not cause invisible message edits", async () => {
  const { store, session, service, sent, edited } = await fixture();
  try {
    await service.sendProgressMessage(session, patchEvent(`@@\n+${"x".repeat(1000)}a`));
    await service.sendProgressMessage(session, patchEvent(`@@\n+${"x".repeat(1000)}b`));
    assert.equal(sent.length, 1);
    assert.equal(edited.length, 0);
    await service.clearProgressMessageForThread("thread-1", { terminal: "completed", turnId: "turn-1" });
    assert.equal(edited.length, 1);
    assert.doesNotMatch(renderLegacyMessage(edited[0]!.spec), /xxx|@@/);
    assert.equal(edited[0]!.spec.title, "Edited · /workspace/project");
  } finally { store.close(); }
});

test("an unchanged diff cannot dedupe away a newly reported edit failure", async () => {
  const { store, session, service, edited } = await fixture();
  try {
    await service.sendProgressMessage(session, patchEvent("@@\n+preview", "item/started"));
    await service.sendProgressMessage(session, patchEvent("@@\n+preview", "item/completed", true));
    assert.equal(store.getLatestProgressPhaseMessage("thread-1", "turn-1")?.state, "step_failed");
    assert.match(renderLegacyMessage(edited.at(-1)!.spec), /Step failed/);
    assert.doesNotMatch(renderLegacyMessage(edited.at(-1)!.spec), /\+preview|@@/);
  } finally { store.close(); }
});
