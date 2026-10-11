import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";

type Rect = { top: number; right: number; bottom: number; left: number; width: number; height: number };
export type PopoverPosition = { top: number; left: number; placement: "top" | "bottom" };

export function placePopover(anchor: Rect, panel: Pick<Rect, "width" | "height">,
  viewport: { width: number; height: number }, gap = 8, margin = 8): PopoverPosition {
  const availableBelow = viewport.height - anchor.bottom - margin;
  const availableAbove = anchor.top - margin;
  const placement = availableBelow < panel.height && availableAbove > availableBelow ? "top" : "bottom";
  const desiredTop = placement === "top" ? anchor.top - panel.height - gap : anchor.bottom + gap;
  const maxTop = Math.max(margin, viewport.height - panel.height - margin);
  const maxLeft = Math.max(margin, viewport.width - panel.width - margin);
  return {
    top: Math.min(Math.max(desiredTop, margin), maxTop),
    left: Math.min(Math.max(anchor.right - panel.width, margin), maxLeft),
    placement
  };
}

const focusable = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export type DismissiblePopoverProps = {
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  label: string;
  title?: string;
  children: ReactNode;
  trigger: ReactNode;
};

export function DismissiblePopover({ className, triggerClassName, panelClassName, label, title, children,
  trigger }: DismissiblePopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const panelId = useId();
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPosition(placePopover(anchor, panel, { width: window.innerWidth, height: window.innerHeight }));
    };
    const frame = window.requestAnimationFrame(updatePosition);
    const dismiss = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        restoreFocus.current = false;
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      restoreFocus.current = true;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
      if (restoreFocus.current && triggerRef.current?.isConnected) triggerRef.current.focus();
      restoreFocus.current = false;
      setPosition(null);
    };
  }, [open]);

  return <div className={className}>
    <button id={triggerId} ref={triggerRef} type="button" className={triggerClassName} aria-label={label} title={title}
      aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => {
        restoreFocus.current = open;
        setOpen((value) => !value);
      }} onKeyDown={(event) => {
        if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
        event.preventDefault();
        const items = panelRef.current?.querySelectorAll<HTMLElement>(focusable);
        (event.key === "ArrowDown" ? items?.[0] : items?.[items.length - 1])?.focus();
      }}>{trigger}</button>
    {open && createPortal(<div ref={panelRef} id={panelId} aria-labelledby={triggerId}
      data-placement={position?.placement} className={cn("dismissible-popover-panel", panelClassName)}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? "visible" : "hidden" }}
      onClickCapture={(event) => {
        const target = event.target as Element;
        if (target.closest("button:not(:disabled)")) {
          restoreFocus.current = true;
          setOpen(false);
        }
      }}>{children}</div>, document.body)}
  </div>;
}
