import type { AppServerNotification } from "./client.js";
import { asRecord, firstString } from "./protocol-utils.js";

// guardianWarning has no review ID or structured outcome. Recognize only the
// observed upstream success envelope; unknown wording must remain visible.
const approvedGuardianMessage = /^Automatic approval review approved \(risk: (?:low|medium|high|critical), authorization: (?:unknown|low|medium|high)\)(?:: [^\r\n]*)?$/;

/** Presentation only. Approval requests and their actual decisions are untouched. */
export function isSilentAutoApprovalNotification(notification: AppServerNotification): boolean {
  const params = asRecord(notification.params);
  if (notification.method === "guardianWarning") {
    const message = firstString(params?.message);
    return !!message && approvedGuardianMessage.test(message.trim());
  }
  if (notification.method !== "item/autoApprovalReview/started" &&
    notification.method !== "item/autoApprovalReview/completed") return false;
  const status = firstString(asRecord(params?.review)?.status);
  return notification.method === "item/autoApprovalReview/started" ? status === "inProgress" : status === "approved";
}
