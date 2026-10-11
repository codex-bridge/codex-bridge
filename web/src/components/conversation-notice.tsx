import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export function ConversationNoticeArea({ children }: { children: ReactNode }) {
  return <div className="conversation-notice-area" aria-live="polite">{children}</div>;
}

export function ConversationNotice({ children, title, tone = "neutral", variant = "context", alert = false }: {
  children?: ReactNode;
  title?: ReactNode;
  tone?: "neutral" | "warning" | "error";
  variant?: "context" | "status";
  alert?: boolean;
}) {
  return <section role={alert ? "alert" : undefined}
    className={cn("conversation-notice", variant === "status" && "conversation-notice-status", tone === "error" && "error")}
    data-tone={tone}>
    {title && <h2>{title}</h2>}
    {children && <p>{children}</p>}
  </section>;
}
