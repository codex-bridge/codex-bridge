import { useEffect, useRef, type ReactNode } from "react";

const focusable = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function ModalDialog({ labelledBy, closeDisabled = false, variant = "dialog", onClose, children }: {
  labelledBy: string;
  variant?: "dialog" | "drawer";
  closeDisabled?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.current;
    const target = root?.querySelector<HTMLElement>("[data-autofocus]")
      ?? root?.querySelector<HTMLElement>(focusable)
      ?? root;
    target?.focus();
    return () => { restore?.focus(); };
  }, []);

  return <div className="dialog-backdrop" data-variant={variant} onMouseDown={(event) => {
    if (event.target === event.currentTarget && !closeDisabled) onClose();
  }}><section ref={dialog} className="directory-dialog" data-variant={variant} role="dialog" aria-modal="true"
    aria-labelledby={labelledBy} tabIndex={-1} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!closeDisabled) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>(focusable) ?? [])]
        .filter((element) => element.getClientRects().length > 0);
      if (!elements.length) { event.preventDefault(); dialog.current?.focus(); return; }
      const first = elements[0]!;
      const last = elements.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>{children}</section></div>;
}
