export type SessionActionCallbackKind =
  | "handoff"
  | "releaseBridge"
  | "releaseCodex"
  | "archive"
  | "delete"
  | "deleteConfirm"
  | "refresh";

const LEGACY_PREFIX_BY_KIND: Record<SessionActionCallbackKind, string> = {
  handoff: "session-handoff",
  releaseBridge: "session-release-bridge",
  releaseCodex: "session-release-codex",
  archive: "session-archive",
  delete: "session-delete",
  deleteConfirm: "session-delete-confirm",
  refresh: "session-refresh"
};

// Three-byte prefixes leave room for a full 44-byte session ID and any safe
// integer lease version within Telegram's 64-byte callback limit.
const PREFIX_BY_KIND: Record<SessionActionCallbackKind, string> = {
  handoff: "sh",
  releaseBridge: "sb",
  releaseCodex: "sc",
  archive: "sa",
  delete: "sd",
  deleteConfirm: "sx",
  refresh: "sr"
};

export function createSessionActionCallback(
  kind: SessionActionCallbackKind,
  sessionId: string,
  leaseVersion?: number
): string {
  if (!sessionId || sessionId.includes(":")) throw new Error("Invalid session callback ID");
  if (leaseVersion !== undefined && (!Number.isSafeInteger(leaseVersion) || leaseVersion < 0)) {
    throw new Error("Invalid session callback lease version");
  }
  const prefix = PREFIX_BY_KIND[kind];
  return `${prefix}:${sessionId}${leaseVersion === undefined ? "" : `:${leaseVersion}`}`;
}

export function parseSessionActionCallback(value: string): {
  kind: SessionActionCallbackKind;
  sessionId: string;
  expectedLeaseVersion?: number;
} | null {
  const [prefix, sessionId, versionText, ...extra] = value.split(":");
  const kind = (Object.keys(PREFIX_BY_KIND) as SessionActionCallbackKind[]).find(
    (candidate) => prefix === PREFIX_BY_KIND[candidate] || prefix === LEGACY_PREFIX_BY_KIND[candidate]
  );
  if (!kind || !sessionId || extra.length > 0) return null;
  const version = versionText === undefined ? undefined : Number(versionText);
  if (versionText !== undefined && (!/^\d+$/.test(versionText) || !Number.isSafeInteger(version))) return null;
  return { kind, sessionId, expectedLeaseVersion: version };
}
