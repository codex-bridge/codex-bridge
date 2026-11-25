import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadSearchPage, ThreadSearchResult } from "../lib/protocol";
import { ModalDialog } from "./modal-dialog";
import { Button } from "./ui/button";

export type SessionHistorySearchPort = {
  search: (query: string, archived: boolean, cursor: string | undefined, signal: AbortSignal,
    partial: (rows: ThreadSearchResult[]) => void) => Promise<ThreadSearchPage>;
  select: (threadId: string) => void;
};

export function SessionHistorySearch({ query, archived, port, onClose }: {
  query: string; archived: boolean; port: SessionHistorySearchPort; onClose: () => void;
}) {
  const [rows, setRows] = useState<ThreadSearchResult[]>([]), [page, setPage] = useState<ThreadSearchPage | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const run = useCallback(async (cursor?: string) => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(""); setRows([]); setPage(null);
    try {
      const result = await port.search(query, archived, cursor, controller.signal, partial => {
        if (controller.signal.aborted) return;
        setRows(previous => [...new Map([...previous, ...partial].map(row => [row.threadId, row])).values()]);
      });
      if (!controller.signal.aborted) { setRows(result.data); setPage(result); }
    } catch (reason) {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Search failed."); setRows([]); }
    } finally { if (active.current === controller) setBusy(false); }
  }, [query, archived, port]);
  useEffect(() => { void run(); return () => active.current?.abort(); }, [run]);
  return <ModalDialog labelledBy="history-search-title" onClose={onClose}>
    <h2 id="history-search-title">Search {archived ? "archived " : ""}conversations</h2>
    <p>{query}</p>
    {busy && <p className="muted" role="status">Searching…</p>}
    {error && <p role="alert">{error}</p>}
    {!busy && !error && rows.length === 0 && <p className="muted">No matching conversations.</p>}
    {rows.map(row => <div className="codex-feature-result" key={row.threadId}>
      <Button variant="ghost" onClick={() => { port.select(row.threadId); onClose(); }}>{row.name ?? row.threadId.slice(0, 8)}</Button>
      <p className="muted">{row.directory}</p><p>{row.snippet}</p>
    </div>)}
    <div className="dialog-actions">
      {busy && <Button variant="ghost" onClick={() => { active.current?.abort(); setBusy(false); setRows([]); }}>Cancel search</Button>}
      {error && <Button variant="ghost" onClick={() => { void run(); }}>Retry</Button>}
      {page?.nextCursor && <Button variant="ghost" onClick={() => { void run(page.nextCursor!); }}>Next page</Button>}
      <Button variant="ghost" onClick={onClose}>Close</Button>
    </div>
  </ModalDialog>;
}
