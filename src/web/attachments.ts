import { resolve } from "node:path";
import { ManagedAttachmentStorage, imageMimeType, sanitizeAttachmentFileName, type AttachmentUploadFile } from "../bridge/input/attachment-storage.js";
import { cleanupManagedAttachments } from "../bridge/input/attachment-files.js";
import { WEB_ATTACHMENT_MAX_FILES, WEB_ATTACHMENT_MAX_FILE_BYTES, WEB_ATTACHMENT_MAX_REQUEST_BYTES,
  WEB_ATTACHMENT_MAX_TOTAL_BYTES, isWebImageMimeType } from "./protocol-limits.js";

export { WEB_ATTACHMENT_MAX_FILES, WEB_ATTACHMENT_MAX_FILE_BYTES, WEB_ATTACHMENT_MAX_REQUEST_BYTES, WEB_ATTACHMENT_MAX_TOTAL_BYTES };
export type WebUploadFile = AttachmentUploadFile;
export const sanitizeWebFileName = sanitizeAttachmentFileName;
export function isSupportedWebImage(file: Pick<WebUploadFile, "bytes" | "mimeType">): boolean {
  return isWebImageMimeType(file.mimeType) && imageMimeType(file.bytes) === file.mimeType?.trim().toLowerCase();
}
export function getWebAttachmentStorageRoot(): string {
  return resolve(process.env.WEB_ATTACHMENT_DIR?.trim() || "workspaces/web-attachments");
}
export class WebAttachmentStorage extends ManagedAttachmentStorage {
  constructor(root = getWebAttachmentStorageRoot()) {
    super(root, { label: "Web", source: "web", kind: "image", maxFiles: WEB_ATTACHMENT_MAX_FILES,
      maxFileBytes: WEB_ATTACHMENT_MAX_FILE_BYTES, maxTotalBytes: WEB_ATTACHMENT_MAX_TOTAL_BYTES, validate: isSupportedWebImage });
  }
}
export function cleanupWebAttachments(root = getWebAttachmentStorageRoot(), now = Date.now()) {
  return cleanupManagedAttachments(root, now);
}
