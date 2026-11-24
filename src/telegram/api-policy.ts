import type { Bot } from "grammy";

/** Long polling keeps its own timeout. Writes never retry an unknown outcome. */
export function configureTelegramApi(bot: Bot, timeoutMs = 10_000): void {
  bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "getUpdates") return previous(method, payload, signal);
    const controller = new AbortController();
    // The runner uses a legacy AbortSignal, so forward cancellation explicitly
    // rather than passing it to the native AbortSignal.any.
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Telegram API request timed out; outcome may be unknown.")), timeoutMs);
    timer.unref();
    try {
      return await previous(method, payload, controller.signal as unknown as typeof signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  });
}
