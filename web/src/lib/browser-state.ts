import type { Grant } from "./protocol";

export interface SessionLocation {
  read(): string | null;
  write(threadId: string | null): void;
  subscribe(listener: () => void): () => void;
}

/** URLs identify a session, never a permission or a connection credential. */
export class BrowserSessionLocation implements SessionLocation {
  constructor(private readonly browser: Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">) {}
  read(): string | null { return new URL(this.browser.location.href).searchParams.get("session") || null; }
  write(threadId: string | null): void {
    if (this.read() === threadId) return;
    const url = new URL(this.browser.location.href);
    if (threadId) url.searchParams.set("session", threadId);
    else url.searchParams.delete("session");
    this.browser.history.pushState(null, "", url);
  }
  subscribe(listener: () => void): () => void {
    this.browser.addEventListener("popstate", listener);
    return () => this.browser.removeEventListener("popstate", listener);
  }
}

export interface WindowGrantStore {
  take(): Grant | null;
  save(grant: Grant): void;
  clear(): void;
}
const GRANT_KEY = "codex-bridge:web-window:v1";

/** Tab-scoped only. Consume before rotation; an uncertain result must not be retried. */
export class TabWindowGrantStore implements WindowGrantStore {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}
  take(): Grant | null {
    try {
      const raw = this.storage.getItem(GRANT_KEY);
      this.storage.removeItem(GRANT_KEY);
      if (!raw || raw.length > 1024) return null;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") return null;
      const grant = value as Partial<Grant>;
      return typeof grant.windowId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(grant.windowId) &&
        typeof grant.token === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(grant.token)
        ? { windowId: grant.windowId, token: grant.token } : null;
    } catch { return null; }
  }
  save(grant: Grant): void {
    try { this.storage.setItem(GRANT_KEY, JSON.stringify({ windowId: grant.windowId, token: grant.token })); }
    catch { this.clear(); }
  }
  clear(): void { try { this.storage.removeItem(GRANT_KEY); } catch { /* Storage is optional. */ } }
}
