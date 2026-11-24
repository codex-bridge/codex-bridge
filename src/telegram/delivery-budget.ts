import { setTimeout as sleep } from "node:timers/promises";
import type { Bot } from "grammy";
import { parseTelegramAddress } from "../shared/telegram-address.js";

export const telegramRefreshPolicy = { typingEnabled: false, progressMode: "summary", workingIntervalMs: 20_000 } as const;

type Clock = { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> };
type Limits = { botPerSecond: number; groupPerMinute: number; chatIntervalMs: number; backgroundIntervalMs: number };
type Waiter = { chatId: string; sessionId: string; signal: AbortSignal; resolve: (ready: boolean) => void; abort: () => void };

/** Runtime-only budgets shared by every transport using this Bot. Counts raw
 * write attempts, including rejected formats and retries, before network I/O.
 * Telegram's FAQ specifies 1/s per chat, 20/min in groups and ~30/s broadcast.
 * Edits conservatively use the same budget; these are ceilings, not promises.
 */
export class TelegramDeliveryBudget {
  private readonly botRequests: number[] = [];
  private readonly chatRequests = new Map<string, number[]>();
  private readonly chatCooldown = new Map<string, number>();
  private botCooldown = 0;
  private readonly backgroundAt = new Map<string, number>();
  private readonly lastServed = new Map<string, number>();
  private sequence = 0;
  private readonly waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly clock: Clock = { now: () => Date.now(), sleep: (ms, signal) => sleep(ms, undefined, { signal }) },
    private readonly limits: Limits = { botPerSecond: 25, groupPerMinute: 18, chatIntervalMs: 1_000, backgroundIntervalMs: 1_000 }) {}

  /** Called at the raw API boundary, once per actual attempt. */
  async acquire(chatId: string, signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      if (this.tryAcquire(chatId)) return;
      await this.clock.sleep(this.waitMs(chatId), signal);
    }
  }

  tryAcquire(chatId: string): boolean {
    if (this.waitMs(chatId) > 0) return false;
    const now = this.clock.now();
    this.botRequests.push(now);
    const requests = this.chatRequests.get(chatId) ?? [];
    requests.push(now); this.chatRequests.set(chatId, requests);
    return true;
  }

  observeRateLimit(chatId: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const until = this.clock.now() + seconds * 1_000;
    this.chatCooldown.set(chatId, Math.max(this.chatCooldown.get(chatId) ?? 0, until));
    // The API does not identify the quota's scope. Conservatively share cooldown.
    this.botCooldown = Math.max(this.botCooldown, until);
    this.schedule();
  }

  /** Wait outside notification/workflow/physical-chat queues. No payload is
   * retained here; owners keep only their latest state and re-read it on admission.
   */
  waitForRefresh(sourceId: string, sessionId: string, signal: AbortSignal): Promise<boolean> {
    const target = parseTelegramAddress(sourceId);
    if (!target || signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter: Waiter = { chatId: target.chatId, sessionId, signal, resolve, abort: () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort);
        resolve(false); this.schedule();
      } };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.schedule();
    });
  }

  private waitMs(chatId: string): number {
    const now = this.clock.now();
    while (this.botRequests.length && this.botRequests[0]! <= now - 1_000) this.botRequests.shift();
    const requests = this.chatRequests.get(chatId) ?? [];
    while (requests.length && requests[0]! <= now - 60_000) requests.shift();
    if (requests.length === 0) this.chatRequests.delete(chatId);
    const last = requests.at(-1);
    return Math.max(0, this.botCooldown - now, (this.chatCooldown.get(chatId) ?? 0) - now,
      this.botRequests.length >= this.limits.botPerSecond ? this.botRequests[0]! + 1_000 - now : 0,
      chatId.startsWith("-") && requests.length >= this.limits.groupPerMinute ? requests[0]! + 60_000 - now : 0,
      last === undefined ? 0 : last + this.limits.chatIntervalMs - now);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.waiters.length) return;
    const now = this.clock.now();
    const due = (entry: Waiter) => Math.max(this.waitMs(entry.chatId), (this.backgroundAt.get(entry.chatId) ?? -Infinity) + this.limits.backgroundIntervalMs - now);
    const ready = this.waiters.filter(entry => due(entry) <= 0);
    // Round robin between sessions, while retaining FIFO within each session.
    const sessionKey = (entry: Waiter) => `${entry.chatId}:${entry.sessionId}`;
    const next = ready.reduce<Waiter | undefined>((oldest, entry) => !oldest ||
      (this.lastServed.get(sessionKey(entry)) ?? 0) < (this.lastServed.get(sessionKey(oldest)) ?? 0) ? entry : oldest, undefined);
    if (next) {
      this.waiters.splice(this.waiters.indexOf(next), 1);
      next.signal.removeEventListener("abort", next.abort);
      this.backgroundAt.set(next.chatId, now);
      this.lastServed.set(sessionKey(next), ++this.sequence);
      next.resolve(true);
      this.schedule();
      return;
    }
    this.timer = setTimeout(() => { this.timer = null; this.schedule(); }, Math.max(1, Math.min(...this.waiters.map(due))));
    this.timer.unref();
  }
}

const budgets = new WeakMap<Bot, TelegramDeliveryBudget>();
export function telegramBudgetFor(bot: Bot): TelegramDeliveryBudget {
  let budget = budgets.get(bot);
  if (!budget) { budget = new TelegramDeliveryBudget(); budgets.set(bot, budget); }
  return budget;
}

export function setTelegramBudget(bot: Bot, budget: TelegramDeliveryBudget): void { budgets.set(bot, budget); }
