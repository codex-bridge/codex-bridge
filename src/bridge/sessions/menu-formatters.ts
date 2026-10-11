import crypto from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { SessionRecord } from "../../shared/types.js";
import {
  formatRelativeTime,
  formatSessionLabel,
  formatSessionMarker,
  formatSessionTitle
} from "../../shared/session-tag.js";

export type DirectoryMenuLabelInput = {
  directoryKey: string;
  sectionCount: number;
  activityAt: number;
};

export function getSessionDirectory(session: SessionRecord): string {
  return session.currentCwd ?? session.pathKey;
}

export function getSessionTitle(session: SessionRecord): string {
  return formatSessionTitle(session.displayName, getSessionDirectory(session));
}

export function hashDirectoryKey(directoryKey: string): string {
  return crypto.createHash("sha256").update(directoryKey).digest("base64url").slice(0, 12);
}

export function formatDirectoryMenuLabel(group: DirectoryMenuLabelInput): string {
  const sectionLabel = group.sectionCount === 1 ? "1 section" : `${group.sectionCount} sections`;
  return `${formatSessionMarker(group.directoryKey)} · ${sectionLabel} · u ${formatRelativeTime(group.activityAt)}`;
}

export function formatCompactDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", {
    month: "short",
    timeZone: "Asia/Shanghai"
  });
  const day = date.toLocaleString("en-US", {
    day: "2-digit",
    timeZone: "Asia/Shanghai"
  });
  return `${month}${day}`;
}

export function formatCompactDateTime(timestamp: number): string {
  const datePart = formatCompactDate(timestamp);
  const timePart = new Date(timestamp).toLocaleString("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: "Asia/Shanghai"
  });
  return `${datePart} ${timePart}`;
}

export function formatSessionMenuLabel(
  session: SessionRecord,
  options?: { activityTimes?: Map<string, number>; includeProviderStatus?: boolean }
): string {
  const activityAt = options?.activityTimes?.get(session.id) ?? session.latestActivityAt;
  const label = formatSessionLabel(
    session.displayName,
    getSessionDirectory(session),
    activityAt,
    session.createdAt
  );

  return options?.includeProviderStatus ? `${label} · a` : label;
}

export function sortSessionsByMenuActivity(
  sessions: SessionRecord[],
  activityTimes: Map<string, number>
): SessionRecord[] {
  return [...sessions].sort((left, right) => {
    const leftActivityAt = activityTimes.get(left.id) ?? left.latestActivityAt;
    const rightActivityAt = activityTimes.get(right.id) ?? right.latestActivityAt;
    return rightActivityAt - leftActivityAt;
  });
}

export function formatNewSessionDisplayName(directory: string): string {
  const projectName = basename(directory) || directory;
  const date = new Date();
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${projectName} ${year}-${month}-${day} ${hours}:${minutes}`;
}

export function expandHomeDirectory(value: string): string {
  return value === "~" || value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
}

export function normalizeDirectoryCandidate(value: string): string {
  return resolve(expandHomeDirectory(value.trim()));
}

export function pickDirectory(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (value.startsWith("/") && !value.includes("/.codex/sessions/")) {
      return value;
    }
  }
  return values.find((value): value is string => Boolean(value)) ?? null;
}
