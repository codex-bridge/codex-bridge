import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Composer } from "./components/composer";
import { ConversationTimeline } from "./components/conversation-timeline";
import { SessionCatalog } from "./components/session-catalog";
import { ServiceConnectionControl } from "./components/service-connection-control";
import { WorkbenchShell } from "./components/workbench-shell";
import { SessionHeader } from "./components/session-header";
import { HttpWorkbenchApi } from "./lib/api";
import { LocalTimelineCache } from "./lib/cache";
import { LocalComposerDraftStore } from "./lib/composer-drafts";
import { WorkbenchController, canInteract, canViewSelectedTimeline, isBusy, isSelectedOperation,
  selectedEntry } from "./lib/workbench";
import { hasOpenDecision } from "./lib/timeline";
import { BrowserSessionLocation, TabWindowGrantStore } from "./lib/browser-state";
import { sessionAccessAppearance } from "./lib/session-access-appearance";
import { createCatalogActions } from "./lib/catalog-actions";
import { sessionControls } from "./lib/session-controls";

export function App({ controller }: { controller: WorkbenchController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const catalogActions = useMemo(() => createCatalogActions(controller), [controller]);
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

  return <WorkbenchShell navigation={<SessionCatalog actions={catalogActions} catalog={state.catalog} catalogFresh={state.catalogFresh}
      catalogError={state.catalogError} connection={state.connection}
      serviceConnection={<ServiceConnectionControl connection={state.connection} occupied={state.occupied}
        onConnect={() => { void controller.connect(state.occupied); }} />}
      selected={state.selected} selectedEntry={entry} busy={busy} operation={state.operation}
      directoryFeedback={directoryFeedback} />}>
      <SessionHeader key={`${state.selected}:${entry?.sessionId}`} selected={state.selected} entry={entry}
        controls={sessionControls(state)} connection={state.connection} catalogFresh={state.catalogFresh}
        feedback={conversationFeedback} onTool={(tool) => { void controller.runSessionTool(tool); }}
        onBind={(action) => { void controller.bind(action); }}
        onRelease={() => { if (entry) void controller.manageSession(entry, "release"); }} />
      <ConversationTimeline controller={controller} selected={state.selected} entry={entry} items={items} queue={queue}
        feedback={conversationFeedback} loading={state.loading} catalogFresh={state.catalogFresh}
        allowed={allowed} pending={pending} busy={busy} emptyTitle={accessAppearance.emptyTitle}
        emptyDescription={accessAppearance.emptyDescription} />
      <Composer controller={controller} selected={state.selected} draft={draft} attachments={attachments}
        allowed={allowed} pending={pending} busy={busy} sending={isSelectedOperation(state, "send")}
        queueRunning={queue?.running === true} placeholder={accessAppearance.draftPlaceholder}
        restriction={accessAppearance.composerRestriction} />
  </WorkbenchShell>;
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
