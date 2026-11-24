export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async drain(): Promise<void> { await Promise.allSettled(this.tails.values()); }
  hasPending(key: string): boolean { return this.tails.has(key); }

  /** Wait for this key to become idle, including work appended while waiting. */
  async waitForIdle(key: string, signal?: AbortSignal): Promise<boolean> {
    while (!signal?.aborted) {
      const tail = this.tails.get(key);
      if (!tail) return true;
      let abort: (() => void) | undefined;
      const cancelled = new Promise<void>(resolve => { abort = () => resolve(); signal?.addEventListener("abort", abort, { once: true }); });
      try { await Promise.race([tail, cancelled]); }
      finally { if (abort) signal?.removeEventListener("abort", abort); }
    }
    return false;
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.tails.get(key) === current) {
        this.tails.delete(key);
      }
    }
  }
}
