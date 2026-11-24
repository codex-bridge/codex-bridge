import crypto from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentRetentionMs, markManagedAttachmentPathsStatus, type ManagedAttachmentStatus } from "./attachment-files.js";
import type { IncomingAttachment } from "./payload.js";

export type AttachmentStoragePolicy = {
  label: string; source: string; kind: IncomingAttachment["kind"];
  maxFiles: number; maxFileBytes: number; maxTotalBytes: number;
  validate: (file: AttachmentUploadFile) => boolean;
};

export function imageMimeType(bytes: Uint8Array): string | null {
  const begins = (values: number[], at = 0) => values.every((value, index) => bytes[at + index] === value);
  if (begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (begins([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (begins([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (begins([0x52, 0x49, 0x46, 0x46]) && begins([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export type AttachmentUploadFile = {
  bytes: Uint8Array;
  mimeType: string | null;
  name: string;
  sizeBytes: number;
};

export function sanitizeAttachmentFileName(name: string, fallback = "attachment"): string {
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

export class ManagedAttachmentStorage {
  constructor(private readonly root: string, private readonly policy: AttachmentStoragePolicy) {}

  async save(files: AttachmentUploadFile[], context: {
    requestId: string;
    sessionId: string;
    status: ManagedAttachmentStatus;
  }): Promise<IncomingAttachment[]> {
    if (!files.length || files.length > this.policy.maxFiles) throw new Error(`Invalid ${this.policy.label} attachment count.`);
    const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (total > this.policy.maxTotalBytes || files.some((file) =>
      file.sizeBytes < 1 || file.sizeBytes > this.policy.maxFileBytes || file.bytes.byteLength !== file.sizeBytes ||
      !this.policy.validate(file))) {
      throw new Error(`Invalid ${this.policy.label} attachment.`);
    }
    const createdAt = new Date();
    const directory = join(this.root, localDate(createdAt));
    await mkdir(directory, { recursive: true });
    const written: string[] = [];
    try {
      const result: IncomingAttachment[] = [];
      for (const file of files) {
        const name = sanitizeAttachmentFileName(file.name);
        const path = join(directory, `${crypto.randomUUID()}-${name}`);
        await writeFile(path, file.bytes, { flag: "wx" });
        written.push(path);
        const expiresAt = new Date(createdAt.getTime() + attachmentRetentionMs(context.status)).toISOString();
        await writeFile(`${path}.json`, `${JSON.stringify({
          source: this.policy.source,
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
          kind: this.policy.kind,
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

