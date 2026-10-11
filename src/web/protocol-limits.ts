export const WEB_REQUEST_BODY_LIMIT_BYTES = 8_192;
export const WEB_ATTACHMENT_MAX_FILES = 5;
export const WEB_ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const WEB_ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const WEB_ATTACHMENT_MAX_REQUEST_BYTES = WEB_ATTACHMENT_MAX_TOTAL_BYTES + 64 * 1024;
export const WEB_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export function isWebImageMimeType(value: string | null | undefined): boolean {
  return WEB_IMAGE_MIME_TYPES.includes(value?.trim().toLowerCase() as typeof WEB_IMAGE_MIME_TYPES[number]);
}
export const WEB_MUTATION_RPC_TIMEOUT_MS = 30_000;
export const WEB_MUTATION_CLIENT_TIMEOUT_MS = 35_000;
