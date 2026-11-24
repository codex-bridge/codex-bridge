import type { Bot, Context } from "grammy";
import { resolve } from "node:path";
import { ManagedAttachmentStorage, imageMimeType, type AttachmentUploadFile } from "../bridge/input/attachment-storage.js";
import { cleanupManagedAttachments } from "../bridge/input/attachment-files.js";

export class TelegramAttachmentError extends Error { readonly name = "TelegramAttachmentError"; }

const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const telegramAttachmentRoot = () => resolve(process.env.TELEGRAM_ATTACHMENT_DIR?.trim() || "workspaces/telegram-attachments");
export const cleanupTelegramAttachments = () => cleanupManagedAttachments(telegramAttachmentRoot());

export function telegramImageStorage(root = telegramAttachmentRoot()): ManagedAttachmentStorage {
  return new ManagedAttachmentStorage(root, { label: "Telegram", source: "telegram", kind: "image", maxFiles: 10,
    maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: 25 * 1024 * 1024,
    validate: file => imageMimeType(file.bytes) === file.mimeType });
}

/** URL contains the bot token: do not log fetch errors, URLs or response bodies. */
export async function downloadTelegramImages(bot: Bot, contexts: Context[], fetchFile: typeof fetch = fetch): Promise<AttachmentUploadFile[]> {
  if (contexts.length > 10) throw new TelegramAttachmentError("At most 10 images can be sent together.");
  const files: AttachmentUploadFile[] = [];
  let total = 0;
  for (const ctx of contexts) {
    const message = ctx.message!;
    const photo = message.photo?.at(-1), document = message.document;
    if (!photo && (!document || !document.mime_type?.startsWith("image/"))) throw new TelegramAttachmentError("Only JPEG, PNG, WebP and GIF image attachments are supported.");
    const input = photo ?? document!;
    if (input.file_size && input.file_size > MAX_FILE_BYTES) throw new TelegramAttachmentError("Image exceeds the 10 MiB limit.");
    const file = await bot.api.getFile(input.file_id).catch(() => { throw new TelegramAttachmentError("Telegram could not retrieve this attachment. Check file availability and the Bridge network connection."); });
    if (!file.file_path) throw new TelegramAttachmentError("Telegram could not provide this attachment.");
    if (file.file_size && file.file_size > MAX_FILE_BYTES) throw new TelegramAttachmentError("Image exceeds the 10 MiB limit.");
    const response = await fetchFile(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(30_000), redirect: "error"
    }).catch(() => { throw new TelegramAttachmentError("Telegram attachment download failed. Check the Bridge host's network connection."); });
    if (!response.ok) { await response.body?.cancel(); throw new TelegramAttachmentError(`Telegram attachment download failed (HTTP ${response.status}).`); }
    const reader = response.body?.getReader();
    if (!reader) throw new TelegramAttachmentError("Telegram returned an empty attachment.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length; total += value.length;
        if (size > MAX_FILE_BYTES || total > 25 * 1024 * 1024) throw new TelegramAttachmentError("Telegram image size limit exceeded.");
        chunks.push(value);
      }
    } catch { await reader.cancel().catch(() => {}); throw new TelegramAttachmentError("Telegram attachment download failed or exceeded the size limit."); }
    const bytes = Buffer.concat(chunks);
    const mimeType = imageMimeType(bytes);
    if (!mimeType) throw new TelegramAttachmentError("Unsupported or invalid image. Send JPEG, PNG, WebP or GIF.");
    files.push({ bytes, mimeType, sizeBytes: size, name: document?.file_name ?? `photo-${message.message_id}.jpg` });
  }
  return files;
}
