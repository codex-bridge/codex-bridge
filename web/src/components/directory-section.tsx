import type { ReactNode } from "react";
import { directoryLabel } from "../lib/directory-label";
import { PlusIcon } from "./icons";
import { Button } from "./ui/button";

export type DirectorySectionProps = {
  directory: string;
  open: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCreate?: () => void;
  createDisabled: boolean;
  children: ReactNode;
};

export function DirectorySection({ directory, open, expanded, onToggle, onCreate, createDisabled, children }: DirectorySectionProps) {
  const label = directoryLabel(directory);
  return <section className="directory" data-open={open ? "true" : "false"} data-expanded={expanded ? "true" : "false"}>
    <div className="directory-heading">
      <button type="button" className="directory-toggle" title={directory} aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} directory ${directory}`} onClick={onToggle}>
        <span className="directory-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="directory-label"><span className="directory-name">{label.name}</span>
          {label.parent && <span className="directory-parent">{label.parent}</span>}</span>
      </button>
      {onCreate && <Button className="directory-create" variant="ghost" aria-label={`Create a session in ${directory}`} title="New session"
        disabled={createDisabled} onClick={onCreate}><PlusIcon /></Button>}
    </div>
    {expanded && <div className="directory-sessions">{children}</div>}
  </section>;
}
