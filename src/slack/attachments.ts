import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../logging/logger.js";
import {
  ATTACHMENT_PENDING_RETENTION_MS,
  ATTACHMENT_SENT_RETENTION_MS,
  cleanupManagedAttachments,
  markManagedAttachmentPathsStatus
} from "../bridge/input/attachment-files.js";

export type SlackFile = {
  filetype?: string;
  id?: string;
  mimetype?: string;
  name?: string;
  size?: number;
  title?: string;
  url_private?: string;
  url_private_download?: string;
};

export type SlackAttachmentKind = "audio" | "image";

type AttachmentFailurePhase = "network" | "http" | "storage";

export class SlackAttachmentDownloadError extends Error {
  constructor(readonly phase: AttachmentFailurePhase, readonly fileId: string, readonly httpStatus: number | null,
    options?: ErrorOptions) {
    super(httpStatus === null ? `Slack attachment ${phase} operation failed.` : `Slack attachment download returned HTTP ${httpStatus}.`, options);
    this.name = "SlackAttachmentDownloadError";
  }
}

function attachmentErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const current = error as { code?: unknown; cause?: unknown };
    if (typeof current.code === "string" && /^[A-Z0-9_]{1,64}$/.test(current.code)) return current.code;
    error = current.cause;
  }
  return null;
}

/** Public diagnostics only: never expose private URLs, authorization headers or raw response bodies. */
export function describeSlackAttachmentFailure(error: unknown): {
  message: string;
  diagnostics: { phase: AttachmentFailurePhase | "unknown"; fileId: string | null; httpStatus: number | null; causeCode: string | null };
} {
  const failure = error instanceof SlackAttachmentDownloadError ? error : null;
  const code = attachmentErrorCode(error);
  const status = failure?.httpStatus ?? null;
  let message = "Attachment download failed. Check the Bridge logs for details.";
  if (failure?.phase === "network") {
    message = `Attachment download failed: network error${code ? ` (${code})` : ""}. Check the Bridge host's connection to Slack's file service.`;
  } else if (failure?.phase === "storage") {
    message = `The attachment was downloaded, but Bridge could not finish saving it locally${code ? ` (${code})` : ""}. Check local storage and file permissions.`;
  } else if (failure?.phase === "http") {
    if (status === 401 || status === 403) {
      message = `Slack rejected the attachment download (HTTP ${status}). Check the bot token and file access.`;
    } else if (status === 404 || status === 410) {
      message = `Slack could not provide this attachment (HTTP ${status}). Check whether the file is still available to this bot.`;
    } else if (status === 429) {
      message = "Slack rate-limited the attachment download (HTTP 429). Try again later.";
    } else {
      message = `Attachment download failed: Slack returned HTTP ${status}.`;
    }
  }
  return { message, diagnostics: { phase: failure?.phase ?? "unknown", fileId: failure?.fileId ?? null, httpStatus: status, causeCode: code } };
}

export type SlackDownloadedAttachment = {
  createdAt: string;
  expiresAt: string;
  id: string;
  kind: SlackAttachmentKind;
  mimeType: string | null;
  name: string;
  path: string;
  size: number;
};

export type SlackAttachmentMetadata = {
  chatId: string | null;
  createdAt: string;
  expiresAt: string;
  kind: SlackAttachmentKind;
  localPath: string;
  messageId: string | null;
  mimeType: string | null;
  originalName: string;
  sizeBytes: number;
  slackFileId: string;
  status: "downloaded" | "queued" | "sent-to-codex" | "failed";
};

export const SLACK_ATTACHMENT_SENT_RETENTION_MS = ATTACHMENT_SENT_RETENTION_MS;
export const SLACK_ATTACHMENT_FAILED_RETENTION_MS = ATTACHMENT_PENDING_RETENTION_MS;
export const SLACK_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const SLACK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const SLACK_MAX_AUDIO_FILES_PER_MESSAGE = 3;
export const SLACK_MAX_IMAGE_FILES_PER_MESSAGE = 5;

export function classifySlackFile(file: Pick<SlackFile, "filetype" | "mimetype">): SlackAttachmentKind | null {
  const mimeType = file.mimetype?.toLowerCase() ?? "";
  const fileType = file.filetype?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/") || ["gif", "heic", "jpeg", "jpg", "png", "webp"].includes(fileType)) {
    return "image";
  }
  if (
    mimeType.startsWith("audio/") ||
    ["aac", "aiff", "amr", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba", "wma"].includes(fileType)
  ) {
    return "audio";
  }
  return null;
}

export function sanitizeSlackFileName(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim() || fallback;
  const sanitized = trimmed
    .replace(/[/\\]/g, "-")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return sanitized || fallback;
}

export function getSlackAttachmentStorageRoot(): string {
  return process.env.SLACK_ATTACHMENT_DIR?.trim() || "workspaces/slack-attachments";
}

export function formatLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildSlackAttachmentPath(
  file: SlackFile,
  index: number,
  createdAt: Date
): { dateDir: string; id: string; name: string; path: string } {
  const dateDir = formatLocalDate(createdAt);
  const id = sanitizeSlackFileName(file.id, `file-${index + 1}`);
  const name = sanitizeSlackFileName(file.name ?? file.title, "slack-file");
  return {
    dateDir,
    id,
    name,
    path: join(getSlackAttachmentStorageRoot(), dateDir, `${id}-${name}`)
  };
}

function retentionMsForStatus(status: SlackAttachmentMetadata["status"]): number {
  return status === "failed" || status === "queued" ? SLACK_ATTACHMENT_FAILED_RETENTION_MS : SLACK_ATTACHMENT_SENT_RETENTION_MS;
}

export async function markSlackAttachmentPathsStatus(
  paths: string[], status: SlackAttachmentMetadata["status"]
): Promise<void> {
  await markManagedAttachmentPathsStatus(paths, status);
}

export async function writeSlackAttachmentMetadata(
  attachment: SlackDownloadedAttachment,
  context: { chatId?: string | null; messageId?: string | null; status?: SlackAttachmentMetadata["status"] }
): Promise<void> {
  const status = context.status ?? "downloaded";
  const createdAtMs = Date.parse(attachment.createdAt);
  const expiresAt = new Date(createdAtMs + retentionMsForStatus(status)).toISOString();
  const metadata: SlackAttachmentMetadata = {
    chatId: context.chatId ?? null,
    createdAt: attachment.createdAt,
    expiresAt,
    kind: attachment.kind,
    localPath: attachment.path,
    messageId: context.messageId ?? null,
    mimeType: attachment.mimeType,
    originalName: attachment.name,
    sizeBytes: attachment.size,
    slackFileId: attachment.id,
    status
  };
  await writeFile(`${attachment.path}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
}

function checkAttachmentLimits(file: SlackFile, kind: SlackAttachmentKind): string | null {
  const size = file.size ?? 0;
  if (kind === "image" && size > SLACK_IMAGE_MAX_BYTES) {
    return `image file is larger than ${SLACK_IMAGE_MAX_BYTES} bytes`;
  }
  if (kind === "audio" && size > SLACK_AUDIO_MAX_BYTES) {
    return `audio file is larger than ${SLACK_AUDIO_MAX_BYTES} bytes`;
  }
  return null;
}

export async function downloadSlackAttachments(
  files: SlackFile[],
  botToken: string,
  context?: { chatId?: string | null; messageId?: string | null; receivedAt?: Date }
): Promise<SlackDownloadedAttachment[]> {
  const counters: Record<SlackAttachmentKind, number> = { audio: 0, image: 0 };
  const supported = files
    .map((file, index) => ({ file, index, kind: classifySlackFile(file) }))
    .filter((item): item is { file: SlackFile; index: number; kind: SlackAttachmentKind } => Boolean(item.kind))
    .filter(({ file, kind }) => {
      counters[kind] += 1;
      if (kind === "image" && counters[kind] > SLACK_MAX_IMAGE_FILES_PER_MESSAGE) {
        logger.warn("slack.attachment.skipped_limit", { fileId: file.id ?? null, kind });
        return false;
      }
      if (kind === "audio" && counters[kind] > SLACK_MAX_AUDIO_FILES_PER_MESSAGE) {
        logger.warn("slack.attachment.skipped_limit", { fileId: file.id ?? null, kind });
        return false;
      }
      const limitError = checkAttachmentLimits(file, kind);
      if (limitError) {
        logger.warn("slack.attachment.skipped_size", { error: limitError, fileId: file.id ?? null, kind });
        return false;
      }
      return true;
    });
  const downloaded: SlackDownloadedAttachment[] = [];
  const receivedAt = context?.receivedAt ?? new Date();
  for (const { file, index, kind } of supported) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      logger.warn("slack.attachment.skipped_missing_url", {
        fileId: file.id ?? null,
        filetype: file.filetype ?? null,
        kind,
        mimetype: file.mimetype ?? null
      });
      continue;
    }
    const target = buildSlackAttachmentPath(file, index, receivedAt);
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
    } catch (cause) {
      throw new SlackAttachmentDownloadError("network", target.id, null, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SlackAttachmentDownloadError("http", target.id, response.status);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      throw new SlackAttachmentDownloadError("network", target.id, null, { cause });
    }
    const attachment: SlackDownloadedAttachment = {
      createdAt: receivedAt.toISOString(),
      expiresAt: new Date(receivedAt.getTime() + SLACK_ATTACHMENT_SENT_RETENTION_MS).toISOString(),
      id: target.id,
      kind,
      mimeType: file.mimetype ?? null,
      name: target.name,
      path: target.path,
      size: file.size ?? bytes.length
    };
    try {
      await mkdir(join(getSlackAttachmentStorageRoot(), target.dateDir), { recursive: true });
      await writeFile(target.path, bytes);
      await writeSlackAttachmentMetadata(attachment, {
        chatId: context?.chatId,
        messageId: context?.messageId,
        status: "downloaded"
      });
    } catch (cause) {
      throw new SlackAttachmentDownloadError("storage", target.id, null, { cause });
    }
    downloaded.push(attachment);
  }
  return downloaded;
}

export async function cleanupSlackAttachments(root = getSlackAttachmentStorageRoot(), now = Date.now()): Promise<{
  deleted: number;
  scanned: number;
}> {
  return cleanupManagedAttachments(root, now);
}
