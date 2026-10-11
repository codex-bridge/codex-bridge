import type { SessionRecord } from "../../shared/types.js";

export type SectionMenuEntry = {
  session: SessionRecord;
  activityAt: number;
};

export type DirectoryMenuGroup = {
  directoryKey: string;
  hash: string;
  sectionCount: number;
  activityAt: number;
  entries: SectionMenuEntry[];
};

export type SessionDirectoryMenuSnapshot = {
  discoveredCount: number;
  hiddenCount: number;
  groups: DirectoryMenuGroup[];
  expiresAt: number;
};

export type SessionMenuSnapshotCacheDependencies = {
  ttlMs?: number;
  now?: () => number;
};

export class SessionMenuSnapshotCache {
  private readonly snapshots = new Map<string, SessionDirectoryMenuSnapshot>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(deps: SessionMenuSnapshotCacheDependencies = {}) {
    this.ttlMs = deps.ttlMs ?? 60_000;
    this.now = deps.now ?? Date.now;
  }

  getFresh(chatId: string): SessionDirectoryMenuSnapshot | null {
    const snapshot = this.snapshots.get(chatId);
    return snapshot && snapshot.expiresAt > this.now() ? snapshot : null;
  }

  set(chatId: string, snapshot: Omit<SessionDirectoryMenuSnapshot, "expiresAt">): SessionDirectoryMenuSnapshot {
    const stored = { ...snapshot, expiresAt: this.now() + this.ttlMs };
    this.snapshots.set(chatId, stored);
    return stored;
  }

  clear(): void {
    this.snapshots.clear();
  }
}
