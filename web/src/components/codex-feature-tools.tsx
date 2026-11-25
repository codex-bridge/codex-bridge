import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelProviderCatalog, RealtimeHistoryPage } from "../lib/protocol";
import { ModalDialog } from "./modal-dialog";
import { Button } from "./ui/button";
import { ToolIcon } from "./icons";
import { InfoHint } from "./info-hint";

export type CodexFeatureToolsPort = {
  providers: (signal?: AbortSignal) => Promise<ModelProviderCatalog>;
  setProvider: (providerId: string) => Promise<void>;
  realtime: (cursor?: string, snapshotEnd?: number, signal?: AbortSignal) => Promise<RealtimeHistoryPage>;
};

export function CodexFeatureTools({ port, canReadRealtime, disabled }: { port: CodexFeatureToolsPort; canReadRealtime: boolean; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <><Button variant="ghost" aria-label="Codex settings and realtime history" title="Codex tools" disabled={disabled}
    onClick={() => setOpen(true)}><ToolIcon /></Button>
    {open && createPortal(<FeatureDialog port={port} canReadRealtime={canReadRealtime} onClose={() => setOpen(false)} />, document.body)}</>;
}

function FeatureDialog({ port, canReadRealtime, onClose }: { port: CodexFeatureToolsPort; canReadRealtime: boolean; onClose: () => void }) {
  const [catalog, setCatalog] = useState<ModelProviderCatalog | null>(null), [selected, setSelected] = useState("");
  const [history, setHistory] = useState<RealtimeHistoryPage | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { if (!canReadRealtime) setHistory(null); }, [canReadRealtime]);
  useEffect(() => {
    const controller = new AbortController();
    void port.providers(controller.signal).then(result => { if (!controller.signal.aborted) { setCatalog(result); setSelected(result.defaultProviderId); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Provider read failed."); });
    return () => controller.abort();
  }, [port]);
  const readHistory = async (next = false) => {
    setBusy(true); setError("");
    try {
      const result = await port.realtime(next ? history?.nextCursor ?? undefined : undefined, next ? history?.snapshotEnd : undefined);
      setHistory(previous => next && previous ? { ...result, data: [...previous.data, ...result.data] } : result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Realtime history read failed."); }
    finally { setBusy(false); }
  };
  return <ModalDialog labelledBy="codex-tools-title" onClose={onClose} closeDisabled={busy}>
    <h2 id="codex-tools-title">Codex tools</h2>
    <div className="heading-with-hint"><label htmlFor="default-provider">Default provider</label>
      <InfoHint label="Default provider scope" text="Updates Codex's global configuration. The next turn reads the latest model and settings. Existing sessions keep Codex's provider compatibility checks; the current turn is not interrupted." /></div>
    {catalog ? <><select id="default-provider" className="input" value={selected} disabled={busy || !catalog.canChangeDefault}
      onChange={event => setSelected(event.target.value)}>{catalog.data.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>
      <Button disabled={busy || !catalog.canChangeDefault || selected === catalog.defaultProviderId} onClick={() => {
        setBusy(true); setError(""); setNotice("");
        void port.setProvider(selected).then(async () => { setNotice("Default provider updated."); setCatalog(await port.providers()); })
          .catch(reason => setError(`${reason instanceof Error ? reason.message : "Provider update result is unknown."} Check settings before trying again.`))
          .finally(() => setBusy(false));
      }}>Save default</Button></> : !error && <p role="status" className="muted">Loading providers…</p>}
    <div className="heading-with-hint"><h3>Realtime history</h3><InfoHint label="Realtime history help" text="Reads existing voice transcripts for the acquired session. It does not start a call or record audio." /></div>
    <Button variant="ghost" disabled={busy || !canReadRealtime} onClick={() => { void readHistory(); }}>Read realtime history</Button>
    {history && canReadRealtime && <><p className="muted">{history.coverage === "ready" ? history.data.length ? "" : "No realtime history." : `History ${history.coverage}.`}</p>
      {history.data.map(entry => <p className="codex-feature-result" key={entry.id}>{entry.text !== null ? `${entry.role ?? "Transcript"}: ${entry.text}` : entry.type}</p>)}
      {history.nextCursor && <Button variant="ghost" disabled={busy || !canReadRealtime} onClick={() => { void readHistory(true); }}>Load more</Button>}</>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><Button data-autofocus variant="ghost" disabled={busy} onClick={onClose}>Close</Button></div>
  </ModalDialog>;
}
