export type SessionActionCallbackKind =
  | "handoff"
  | "releaseBridge"
  | "releaseCodex"
  | "archive"
  | "delete"
  | "deleteConfirm"
  | "refresh";

const PREFIX_BY_KIND: Record<SessionActionCallbackKind, string> = {
  handoff: "session-handoff",
  releaseBridge: "session-release-bridge",
  releaseCodex: "session-release-codex",
  archive: "session-archive",
  delete: "session-delete",
  deleteConfirm: "session-delete-confirm",
  refresh: "session-refresh"
};

export function createSessionActionCallback(
  kind: SessionActionCallbackKind,
  sessionId: string,
  leaseVersion?: number
): string {
  const prefix = PREFIX_BY_KIND[kind];
  return `${prefix}:${sessionId}${leaseVersion === undefined ? "" : `:${leaseVersion}`}`;
}
