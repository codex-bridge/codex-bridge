import { useId } from "react";
import { connectionLabels } from "../lib/connection-labels";
import type { SessionEntry } from "../lib/protocol";
import type { WorkbenchFeedback, WorkbenchState } from "../lib/workbench";
import { ModalDialog } from "./modal-dialog";
import { SessionBindingActions, type SessionBindingActionsProps } from "./session-binding-actions";
import { Button } from "./ui/button";

export type SessionDetailsProps = SessionBindingActionsProps & {
  selected: string;
  entry?: SessionEntry;
  connection: WorkbenchState["connection"];
  catalogFresh: boolean;
  feedback: WorkbenchFeedback | null;
  onRelease: () => void;
  onClose: () => void;
};

export function SessionDetails({ selected, entry, connection, catalogFresh, feedback, controls,
  onBind, onRelease, onClose }: SessionDetailsProps) {
  const titleId = useId();
  const fresh = connection === "connected" && catalogFresh;
  return <ModalDialog labelledBy={titleId} variant="drawer" onClose={onClose}>
    <div className="session-details">
      <div className="session-details-heading"><h2 id={titleId}>Session details</h2>
        <Button variant="ghost" aria-label="Close session details" onClick={onClose}>Close</Button></div>
      {!entry ? <p role="status">This session is temporarily unavailable.</p>
        : !fresh && <p role="status" className="muted">Session information is last reported and may be stale.</p>}
      <dl>
        <dt>Thread ID</dt><dd>{selected}</dd>
        <dt>Codex session ID</dt><dd>{entry?.sessionId ?? "Unknown"}</dd>
        <dt>Directory</dt><dd>{entry?.directory ?? "Unknown"}</dd>
        <dt>Provider</dt><dd>{entry?.provider ?? "Unknown"}</dd>
        <dt>Service connection</dt><dd>{connectionLabels[connection]}</dd>
        <dt>Codex connection</dt><dd>{!fresh || !entry ? "Unknown"
          : entry.connection === "active" ? "Loaded" : entry.connection === "inactive" ? "Not loaded" : "Unknown"}</dd>
        <dt>Archived</dt><dd>{entry ? entry.archived ? "Yes" : "No" : "Unknown"}</dd>
        <dt>Owner</dt><dd>{entry?.ownership ? entry.ownership.ownerSourceId ?? "Unbound" : "Unknown"}</dd>
        <dt>Ownership state</dt><dd>{entry?.ownership?.state ?? "Unknown"}</dd>
        <dt>Waiting source</dt><dd>{entry?.ownership ? entry.ownership.pendingSourceId ?? "None" : "Unknown"}</dd>
      </dl>
      {feedback && <p role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p>}
      <div className="session-details-actions"><SessionBindingActions controls={controls} onBind={onBind} />
        {controls.showRelease && <Button variant="outline" disabled={!controls.releaseEnabled}
          title={controls.releaseEnabled ? "Release Bridge ownership so external Codex can use the session"
            : "Available only when connected and idle with no queue, approval, or pending handoff"}
          onClick={onRelease}>Release to external Codex</Button>}</div>
    </div>
  </ModalDialog>;
}
