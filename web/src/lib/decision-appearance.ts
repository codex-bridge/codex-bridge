import type { MessageSpec } from "./protocol";

type Decision = NonNullable<MessageSpec["decision"]>;

export type DecisionAppearance = {
  label: string;
  tone: "attention" | "success" | "danger" | "muted";
  open: boolean;
  guidance: string;
  unavailable: string | null;
};

const terminal: Record<Exclude<Decision["state"], "pending" | "awaitingInput">,
  Pick<DecisionAppearance, "label" | "tone" | "guidance">> = {
  approved: { label: "Approved", tone: "success", guidance: "Codex may continue. This does not mean the later operation succeeded." },
  approvedForSession: { label: "Approved for session", tone: "success", guidance: "Codex may continue within this session. This does not mean the later operation succeeded." },
  rejected: { label: "Rejected", tone: "danger", guidance: "This request was rejected." },
  cancelled: { label: "Cancelled", tone: "muted", guidance: "This request was cancelled." },
  stale: { label: "Request expired", tone: "muted", guidance: "Codex is no longer waiting for this request, so it cannot be acted on." }
};

export function decisionAppearance(decision: Decision, options: { current: boolean; enabled: boolean; busy: boolean }): DecisionAppearance {
  if ((decision.state === "pending" || decision.state === "awaitingInput") && !options.current) return {
    label: "Status unknown",
    tone: "muted",
    open: false,
    guidance: "No final result was received for this request.",
    unavailable: "This request is no longer an open approval and cannot be acted on."
  };
  if (decision.state !== "pending" && decision.state !== "awaitingInput") {
    return { ...terminal[decision.state], open: false, unavailable: null };
  }

  const unavailable = decision.unavailableReason === "runtime_disconnected"
    ? "The runtime is disconnected, so actions are temporarily unavailable."
    : decision.unavailableReason === "original_request_inactive"
      ? "The original request has expired and cannot be acted on."
      : !options.enabled
        ? "A valid connection and session access are required."
        : options.busy
          ? "Another operation is in progress. Wait for it to finish."
          : null;
  return {
    label: decision.state === "awaitingInput" ? "Awaiting input" : "Awaiting approval",
    tone: "attention",
    open: true,
    guidance: decision.state === "awaitingInput"
      ? "Fill in the required fields and submit. Submission only continues this request; it does not mean the later operation succeeded."
      : "Approval only allows Codex to continue; it does not mean the later operation succeeded.",
    unavailable
  };
}
