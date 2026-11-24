import { GrammyError, type Bot } from "grammy";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { timeTelegramDelivery, timeTelegramRetryWait } from "./delivery-timing.js";
import type { DeliveryTimingInput } from "../shared/delivery-timing.js";
import { KeyedQueue } from "../shared/keyed-queue.js";
import { AsyncLocalStorage } from "node:async_hooks";

export class TelegramDeliveryCancelled extends Error {}
export const telegramDeliveryContext = new AsyncLocalStorage<{
  canSend?: () => Promise<boolean>; signal?: AbortSignal; onRateDeferred?: () => void;
  started?: boolean;
}>();

/** All topics and immediate/background writes share the physical chat's queue.
 * Only an explicit rate-limit rejection is retried, once. Unknown outcomes propagate.
 */
export class TelegramApiScheduler {
  private readonly queue = new KeyedQueue();
  private readonly retryAfter = new Map<string, number>();

  constructor(private readonly clock = { now: () => Date.now(), sleep: (ms: number): Promise<void> => delay(ms) }) {}

  run<T>(chatId: string, operation: () => Promise<T>,
    context?: Omit<DeliveryTimingInput, "queuedAt" | "queued" | "physicalChatId">): Promise<T> {
    const queuedAt = performance.now();
    return this.queue.run(chatId, () => timeTelegramDelivery({
      chatId, operation: "write", ...context, physicalChatId: chatId, queued: true, queuedAt
    }, async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = (this.retryAfter.get(chatId) ?? 0) - this.clock.now();
        if (wait > 0) await timeTelegramRetryWait(() => this.clock.sleep(wait));
        this.retryAfter.delete(chatId);
        try { return await operation(); }
        catch (error) {
          const seconds = error instanceof GrammyError && error.error_code === 429 ? error.parameters.retry_after : undefined;
          if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) throw error;
          this.retryAfter.set(chatId, this.clock.now() + seconds * 1000);
          if (attempt > 0) throw error;
        }
      }
    }));
  }
}

const schedulers = new WeakMap<Bot, TelegramApiScheduler>();
export function telegramSchedulerFor(bot: Bot): TelegramApiScheduler {
  let scheduler = schedulers.get(bot);
  if (!scheduler) { scheduler = new TelegramApiScheduler(); schedulers.set(bot, scheduler); }
  return scheduler;
}
