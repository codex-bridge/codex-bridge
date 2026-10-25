import { logger } from "../../logging/logger.js";
import type { BridgeMessageOptions } from "../transport.js";
import type { MessageSpec } from "../messages/types.js";

export type PhaseDeliveryDependencies = {
  editMessageSpec: (
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ) => Promise<boolean>;
  sendTemporaryMessageSpec: (
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ) => Promise<{ messageId: string; text: string } | null>;
};

export type PhaseEditResult = "synced" | "retryable" | "unavailable";

function editErrorResult(error: unknown): PhaseEditResult {
  if (typeof error !== "object" || error === null) return "retryable";
  const value = error as { data?: { error?: string }; error_code?: number; description?: string; statusCode?: number };
  // Unknown SDK/transport failures stay retryable; only definite rejections stop retries.
  if (value.error_code === 400 && value.description?.includes("message is not modified")) return "synced";
  const status = value.error_code ?? value.statusCode;
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return "unavailable";
  const code = value.data?.error;
  if (code && ["message_not_found", "thread_not_found", "channel_not_found", "cant_update_message",
    "edit_window_closed", "not_in_channel", "is_archived", "missing_scope", "no_permission",
    "not_authed", "invalid_auth", "account_inactive", "token_revoked"].includes(code)) return "unavailable";
  return "retryable";
}

export class PhaseDeliveryAdapter {
  constructor(private readonly deps: PhaseDeliveryDependencies) {}

  send(chatId: string, messageSpec: MessageSpec): Promise<{ messageId: string; text: string } | null> {
    return this.deps.sendTemporaryMessageSpec(chatId, messageSpec, { disable_notification: true });
  }

  async edit(chatId: string, messageId: string, messageSpec: MessageSpec): Promise<boolean> {
    return await this.editResult(chatId, messageId, messageSpec) === "synced";
  }

  async editResult(chatId: string, messageId: string, messageSpec: MessageSpec): Promise<PhaseEditResult> {
    try {
      return await this.deps.editMessageSpec(chatId, messageId, messageSpec, { disable_notification: true })
        ? "synced" : "unavailable";
    } catch (error) {
      logger.warn("bridge.progress.delivery_edit_failed", {
        chatId,
        messageId,
        error: error instanceof Error ? error.message : String(error)
      });
      return editErrorResult(error);
    }
  }
}
