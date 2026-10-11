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

export class PhaseDeliveryAdapter {
  constructor(private readonly deps: PhaseDeliveryDependencies) {}

  send(chatId: string, messageSpec: MessageSpec): Promise<{ messageId: string; text: string } | null> {
    return this.deps.sendTemporaryMessageSpec(chatId, messageSpec, { disable_notification: true });
  }

  async edit(chatId: string, messageId: string, messageSpec: MessageSpec): Promise<boolean> {
    try {
      return await this.deps.editMessageSpec(chatId, messageId, messageSpec, { disable_notification: true });
    } catch (error) {
      logger.warn("bridge.progress.delivery_edit_failed", {
        chatId,
        messageId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
}
