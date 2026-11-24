import type { Bot, Context } from "grammy";
import { KeyedQueue } from "../shared/keyed-queue.js";
import { telegramSourceForContext } from "../shared/telegram-address.js";

/** Telegram has no album-complete event. Buffer its fragments without awaiting
 * the debounce in sequentialize; flush before the next non-album input.
 */
export class TelegramMediaGroups {
  private readonly groups = new Map<string, { source: string; contexts: Context[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly queue = new KeyedQueue();
  constructor(private readonly deliver: (contexts: Context[]) => Promise<void>, private readonly onError: (contexts: Context[], error: unknown) => Promise<void>,
    private readonly debounceMs = 600) {}

  add(ctx: Context): void {
    const source = telegramSourceForContext(ctx), key = `${source}:${ctx.message!.media_group_id}`;
    const old = this.groups.get(key);
    if (old) { clearTimeout(old.timer); old.contexts.push(ctx); }
    const contexts = old?.contexts ?? [ctx];
    const timer = setTimeout(() => { void this.flush(key).catch(() => {}); }, this.debounceMs);
    timer.unref();
    this.groups.set(key, { source, contexts, timer });
  }

  async flushSource(source: string): Promise<void> {
    for (const [key, group] of this.groups) if (group.source === source) await this.flush(key);
    await this.queue.run(source, async () => {});
  }

  async drain(): Promise<void> {
    for (const key of this.groups.keys()) await this.flush(key);
    await this.queue.drain();
  }

  private async flush(key: string): Promise<void> {
    const group = this.groups.get(key);
    if (!group) return;
    clearTimeout(group.timer); this.groups.delete(key);
    await this.queue.run(group.source, async () => {
      try { await this.deliver(group.contexts.sort((a, b) => a.message!.message_id - b.message!.message_id)); }
      catch (error) { await this.onError(group.contexts, error); }
    });
  }
}

const inboxes = new WeakMap<Bot, TelegramMediaGroups>();
export function registerTelegramMediaGroups(bot: Bot, groups: TelegramMediaGroups): void { inboxes.set(bot, groups); }
export async function drainTelegramMediaGroups(bot: Bot): Promise<void> { await inboxes.get(bot)?.drain(); }
