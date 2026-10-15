import { useState } from "react";
import type { SessionTool } from "../lib/protocol";
import { DismissiblePopover } from "./dismissible-popover";
import { InfoHint } from "./info-hint";
import { InfoIcon, ToolIcon } from "./icons";
import { SessionBindingActions } from "./session-binding-actions";
import { SessionDetails, type SessionDetailsProps } from "./session-details";
import { Button } from "./ui/button";

export type SessionHeaderProps = Omit<SessionDetailsProps, "selected" | "onClose"> & {
  selected: string | null;
  onTool: (tool: SessionTool) => void;
};

export function SessionHeader({ selected, entry, controls, onTool, onBind, ...details }: SessionHeaderProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return <>
    <header className="toolbar">
      <div className="session-title">
        {(entry?.directory ?? selected) && <p className="muted truncate" title={entry?.directory ?? selected ?? undefined}>{entry?.directory ?? selected}</p>}
        <div className="heading-with-hint">
        <h2>{entry?.name ?? (entry ? "Untitled session" : selected ? "Locate session" : "Select a session")}</h2>
        {!entry && !selected && <InfoHint text="Selecting only changes the current view. It does not bind the session or interrupt a running task."
          label="Session selection help" />}</div></div>
      <div className="toolbar-actions">
        {controls.showTools && <DismissiblePopover className="tool-menu" triggerClassName="tool-menu-trigger"
          panelClassName="tool-menu-panel" label="Session tools" title="Session tools" trigger={<ToolIcon />}><div>
          <Button variant="ghost" disabled={!controls.toolsEnabled} onClick={() => onTool("help")}>Help</Button>
          <Button variant="ghost" disabled={!controls.toolsEnabled} onClick={() => onTool("status")}>Status</Button>
          <Button variant="ghost" disabled={!controls.compactEnabled} onClick={() => onTool("compact")}>Compact</Button>
        </div></DismissiblePopover>}
        {controls.showInterrupt && <Button variant="destructive" disabled={!controls.toolsEnabled}
          onClick={() => onTool("interrupt")}>Interrupt</Button>}
        <SessionBindingActions controls={controls} onBind={onBind} />
        {selected && <Button variant="ghost" aria-label="Session details" title="Session details"
          aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)}><InfoIcon /></Button>}
      </div>
    </header>
    {detailsOpen && selected && <SessionDetails {...details} selected={selected} entry={entry}
      controls={controls} onBind={onBind} onClose={() => setDetailsOpen(false)} />}
  </>;
}
