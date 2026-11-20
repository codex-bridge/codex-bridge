export type MessageEditResult = "synced" | "retryable" | "missing" | "unavailable";

/** Unknown outcomes never establish that the original message is missing. */
export function classifyMessageEditError(error: unknown): MessageEditResult {
  if (typeof error !== "object" || error === null) return "retryable";
  const value = error as { data?: { error?: string }; error_code?: number; description?: string; statusCode?: number };
  if (value.error_code === 400) {
    if (value.description?.includes("message is not modified")) return "synced";
    if (value.description?.includes("message to edit not found")) return "missing";
  }
  const code = value.data?.error;
  if (code === "message_not_found") return "missing";
  const status = value.error_code ?? value.statusCode;
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return "unavailable";
  if (code && ["thread_not_found", "channel_not_found", "cant_update_message", "edit_window_closed",
    "not_in_channel", "is_archived", "missing_scope", "no_permission", "not_authed", "invalid_auth",
    "account_inactive", "token_revoked"].includes(code)) return "unavailable";
  return "retryable";
}
