import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../../logging/logger.js";

export type ManagedAttachmentStatus = "downloaded" | "queued" | "sent-to-codex" | "failed";

export const ATTACHMENT_SENT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function attachmentRetentionMs(status: ManagedAttachmentStatus): number {
  return status === "sent-to-codex" ? ATTACHMENT_SENT_RETENTION_MS : ATTACHMENT_PENDING_RETENTION_MS;
}

export async function markManagedAttachmentPathsStatus(
  paths: string[], status: ManagedAttachmentStatus
): Promise<void> {
  await Promise.all(paths.map(async (localPath) => {
    const metadataPath = `${localPath}.json`;
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      metadata.status = status;
      metadata.expiresAt = new Date(Date.now() + attachmentRetentionMs(status)).toISOString();
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    } catch (error) {
      logger.warn("attachment.status_update_failed", { localPath, status, error: String(error) });
    }
  }));
}

export async function cleanupManagedAttachments(root: string, now = Date.now()): Promise<{
  deleted: number;
  scanned: number;
}> {
  let deleted = 0;
  let scanned = 0;
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      const path = join(directory, entry);
      const metadata = await stat(path).catch(() => null);
      if (!metadata) continue;
      if (metadata.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!path.endsWith(".json")) continue;
      scanned += 1;
      const raw = await readFile(path, "utf8").catch(() => null);
      if (!raw) continue;
      let parsed: { expiresAt?: unknown; localPath?: unknown };
      try {
        parsed = JSON.parse(raw) as { expiresAt?: unknown; localPath?: unknown };
      } catch {
        logger.warn("attachment.cleanup_invalid_metadata", { path });
        continue;
      }
      const expiresAt = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt > now || typeof parsed.localPath !== "string") continue;
      await unlink(parsed.localPath).catch(() => undefined);
      await unlink(path).catch(() => undefined);
      deleted += 1;
    }
  }
  await walk(root);
  return { deleted, scanned };
}
