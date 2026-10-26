import { useEffect, useSyncExternalStore } from "react";
import type { WebNotifications } from "../lib/notifications";
import { Button } from "./ui/button";
import { BellIcon } from "./icons";

export type NotificationControlProps = { notifications: WebNotifications };
export function NotificationControl({ notifications }: NotificationControlProps) {
  const state = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, notifications.getSnapshot);
  useEffect(() => {
    const refresh = () => notifications.refreshPermission();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [notifications]);
  const blocked = state.permission === "denied";
  const label = state.enabled ? "Disable notifications" : "Enable notifications";
  const help = state.unavailable ?? state.error ?? (blocked ? "Allow notifications in your browser's site settings."
    : state.enabled ? "Notifications on while this page is open in the background. Click to disable."
      : "Enable background notifications for replies, requests, stopped execution and pending session bindings.");
  return <Button className="notification-control catalog-action" variant="ghost" type="button"
    aria-label={label} aria-pressed={state.enabled} aria-disabled={!!state.unavailable || blocked || state.busy}
    title={help} data-enabled={state.enabled ? "true" : "false"} data-error={state.error ? "true" : "false"}
    onClick={() => { if (!blocked) void notifications.toggle(); }}><BellIcon /></Button>;
}
