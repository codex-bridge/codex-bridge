import { logger } from "../../logging/logger.js";
import type { BridgeMessageOptions } from "../transport.js";
import type { MessageSpec } from "../messages/types.js";
import { classifyMessageEditError } from "../messages/edit-result.js";

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
      const result = classifyMessageEditError(error);
      // Progress finalization never replaces a missing message.
      return result === "missing" ? "unavailable" : result;
    }
  }
}
