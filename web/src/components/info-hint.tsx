import { useEffect, useId, useRef, useState } from "react";
import { InfoIcon } from "./icons";

export function InfoHint({ text, label = "Help" }: { text: string; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <span ref={root} className="info-hint" data-open={open ? "true" : "false"}
    onMouseEnter={() => setOpen(true)}
    onMouseLeave={() => {
      if (!root.current?.contains(document.activeElement)) setOpen(false);
    }}>
    <button ref={trigger} type="button" className="info-hint-trigger" aria-label={label} aria-describedby={id}
      aria-expanded={open} onFocus={() => setOpen(true)} onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget)) setOpen(false);
      }} onClick={() => setOpen(true)}><InfoIcon /></button>
    <span id={id} className="info-hint-content" role="tooltip">{text}</span>
  </span>;
}
