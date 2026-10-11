import { useEffect, useSyncExternalStore } from "react";
import { Button } from "./components/ui/button";
import { Composer } from "./components/composer";
import { ConversationTimeline } from "./components/conversation-timeline";
import { DismissiblePopover } from "./components/dismissible-popover";
import { InfoHint } from "./components/info-hint";
import { SessionCatalog } from "./components/session-catalog";
import { ToolIcon } from "./components/icons";
import { HttpWorkbenchApi } from "./lib/api";
import { LocalTimelineCache } from "./lib/cache";
import { LocalComposerDraftStore } from "./lib/composer-drafts";
import { WorkbenchController, canInteract, canViewSelectedTimeline, isBusy, isSelectedOperation,
  selectedEntry } from "./lib/workbench";
import { isOwned } from "./lib/protocol";
import { hasOpenDecision } from "./lib/timeline";
import { BrowserSessionLocation, TabWindowGrantStore } from "./lib/browser-state";
import { sessionAccessAppearance } from "./lib/session-access-appearance";

export function App({ controller }: { controller: WorkbenchController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const entry = selectedEntry(state);
  const items = state.selected && canViewSelectedTimeline(state)
    ? state.timelines[state.selected] ?? [] : [];
  const draft = state.selected ? state.drafts[state.selected] ?? "" : "";
  const attachments = state.selected ? state.attachments[state.selected] ?? [] : [];
  const allowed = canInteract(state);
  const pending = items.some(hasOpenDecision);
  const queue = entry ? state.queues[entry.threadId] : undefined;
  const busy = isBusy(state);
  const conversationFeedback = state.feedback?.surface === "conversation" &&
    (!state.feedback.threadId || state.feedback.threadId === state.selected) ? state.feedback : null;
  const directoryFeedback = state.feedback?.surface === "directory" ? state.feedback : null;
  const accessAppearance = sessionAccessAppearance({ selected: !!state.selected, entry,
    connection: state.connection, catalogReady: !!state.catalog && state.catalogFresh,
    interactive: allowed, decisionPending: pending });

  useEffect(() => { void controller.start(); }, [controller]);

  return <main className="workbench">
    <SessionCatalog controller={controller} catalog={state.catalog} catalogFresh={state.catalogFresh}
      catalogError={state.catalogError} connection={state.connection} occupied={state.occupied}
      selected={state.selected} selectedEntry={entry} busy={busy} operation={state.operation}
      directoryFeedback={directoryFeedback} />
    <section className="conversation" aria-label="Conversation">
      <header className="toolbar">
        <div className="session-title"><div className="heading-with-hint"><h2>{entry?.name ?? (entry ? "Untitled session" : state.selected ? "Locate session" : "Select a session")}</h2>
          {!entry && !state.selected && <InfoHint text="Selecting only changes the current view. It does not bind the session or interrupt a running task." label="Session selection help" />}</div>
          {(entry?.directory ?? state.selected) && <p className="muted truncate" title={entry?.directory ?? state.selected ?? undefined}>{entry?.directory ?? state.selected}</p>}</div>
        <div className="toolbar-actions">{entry && <>
          {isOwned(entry) && <DismissiblePopover className="tool-menu" triggerClassName="tool-menu-trigger"
            panelClassName="tool-menu-panel" label="Session tools" title="Session tools" trigger={<ToolIcon />}><div>
            <Button variant="ghost" disabled={!allowed || busy} onClick={() => { void controller.runSessionTool("help"); }}>Help</Button>
            <Button variant="ghost" disabled={!allowed || busy} onClick={() => { void controller.runSessionTool("status"); }}>Status</Button>
            <Button variant="ghost" disabled={!allowed || busy || queue?.running === true}
              onClick={() => { void controller.runSessionTool("compact"); }}>Compact</Button>
          </div></DismissiblePopover>}
          {isOwned(entry) && queue?.running && <Button variant="destructive" disabled={!allowed || busy}
            onClick={() => { void controller.runSessionTool("interrupt"); }}>Interrupt</Button>}
          {!isOwned(entry) && <Button disabled={state.connection !== "connected" || !state.catalogFresh || busy || entry.archived}
            onClick={() => { void controller.bind("request"); }}>{isSelectedOperation(state, "binding") ? "Working…"
              : entry.ownership?.pendingSourceId === "web:local" ? "Request again" : "Bind session"}</Button>}
          {entry.ownership?.pendingSourceId === "web:local" && <Button variant="outline"
            disabled={state.connection !== "connected" || !state.catalogFresh || busy}
            onClick={() => { void controller.bind("cancel"); }}>Cancel wait</Button>}
        </>}</div>
      </header>
      <ConversationTimeline controller={controller} selected={state.selected} entry={entry} items={items} queue={queue}
        feedback={conversationFeedback} loading={state.loading} catalogFresh={state.catalogFresh}
        allowed={allowed} pending={pending} busy={busy} emptyTitle={accessAppearance.emptyTitle}
        emptyDescription={accessAppearance.emptyDescription} />
      <Composer controller={controller} selected={state.selected} draft={draft} attachments={attachments}
        allowed={allowed} pending={pending} busy={busy} sending={isSelectedOperation(state, "send")}
        queueRunning={queue?.running === true} placeholder={accessAppearance.draftPlaceholder}
        restriction={accessAppearance.composerRestriction} />
    </section>
  </main>;
}

export function createWorkbench(): WorkbenchController {
  let cache: LocalTimelineCache | undefined;
  let grants: TabWindowGrantStore | undefined;
  let drafts: LocalComposerDraftStore | undefined;
  try { cache = new LocalTimelineCache(window.localStorage); } catch { /* Local storage is optional. */ }
  try {
    grants = new TabWindowGrantStore(window.sessionStorage);
    drafts = new LocalComposerDraftStore(window.sessionStorage, window.indexedDB);
  } catch { /* Tab storage is optional. */ }
  return new WorkbenchController(new HttpWorkbenchApi(), undefined, undefined, cache,
    { location: new BrowserSessionLocation(window), grants, drafts });
}
