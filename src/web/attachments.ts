import crypto from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import {
  attachmentRetentionMs,
  cleanupManagedAttachments,
  markManagedAttachmentPathsStatus,
  type ManagedAttachmentStatus
} from "../bridge/input/attachment-files.js";
import type { IncomingAttachment } from "../bridge/input/payload.js";
import {
  WEB_ATTACHMENT_MAX_FILES,
  WEB_ATTACHMENT_MAX_FILE_BYTES,
  WEB_ATTACHMENT_MAX_REQUEST_BYTES,
  WEB_ATTACHMENT_MAX_TOTAL_BYTES,
  isWebImageMimeType
} from "./protocol-limits.js";

export { WEB_ATTACHMENT_MAX_FILES, WEB_ATTACHMENT_MAX_FILE_BYTES, WEB_ATTACHMENT_MAX_REQUEST_BYTES,
  WEB_ATTACHMENT_MAX_TOTAL_BYTES };

export type WebUploadFile = {
  bytes: Uint8Array;
  mimeType: string | null;
  name: string;
  sizeBytes: number;
};

function beginsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function isSupportedWebImage(file: Pick<WebUploadFile, "bytes" | "mimeType">): boolean {
  const mimeType = file.mimeType?.trim().toLowerCase();
  if (!isWebImageMimeType(mimeType)) return false;
  if (mimeType === "image/png") return beginsWith(file.bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === "image/jpeg") return beginsWith(file.bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") return beginsWith(file.bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (file.bytes[4] === 0x37 || file.bytes[4] === 0x39) && file.bytes[5] === 0x61;
  return beginsWith(file.bytes, [0x52, 0x49, 0x46, 0x46]) && beginsWith(file.bytes.slice(8), [0x57, 0x45, 0x42, 0x50]);
}

export function getWebAttachmentStorageRoot(): string {
  return resolve(process.env.WEB_ATTACHMENT_DIR?.trim() || "workspaces/web-attachments");
}

export function sanitizeWebFileName(name: string, fallback = "attachment"): string {
  const sanitized = (name.trim() || fallback)
    .replace(/[/\\]/g, "-")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return sanitized || fallback;
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class WebAttachmentStorage {
  constructor(private readonly root = getWebAttachmentStorageRoot()) {}

  async save(files: WebUploadFile[], context: {
    requestId: string;
    sessionId: string;
    status: ManagedAttachmentStatus;
  }): Promise<IncomingAttachment[]> {
    if (!files.length || files.length > WEB_ATTACHMENT_MAX_FILES) throw new Error("Invalid Web attachment count.");
    const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > WEB_ATTACHMENT_MAX_TOTAL_BYTES || files.some((file) =>
      file.sizeBytes < 1 || file.sizeBytes > WEB_ATTACHMENT_MAX_FILE_BYTES || file.bytes.byteLength !== file.sizeBytes ||
      !isSupportedWebImage(file))) {
      throw new Error("Invalid Web attachment.");
    }
    const createdAt = new Date();
    const directory = join(this.root, localDate(createdAt));
    await mkdir(directory, { recursive: true });
    const written: string[] = [];
    try {
      const result: IncomingAttachment[] = [];
      for (const file of files) {
        const name = sanitizeWebFileName(file.name);
        const path = join(directory, `${crypto.randomUUID()}-${name}`);
        await writeFile(path, file.bytes, { flag: "wx" });
        written.push(path);
        const expiresAt = new Date(createdAt.getTime() + attachmentRetentionMs(context.status)).toISOString();
        await writeFile(`${path}.json`, `${JSON.stringify({
          source: "web",
          createdAt: createdAt.toISOString(),
          expiresAt,
          localPath: path,
          mimeType: file.mimeType,
          originalName: name,
          requestId: context.requestId,
          sessionId: context.sessionId,
          sizeBytes: file.sizeBytes,
          status: context.status
        }, null, 2)}\n`, { flag: "wx" });
        result.push({
          kind: "image",
          localPath: path,
          mimeType: file.mimeType,
          name,
          sizeBytes: file.sizeBytes
        });
      }
      return result;
    } catch (error) {
      await Promise.all(written.flatMap((path) => [unlink(path).catch(() => undefined), unlink(`${path}.json`).catch(() => undefined)]));
      throw error;
    }
  }

  mark(paths: string[], status: ManagedAttachmentStatus): Promise<void> {
    return markManagedAttachmentPathsStatus(paths, status);
  }
}

export function cleanupWebAttachments(root = getWebAttachmentStorageRoot(), now = Date.now()) {
  return cleanupManagedAttachments(root, now);
}
