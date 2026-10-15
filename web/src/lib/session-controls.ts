import { isOwned } from "./protocol";
import { canInteract, isBusy, isSelectedOperation, selectedEntry, type WorkbenchState } from "./workbench";

export type SessionControls = ReturnType<typeof sessionControls>;

/** Shared presentation permissions; the controller and server remain authoritative. */
export function sessionControls(state: WorkbenchState) {
  const entry = selectedEntry(state);
  const owned = isOwned(entry);
  const available = state.connection === "connected" && state.catalogFresh && !isBusy(state);
  const toolsEnabled = canInteract(state) && !isBusy(state);
  const running = entry ? state.queues[entry.threadId]?.running === true : false;
  return {
    showTools: owned,
    toolsEnabled,
    compactEnabled: toolsEnabled && !running,
    showInterrupt: owned && running,
    showBind: !!entry && !owned,
    bindEnabled: !!entry && !entry.archived && available,
    bindLabel: isSelectedOperation(state, "binding") ? "Working…"
      : entry?.ownership?.pendingSourceId === "web:local" ? "Request again" : "Bind session",
    showCancel: entry?.ownership?.pendingSourceId === "web:local",
    cancelEnabled: !!entry && !entry.archived && available,
    showRelease: !!entry && !entry.archived,
    releaseEnabled: owned && available && entry?.capabilities?.releaseToCodex === true
  };
}
