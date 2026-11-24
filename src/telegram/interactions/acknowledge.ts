import { logger } from "../../logging/logger.js";

/** A Telegram spinner/toast is feedback, not permission to run the business action. */
export async function acknowledgeTelegramCallback(
  answer: (signal: AbortSignal) => Promise<unknown>,
  context: { chatId?: number; callbackId?: string },
  timeoutMs = 2000
): Promise<void> {
  try { await answer(AbortSignal.timeout(timeoutMs)); }
  catch (error) {
    logger.warn("telegram.callback.ack_failed", {
      ...context, error: error instanceof Error ? error.message : String(error)
    });
  }
}
