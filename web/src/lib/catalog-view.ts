import type { Catalog, SessionEntry } from "./protocol";

export type CatalogMode = "active" | "archived";

export type CatalogDirectoryGroup = {
  directory: string;
  sessions: SessionEntry[];
  open: boolean;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestamp(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function compareSessions(left: SessionEntry, right: SessionEntry): number {
  const leftActivity = timestamp(left.updatedAt);
  const rightActivity = timestamp(right.updatedAt);
  if (leftActivity !== rightActivity) return leftActivity > rightActivity ? -1 : 1;
  const byName = compareText(left.name ?? "", right.name ?? "");
  return byName || compareText(left.threadId, right.threadId);
}

function latestActivity(sessions: SessionEntry[]): number {
  return sessions.reduce((latest, session) => Math.max(latest, timestamp(session.updatedAt)), Number.NEGATIVE_INFINITY);
}

export function buildCatalogGroups(catalog: Catalog, input: {
  mode: CatalogMode;
  query: string;
}): CatalogDirectoryGroup[] {
  const archived = input.mode === "archived";
  const query = input.query.trim().toLowerCase();
  const modeSessions = catalog.sessions.filter((session) => session.archived === archived);
  const sessions = modeSessions.filter((session) => !query ||
    `${session.directory} ${session.name ?? ""} ${session.threadId}`.toLowerCase().includes(query));
  const baseDirectories = archived
    ? [...new Set(modeSessions.map((session) => session.directory))]
    : [...new Set([...catalog.directories, ...modeSessions.map((session) => session.directory)])];
  const directories = baseDirectories.filter((directory) => !query || directory.toLowerCase().includes(query) ||
    sessions.some((session) => session.directory === directory));

  return directories.map((directory) => ({
    directory,
    sessions: sessions.filter((session) => session.directory === directory).sort(compareSessions),
    open: !archived && modeSessions.some((session) => session.directory === directory && session.connection === "active")
  })).sort((left, right) => {
    if (left.open !== right.open) return left.open ? -1 : 1;
    if (!!left.sessions.length !== !!right.sessions.length) return left.sessions.length ? -1 : 1;
    const leftActivity = latestActivity(left.sessions);
    const rightActivity = latestActivity(right.sessions);
    if (leftActivity !== rightActivity) return leftActivity > rightActivity ? -1 : 1;
    return compareText(left.directory, right.directory);
  });
}
