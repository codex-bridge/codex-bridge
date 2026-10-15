import { useState } from "react";
import { Button } from "./ui/button";
import { InfoHint } from "./info-hint";
import { ModalDialog } from "./modal-dialog";
import type { SessionEntry } from "../lib/protocol";
import type { WorkbenchFeedback, WorkbenchOperation } from "../lib/workbench";
import type { CatalogActions } from "../lib/catalog-actions";

export type SessionDialog =
  | { kind: "create"; directory: string }
  | { kind: "rename"; session: SessionEntry }
  | { kind: "archive"; session: SessionEntry };

export function AddDirectoryDialog({ onAddDirectory, busy, operation, feedback, onClose, onAdded }: {
  onAddDirectory: CatalogActions["addDirectory"];
  busy: boolean;
  operation: WorkbenchOperation | null;
  feedback: WorkbenchFeedback | null;
  onClose: () => void;
  onAdded: (directory: string) => void;
}) {
  const [path, setPath] = useState("");
  const [attempted, setAttempted] = useState(false);
  return <ModalDialog labelledBy="add-directory-title" closeDisabled={busy} onClose={onClose}>
    <div className="heading-with-hint"><h2 id="add-directory-title">Add directory</h2>
      <InfoHint label="Add directory help" text="Enter an existing directory path on the Bridge machine. This only adds navigation; it does not create a directory or session." /></div>
    <form onSubmit={(event) => {
      event.preventDefault();
      setAttempted(true);
      void onAddDirectory(path).then((receipt) => {
        if (!receipt) return;
        onAdded(receipt.directory);
      });
    }}>
      <label htmlFor="directory-path">Directory path</label>
      <input id="directory-path" className="input" data-autofocus value={path} maxLength={4096}
        onChange={(event) => setPath(event.target.value)} placeholder="/Users/name/project" />
      {attempted && feedback && <p role="alert" className="error">{feedback.message}</p>}
      <div className="dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !path.trim()}>{operation?.kind === "directory" ? "Adding…" : "Add"}</Button></div>
    </form>
  </ModalDialog>;
}

export function SessionManagementDialog({ onConfirm, busy, operation, dialog, onClose }: {
  onConfirm: (name: string) => Promise<boolean>;
  busy: boolean;
  operation: WorkbenchOperation | null;
  dialog: SessionDialog;
  onClose: () => void;
}) {
  const [name, setName] = useState(dialog.kind === "rename" ? dialog.session.name ?? "" : "");
  const title = dialog.kind === "create" ? "New session" : dialog.kind === "rename" ? "Rename session" : "Archive session";
  return <ModalDialog labelledBy="session-dialog-title" closeDisabled={busy} onClose={onClose}>
    <h2 id="session-dialog-title">{title}</h2>
    {dialog.kind === "create" && <p className="muted">A new Codex session will be created in <code>{dialog.directory}</code> without switching or interrupting other tasks.</p>}
    {dialog.kind === "archive" && <p className="muted">Conversation history is preserved and can be restored from Archived. A session cannot be archived while running, queued, or awaiting approval.</p>}
    {dialog.kind === "rename" && <label htmlFor="session-name">Name
      <input id="session-name" className="input" data-autofocus value={name} maxLength={48}
        onChange={(event) => setName(event.target.value)} /></label>}
    <div className="dialog-actions"><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button disabled={busy || (dialog.kind === "rename" && !name.trim())} onClick={() => {
        void onConfirm(name).then((completed) => { if (completed) onClose(); });
      }}>{operation?.kind === "session-create" || operation?.kind === "session-manage" ? "Working…"
          : dialog.kind === "archive" ? "Archive" : "Confirm"}</Button></div>
  </ModalDialog>;
}
