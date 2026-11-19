import { Button } from "./ui/button";
import type { WebActionSpec } from "../lib/protocol";

export function MessageActions({ actions, enabled, busy, onAction }: {
  actions: WebActionSpec[];
  enabled: boolean;
  busy: boolean;
  onAction: (action: WebActionSpec) => void;
}) {
  if (!actions.length) return null;
  const groups = new Map<string, { label?: string; actions: WebActionSpec[] }>();
  for (const action of actions) {
    const reply = action.execution.type === "send-text" ? action.execution.reply : undefined;
    const key = reply?.questionId ?? action.group ?? "";
    const group = groups.get(key) ?? { label: action.group, actions: [] };
    group.actions.push(action); groups.set(key, group);
  }
  return <div className="message-action-groups">{[...groups].map(([key, group]) => <div key={key}>
    {group.label && <p className="message-action-label">{group.label}</p>}
    <div className="message-actions" aria-label={group.label ?? "Message actions"}>{group.actions.map((action) =>
      <Button key={action.id} type="button" variant={action.style === "danger" ? "destructive" : "outline"}
        disabled={!enabled || busy} onClick={() => onAction(action)}>{action.label}</Button>)}</div>
  </div>)}</div>;
}
