import type { QueueSnapshot } from "../lib/protocol";
import { Button } from "./ui/button";

export type QueuePanelProps = {
  queue?: QueueSnapshot;
  allowed: boolean;
  busy: boolean;
  onCancel: (id: string) => void;
};

export function QueuePanel({ queue, allowed, busy, onCancel }: QueuePanelProps) {
  if (!queue || (!queue.running && !queue.entries.length)) return null;
  return <section className="queue-panel" aria-label="Queued messages">
    <div className="queue-heading"><h3>Queued messages</h3><span className="muted">{queue.entries.length}</span></div>
    {!queue.entries.length && <p className="muted">A turn is running. You can add the draft to the queue.</p>}
    {!!queue.entries.length && <ol>{queue.entries.map((item, index) => <li key={item.id}>
      <div><span className="queue-index">{index + 1}</span><span>{item.summary}</span><span className="muted">{item.state}</span></div>
      <Button variant="ghost" disabled={!allowed || busy || item.state !== "queued"}
        onClick={() => onCancel(item.id)}>Cancel</Button>
    </li>)}</ol>}
  </section>;
}
