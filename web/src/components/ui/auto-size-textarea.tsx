import { useCallback, useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/utils";

export type AutoSizeTextareaProps = Omit<ComponentPropsWithoutRef<"textarea">, "value" | "defaultValue"> & {
  value: string;
};

/** Native, controlled textarea. CSS owns the minimum and maximum heights. */
export function AutoSizeTextarea({ value, className, rows = 2, ...props }: AutoSizeTextareaProps) {
  const element = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const textarea = element.current;
    if (!textarea) return;
    const style = getComputedStyle(textarea);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const scrollTop = textarea.scrollTop;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight + border}px`;
    textarea.scrollTop = scrollTop;
  }, []);

  useLayoutEffect(resize, [value, resize]);
  useLayoutEffect(() => {
    const textarea = element.current;
    if (!textarea) return;
    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    observer.observe(textarea);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    document.fonts.addEventListener("loadingdone", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      document.fonts.removeEventListener("loadingdone", resize);
    };
  }, [resize]);

  return <textarea {...props} ref={element} value={value} rows={rows}
    className={cn("input auto-size-textarea", className)} />;
}
