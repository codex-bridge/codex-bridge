import { useState, type Ref } from "react";
import { Button } from "./ui/button";
import { DismissiblePopover } from "./dismissible-popover";
import { isOwned, type SessionEntry as SessionEntryData } from "../lib/protocol";

export function SessionEntry({ session, selected, busy, connected, elementRef, onSelect, onRename, onArchive, onRestore, onRelease }: {
  session: SessionEntryData;
  selected: boolean;
  busy: boolean;
  connected: boolean;
  elementRef?: Ref<HTMLDivElement>;
  onSelect: () => void;
  onRename: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onRelease: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return <div className="session-entry" ref={elementRef}>
    <button className="session-row" aria-current={selected ? "true" : undefined} onClick={onSelect}>
      <span className="session-name-line">
        {session.connection === "active" && <span className="session-active-dot" role="img"
          aria-label="Codex session loaded" title="Codex session loaded" />}
        <span className="session-name">{session.name ?? session.threadId.slice(0, 12)}</span>
      </span>
      <span className="session-meta">{session.archived ? "Archived" : isOwned(session) ? "Bound to this page" : session.ownership?.ownerSourceId ?? "Unbound"}
        {session.ownership?.pendingSourceId ? " · Waiting to bind" : ""}</span>
    </button>
    <DismissiblePopover className="session-more" triggerClassName="session-more-trigger"
      panelClassName="session-menu" label={`More actions for ${session.name ?? session.threadId}`} title="More actions" trigger="•••">
      <div role="group" aria-label="Session actions">
        <Button variant="ghost" onClick={() => {
          setCopyError(false);
          if (!navigator.clipboard) { setCopyError(true); return; }
          void navigator.clipboard.writeText(session.threadId).then(() => setCopied(true)).catch(() => setCopyError(true));
        }}>{copyError ? "Copy failed" : copied ? "ID copied" : "Copy ID"}</Button>
        {!session.archived && <Button variant="ghost" disabled={!connected || busy || !isOwned(session)} onClick={onRename}>Rename</Button>}
        {!session.archived && <Button variant="ghost" disabled={!connected || busy || !isOwned(session)} onClick={onArchive}>Archive</Button>}
        {!session.archived && <Button variant="ghost"
          title={session.capabilities?.releaseToCodex ? "Release Bridge ownership so external Codex can use the session" : "Available only when idle with no queue, approval, or pending handoff"}
          disabled={!connected || busy || session.capabilities?.releaseToCodex !== true}
          onClick={onRelease}>Release to external Codex</Button>}
        {session.archived && <Button variant="ghost" disabled={!connected || busy} onClick={onRestore}>Restore</Button>}
      </div>
    </DismissiblePopover>
  </div>;
}
