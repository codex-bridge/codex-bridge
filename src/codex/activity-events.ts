import type { AppServerNotification, AppServerProgressEvent } from "./client.js";
import type { ProgressActivity } from "../shared/types.js";
import { formatActivityStatus } from "../shared/activity-status.js";
import { asRecord, firstString } from "./protocol-utils.js";

function event(threadId: string, turnId: string | undefined, activity: ProgressActivity, failed = false): AppServerProgressEvent {
  return { threadId, ...(turnId ? { turnId } : {}), itemId: activity.key, activity,
    label: activity.kind, toolName: null, action: null, target: null, input: null, changes: null,
    failed, completed: activity.terminal, text: activity.lines.join("\n") || `${activity.name} · ${activity.status}` };
}

/** Explicit public activity fields; never raw tool arguments, output, Hook context or deltas. */
export function extractActivityEvent(notification: AppServerNotification): AppServerProgressEvent | null {
  const p = asRecord(notification.params), threadId = firstString(p?.threadId);
  if (!threadId) return null;
  const turnId = firstString(p?.turnId);
  if (notification.method === "turn/plan/updated") {
    if (!turnId || !Array.isArray(p?.plan)) return null;
    const lines: string[] = [];
    const explanation = firstString(p.explanation); if (explanation) lines.push(explanation);
    for (const [index, raw] of p.plan.entries()) {
      const step = asRecord(raw), text = firstString(step?.step), status = firstString(step?.status);
      if (!text || !status) return null;
      lines.push(`${index + 1}. [${formatActivityStatus(status)}] ${text}`);
    }
    if (!lines.length) return null;
    return event(threadId, turnId, { key: `turn-plan:${turnId}`, kind: "plan", name: "Plan", status: "Updated", lines, terminal: false, updateMode: "snapshot" });
  }
  if (notification.method === "hook/started" || notification.method === "hook/completed") {
    const run = asRecord(p?.run), id = firstString(run?.id), name = firstString(run?.eventName), status = firstString(run?.status);
    // Null turn IDs are connection/session hooks; do not guess a task identity.
    if (!turnId || !id || !name || !status) return null;
    const lines: string[] = [];
    const message = firstString(run?.statusMessage); if (message) lines.push(message);
    for (const raw of Array.isArray(run?.entries) ? run.entries : []) {
      const entry = asRecord(raw), text = firstString(entry?.text);
      if (text && ["warning", "stop", "error"].includes(String(entry?.kind))) lines.push(`${entry!.kind}: ${text}`);
    }
    return event(threadId, turnId, { key: `hook:${id}`, kind: "hook", name, status, lines,
      terminal: notification.method === "hook/completed" }, status === "failed" || status === "blocked");
  }
  if (notification.method === "item/autoApprovalReview/started" || notification.method === "item/autoApprovalReview/completed") {
    const review = asRecord(p?.review), id = firstString(p?.reviewId), status = firstString(review?.status);
    if (!turnId || !id || !status) return null;
    const rationale = firstString(review?.rationale);
    return event(threadId, turnId, { key: `approval-review:${id}`, kind: "review", name: "Approval review", status,
      lines: rationale ? [rationale] : [], terminal: notification.method.endsWith("/completed") });
  }
  if (notification.method === "autoApprovalReview/strictReviewRequired") {
    if (!turnId || typeof p?.startedAtMs !== "number" || !Number.isFinite(p.startedAtMs)) return null;
    return event(threadId, turnId, { key: `strict-review:${turnId}:${p.startedAtMs}`, kind: "review", name: "Approval review",
      status: "Strict review required", lines: [], terminal: false });
  }
  if (notification.method !== "item/started" && notification.method !== "item/completed") return null;
  // Item observations below retain their original item identity.
  const item = asRecord(p?.item), id = firstString(item?.id), type = firstString(item?.type);
  if (!item || !id) return null;
  const terminal = notification.method === "item/completed";
  if (type === "plan") {
    const text = firstString(item.text); if (!text) return null;
    return event(threadId, turnId, { key: `plan:${id}`, kind: "plan", name: "Plan", status: terminal ? "Recorded" : "Updating", lines: [text], terminal });
  }
  if (type === "sleep") {
    const duration = typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0 ? item.durationMs : null;
    return event(threadId, turnId, { key: `sleep:${id}`, kind: "waiting", name: "Wait", status: terminal ? "Ended" : "Waiting",
      lines: duration === null ? [] : [`Requested duration: ${duration} ms`], terminal });
  }
  if (type === "imageView") {
    const path = firstString(item.path);
    return event(threadId, turnId, { key: `image-view:${id}`, kind: "viewed", name: "Image", status: terminal ? "Viewed" : "Viewing", lines: path ? [path] : [], terminal });
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    const text = firstString(item.review);
    return event(threadId, turnId, { key: `review:${id}`, kind: "review", name: "Review",
      status: type === "enteredReviewMode" ? "Entered" : "Result", lines: text ? [text] : [], terminal });
  }
  return null;
}
