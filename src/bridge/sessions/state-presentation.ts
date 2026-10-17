import { createMessage, messageContextForSession } from "../messages/factory.js";
import type { MessageSpec, SessionContext } from "../messages/types.js";

export type CurrentSessionSnapshot = {
  session: SessionContext;
  thread: string;
  binding: "external" | "bound" | "pending" | "other" | "unbound";
  actions: MessageSpec["actions"];
};

const BINDING_LABELS: Record<CurrentSessionSnapshot["binding"], string> = {
  external: "In use outside Bridge",
  bound: "Bound here",
  pending: "Waiting for handoff",
  other: "In use in another conversation",
  unbound: "Not bound"
};

function sessionFields(snapshot: CurrentSessionSnapshot): MessageSpec["body"] {
  return [
    { type: "field", label: "Session ID", value: snapshot.session.id ?? "n/a" },
    { type: "field", label: "Thread", value: snapshot.thread },
    { type: "field", label: "Binding", value: BINDING_LABELS[snapshot.binding] }
  ];
}

export function renderCurrentSessionMenuSection(snapshot: CurrentSessionSnapshot | null): { messageSpec: MessageSpec } | null {
  return snapshot ? { messageSpec: createMessage({ kind: "menu", session: snapshot.session,
    body: [{ type: "field", label: "Directory", value: snapshot.session.directory }, ...sessionFields(snapshot)],
    actions: snapshot.actions }) } : null;
}

export function renderSessionStatus(snapshot: CurrentSessionSnapshot | null): MessageSpec {
  return createMessage({ kind: "system", titleLabel: "Codex", surface: "session-status",
    ...messageContextForSession(snapshot?.session),
    body: snapshot ? sessionFields(snapshot) : [{ type: "text", text: "No session selected." }] });
}
