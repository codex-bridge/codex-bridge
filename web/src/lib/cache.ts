import type { MessageSpec } from "./protocol";
import type { TimelineItem } from "./timeline";

export interface TimelineCache {
  load(threadId: string, sessionId: string): TimelineItem[];
  save(threadId: string, sessionId: string, items: TimelineItem[]): void;
}
type StoredSession = { threadId: string; sessionId: string; savedAt: number; items: TimelineItem[] };
// v1 conflated lifecycle status with assistant dialogue. Keep its bytes for
// recovery, but never guess message semantics from titles or text when loading.
const KEY = "codex-bridge:timeline:v2";
const MAX_SESSIONS = 20, MAX_ITEMS = 100, MAX_BYTES = 512 * 1024, TTL = 7 * 24 * 60 * 60 * 1000;
const kinds = new Set(["user", "codex", "progress", "failed", "called", "edited", "working", "mcp", "subagent", "compact-started", "compact-completed"]);

/** Only historical text is persisted. No credentials, callbacks, permissions or decisions. */
function sanitize(item: unknown): TimelineItem | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Partial<TimelineItem>, message = value.message;
  if (typeof value.id !== "string" || value.id.length > 200 || !message || !kinds.has(message.kind) || message.decision ||
      typeof message.title !== "string" || !Array.isArray(message.body) ||
      ["sending", "unknown", "refused"].includes(value.deliveryStatus ?? "")) return null;
  const body: MessageSpec["body"] = [];
  let length = 0;
  for (const part of message.body.slice(0, 30)) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "field" && typeof part.label === "string" && typeof part.value === "string") {
      body.push({ type: "field", label: part.label.slice(0, 200), value: part.value.slice(0, 12000) });
      length += part.label.length + part.value.length;
    } else if (["text", "markdown", "code", "heading"].includes(part.type) && "text" in part && typeof part.text === "string") {
      body.push({ type: part.type as "text" | "markdown" | "code" | "heading", text: part.text.slice(0, 12000) });
      length += part.text.length;
    }
    if (length > 24000) return null;
  }
  if (!body.length) return null;
  return { id: value.id, origin: "cache", message: { kind: message.kind, title: message.title.slice(0, 300), body, actions: [] } };
}
export class LocalTimelineCache implements TimelineCache {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly now: () => number = Date.now) {}
  private read(): StoredSession[] {
    const raw = this.storage.getItem(KEY);
    if (!raw) return [];
    if (new TextEncoder().encode(raw).length > MAX_BYTES) { this.storage.removeItem(KEY); return []; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { this.storage.removeItem(KEY); return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: Partial<StoredSession>) => {
      if (!entry || typeof entry.threadId !== "string" || typeof entry.sessionId !== "string" ||
          typeof entry.savedAt !== "number" || !Number.isFinite(entry.savedAt) || entry.savedAt > this.now() ||
          this.now() - entry.savedAt > TTL || !Array.isArray(entry.items)) return [];
      return [{ threadId: entry.threadId.slice(0, 200), sessionId: entry.sessionId.slice(0, 200), savedAt: entry.savedAt,
        items: entry.items.slice(-MAX_ITEMS).flatMap((item) => { const safe = sanitize(item); return safe ? [safe] : []; }) }];
    }).slice(-MAX_SESSIONS);
  }
  load(threadId: string, sessionId: string): TimelineItem[] {
    try {
      const entries = this.read(); this.storage.setItem(KEY, JSON.stringify(entries));
      return entries.find((entry) => entry.threadId === threadId && entry.sessionId === sessionId)?.items ?? [];
    }
    catch { return []; }
  }
  save(threadId: string, sessionId: string, items: TimelineItem[]): void {
    try {
      const entries = this.read().filter((entry) => entry.threadId !== threadId);
      const safe = items.slice(-MAX_ITEMS).flatMap((item) => {
        // Restored user/assistant dialogue is useful, but never save in-flight sends.
        const result = sanitize(item); return result ? [result] : [];
      });
      if (safe.length) entries.push({ threadId, sessionId, savedAt: this.now(), items: safe });
      let limited = entries.slice(-MAX_SESSIONS);
      while (new TextEncoder().encode(JSON.stringify(limited)).length > MAX_BYTES) {
        if (limited.length > 1) limited = limited.slice(1);
        else if (limited[0]?.items.length) limited[0].items.shift();
        else break;
      }
      this.storage.setItem(KEY, JSON.stringify(limited));
    } catch { /* Storage disabled/full/corrupt: live conversation remains usable. */ }
  }
}
