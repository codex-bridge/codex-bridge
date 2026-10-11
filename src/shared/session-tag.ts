function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function isPathLike(text: string): boolean {
  return text.startsWith("/") || text.includes("\\");
}

export function formatSessionMarker(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }

  const tail = parts.slice(-2).join("/");
  return `.../${tail}`;
}

export function formatRelativeTime(timestamp: number): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const deltaMinutes = Math.max(1, Math.floor(deltaMs / 60_000));

  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function formatCompactDate(timestamp: number): string {
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

export function formatSessionLabel(
  displayName: string | null,
  path: string,
  latestActivityAt: number,
  createdAt?: number
): string {
  const title = formatSessionTitle(displayName, path);
  const created = createdAt ? ` · c ${formatCompactDate(createdAt)}` : "";
  return `${title} · u ${formatRelativeTime(latestActivityAt)}${created}`;
}

export function formatSessionTitle(
  displayName: string | null,
  path: string
): string {
  const preferred = displayName?.split("\n")[0]?.trim();
  if (preferred) {
    return isPathLike(preferred) ? formatSessionMarker(preferred) : truncate(preferred, 48);
  }

  return formatSessionMarker(path);
}
