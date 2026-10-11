import { isOwned, type SessionEntry } from "./protocol";

type Connection = "idle" | "connecting" | "connected" | "offline" | "revoked";

export type SessionAccessAppearance = {
  emptyTitle: string | null;
  emptyDescription: string | null;
  draftPlaceholder: string;
  composerRestriction: string | null;
};

export function sessionAccessAppearance(input: {
  selected: boolean;
  entry?: SessionEntry;
  connection: Connection;
  catalogReady: boolean;
  interactive: boolean;
  decisionPending: boolean;
}): SessionAccessAppearance {
  const { selected, entry, connection, catalogReady, interactive, decisionPending } = input;
  if (!selected) return {
    emptyTitle: "Open your workspace",
    emptyDescription: connection === "connected" && catalogReady ? "Select and bind a session from the sidebar." : null,
    draftPlaceholder: "Select a session to start a draft",
    composerRestriction: "Select a session to start a draft."
  };
  if (!entry) return {
    emptyTitle: null,
    emptyDescription: null,
    draftPlaceholder: "Draft",
    composerRestriction: connection === "connected" ? "This session is temporarily unavailable." : "Connect to the service to confirm this session."
  };
  if (entry.archived) return {
    emptyTitle: "Archived session",
    emptyDescription: "Restore it to continue the conversation.",
    draftPlaceholder: "Draft",
    composerRestriction: "Messages cannot be sent to an archived session."
  };
  if (!isOwned(entry)) return {
    emptyTitle: null,
    emptyDescription: "Binding restores the 5 most recent messages. Switching does not stop a running task.",
    draftPlaceholder: "You can start a draft",
    composerRestriction: connection !== "connected" ? "Connect to the service before binding."
      : !catalogReady ? "Refresh the session status before binding." : "Bind this session before sending."
  };
  return {
    emptyTitle: "Continue the conversation here",
    emptyDescription: "This session has no messages yet. New messages will appear here.",
    draftPlaceholder: "Write a message",
    composerRestriction: decisionPending ? "Resolve the approval or input request before sending a message."
      : interactive ? null : connection !== "connected" ? "Reconnect to the service before sending."
        : !catalogReady ? "Refresh the session status before sending." : "Restoring session status…"
  };
}
