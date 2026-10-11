import { Button } from "./ui/button";
import type { WebActionSpec } from "../lib/protocol";

export function MessageActions({ actions, enabled, busy, onAction }: {
  actions: WebActionSpec[];
  enabled: boolean;
  busy: boolean;
  onAction: (action: WebActionSpec) => void;
}) {
  if (!actions.length) return null;
  return <div className="message-actions" aria-label="Message actions">{actions.map((action) =>
    <Button key={action.id} type="button" variant={action.style === "danger" ? "destructive" : "outline"}
      disabled={!enabled || busy} onClick={() => onAction(action)}>{action.label}</Button>)}</div>;
}
