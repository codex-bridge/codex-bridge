import type { WebAttentionEvent } from "../../../src/web/attention-protocol";
export type { WebAttentionEvent };

export interface NotificationPlatform {
  unavailable: string | null;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  show(event: WebAttentionEvent, isCurrent: () => boolean): Promise<(() => void) | null>;
  onOpen?: (threadId: string) => void;
  dispose?: () => void;
}
export type NotificationState = { enabled: boolean; permission: NotificationPermission; unavailable: string | null;
  busy: boolean; error: string | null };
const PREFERENCE_KEY = "codex-bridge:notifications:v1";
const LIMIT = 512;

/** Live-only policy. Historical messages, text formatting and SSE reconnection do not drive notifications. */
export class WebNotifications {
  private readonly listeners = new Set<() => void>();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, { sessionId: string; cancelled: boolean; close?: () => void }>();
  private state: NotificationState;
  private disposed = false;
  private preference = false;

  constructor(private readonly platform: NotificationPlatform, private readonly background: () => boolean,
    private readonly storage?: Pick<Storage, "getItem" | "setItem">) {
    try { this.preference = storage?.getItem(PREFERENCE_KEY) === "true"; } catch { /* Storage is optional. */ }
    this.state = { enabled: this.preference && platform.permission() === "granted", permission: platform.permission(),
      unavailable: platform.unavailable, busy: false, error: null };
  }
  getSnapshot = (): NotificationState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onOpen(listener: (threadId: string) => void): void { this.platform.onOpen = listener; }
  private update(patch: Partial<NotificationState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  refreshPermission(): void {
    const permission = this.platform.permission();
    this.update({ permission, enabled: this.preference && permission === "granted" });
    if (permission !== "granted") this.clear();
  }
  async toggle(): Promise<void> {
    if (this.disposed || this.state.busy || this.state.unavailable) return;
    if (this.state.enabled) {
      this.preference = false;
      this.clear();
      this.update({ enabled: false, error: null });
    } else {
      this.update({ busy: true, error: null });
      try {
        // Called directly from the button: preserve the user gesture for browser permission.
        const permission = await this.platform.requestPermission();
        if (this.disposed) return;
        this.preference = permission === "granted";
        this.update({ enabled: this.preference, permission });
      } catch {
        this.update({ error: "Could not enable notifications. Check HTTPS trust and the browser's site settings." });
      } finally { this.update({ busy: false }); }
    }
    try { this.storage?.setItem(PREFERENCE_KEY, String(this.preference)); } catch { /* Storage is optional. */ }
  }
  async notify(event: WebAttentionEvent, isCurrent: () => boolean): Promise<void> {
    if (this.disposed || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > LIMIT) this.seen.delete(this.seen.values().next().value!);
    if (this.state.unavailable || !this.state.enabled || this.platform.permission() !== "granted" || !this.background() || !isCurrent()) return;
    const pending = { sessionId: event.sessionId, cancelled: false } as { sessionId: string; cancelled: boolean; close?: () => void };
    this.pending.set(event.id, pending);
    if (this.pending.size > LIMIT) this.dismiss(this.pending.keys().next().value!);
    const current = (): boolean => !this.disposed && !pending.cancelled && this.state.enabled &&
      this.platform.permission() === "granted" && this.background() && isCurrent();
    try {
      pending.close = await this.platform.show(event, current) ?? undefined;
      if (!current()) { pending.close?.(); this.pending.delete(event.id); }
    } catch {
      this.pending.delete(event.id);
      this.update({ error: "Notification delivery failed. Re-enable notifications to try again." });
    }
  }
  private dismiss(id: string): void {
    const pending = this.pending.get(id);
    if (pending) { pending.cancelled = true; pending.close?.(); this.pending.delete(id); }
  }
  withdrawSession(sessionId: string): void {
    for (const [id, pending] of this.pending) if (pending.sessionId === sessionId) this.dismiss(id);
  }
  clear(): void { for (const id of this.pending.keys()) this.dismiss(id); }
  dispose(): void { this.disposed = true; this.clear(); this.platform.onOpen = undefined; this.platform.dispose?.(); this.listeners.clear(); }
}

const LABELS: Record<WebAttentionEvent["kind"], string> = {
  "turn-ended": "Turn ended", "turn-failed": "Execution stopped", "approval-required": "Approval needed",
  "input-required": "Input needed", "binding-acquired": "Session ready"
};

/** A notification-only worker: no push subscription, background connection or offline cache. */
export class BrowserNotificationPlatform implements NotificationPlatform {
  readonly unavailable: string | null;
  onOpen?: (threadId: string) => void;
  private registration?: Promise<{ registration: ServiceWorkerRegistration; clientId: string }>;
  private readonly handleOpen = (event: MessageEvent): void => {
    if (event.origin === this.browser.location.origin && event.data?.type === "bridge-notification-open" &&
      typeof event.data.threadId === "string") this.onOpen?.(event.data.threadId);
  };
  constructor(private readonly browser: Window, private readonly navigator: Navigator) {
    this.unavailable = !browser.isSecureContext ? "Notifications require HTTPS with a trusted certificate."
      : !("Notification" in browser) || !("serviceWorker" in navigator) ? "Notifications are not supported in this browser." : null;
    navigator.serviceWorker?.addEventListener("message", this.handleOpen);
  }
  dispose(): void { this.navigator.serviceWorker?.removeEventListener("message", this.handleOpen); }
  permission(): NotificationPermission { return typeof Notification === "undefined" ? "denied" : Notification.permission; }
  async requestPermission(): Promise<NotificationPermission> {
    const permission = await Notification.requestPermission();
    if (permission === "granted") await this.prepare();
    return permission;
  }
  private prepare(): Promise<{ registration: ServiceWorkerRegistration; clientId: string }> {
    return this.registration ??= (async () => {
      await this.navigator.serviceWorker.register("/notifications-worker.js", { scope: "/", updateViaCache: "none" });
      const registration = await this.navigator.serviceWorker.ready;
      const clientId = await new Promise<string>((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error("Notification worker did not respond.")); }, 5000);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          clearTimeout(timer); channel.port1.close();
          if (typeof event.data === "string") resolve(event.data); else reject(new Error("Invalid notification client."));
        };
        registration.active?.postMessage({ type: "bridge-notification-client" }, [channel.port2]);
      });
      return { registration, clientId };
    })().catch((error: unknown) => { this.registration = undefined; throw error; });
  }
  async show(event: WebAttentionEvent, isCurrent: () => boolean): Promise<(() => void) | null> {
    const { registration, clientId } = await this.prepare();
    if (!isCurrent()) return null;
    await registration.showNotification(`${LABELS[event.kind]} · ${event.name || "Codex Bridge"}`, {
      body: event.directory, tag: event.id,
      data: { clientId, threadId: event.threadId }
    });
    return () => { void registration.getNotifications({ tag: event.id }).then((items) => {
      for (const item of items) item.close();
    }).catch(() => {}); };
  }
}
