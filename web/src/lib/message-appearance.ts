import type { MessageSpec } from "./protocol";

export type MessageAppearance = "assistant" | "user" | "activity" | "decision" | "actions";
export type MessageTone = "default" | "error";

const errorKinds = new Set<MessageSpec["kind"]>(["failed", "error", "stream-error"]);

/** Maps protocol semantics to a small, stable set of visual roles. */
export function messageAppearance(message: MessageSpec): { appearance: MessageAppearance; tone: MessageTone } {
  const appearance: MessageAppearance = message.decision || message.kind === "decision" || message.kind === "decision-batch"
    ? "decision"
    : message.kind === "codex"
    ? "assistant"
    : message.kind === "user"
      ? "user"
      : message.kind === "actions"
        ? "actions"
        : "activity";

  return { appearance, tone: errorKinds.has(message.kind) ? "error" : "default" };
}
