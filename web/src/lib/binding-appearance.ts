import type { BindingReceipt } from "./protocol";

export type BindingFeedback = { tone: "notice" | "error"; message: string } | null;

export function bindingAppearance(receipt: BindingReceipt, action: "request" | "cancel"): BindingFeedback {
  if (action === "cancel") {
    if (receipt.cancelled || receipt.reason === "not_pending") return null;
    return receipt.reason === "stale"
      ? { tone: "error", message: "Cancellation did not take effect because the session state changed. Try again." }
      : { tone: "error", message: "Could not cancel the pending bind. Refresh the session status and try again." };
  }

  if (receipt.owned) return null;
  if (receipt.pending) {
    return { tone: "notice", message: `Waiting to bind when the current stage ends. ${receipt.replacedSourceId
      ? `This replaced the pending request from ${receipt.replacedSourceId}.` : ""}`.trim() };
  }

  const message = {
    stale: "Binding did not take effect because the session state changed. Try again.",
    owned_by_other: "Binding did not take effect because another client owns this session. Try again later.",
    unavailable: "Binding did not take effect because this session cannot be bound right now. Try again later.",
    claimed: "The binding result is unknown. Refresh the session status before continuing.",
    already_owned: "The binding result is unknown. Refresh the session status before continuing.",
    cancelled: "The binding result is unknown. Refresh the session status before continuing.",
    not_pending: "The binding result is unknown. Refresh the session status before continuing."
  }[receipt.reason];
  return { tone: "error", message };
}
