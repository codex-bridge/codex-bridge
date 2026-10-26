import { useState } from "react";
import { decisionAppearance } from "../lib/decision-appearance";
import type { MessageSpec } from "../lib/protocol";
import { Button } from "./ui/button";
import { AutoSizeTextarea } from "./ui/auto-size-textarea";

const labels: Record<string, string> = { accept: "Approve once", acceptForSession: "Approve for session", decline: "Reject", cancel: "Cancel" };
const variants = { accept: "default", acceptForSession: "outline", decline: "destructive", cancel: "ghost" } as const;
export function DecisionCard({ message, current, enabled, busy, onAction }: { message: MessageSpec; current: boolean; enabled: boolean; busy: boolean;
  onAction: (id: string, action: string, content?: Record<string, unknown>) => Promise<void> }) {
  const decision = message.decision!;
  const [input, setInput] = useState("{}"), [error, setError] = useState<string | null>(null);
  const actions = decision.availableActions.filter((action) => action in labels);
  const appearance = decisionAppearance(decision, { current, enabled, busy });
  const disabled = !!appearance.unavailable || !!decision.unavailableReason;
  const noControls = appearance.open && !actions.length && !decision.inputAllowed;
  const helpId = `decision-help-${decision.id}`, errorId = `decision-error-${decision.id}`;
  return <section className="decision-card" data-open={appearance.open} data-tone={appearance.tone} aria-label={`Approval status: ${appearance.label}`}>
    <div className="decision-status-line">
      <strong className="decision-status" role="status">{appearance.label}</strong>
      <p>{appearance.guidance}</p>
    </div>
    {(appearance.unavailable || noControls) && <p className="decision-unavailable">{appearance.unavailable ?? "No actions are available. Refresh the status."}</p>}
    {appearance.open && decision.inputAllowed && <form className="decision-input" onSubmit={(event) => {
      event.preventDefault(); setError(null);
      try {
        const parsed: unknown = JSON.parse(input);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enter a JSON object, not an array or plain text.");
        if (decision.requestedFields.some((field) => !Object.hasOwn(parsed, field))) throw new Error("Include every required field listed below.");
        void onAction(decision.id, "submit", parsed as Record<string, unknown>);
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Invalid JSON."); }
    }}>
      <div className="decision-input-heading">
        <label htmlFor={`input-${decision.id}`}>MCP input</label>
        <span>JSON object</span>
      </div>
      <p className="decision-input-help" id={helpId}>Required fields: {decision.requestedFields.length
        ? decision.requestedFields.map((field) => <code key={field}>{field}</code>)
        : "none"}</p>
      <AutoSizeTextarea id={`input-${decision.id}`} className="json-input" value={input} maxLength={6000} disabled={disabled}
        aria-describedby={`${helpId} ${errorId}`} aria-invalid={!!error}
        onChange={(event) => { setInput(event.target.value); setError(null); }} spellCheck={false} />
      <p id={errorId} role={error ? "alert" : undefined} className="decision-input-error">{error ?? ""}</p>
      <div className="decision-input-footer"><Button type="submit" disabled={disabled}>Submit input</Button></div>
    </form>}
    {appearance.open && !!actions.length && <div className="decision-actions" aria-label="Approval actions">{actions.map((action) => <Button key={action}
      variant={variants[action as keyof typeof variants]} disabled={disabled}
      onClick={() => { void onAction(decision.id, action); }}>{labels[action]}</Button>)}</div>}
  </section>;
}
