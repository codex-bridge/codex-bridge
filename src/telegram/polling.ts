import { run } from "@grammyjs/runner";
import type { Bot, BotError, Context } from "grammy";
import type { Update } from "grammy/types";
import { logger } from "../logging/logger.js";

export type TelegramPolling = { task: Promise<void>; stop: () => Promise<void> };

export async function startTelegramPolling(bot: Bot): Promise<TelegramPolling> {
  await Promise.all([bot.init(), bot.api.deleteWebhook({ drop_pending_updates: false })]);
  const pending = new Set<Promise<void>>();
  const concurrency = 16;
  const runner = run<Update, BotError<Context>>({
    // The runner's initial fetch defaults to 100 even with a smaller sink limit.
    api: { getUpdates: async (args, signal) => {
      try { return await bot.api.getUpdates({ ...args, limit: Math.min(args.limit, concurrency) }, signal); }
      catch (error) {
        if (!signal.aborted) logger.warn("telegram.polling.fetch_failed", {
          errorType: error instanceof Error ? error.name : "Unknown",
          errorCode: (error as { error_code?: number } | null)?.error_code
        });
        throw error;
      }
    } },
    errorHandler: error => bot.errorHandler(error),
    handleUpdate: update => {
      const task = bot.handleUpdate(update);
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    }
  }, { sink: { concurrency }, runner: { silent: true, fetch: { allowed_updates: [] } } });
  return {
    task: runner.task()!,
    stop: async () => {
      // Stop fetching first, then drain accepted updates before closing the store.
      await runner.stop();
      await Promise.allSettled(pending);
    }
  };
}
