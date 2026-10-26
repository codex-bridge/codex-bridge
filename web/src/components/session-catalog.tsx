import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { InfoHint } from "./info-hint";
import { SessionEntry } from "./session-entry";
import { DirectorySection } from "./directory-section";
import { AddDirectoryDialog, SessionManagementDialog, type SessionDialog } from "./session-dialogs";
import { LocateIcon, PlusIcon, RefreshIcon } from "./icons";
import type { CatalogActions } from "../lib/catalog-actions";
import { buildCatalogGroups, type CatalogMode } from "../lib/catalog-view";
import type { Catalog, SessionEntry as SessionEntryData } from "../lib/protocol";
import type { WorkbenchFeedback, WorkbenchOperation, WorkbenchState } from "../lib/workbench";

export type SessionCatalogProps = {
  actions: CatalogActions;
  catalog: Catalog | null;
  catalogFresh: boolean;
  catalogError: string | null;
  connection: WorkbenchState["connection"];
  serviceConnection: ReactNode;
  notificationControl?: ReactNode;
  selected: string | null;
  selectedEntry?: SessionEntryData;
  busy: boolean;
  operation: WorkbenchOperation | null;
  directoryFeedback: WorkbenchFeedback | null;
};

export const SessionCatalog = memo(function SessionCatalog({ actions, catalog, catalogFresh, catalogError,
  connection, serviceConnection, notificationControl, selected, selectedEntry, busy, operation, directoryFeedback }: SessionCatalogProps) {
  const [filter, setFilter] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogMode, setCatalogMode] = useState<CatalogMode>("active");
  const [directoryDialogOpen, setDirectoryDialogOpen] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<SessionDialog | null>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const selectedSession = useRef<HTMLDivElement>(null);
  const locateRequested = useRef(false);
  const currentDirectory = selectedEntry?.directory;
  const selectedThreadId = selectedEntry?.threadId;
  const selectedArchived = selectedEntry?.archived;

  useEffect(() => {
    if (!selectedThreadId || !currentDirectory || selectedArchived === undefined) return;
    setCatalogMode(selectedArchived ? "archived" : "active");
    setExpandedDirectories((current) => new Set(current).add(currentDirectory));
  }, [selectedThreadId, currentDirectory, selectedArchived]);
  useEffect(() => {
    if (!catalogOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setCatalogOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [catalogOpen]);
  useEffect(() => {
    if (!locateRequested.current) return;
    const frame = window.requestAnimationFrame(() => {
      selectedSession.current?.scrollIntoView({ block: "center" });
      locateRequested.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [catalogOpen, catalogMode, filter, expandedDirectories]);

  const groups = catalog ? buildCatalogGroups(catalog, { mode: catalogMode, query: filter }) : [];
  const visibleCount = groups.reduce((count, group) => count + group.sessions.length, 0);
  const archivedCount = catalog?.sessions.filter((session) => session.archived).length ?? 0;
  const activeCount = catalog?.sessions.length ? catalog.sessions.length - archivedCount : 0;
  const hasOpenDirectory = groups.some((group) => group.open);

  return <>
    {catalogOpen && <div className="catalog-backdrop" aria-hidden="true" onMouseDown={() => setCatalogOpen(false)} />}
    <aside className="sidebar" aria-label="Directories and sessions" data-catalog-open={catalogOpen ? "true" : "false"}>
      <div className="sidebar-heading">
        <div className="brand"><h1>Codex Bridge</h1></div>
        <div className="sidebar-utilities">
          {notificationControl}
          {connection === "connected" && serviceConnection}
          {catalog && <Button className="catalog-toggle" variant="ghost" aria-expanded={catalogOpen} aria-controls="session-catalog"
            onClick={() => setCatalogOpen((open) => !open)}>{catalogOpen ? "Hide directories"
              : `${catalogMode === "archived" ? "Archived" : "Directories"} · ${visibleCount}`}</Button>}
        </div>
      </div>
      {connection !== "connected" && serviceConnection}
      {connection === "connected" && !catalog && <div className="catalog-state">
        <p className="muted">{catalogError ? "Failed to load directories." : "Loading directories…"}</p>
        {catalogError && <Button variant="ghost" onClick={() => { void actions.refresh(); }}><RefreshIcon />Retry</Button>}
      </div>}
      {catalog && <div id="session-catalog" className="sidebar-catalog" data-open={catalogOpen ? "true" : "false"}>
        <label className="visually-hidden" htmlFor="session-search">{catalogMode === "archived" ? "Find archived sessions" : "Find directories or sessions"}</label>
        <input id="session-search" className="input" value={filter} onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !filter) return;
            event.preventDefault(); event.stopPropagation(); setFilter("");
          }} placeholder={catalogMode === "archived" ? "Find archived sessions" : "Find directories or sessions"} />
        <div className="catalog-header"><div className="heading-with-hint"><h2>{catalogMode === "archived" ? "Archived" : "Sessions"}</h2>
          <InfoHint text={catalogMode === "archived"
            ? "Archived sessions are excluded from the normal list, search, and sorting. Restored sessions return to Sessions."
            : "A green dot means Bridge has confirmed that the Codex session is currently loaded. No dot does not mean the session is unavailable."}
            label={catalogMode === "archived" ? "Archived session help" : "Session status help"} /></div><div className="catalog-actions">
          <Button className="catalog-action" variant="ghost" aria-label="Locate current session" title="Locate current session"
            disabled={!selectedEntry || selectedEntry.archived} onClick={() => {
              if (!selectedEntry || selectedEntry.archived) return;
              locateRequested.current = true; setCatalogMode("active"); setFilter(""); setCatalogOpen(true);
              setExpandedDirectories((current) => new Set(current).add(selectedEntry.directory));
            }}><LocateIcon /></Button>
          {catalogMode === "active" && <Button className="catalog-action" variant="ghost" aria-label="Add directory" title="Add directory"
            disabled={connection !== "connected" || busy} onClick={() => setDirectoryDialogOpen(true)}><PlusIcon /></Button>}
          <Button className="catalog-action" variant="ghost" aria-label="Refresh directories and sessions" title="Refresh"
            disabled={connection !== "connected"} onClick={() => { void actions.refresh(); }}><RefreshIcon /></Button></div></div>
        {!catalogFresh && <p className="muted">Status is temporarily unavailable. The list below may be stale.</p>}
        <nav aria-label={catalogMode === "archived" ? "Archived sessions" : "Sessions"}>
          {(catalogMode === "archived" || archivedCount > 0) && <Button className="catalog-view-switch" variant="ghost"
            aria-current={catalogMode === "archived" ? "page" : undefined}
            onClick={() => setCatalogMode(catalogMode === "archived" ? "active" : "archived")}>
            <span>{catalogMode === "archived" ? "← Back to Sessions" : "Archived"}</span>
            <span className="catalog-view-switch-trailing"><span>{catalogMode === "archived" ? activeCount : archivedCount}</span>
              {catalogMode === "active" && <span aria-hidden="true">›</span>}</span>
          </Button>}
          {!groups.length && <p className="sidebar-empty muted">{catalogMode === "archived"
            ? filter.trim() ? "No archived sessions match." : "No archived sessions."
            : filter.trim() ? "No directories or sessions match." : "No directories yet."}</p>}
          {groups.map((group, index) => {
            const { directory, sessions, open } = group;
            const expanded = expandedDirectories.has(directory);
            return <Fragment key={directory}>
              {catalogMode === "active" && open && (index === 0 || !groups[index - 1]?.open) && <p className="directory-group-label">Open projects</p>}
              {catalogMode === "active" && hasOpenDirectory && !open && groups[index - 1]?.open && <p className="directory-group-label">Other directories</p>}
              <DirectorySection directory={directory} open={open} expanded={expanded}
                createDisabled={connection !== "connected" || !catalogFresh || busy}
                onCreate={catalogMode === "active" ? () => setSessionDialog({ kind: "create", directory }) : undefined}
                onToggle={() => setExpandedDirectories((current) => {
                  const next = new Set(current); if (expanded) next.delete(directory); else next.add(directory); return next;
                })}>
                {expanded && <>
                  {!sessions.length && <p className="directory-empty muted">No sessions</p>}
                  {sessions.map((session) => <SessionEntry key={session.threadId} session={session}
                    selected={session.threadId === selected} busy={busy}
                    elementRef={session.threadId === selected ? selectedSession : undefined}
                    connected={connection === "connected" && catalogFresh}
                    onSelect={() => { actions.select(session.threadId); setCatalogOpen(false); }}
                    onRename={() => setSessionDialog({ kind: "rename", session })}
                    onArchive={() => setSessionDialog({ kind: "archive", session })}
                    onRestore={() => { void actions.manageSession(session, "restore"); }}
                    onRelease={() => { void actions.manageSession(session, "release"); }} />)}
                </>}
              </DirectorySection>
            </Fragment>;
          })}
        </nav>
      </div>}
    </aside>
    {directoryDialogOpen && <AddDirectoryDialog onAddDirectory={actions.addDirectory} busy={busy} operation={operation}
      feedback={directoryFeedback} onClose={() => setDirectoryDialogOpen(false)} onAdded={(directory) => {
        setExpandedDirectories((current) => new Set(current).add(directory));
        setDirectoryDialogOpen(false); setCatalogOpen(true);
      }} />}
    {sessionDialog && <SessionManagementDialog key={sessionDialog.kind === "create" ? `create:${sessionDialog.directory}` : `${sessionDialog.kind}:${sessionDialog.session.threadId}`}
      busy={busy} operation={operation} dialog={sessionDialog} onClose={() => setSessionDialog(null)}
      onConfirm={async (name) => sessionDialog.kind === "create"
        ? !!(await actions.createSession(sessionDialog.directory))
        : actions.manageSession(sessionDialog.session, sessionDialog.kind, sessionDialog.kind === "rename" ? name : undefined)} />}
  </>;
});
