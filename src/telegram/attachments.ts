import type { Bot, Context } from "grammy";
import { resolve } from "node:path";
import { ManagedAttachmentStorage, imageMimeType, type AttachmentUploadFile } from "../bridge/input/attachment-storage.js";
import { cleanupManagedAttachments } from "../bridge/input/attachment-files.js";

export class TelegramAttachmentError extends Error { readonly name = "TelegramAttachmentError"; }

export function telegramMediaKind(ctx: Context): "image" | "audio" | null {
  if (ctx.message?.photo || ctx.message?.document?.mime_type?.startsWith("image/")) return "image";
  if (ctx.message?.voice || ctx.message?.audio || ctx.message?.document?.mime_type?.startsWith("audio/")) return "audio";
  return null;
}

export function audioMimeType(bytes: Uint8Array): string | null {
  const starts = (value: string, at = 0) => [...value].every((character, index) => bytes[at + index] === character.charCodeAt(0));
  if (starts("OggS")) return "audio/ogg";
  if (starts("RIFF") && starts("WAVE", 8)) return "audio/wav";
  if (starts("fLaC")) return "audio/flac";
  if (starts("ftyp", 4)) return "audio/mp4";
  if ([0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)) return "audio/webm";
  if (starts("ID3") || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const telegramAttachmentRoot = () => resolve(process.env.TELEGRAM_ATTACHMENT_DIR?.trim() || "workspaces/telegram-attachments");
export const cleanupTelegramAttachments = () => cleanupManagedAttachments(telegramAttachmentRoot());

export function telegramImageStorage(root = telegramAttachmentRoot()): ManagedAttachmentStorage {
  return telegramMediaStorage("image", root);
}

export function telegramMediaStorage(kind: "image" | "audio", root = telegramAttachmentRoot()): ManagedAttachmentStorage {
  return new ManagedAttachmentStorage(root, { label: "Telegram", source: "telegram", kind, maxFiles: kind === "image" ? 10 : 3,
    maxFileBytes: kind === "image" ? IMAGE_MAX_BYTES : AUDIO_MAX_BYTES, maxTotalBytes: 25 * 1024 * 1024,
    validate: file => (kind === "image" ? imageMimeType(file.bytes) : audioMimeType(file.bytes)) === file.mimeType });
}

/** URL contains the bot token: do not log fetch errors, URLs or response bodies. */
export async function downloadTelegramImages(bot: Bot, contexts: Context[], fetchFile: typeof fetch = fetch): Promise<AttachmentUploadFile[]> {
  return downloadTelegramMedia(bot, contexts, "image", fetchFile);
}

export async function downloadTelegramMedia(bot: Bot, contexts: Context[], kind: "image" | "audio", fetchFile: typeof fetch = fetch): Promise<AttachmentUploadFile[]> {
  const maxFiles = kind === "image" ? 10 : 3, maxBytes = kind === "image" ? IMAGE_MAX_BYTES : AUDIO_MAX_BYTES;
  if (contexts.length > maxFiles) throw new TelegramAttachmentError(`At most ${maxFiles} ${kind} files can be sent together.`);
  const files: AttachmentUploadFile[] = [];
  let total = 0;
  for (const ctx of contexts) {
    const message = ctx.message!;
    const photo = message.photo?.at(-1), document = message.document;
    const audio = message.voice ?? message.audio ?? (document?.mime_type?.startsWith("audio/") ? document : undefined);
    const input = kind === "image" ? photo ?? (document?.mime_type?.startsWith("image/") ? document : undefined) : audio;
    if (!input) throw new TelegramAttachmentError("Only JPEG, PNG, WebP, GIF images or supported audio attachments are accepted.");
    if (input.file_size && input.file_size > maxBytes) throw new TelegramAttachmentError(`${kind} exceeds the ${maxBytes / 1024 / 1024} MiB limit.`);
    const file = await bot.api.getFile(input.file_id).catch(() => { throw new TelegramAttachmentError("Telegram could not retrieve this attachment. Check file availability and the Bridge network connection."); });
    if (!file.file_path) throw new TelegramAttachmentError("Telegram could not provide this attachment.");
    if (file.file_size && file.file_size > maxBytes) throw new TelegramAttachmentError(`${kind} exceeds the ${maxBytes / 1024 / 1024} MiB limit.`);
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
        if (size > maxBytes || total > 25 * 1024 * 1024) throw new TelegramAttachmentError("Telegram media size limit exceeded.");
        chunks.push(value);
      }
    } catch { await reader.cancel().catch(() => {}); throw new TelegramAttachmentError("Telegram attachment download failed or exceeded the size limit."); }
    const bytes = Buffer.concat(chunks);
    const mimeType = kind === "image" ? imageMimeType(bytes) : audioMimeType(bytes);
    if (!mimeType) throw new TelegramAttachmentError(`Unsupported or invalid ${kind} file.`);
    files.push({ bytes, mimeType, sizeBytes: size, name: document?.file_name ?? message.audio?.file_name ?? `${kind}-${message.message_id}.${mimeType.split("/")[1] === "mpeg" ? "mp3" : mimeType.split("/")[1]}` });
  }
  return files;
}
