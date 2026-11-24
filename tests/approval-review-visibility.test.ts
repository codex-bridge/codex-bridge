import assert from "node:assert/strict";
import test from "node:test";
import { isSilentAutoApprovalNotification } from "../src/codex/approval-review-visibility.js";
import { extractProgressEvent, extractWarningEvent } from "../src/codex/notification-events.js";
import type { AppServerNotification } from "../src/codex/client.js";
import { NotificationPreviewBacklog } from "../src/bridge/notifications/preview-backlog.js";
import { BridgeService } from "../src/bridge/service.js";
import { BridgeStore } from "../src/store/index.js";
import { testConfig } from "./bridge-test-config.js";
import { telegramRefreshPolicy } from "../src/telegram/delivery-budget.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";

const rationale = "Auto-review returned a low-risk allow decision.";
const approvedWarning = `Automatic approval review approved (risk: low, authorization: unknown): ${rationale}`;
const warning = (message = approvedWarning, method = "guardianWarning"): AppServerNotification => ({ method,
  params: { threadId: "thread", message } });
const review = (status: string, method = "item/autoApprovalReview/completed"): AppServerNotification => ({ method,
  params: { threadId: "thread", turnId: "turn", reviewId: "review", review: { status, rationale } } });
const called = (id: string): AppServerNotification => ({ method: "item/completed", params: {
  threadId: "thread", turnId: "turn", item: { id, type: "mcpToolCall", server: "demo", tool: "read", status: "completed" } } });

test("automatic review progress and approval are silent, including the successful Guardian alias", () => {
  for (const notification of [review("inProgress", "item/autoApprovalReview/started"), review("approved"), warning()]) {
    assert.equal(isSilentAutoApprovalNotification(notification), true);
    assert.equal(extractProgressEvent(notification), null);
    assert.equal(extractWarningEvent(notification), null);
  }
});

test("exceptional, strict and unknown review outcomes remain visible without treating them as tool failures", () => {
  for (const status of ["denied", "timedOut", "aborted", "futureStatus", "inProgress"]) {
    const notification = review(status);
    assert.equal(isSilentAutoApprovalNotification(notification), false);
    const activity = extractProgressEvent(notification)!;
    assert.equal(activity.activity!.status, status);
    assert.deepEqual(activity.activity!.lines, [rationale]);
    assert.equal(activity.failed, false);
  }
  const strict = { method: "autoApprovalReview/strictReviewRequired", params: {
    threadId: "thread", turnId: "turn", startedAtMs: 1000 } };
  assert.ok(extractProgressEvent(strict));
  const manual = { method: "item/completed", params: { threadId: "thread", turnId: "turn",
    item: { id: "manual", type: "exitedReviewMode", review: "Manual review approved" } } };
  assert.ok(extractProgressEvent(manual));
});

test("Guardian filtering recognizes the exact success envelope and retains unrelated or changed warnings", () => {
  for (const message of [
    "Automatic approval review denied (risk: low, authorization: unknown): Requires confirmation",
    "Automatic approval review timed out", "Review could not run", "This action was not approved",
    `Additional warning: ${approvedWarning}`, `${approvedWarning}\nAdditional warning without the original envelope`,
    approvedWarning.replace("risk: low", "risk: futureRisk"),
    approvedWarning.replace("authorization: unknown", "authorization: futureAuthorization"),
    "Automatic approval review approved: changed upstream format"
  ]) {
    assert.equal(isSilentAutoApprovalNotification(warning(message)), false, message);
    assert.equal(extractWarningEvent(warning(message))!.message, message);
  }
  assert.equal(isSilentAutoApprovalNotification(warning(approvedWarning, "warning")), false,
    "the envelope never suppresses ordinary configuration or runtime warnings");
});

test("silent review observations do not split or prevent coalescing of Called previews", () => {
  const backlog = new NotificationPreviewBacklog();
  const first = backlog.track("thread", called("first"));
  for (const notification of [review("inProgress", "item/autoApprovalReview/started"), warning(), review("approved")]) {
    backlog.track("thread", notification)();
  }
  const latest = backlog.track("thread", called("latest"));
  assert.equal(first().suppressPreview, true);
  assert.notEqual(latest().suppressPreview, true);
});

for (const source of ["telegram:-1:10", "slack:T:C:1", "web:local"]) {
  test(`${source} keeps successful reviews silent while preserving failure and warning delivery`, async t => {
    const store = new BridgeStore(":memory:");
    const bridge = new BridgeService(testConfig(":memory:"), store, { listQueuedSubmissions: async () => [] } as never);
    t.after(async () => { await bridge.shutdown(); store.close(); });
    const session = await store.upsertDiscoveredSession({ telegramChatId: source, codexThreadId: "thread", pathKey: "/work" });
    await store.setActiveSession(source, session.id); store.claimSession(session.id, source);
    const sent: MessageSpec[] = [];
    bridge.registerMessageTransport({ name: "fixture", canHandle: () => true,
      ...(source.startsWith("telegram:") ? { refreshPolicy: telegramRefreshPolicy } : {}),
      sendMessageSpec: async (_source, spec) => { sent.push(spec); return { message_id: String(sent.length) }; },
      editMessageSpec: async () => true, sendMessage: async () => assert.fail("structured"),
      editMessageText: async () => true, clearMessageActions: async () => true, deleteMessage: async () => true, sendTyping: async () => {}
    });
    const send = (notification: AppServerNotification) => (bridge as unknown as {
      handleAppServerNotification(event: AppServerNotification): Promise<void> }).handleAppServerNotification(notification);
    await send({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", status: "inProgress" } } });
    await send(called("first"));
    const phase = store.getActiveProgressPhaseMessage("thread", "turn")!;
    const before = sent.length;
    for (const observations of [[warning(), review("approved")], [review("approved"), warning()]]) {
      await send(review("inProgress", "item/autoApprovalReview/started"));
      for (const notification of observations) await send(notification);
    }
    assert.equal(sent.length, before);
    assert.equal(store.getActiveProgressPhaseMessage("thread", "turn")!.id, phase.id);
    await send(called("second"));
    assert.equal(store.getActiveProgressPhaseMessage("thread", "turn")!.id, phase.id);
    await send(review("denied"));
    assert.equal(store.getActiveProgressPhaseMessage("thread", "turn")!.phaseKind, "review");
    await send(warning("Review could not run"));
    assert.ok(sent.some(spec => spec.title.startsWith("Review")));
    assert.ok(sent.some(spec => spec.title.startsWith("Guardian warning")));
    assert.ok(sent.every(spec => !JSON.stringify(spec).includes(approvedWarning)));
  });
}
