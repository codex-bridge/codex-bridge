export type DirectoryLabel = {
  name: string;
  parent: string | null;
};

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed || path.slice(0, 1) || path;
}

export function directoryLabel(path: string): DirectoryLabel {
  const normalized = trimTrailingSeparators(path).replaceAll("\\", "/");
  if (normalized === "/") return { name: "/", parent: null };

  const parts = normalized.split("/").filter(Boolean);
  const name = parts.at(-1) ?? normalized;
  const parentParts = parts.slice(0, -1);
  if (!parentParts.length) return { name, parent: null };

  const absolute = normalized.startsWith("/");
  const parent = parentParts.length <= 2
    ? `${absolute ? "/" : ""}${parentParts.join("/")}`
    : `…/${parentParts.slice(-2).join("/")}`;
  return { name, parent };
}
