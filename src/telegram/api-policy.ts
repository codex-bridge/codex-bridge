import type { Bot } from "grammy";
import { setTelegramBudget, telegramBudgetFor, type TelegramDeliveryBudget } from "./delivery-budget.js";
import { telegramDeliveryContext, TelegramDeliveryCancelled } from "./api-scheduler.js";

export type TelegramApiOptions = { budget?: TelegramDeliveryBudget };
const budgetedMethods = new Set(["sendRichMessage", "sendMessage", "editMessageText", "editMessageReplyMarkup", "deleteMessage", "sendChatAction"]);

/** Long polling keeps its own timeout. Writes never retry an unknown outcome. */
export function configureTelegramApi(bot: Bot, timeoutMs = 10_000, options: TelegramApiOptions = {}): void {
  if (options.budget) setTelegramBudget(bot, options.budget);
  const budget = telegramBudgetFor(bot);
  bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "getUpdates") return previous(method, payload, signal);
    const controller = new AbortController();
    // The runner uses a legacy AbortSignal, so forward cancellation explicitly
    // rather than passing it to the native AbortSignal.any.
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const delivery = telegramDeliveryContext.getStore();
    if (delivery?.signal?.aborted) abort();
    else delivery?.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const chatId = "chat_id" in payload ? String(payload.chat_id) : null;
      if (controller.signal.aborted || await delivery?.canSend?.() === false) throw new TelegramDeliveryCancelled();
      if (chatId && budgetedMethods.has(method)) {
        if (delivery?.onRateDeferred && !delivery.started) {
          if (!budget.tryAcquire(chatId)) { delivery.onRateDeferred(); throw new TelegramDeliveryCancelled(); }
        } else await budget.acquire(chatId, controller.signal);
        // An admitted write finishes its known format fallback in place. Starting
        // over at the rejected format would otherwise prevent fallback forever.
        if (delivery) delivery.started = true;
      }
      if (controller.signal.aborted || await delivery?.canSend?.() === false) throw new TelegramDeliveryCancelled();
      // Waiting for quota is not a network timeout.
      timer = setTimeout(() => controller.abort(new Error("Telegram API request timed out; outcome may be unknown.")), timeoutMs);
      timer.unref();
      const response = await previous(method, payload, controller.signal as unknown as typeof signal);
      if (chatId && !response.ok && response.error_code === 429) budget.observeRateLimit(chatId, response.parameters?.retry_after ?? 0);
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      delivery?.signal?.removeEventListener("abort", abort);
    }
  });
}
